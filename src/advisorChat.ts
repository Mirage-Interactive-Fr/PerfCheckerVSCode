import * as vscode from 'vscode';
import {spawn, ChildProcess} from 'node:child_process';
import {promises as fs} from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {StringDecoder} from 'node:string_decoder';
import {createHash, randomUUID} from 'node:crypto';
import {currentWorkspaceFolder, resolveControllerProject} from './workspace-root';
import {readAdvisorConfiguration} from './advisorSetup';
import {localAdvisorConnection, implementationMcpArguments, disconnectLocalAdvisorConnection} from './advisorConnection';
import {ChatMessage, prepareChatMessages, completeChatMessages, chatReply} from './advisorChatModel';
import {InvestigationReport} from './investigationModel';
import {createImplementationCheckout, applyImplementation, recoverImplementationProposal, recoverActiveImplementationProposal, saveActiveImplementationProposal, implementationWorkingTree, ImplementationProposal} from './implementation';
import {cancellableJulia, controllerCancellation} from './controllerCancellation';
import {SuiteChatSource, validateSuiteChatSource, captureSuiteChatSource, suiteAnalysisContext} from './suiteChatEvidence';
import {AnalysisContext, GuidedAnalysis, analysisContextKey, analysisRequest, analysisTopics,
  selectedAnalysisContext, parseGuidedAnalysis, implementationRequest, createChecksRequest,
  selectedMeasurementEvidence} from './guidedAnalysis';
import {WorkflowHistory} from './workflowHistory';
import {callMcpAction} from './mcpActionClient';
import {readProfileObservations} from './observation-reader';
import {runPackageTests} from './packageTests';
import {trialComparisons} from './trialComparison';

export interface ChatEvidence {id: string; label: string; unavailable?: boolean}
const selectedAnalysisContextOrEmpty = (context: AnalysisContext, ids: string[]): AnalysisContext =>
  ids.length ? selectedAnalysisContext(context, ids) : {...context, results: []};
export class AdvisorChat implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private workspace?: string;
  private messages: ChatMessage[] = [];
  private evidenceId = '';
  private displayedEvidence: ChatEvidence[] = [];
  private child?: ChildProcess;
  private cancellation?: ReturnType<typeof controllerCancellation>;
  private busy = false;
  private cancelled = false;
  private status = 'Connect an agent, then choose or create checks.';
  private pending = '';
  private disposed = false;
  private proposal?: ImplementationProposal;
  private implementationSummary = '';
  private backupRef = '';
  private recoveredWorkspace?: string;
  private retainedRelease?: Promise<void>;
  private incompleteLocalCleanup = new Set<string>();
  private retainedImplementation?: {key: string; checkout: Awaited<ReturnType<typeof createImplementationCheckout>>};
  private history?: WorkflowHistory;
  private guidedContext?: AnalysisContext;
  private guidedAnalysis?: GuidedAnalysis;
  private guidedAnalysisKey?: string;
  private guidedAnalysisCode?: string;
  private selectedResultIds: string[] = [];
  private selectedSuggestionId = '';
  private frozenSources = new Map<string, SuiteChatSource>();
  private contexts = new Map<string, AnalysisContext>();
  private adviceCache = new Map<string, InvestigationReport>();
  private actionCancellation?: AbortController;
  private activeIntent?: {kind: 'suggestion' | 'create-checks'; prompt: string; context?: AnalysisContext; suggestionId?: string; candidateRef?: string};
  private verification?: Record<string, any>;
  constructor(private context: vscode.ExtensionContext,
    private evidenceOptions: () => ChatEvidence[],
    private readEvidence: (id: string) => Promise<InvestigationReport | SuiteChatSource>,
    private refreshEvidence?: (folder: vscode.WorkspaceFolder) => Promise<void>) {}

  private folder() {
    const folder = currentWorkspaceFolder<vscode.WorkspaceFolder>(vscode.workspace.workspaceFolders);
    const key = folder.uri.toString();
    if (key !== this.workspace) {
      if (this.busy) throw new Error('Wait for the active conversation before changing PerfChecker folders.');
      this.panel?.dispose(); this.panel = undefined;
      this.messages = []; this.evidenceId = ''; this.pending = '';
      this.displayedEvidence = [];
      this.proposal = undefined; this.implementationSummary = ''; this.backupRef = '';
      this.recoveredWorkspace = undefined;
      this.workspace = key;
    }
    return folder;
  }
  state() {
    // A displayed conversation retains its folder even when another Studio
    // changes the window's selected workspace. Its owned Cancel stays usable.
    const folder = this.panel ? vscode.workspace.workspaceFolders?.find(folder=>folder.uri.toString()===this.workspace) : this.folder();
    if (!folder) throw new Error('The conversation workspace was closed.');
    let selectedHere=false;
    try{selectedHere=currentWorkspaceFolder(vscode.workspace.workspaceFolders).uri.toString()===folder.uri.toString();}
    catch{/* A different selected folder may have closed while this request finishes. */}
    // The evidence provider is selected-folder scoped. Retain A's last inventory
    // while B is selected instead of invoking B's history provider for A's panel.
    if(selectedHere) {
      const current = this.evidenceOptions().map(item=>({...item}));
      for (const [id, source] of this.frozenSources) if (!current.some(item => item.id === id)) {
        current.push({id, label: `Saved execution · ${source.runId}`});
      }
      this.displayedEvidence = current;
    }
    const settings = vscode.workspace.getConfiguration('perfchecker', folder.uri);
    return {type: 'chatState', workspace: folder.name, messages: this.messages, evidenceId: this.evidenceId,
      evidence: this.displayedEvidence, busy: this.busy, status: this.status, pending: this.pending,
      guided: {context: this.guidedContext, selectedResultIds: this.selectedResultIds,
        analysis: this.guidedAnalysis, selectedSuggestionId: this.selectedSuggestionId,
        history: this.history?.state(), verification: this.verification,
        analysisCurrent: !!this.guidedContext && this.guidedAnalysisKey === analysisContextKey(selectedAnalysisContextOrEmpty(this.guidedContext, this.selectedResultIds)),
        intent: this.activeIntent?.kind},
      connection: localAdvisorConnection(folder.uri.toString())?.label,
      connectionKind: localAdvisorConnection(folder.uri.toString())?.kind,
      implementation: localAdvisorConnection(folder.uri.toString())?.implementation ?? {tool: settings.get('advisorImplementationMcpTool', ''),
        promptArgument: settings.get('advisorImplementationMcpPromptArgument', 'prompt'),
        workspaceArgument: settings.get('advisorImplementationMcpWorkspaceArgument', 'workspace'),
        arguments: settings.get('advisorImplementationMcpArguments', {})},
      proposal: this.proposal ? {patch: this.proposal.patch, lossyPreview: this.proposal.lossyPreview, files: this.proposal.files, applied: this.proposal.applied,
        intentMatches: !this.activeIntent || this.activeIntent.candidateRef === this.proposal.candidateRef} : undefined,
      implementationSummary: this.implementationSummary, backupRef: this.proposal?.backupRef ?? this.backupRef};
  }
  private workflow() {
    const workspace = this.folder().uri.toString();
    if (this.history?.workspace !== workspace) {
      const saved = this.context.workspaceState.get<any>(`perfchecker.workflow.${workspace}`);
      try {this.history = new WorkflowHistory(workspace, saved?.history);} catch {this.history = new WorkflowHistory(workspace);}
      this.guidedContext = undefined; this.guidedAnalysis = undefined; this.guidedAnalysisKey = undefined;
      this.guidedAnalysisCode = undefined; this.activeIntent = undefined;
      this.selectedResultIds = []; this.selectedSuggestionId = ''; this.verification = undefined;
      this.contexts.clear(); this.frozenSources.clear(); this.adviceCache.clear();
      if (saved?.history?.workspace === workspace && Array.isArray(saved.sources) && Array.isArray(saved.contexts) && Buffer.byteLength(JSON.stringify(saved)) <= 24_000_000) {
        for (const item of saved.sources.slice(0, 256)) {
          if (!Array.isArray(item) || item.length !== 2) continue;
          const [id, source] = item;
          if (typeof id === 'string' && source?.workspace === workspace && typeof source.snapshot?.suite === 'string' && typeof source.snapshot?.series === 'string') {
            try {JSON.parse(source.snapshot.suite); JSON.parse(source.snapshot.series); this.frozenSources.set(id, source);} catch {/* Invalid local snapshot is not a result choice. */}
          }
        }
        for (const item of saved.contexts.slice(0, 256)) {
          if (!Array.isArray(item) || item.length !== 2) continue;
          const [key, context] = item;
          if (context?.evidenceId && Array.isArray(context.results) && context.results.every((result: any) => typeof result?.id === 'string') && analysisContextKey(context) === key)
            this.contexts.set(key, context);
        }
        try {this.restoreCheckpoint(this.history);} catch {this.status = 'The saved checkpoint needs attention. Choose a saved execution to continue.';}
      }
    }
    return this.history!;
  }
  private async persistWorkflow() {
    const history = this.workflow();
    const saved = {
      history: history.state(), sources: [...this.frozenSources], contexts: [...this.contexts],
    };
    if (Buffer.byteLength(JSON.stringify(saved)) > 24_000_000) throw new Error('This workflow reached its saved-context limit. The existing saved history was preserved.');
    await this.context.workspaceState.update(`perfchecker.workflow.${history.workspace}`, saved);
  }
  async selectResults(evidenceId: unknown, identities?: unknown) {
    if (this.busy) throw new Error('Wait for the current action before changing results.');
    const history = this.workflow(), folder = this.folder();
    if (typeof evidenceId !== 'string' || !evidenceId) throw new Error('Choose a saved execution.');
    let source = this.frozenSources.get(evidenceId);
    if (!source) {
      const evidence = await this.readEvidence(evidenceId);
      if (!('kind' in evidence) || evidence.kind !== 'suite-bundle') throw new Error('Choose a saved feature-suite execution.');
      if (evidence.workspace !== folder.uri.toString() || evidence.root !== await fs.realpath(folder.uri.fsPath))
        throw new Error('This execution belongs to another workspace.');
      source = await captureSuiteChatSource(evidence);
      this.frozenSources.set(evidenceId, source);
    }
    const context = await suiteAnalysisContext(source, evidenceId);
    const selected = identities === undefined ? context.results : context.results.filter(result =>
      Array.isArray(identities) && identities.some((value: any) => value?.package === result.package &&
        value?.feature === result.feature && value?.version === result.target));
    if (identities !== undefined && !selected.length) throw new Error('The selected checks have no saved results in this execution.');
    if (this.verification && this.verification.resultEvidenceId !== evidenceId && this.verification.baselineRunId !== context.runId)
      this.verification = undefined;
    this.guidedContext = context; this.evidenceId = evidenceId;
    this.selectedResultIds = selected.map(result => result.id); this.guidedAnalysis = undefined; this.selectedSuggestionId = '';
    const selectedContext = selectedAnalysisContextOrEmpty(context, this.selectedResultIds), key = analysisContextKey(selectedContext);
    this.contexts.set(key, selectedContext);
    history.append('results', context.label, {evidenceId, resultIds: this.selectedResultIds}, key);
    await this.persistWorkflow(); this.status = 'Results selected. Choose what to analyze.'; this.publish();
  }
  async selectSavedResults(source: SuiteChatSource, identities?: unknown) {
    if (this.busy) throw new Error('Wait for the current action before changing results.');
    this.workflow();
    const folder = this.folder();
    if (source?.workspace !== folder.uri.toString() || source.root !== await fs.realpath(folder.uri.fsPath))
      throw new Error('This execution belongs to another workspace.');
    const captured = await captureSuiteChatSource(source);
    const id = `suite:${JSON.stringify([source.workspace, source.runId, source.fingerprint])}`;
    this.frozenSources.set(id, captured);
    return this.selectResults(id, identities);
  }
  private async profileContext(context: AnalysisContext) {
    const source = this.frozenSources.get(context.evidenceId);
    if (!source) return [];
    await validateSuiteChatSource(source, true);
    const observations = await readProfileObservations(path.join(source.directory, 'observations.jsonl'),
      context.results.map(result => ({package: result.package, feature: result.feature, version: result.target})));
    const frames = observations.filter(record => Array.isArray(record.attributes?.stack) || record.attributes?.source_line !== undefined);
    const groups = new Map<string, typeof frames>();
    for (const frame of frames) {
      const key = JSON.stringify([frame.case_id, frame.target_id, frame.metric, frame.measurement_definition, frame.unit]);
      const group = groups.get(key) ?? []; group.push(frame); groups.set(key, group);
    }
    return [...groups.values()].map(group => ({totalRecords: group.length, shownRecords: Math.min(group.length, 100),
      limited: group.length > 100, frames: [...group].sort((a, b) => Number(b.value) - Number(a.value)).slice(0, 100)}));
  }
  async analyze(input: {resultIds?: unknown; topics?: unknown; instructions?: unknown} = {}) {
    if (this.busy) throw new Error('An agent action is already running.');
    const history = this.workflow(), folder = this.folder(), owner = folder.uri.toString();
    if (!vscode.workspace.isTrusted) throw new Error('Trust the workspace before connecting an agent.');
    if (!this.guidedContext) throw new Error('Select check results before asking for an analysis.');
    const context = selectedAnalysisContext(this.guidedContext, input.resultIds ?? this.selectedResultIds);
    const key = analysisContextKey(context), topics = input.topics ?? [...analysisTopics];
    this.selectedResultIds = context.results.map(result => result.id);
    this.guidedAnalysis = undefined; this.guidedAnalysisKey = undefined; this.selectedSuggestionId = '';
    this.busy = true; this.cancelled = false; this.actionCancellation = new AbortController();
    this.status = 'Preparing the selected check results…'; this.publish();
    let invoked = false;
    const local = localAdvisorConnection(owner);
    try {
      this.assertLocalCleanup(owner);
      const codeIdentity = await implementationWorkingTree(folder.uri.fsPath).catch(() => undefined);
      const config = await readAdvisorConfiguration(folder);
      const advice = await this.selectedEvidence(folder, context.evidenceId, context);
      const profiles = await this.profileContext(context);
      if (this.cancelled || this.folder().uri.toString() !== owner) throw new Error('Analysis cancelled or workspace changed.');
      const current = {measurements: advice.measurement_summaries ?? [], profiles, ...(this.verification ? {trial: this.verification} : {})};
      const prompt = analysisRequest(context, topics, input.instructions, current);
      const replayPrompt = analysisRequest(context, topics, input.instructions, {...current, branch: history.replay()});
      this.status = 'The connected agent is analyzing the selected results…'; this.publish();
      invoked = true;
      const result = await callMcpAction(config, {prompt, replayPrompt, parentSession: history.agentParent()}, this.actionCancellation.signal);
      if (this.cancelled || this.folder().uri.toString() !== owner) throw new Error('Analysis cancelled or workspace changed.');
      const analysis = parseGuidedAnalysis(result.text, context);
      this.contexts.set(key, context); this.guidedAnalysis = analysis; this.guidedAnalysisKey = key; this.guidedAnalysisCode = codeIdentity;
      history.append('analysis', 'Agent analysis', {analysis, codeIdentity, input: JSON.parse(prompt.split('\n').at(-1)!),
        topics, instructions: input.instructions ?? '', historyMode: result.historyMode}, key, result.agentSession);
      await this.persistWorkflow();
      this.status = 'Analysis ready. Choose a suggestion to try, or keep the current code.';
      return analysis;
    } catch (error) {
      if (invoked && local) {
        this.incompleteLocalCleanup.add(owner);
        try {await disconnectLocalAdvisorConnection(owner); this.incompleteLocalCleanup.delete(owner);}
        catch (cleanup) {this.status = `${String(error)} Agent cleanup is incomplete: ${String(cleanup)}`; throw new AggregateError([error, cleanup], this.status);}
      }
      this.status = String(error); throw error;
    }
    finally {this.busy = false; this.actionCancellation = undefined; this.child = undefined; this.publish();}
  }
  async trySuggestion(id: unknown = this.selectedSuggestionId, instructions?: unknown) {
    if (this.busy) throw new Error('Wait for the current action.');
    if (this.proposal?.applied) throw new Error('Restore or keep the current trial before trying another suggestion.');
    if (!this.guidedContext || !this.guidedAnalysis) throw new Error('Analyze selected results before trying a suggestion.');
    const context = selectedAnalysisContext(this.guidedContext, this.selectedResultIds);
    if (analysisContextKey(context) !== this.guidedAnalysisKey) throw new Error('The result selection changed. Analyze it before trying a suggestion.');
    if (this.guidedAnalysisCode && await implementationWorkingTree(this.folder().uri.fsPath) !== this.guidedAnalysisCode)
      throw new Error('The code changed after this analysis. Run the checks again or return to the matching code before trying the suggestion.');
    const prompt = implementationRequest(this.guidedAnalysis, id, context, instructions);
    this.selectedSuggestionId = String(id);
    this.activeIntent = {kind: 'suggestion', prompt, context, suggestionId: this.selectedSuggestionId};
    return this.implement(true, this.activeIntent);
  }
  async createChecks(instructions?: unknown) {
    if (this.busy || this.proposal?.applied) throw new Error('Finish the current action or restore the current trial first.');
    this.workflow();
    this.activeIntent = {kind: 'create-checks', prompt: createChecksRequest(instructions)};
    return this.implement(true, this.activeIntent);
  }
  async continueFrom(id: unknown) {
    if (this.busy) throw new Error('Wait for the current action before choosing a checkpoint.');
    const history = this.workflow(); history.checkout(id); this.restoreCheckpoint(history);
    this.status = 'Checkpoint selected. Your next action will create a new branch. Source files are unchanged.';
    await this.persistWorkflow(); this.publish();
  }
  private restoreCheckpoint(history: WorkflowHistory) {
    const node = history.get();
    if (!node) return;
    const context = node.contextKey ? this.contexts.get(node.contextKey) : undefined;
    this.guidedContext = context || undefined; this.evidenceId = context?.evidenceId ?? '';
    this.selectedResultIds = context?.results.map(result => result.id) ?? [];
    const analysisNode = history.branch().reverse().find(item => item.action === 'analysis' && item.contextKey === node.contextKey);
    this.guidedAnalysis = context && analysisNode ? parseGuidedAnalysis(JSON.stringify(analysisNode.data.analysis), context) : undefined;
    this.guidedAnalysisKey = this.guidedAnalysis && context ? analysisContextKey(context) : undefined;
    this.guidedAnalysisCode = typeof analysisNode?.data.codeIdentity === 'string' ? analysisNode.data.codeIdentity : undefined;
    this.verification = history.branch().reverse().find(item => item.action === 'verification')?.data.verification as Record<string, any> | undefined;
    const implementation = history.branch().reverse().find(item => ['implementation', 'create-checks', 'accept'].includes(item.action));
    this.activeIntent = implementation && implementation.action !== 'accept' && typeof implementation.data.request === 'string' ? {
      kind: implementation.action === 'create-checks' ? 'create-checks' : 'suggestion', prompt: implementation.data.request,
      context: implementation.contextKey ? this.contexts.get(implementation.contextKey) : undefined,
      suggestionId: typeof implementation.data.suggestionId === 'string' ? implementation.data.suggestionId : undefined,
      candidateRef: typeof implementation.data.candidateRef === 'string' ? implementation.data.candidateRef : undefined,
    } : undefined;
    this.selectedSuggestionId = '';
  }
  async verifyTrial(analyzeAfter = false, instructions?: unknown) {
    if (this.busy) throw new Error('Wait for the current action.');
    if (!this.proposal?.applied) throw new Error('Review and apply the proposed diff before verifying the trial.');
    if (this.activeIntent && this.activeIntent.candidateRef !== this.proposal.candidateRef)
      throw new Error('This trial belongs to another branch. Return to its implementation checkpoint before verifying it.');
    const folder = this.folder(), workspace = folder.uri.toString(), history = this.workflow();
    const context = this.activeIntent?.context ?? this.guidedContext;
    this.busy = true; this.cancelled = false; this.actionCancellation = new AbortController();
    const signal = this.actionCancellation.signal;
    this.status = 'Running the package tests…'; this.publish();
    const verification: Record<string, any> = {id: randomUUID(), candidateRef: this.proposal.candidateRef, startedAt: new Date().toISOString(),
      baselineRunId: context?.runId, suggestionId: this.activeIntent?.suggestionId};
    try {
      const codeIdentity = await implementationWorkingTree(folder.uri.fsPath);
      const settings = vscode.workspace.getConfiguration('perfchecker', folder.uri);
      verification.packageTests = await runPackageTests(folder.uri.fsPath, settings.get('juliaExecutable', 'julia'), signal,
        text => {const line = text.trim().split(/\r?\n/).at(-1); if (line) {this.status = line.slice(0, 240); this.publish();}});
      if (verification.packageTests.status === 'passed' && !signal.aborted) {
        if (this.folder().uri.toString() !== workspace) throw new Error('The verification workspace changed.');
        this.status = 'Package tests passed. Repeating the selected performance checks…'; this.publish();
        const measured = context?.results.filter(result => result.check !== 'package-tests');
        const selections = measured?.length ? measured.map(result => ({package: result.package, feature: result.feature, version: result.target})) : undefined;
        verification.checks = await vscode.commands.executeCommand('perfchecker.runVerificationChecks', {workspace: folder.uri, selections, signal});
        if (!verification.checks || typeof verification.checks !== 'object') throw new Error('The performance checks returned no verification result.');
        await this.refreshEvidence?.(folder);
        const option = this.evidenceOptions().find(item => {
          if (!item.id.startsWith('suite:') || item.unavailable) return false;
          try {return JSON.parse(item.id.slice(6))[1] === verification.checks.runId;} catch {return false;}
        });
        if (option) {
          const source = await this.readEvidence(option.id);
          if ('kind' in source && source.kind === 'suite-bundle') {
            this.frozenSources.set(option.id, await captureSuiteChatSource(source));
            verification.resultEvidenceId = option.id;
            if (context && measured?.length) {
              const trialContext = await suiteAnalysisContext(this.frozenSources.get(option.id)!, option.id);
              const selectedTrial = selectedAnalysisContext(trialContext, trialContext.results.filter(result =>
                result.targetKind === 'dev' && verification.checks.trialSelections?.some((selected: any) => selected.package === result.package &&
                  selected.feature === result.feature && selected.version === result.target)).map(result => result.id));
              const before = await this.selectedEvidence(folder, context.evidenceId, context);
              const after = await this.selectedEvidence(folder, option.id, selectedTrial);
              verification.checks.comparisons = trialComparisons(before.measurement_summaries ?? [], after.measurement_summaries ?? [], context, selectedTrial);
              verification.checks.comparisonNotice = verification.checks.comparisons.length ?
                'Observed changes between executions. Profile weights are excluded; no statistical performance verdict is implied.' :
                'No directly comparable operation measurements were available. No speedup can be inferred.';
            }
          }
        }
      } else verification.checks = {status: 'not_run', reason: 'Package tests did not pass.'};
      if (await implementationWorkingTree(folder.uri.fsPath) !== codeIdentity) throw new Error('Files changed while verification was running. Run verification again before keeping the trial.');
      verification.codeIdentity = codeIdentity;
    } catch (error) {verification.error = String(error);}
    finally {
      verification.finishedAt = new Date().toISOString(); this.verification = verification;
      try {
        if (this.folder().uri.toString() === workspace) {
          const key = context ? analysisContextKey(context) : undefined;
          if (key && context) this.contexts.set(key, context);
          history.append('verification', 'Trial verification', {verification}, key);
          await this.persistWorkflow();
        }
      } finally {
        this.busy = false; this.actionCancellation = undefined;
        this.status = !verification.error && verification.packageTests?.status === 'passed' && verification.checks?.status === 'passed' ?
          'Verification complete. Review the comparison, keep the trial or restore the previous code.' :
          'Verification needs attention. Send the test feedback back to the analysis, or restore the previous code.';
        this.publish();
      }
    }
    if (analyzeAfter && !this.cancelled) await this.analyzeTrial(instructions);
    return verification;
  }
  async applyAndVerify(instructions?: unknown) {
    await this.apply();
    return this.verifyTrial(true, instructions);
  }
  async analyzeTrial(instructions?: unknown) {
    if (this.busy) throw new Error('Wait for verification to finish.');
    if (!this.verification) throw new Error('Verify the trial before analyzing its feedback.');
    if (this.verification.resultEvidenceId) {
      await this.selectResults(this.verification.resultEvidenceId, this.verification.checks?.selections);
    } else if (!this.guidedContext) {
      const evidenceId = `verification:${this.verification.id}`;
      const context: AnalysisContext = {evidenceId, runId: this.verification.id,
        fingerprint: createHash('sha256').update(JSON.stringify(this.verification)).digest('hex'), label: 'Package-test feedback',
        results: [{id: evidenceId, package: this.folder().name, feature: 'package tests', check: 'package-tests', target: 'trial',
          revision: this.proposal?.candidateRef, status: this.verification.packageTests?.status ?? 'error', summary: {},
          message: this.verification.packageTests?.output ?? this.verification.error}]};
      this.guidedContext = context; this.evidenceId = evidenceId; this.selectedResultIds = [evidenceId];
      const key = analysisContextKey(context); this.contexts.set(key, context);
      this.workflow().append('results', 'Package-test feedback', {evidenceId, resultIds: [evidenceId]}, key);
      await this.persistWorkflow();
    }
    return this.analyze({instructions});
  }
  async restoreTrial() {
    await this.apply(true);
    this.workflow().append('restore', 'Previous code restored', {verificationId: this.verification?.id}, this.guidedAnalysisKey);
    await this.persistWorkflow(); this.publish();
  }
  async keepTrial() {
    if (this.busy || !this.proposal?.applied || this.verification?.candidateRef !== this.proposal.candidateRef ||
      this.verification?.packageTests?.status !== 'passed' || this.verification.checks?.status !== 'passed' || !this.verification.codeIdentity || this.verification.error)
      throw new Error('A trial must pass package tests and the selected checks before it can be kept.');
    if (await implementationWorkingTree(this.folder().uri.fsPath) !== this.verification.codeIdentity)
      throw new Error('Files changed after verification. Run verification again before keeping the trial.');
    this.workflow().append('accept', 'Trial kept', {verificationId: this.verification.id, files: this.proposal.files}, this.guidedAnalysisKey);
    this.proposal = undefined; this.activeIntent = undefined; this.implementationSummary = '';
    await this.persistProposal(); await this.persistWorkflow(); this.status = 'Trial kept. The verification and analysis remain in the workflow history.'; this.publish();
  }
  isBusy() {return this.busy;}
  connectionChanged() {
    // Connector cleanup may finish after another Studio selects a different
    // folder. Keep the displayed conversation and its history with its owner.
    const workspace = this.panel ? this.workspace : this.folder().uri.toString();
    const local = workspace ? localAdvisorConnection(workspace) : undefined;
    this.status = local ? `${local.label} connected for this editor session. Advice is requested explicitly; implementation requires review. Tool permissions are managed by the server.` : 'Local connector disconnected. Saved provider configuration is active again. Reconnect after an editor restart.';
    const retained = this.retainedImplementation;
    if (retained && !localAdvisorConnection(retained.key)) {
      void this.releaseRetainedImplementation().then(() => this.publish(), error => {
        this.status = 'Local agent stopped, but isolated copy cleanup failed; checkpoint retained. ' + String(error);
        this.publish();
      });
    }
    this.publish();
  }
  private publish() {
    if (this.disposed) return;
    try {void this.panel?.webview.postMessage(this.state());} catch {/* selected folder was closed */}
  }
  async open() {
    const folder = this.folder(), workspace = folder.uri.toString();
    this.workflow();
    if (!this.busy) await this.refreshEvidence?.(folder);
    await this.recoverProposal();
    if (this.panel) {this.panel.reveal(); this.publish(); return;}
    this.panel = vscode.window.createWebviewPanel('perfchecker.advisorChat', 'PerfChecker · Agent workflow', vscode.ViewColumn.One,
      {enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]});
    const panel = this.panel, webview = panel.webview, nonce = randomUUID();
    const resource = (name: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', name));
    this.panel.iconPath = {light: vscode.Uri.joinPath(this.context.extensionUri, 'media', 'perfchecker-light.svg'),
      dark: vscode.Uri.joinPath(this.context.extensionUri, 'media', 'perfchecker-dark.svg')};
    webview.html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${resource('advisor-workflow.css')}"><title>PerfChecker agent workflow</title></head><body><div id="workflow-root"></div><script nonce="${nonce}" src="${resource('advisor-workflow.js')}"></script><script nonce="${nonce}">const api=acquireVsCodeApi();const panel=mountAdvisorWorkflow(document.getElementById('workflow-root'),m=>api.postMessage(m),${JSON.stringify(String(resource('perfchecker.png')))});window.addEventListener('message',e=>panel.receive(e.data));api.postMessage({type:'chatReady'});</script></body></html>`;
    panel.onDidDispose(() => {if (this.panel===panel) {this.cancel(true);this.panel=undefined;}});
    webview.onDidReceiveMessage(async message => {
      try {
        if (this.panel!==panel || this.workspace!==workspace) return;
        if (message?.type==='chatCancel') {this.cancel();return;}
        if (this.folder().uri.toString() !== workspace) throw new Error('PerfChecker folder changed. Reopen the conversation.');
        if (message?.type === 'chatReady') this.publish();
        else if (message?.type === 'workflowSelectResults') await this.selectResults(message.evidenceId);
        else if (message?.type === 'workflowSelection') {
          if (this.busy || !this.guidedContext) throw new Error('Wait for the current action or select an execution.');
          const ids = message.resultIds;
          if (!Array.isArray(ids)) throw new Error('Choose check results.');
          if (ids.length) selectedAnalysisContext(this.guidedContext, ids);
          this.selectedResultIds = [...ids]; this.selectedSuggestionId = ''; this.publish();
        }
        else if (message?.type === 'workflowAnalyze') await this.analyze(message);
        else if (message?.type === 'workflowSuggestion') {
          if (this.busy || !this.guidedAnalysis?.suggestions.some(item => item.id === message.suggestionId)) throw new Error('Choose a suggestion from the current analysis.');
          this.selectedSuggestionId = message.suggestionId; this.publish();
        }
        else if (message?.type === 'workflowCreateChecks') await this.createChecks(message.instructions);
        else if (message?.type === 'workflowTrySuggestion') await this.trySuggestion(message.suggestionId, message.instructions);
        else if (message?.type === 'workflowContinue') await this.continueFrom(message.nodeId);
        else if (message?.type === 'workflowApplyVerify') await this.applyAndVerify(message.instructions);
        else if (message?.type === 'workflowVerify') await this.verifyTrial();
        else if (message?.type === 'workflowAnalyzeTrial') await this.analyzeTrial(message.instructions);
        else if (message?.type === 'workflowKeep') await this.keepTrial();
        else if (message?.type === 'workflowRestore') await this.restoreTrial();
        else if (message?.type === 'workflowChecks') await vscode.commands.executeCommand('perfchecker.openDesigner');
        else if (message?.type === 'workflowShowResults') {
          if (!this.guidedContext) throw new Error('Choose results first.');
          const selected = selectedAnalysisContext(this.guidedContext, message.resultIds ?? this.selectedResultIds);
          if (!this.frozenSources.has(selected.evidenceId)) throw new Error('Package-test feedback has no performance plots. Review the verification output below.');
          await vscode.commands.executeCommand('perfchecker.openSelectedAnalysisResults', {
            workspace: folder.uri, source: this.frozenSources.get(selected.evidenceId), runId: selected.runId,
            selections: selected.results.map(result => ({package: result.package, feature: result.feature, version: result.target})),
          });
        }
        else if (message?.type === 'chatSend') await this.send(message.question, message.evidenceId);
        else if (message?.type === 'chatClear') this.clear(message.evidenceId);
        else if (message?.type === 'chatSettings') await vscode.commands.executeCommand('perfchecker.configureAdvisor');
        else if (message?.type === 'chatConnectCodex') await vscode.commands.executeCommand('perfchecker.connectCodex');
        else if (message?.type === 'chatDisconnectCodex') await vscode.commands.executeCommand('perfchecker.disconnectCodex');
        else if (message?.type === 'chatConnectMcpStdio') await vscode.commands.executeCommand('perfchecker.connectMcpStdio');
        else if (message?.type === 'workflowConnectAcp') {
          if (this.busy) throw new Error('Finish or cancel the active action before changing agents.');
          await disconnectLocalAdvisorConnection(workspace);
          await vscode.commands.executeCommand('perfchecker.configureAdvisor', {acp: true, preset: message.preset});
        }
        else if (message?.type === 'chatDisconnectMcpStdio') await vscode.commands.executeCommand('perfchecker.disconnectMcpStdio');
        else if (message?.type === 'implementationSettings') await this.saveImplementationSettings(message);
        else if (message?.type === 'chatImplement') await this.trySuggestion();
        else if (message?.type === 'chatApply') await this.apply();
        else if (message?.type === 'chatRestore') await this.apply(true);
        else if (message?.type === 'chatDiff') {
          if (!this.proposal) throw new Error('No implementation diff is available.');
          await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({language: 'diff', content: this.proposal.patch}), {preview: true});
        }
        else if (message?.type === 'chatVerify') await vscode.commands.executeCommand('perfchecker.openInvestigations');
        else if (message?.type === 'chatDiscard') {
          if (this.busy || this.proposal?.applied) throw new Error('Finish the current action, then restore or keep an applied trial before discarding it.');
          this.proposal = undefined; this.activeIntent = undefined; this.implementationSummary = ''; await this.persistProposal(); this.publish();
        }
      } catch (error) {if (this.panel===panel && this.workspace===workspace) {this.status=String(error);this.publish();}}
    }, undefined, this.context.subscriptions);
  }
  clear(evidenceId: unknown = '') {
    this.folder();
    if (this.busy) throw new Error('Cancel or finish the current request before starting a new conversation.');
    if (typeof evidenceId !== 'string' || (evidenceId && !this.evidenceOptions().some(item => item.id === evidenceId && !item.unavailable))) throw new Error('Saved evidence is no longer available.');
    this.messages = []; this.pending = ''; this.evidenceId = evidenceId;
    this.status = 'New conversation. Only the selected saved evidence and your messages will be sent.';
    this.publish();
  }
  private assertLocalCleanup(workspace: string) {
    if (!this.incompleteLocalCleanup.has(workspace)) return;
    if (localAdvisorConnection(workspace)) throw new Error('Local agent cleanup is incomplete. Retry Disconnect before making another request.');
    this.incompleteLocalCleanup.delete(workspace);
  }
  async send(question: unknown, evidenceId: unknown = this.evidenceId) {
    const folder = this.folder(), key = folder.uri.toString(), local = localAdvisorConnection(key);
    this.assertLocalCleanup(key);
    if (!vscode.workspace.isTrusted) throw new Error('Trust the workspace before connecting an advisor.');
    if (this.busy) throw new Error('An advisor request is already running.');
    const settings = vscode.workspace.getConfiguration('perfchecker', folder.uri);
    if (!settings.get('advisorEnabled', true) && !localAdvisorConnection(folder.uri.toString())) throw new Error('Optional advisor is disabled. Open Advisor settings to configure it.');
    if (typeof evidenceId !== 'string' || (evidenceId && !this.evidenceOptions().some(item => item.id === evidenceId && !item.unavailable))) throw new Error('Saved evidence is no longer available.');
    const prepared = prepareChatMessages(evidenceId === this.evidenceId ? this.messages : [], question);
    // Lock before any asynchronous read so double submissions cannot overlap.
    this.busy = true; this.cancelled = false;
    this.pending = prepared.messages.at(-1)!.content;
    this.status = 'Connecting to the configured MCP advice tool…'; this.publish();
    let invoked = false;
    try {
      await this.recoverProposal();
      const config = await readAdvisorConfiguration(folder);
      if (config.protocol !== 'mcp_http' || (config.mcp_response ?? 'text') !== 'text' || !config.mcp_tool) {
        throw new Error('Chat requires an MCP advice tool in text mode. Open Advisor settings, select mcp_http, discover a tool and save.');
      }
      const advice = evidenceId ? await this.selectedEvidence(folder, evidenceId) : undefined;
      if (this.cancelled) throw new Error('Request cancelled.');
      invoked = true;
      const result = await this.invoke(folder, config, {messages: prepared.messages, ...(advice ? {advice} : {})});
      if (this.cancelled) throw new Error('Request cancelled. The remote server may still finish its work.');
      const reply = chatReply(result, Number(config.timeout ?? 90));
      const completed = completeChatMessages(prepared.messages, reply);
      this.messages = completed.messages;
      this.evidenceId = evidenceId;
      this.pending = '';
      const omitted = prepared.omitted + completed.omitted;
      this.status = `Reply received · advice is unverified.${omitted ? ` ${omitted / 2} older exchanges were omitted to fit the context limit.` : ''}`;
      return result;
    } catch (error) {
      let failure = error;
      if (invoked && local) {
        this.incompleteLocalCleanup.add(key);
        try {await disconnectLocalAdvisorConnection(key); this.incompleteLocalCleanup.delete(key);}
        catch (cleanupError) {failure = new AggregateError([error, cleanupError], String(error) + ' Local agent cleanup is incomplete. Retry Disconnect before making another request.');}
      }
      this.status = String(failure); throw failure;
    } finally {this.busy = false; this.child = undefined; this.publish();}
  }
  private async selectedEvidence(folder: vscode.WorkspaceFolder, id: string, selection?: AnalysisContext): Promise<InvestigationReport> {
    if (id === `verification:${this.verification?.id}` && selection?.results.every(result => result.check === 'package-tests'))
      return {schema_version: 'perfchecker-advice/1', recommendations: [], measurement_summaries: []};
    const evidence = this.frozenSources.get(id) ?? await this.readEvidence(id);
    if (!('kind' in evidence) || evidence.kind !== 'suite-bundle') return evidence as InvestigationReport;
    const source = evidence as SuiteChatSource;
    if (source.workspace !== folder.uri.toString() || source.root !== await fs.realpath(folder.uri.fsPath))
      throw new Error('Saved suite evidence belongs to another workspace.');
    await validateSuiteChatSource(source, true);
    if (this.cancelled) throw new Error('Request cancelled before projecting saved suite evidence.');
    this.status = 'Reading saved suite measurements locally; no benchmarks or provider request…'; this.publish();
    const advice = this.adviceCache.get(id) ?? await this.invoke(folder, {}, undefined, 'advise', source.directory) as InvestigationReport;
    if (this.cancelled) throw new Error('Request cancelled before sending saved suite evidence.');
    await validateSuiteChatSource(source, true);
    if (advice?.schema_version !== 'perfchecker-advice/1' || !Array.isArray(advice.recommendations))
      throw new Error('The controller returned invalid saved suite evidence. No measurements were sent.');
    if (!Array.isArray(advice.measurement_summaries))
      throw new Error('Suite evidence requires PerfChecker 1.0.1 or later with canonical measurement summaries. Core 1.0.0 does not provide them. Update the controller, or ask without suite evidence. No measurements were sent.');
    if (!selection && !advice.measurement_summaries.length)
      throw new Error('This saved bundle has no supported canonical measurement summaries. No measurements were sent.');
    if (selection) {
      this.adviceCache.set(id, advice);
      if (this.adviceCache.size > 8) this.adviceCache.delete(this.adviceCache.keys().next().value!);
    }
    return selection ? selectedMeasurementEvidence(advice, selection) as InvestigationReport : advice;
  }
  private async saveImplementationSettings(input: any) {
    const folder = this.folder();
    if (this.busy) throw new Error('Wait for the current request.');
    const local = localAdvisorConnection(folder.uri.toString());
    if (local) throw new Error(`Disconnect ${local.label} before changing its tool selection or configuring your saved provider.`);
    if (!vscode.workspace.isTrusted) throw new Error('Trust the workspace before configuring implementation.');
    if (typeof input.tool !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(input.tool) ||
      ![input.promptArgument, input.workspaceArgument].every(value => typeof value === 'string' && /^[A-Za-z_][A-Za-z_0-9.-]{0,127}$/.test(value)) ||
      input.promptArgument === input.workspaceArgument) throw new Error('Enter an implementation tool and two different argument names.');
    const argumentsValue = implementationMcpArguments({}, input.arguments, input.promptArgument, input.workspaceArgument);
    const settings = vscode.workspace.getConfiguration('perfchecker', folder.uri);
    await settings.update('advisorImplementationMcpTool', input.tool, vscode.ConfigurationTarget.WorkspaceFolder);
    await settings.update('advisorImplementationMcpPromptArgument', input.promptArgument, vscode.ConfigurationTarget.WorkspaceFolder);
    await settings.update('advisorImplementationMcpWorkspaceArgument', input.workspaceArgument, vscode.ConfigurationTarget.WorkspaceFolder);
    await settings.update('advisorImplementationMcpArguments', argumentsValue, vscode.ConfigurationTarget.WorkspaceFolder);
    this.status = 'Implementation tool saved. Review advice before preparing changes.'; this.publish();
  }
  private async releaseRetainedImplementation() {
    if (this.retainedRelease) return this.retainedRelease;
    const retained = this.retainedImplementation;
    if (!retained) return;
    if (localAdvisorConnection(retained.key)) throw new Error('Local agent cleanup is incomplete. Retry Disconnect before preparing another implementation. The isolated copy and checkpoint are retained.');
    const release = retained.checkout.dispose().then(() => {
      if (this.retainedImplementation === retained) this.retainedImplementation = undefined;
    });
    this.retainedRelease = release;
    try {await release;} finally {if (this.retainedRelease === release) this.retainedRelease = undefined;}
  }
  async implement(warningShown = false, intent?: NonNullable<AdvisorChat['activeIntent']>) {
    if (this.busy) throw new Error('An advisor request is already running.');
    await this.releaseRetainedImplementation();
    const folder = this.folder();
    this.assertLocalCleanup(folder.uri.toString());
    if (!vscode.workspace.isTrusted) throw new Error('Trust the workspace before requesting implementation.');
    if (this.busy) throw new Error('An advisor request is already running.');
    if (!intent && !this.messages.length) throw new Error('Get and review advice before requesting implementation.');
    if (vscode.workspace.textDocuments.some(document => document.isDirty && document.uri.scheme === 'file' &&
      this.containsFile(folder.uri.fsPath, document.uri.fsPath))) throw new Error('Save your files before preparing a Git checkpoint.');
    const settings = vscode.workspace.getConfiguration('perfchecker', folder.uri);
    const local = localAdvisorConnection(folder.uri.toString());
    if (!settings.get('advisorEnabled', true) && !local) throw new Error('Optional advisor is disabled.');
    const tool = local?.implementation.tool ?? settings.get<string>('advisorImplementationMcpTool', '');
    if (!tool) throw new Error('Configure an explicit MCP implementation tool first.');
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(tool)) throw new Error('Invalid MCP implementation tool name.');
    const promptArgument = local?.implementation.promptArgument ?? settings.get<string>('advisorImplementationMcpPromptArgument', 'prompt');
    const workspaceArgument = local?.implementation.workspaceArgument ?? settings.get<string>('advisorImplementationMcpWorkspaceArgument', 'workspace');
    if (![promptArgument, workspaceArgument].every(value => /^[A-Za-z_][A-Za-z_0-9.-]{0,127}$/.test(value)) || promptArgument === workspaceArgument) throw new Error('Configure two distinct MCP prompt and workspace argument names.');
    if (!warningShown) void vscode.window.showWarningMessage('Agent edits may be incorrect. PerfChecker saves a Git checkpoint and prepares an isolated copy. Review the diff before applying, then rerun checks.');
    this.busy = true; this.cancelled = false;
    this.status = 'Creating Git checkpoint and isolated checkout…'; this.publish();
    let checkout: Awaited<ReturnType<typeof createImplementationCheckout>> | undefined;
    let primaryFailure: unknown;
    try {
      await this.recoverProposal();
      const config = await readAdvisorConfiguration(folder);
      if (config.protocol !== 'mcp_http') throw new Error('Implementation requires an MCP endpoint.');
      config.mcp_tool = tool; config.mcp_response = 'text';
      config.mcp_prompt_argument = promptArgument;
      // Existing configurations retain their arguments until the user saves a
      // separate implementation configuration. Advice and editing tools may
      // require different arguments even when they share an MCP server.
      config.mcp_arguments = implementationMcpArguments(config.mcp_arguments,
        local ? local.implementation.arguments : settings.get('advisorImplementationMcpArguments'), promptArgument, workspaceArgument);
      checkout = await createImplementationCheckout(folder.uri.fsPath);
      this.backupRef = checkout.backupRef;
      await this.persistProposal();
      if (this.cancelled) throw new Error('Implementation cancelled; checkpoint retained.');
      this.status = 'Agent is implementing in an isolated checkout. Your project awaits diff review.'; this.publish();
      let result: unknown, actionResponse: Awaited<ReturnType<typeof callMcpAction>> | undefined;
      if (intent) {
        this.actionCancellation = new AbortController();
        const history = this.workflow();
        const response = actionResponse = await callMcpAction(config, {prompt: intent.prompt,
          replayPrompt: `${intent.prompt}\n\nPrevious actions in this branch:\n${JSON.stringify(history.replay())}`,
          parentSession: history.agentParent(), arguments: {[workspaceArgument]: checkout.workspace}}, this.actionCancellation.signal);
        result = {schema_version: 'perfchecker-narrative/1', status: 'complete', authority: 'unverified_narrative',
          reference_status: 'unstructured_not_verified', cards: [], external_review: response.text};
      } else {
        const advice = this.evidenceId ? await this.selectedEvidence(folder, this.evidenceId) : undefined;
        const prepared = prepareChatMessages(this.messages, 'Implement the recommendations in the latest assistant reply. Inspect the code and verify the changes.');
        result = await this.invoke(folder, config, {messages: prepared.messages, ...(advice ? {advice} : {}),
          workspace: checkout.workspace, workspace_argument: workspaceArgument}, 'implement');
      }
      if (this.cancelled) throw new Error('Implementation cancelled; checkpoint retained. The remote agent may still be running.');
      this.folder();
      const summary = chatReply(result, Number(config.timeout ?? 90));
      this.proposal = await checkout.collect();
      if (intent) intent.candidateRef = this.proposal.candidateRef;
      this.implementationSummary = summary;
      await this.persistProposal();
      if (intent) {
        const key = intent.context ? analysisContextKey(intent.context) : undefined;
        this.workflow().append(intent.kind === 'create-checks' ? 'create-checks' : 'implementation',
          intent.kind === 'create-checks' ? 'Checks prepared' : 'Suggestion prepared', {
            suggestionId: intent.suggestionId, request: intent.prompt, summary, files: this.proposal.files, historyMode: actionResponse?.historyMode,
            backupRef: this.proposal.backupRef, candidateRef: this.proposal.candidateRef,
          }, key, actionResponse?.agentSession);
        await this.persistWorkflow();
      }
      this.status = this.proposal.files.length ? 'Review the proposed diff, then apply it. Rerun correctness and performance checks after applying.' : 'The agent returned no code changes. Its summary is unverified.';
      return this.proposal;
    } catch (error) {
      primaryFailure = error;
      if (checkout && local) {
        this.retainedImplementation = {key: folder.uri.toString(), checkout};
        this.incompleteLocalCleanup.add(folder.uri.toString());
        try {await disconnectLocalAdvisorConnection(folder.uri.toString()); this.incompleteLocalCleanup.delete(folder.uri.toString());}
        catch (cleanupError) {
          primaryFailure = new AggregateError([error, cleanupError],
            String(error) + ' Local agent cleanup is incomplete. Retry Disconnect; isolated copy retained at ' + checkout.workspace + '. Git checkpoint retained: ' + checkout.backupRef);
        }
      }
      this.status = String(primaryFailure); throw primaryFailure;
    } finally {
      try {
        if (checkout && this.retainedImplementation?.checkout === checkout) {
          if (!localAdvisorConnection(this.retainedImplementation.key)) await this.releaseRetainedImplementation();
        } else await checkout?.dispose();
      } catch (cleanupError) {
        const failure = new AggregateError(primaryFailure ? [primaryFailure, cleanupError] : [cleanupError],
          String(primaryFailure ?? 'Implementation completed.') + ' Isolated copy cleanup failed; checkpoint retained.');
        this.status = String(failure); throw failure;
      } finally {this.busy = false; this.child = undefined; this.actionCancellation = undefined; this.publish();}
    }
  }
  async apply(restore = false) {
    this.folder();
    if (!vscode.workspace.isTrusted) throw new Error('Trust the workspace before applying changes.');
    if (this.busy) throw new Error('An advisor request is already running.');
    this.busy = true; this.publish();
    try {
      await this.recoverProposal();
      if (!this.proposal) throw new Error('Prepare and review an implementation first.');
      if (!restore && this.activeIntent && this.activeIntent.candidateRef !== this.proposal.candidateRef)
        throw new Error('This diff belongs to another choice. Prepare the selected suggestion again or discard the previous proposal.');
      if (vscode.workspace.textDocuments.some(document => document.isDirty && document.uri.scheme === 'file' &&
        this.containsFile(this.proposal!.repository, document.uri.fsPath))) throw new Error('Save or discard editor changes before applying or restoring.');
      await applyImplementation(this.proposal, restore);
      await this.persistProposal();
      this.status = restore ? 'Previous code restored. Git staging is preserved.' : 'Reviewed changes applied. Run correctness tests and compare performance before accepting the result.';
      return this.state();
    } catch (error) {this.status = String(error); throw error;}
    finally {this.busy = false; this.publish();}
  }
  private containsFile(root: string, file: string) {
    const relative = path.relative(root, file);
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  }
  private recoveryKey() {return `perfchecker.implementation.${this.folder().uri.toString()}`;}
  private async persistProposal() {
    const proposal = this.proposal;
    await saveActiveImplementationProposal(this.folder().uri.fsPath, proposal);
    await this.context.workspaceState.update(this.recoveryKey(), {backupRef: this.backupRef,
      ...(proposal ? {proposal: {backupRef: proposal.backupRef, candidateRef: proposal.candidateRef, applied: proposal.applied}} : {})});
  }
  private async recoverProposal() {
    const folder = this.folder(), key = folder.uri.toString();
    if (this.recoveredWorkspace === key) return;
    this.recoveredWorkspace = key;
    const saved = this.context.workspaceState.get<{backupRef?: string; proposal?: {backupRef: string; candidateRef: string; applied: boolean}}>(this.recoveryKey());
    this.backupRef = saved?.backupRef ?? '';
    try {
      this.proposal = saved?.proposal ? await recoverImplementationProposal(folder.uri.fsPath, saved.proposal.backupRef, saved.proposal.candidateRef, saved.proposal.applied) : await recoverActiveImplementationProposal(folder.uri.fsPath);
      if (this.proposal) {this.backupRef = this.proposal.backupRef; this.status = 'Previous implementation recovered from Git. Review the diff or restore previous code.';}
    } catch (error) {this.status = `Git recovery needs attention: ${String(error)}. Checkpoint references are retained.`;}
  }
  private async invoke(folder: vscode.WorkspaceFolder, config: Record<string, unknown>, request: unknown, command = 'chat', bundle?: string): Promise<unknown> {
    const settings = vscode.workspace.getConfiguration('perfchecker', folder.uri);
    const project = resolveControllerProject(folder.uri.fsPath, settings).project;
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'perfchecker-chat-'));
    try {
      const source = bundle ?? path.join(directory, 'request.json'), configuration = path.join(directory, 'advisor.json');
      if (!bundle) await fs.writeFile(source, JSON.stringify(request), {flag: 'wx', mode: 0o600});
      if (command !== 'advise') await fs.writeFile(configuration, JSON.stringify(config), {flag: 'wx', mode: 0o600});
      if (this.cancelled) throw new Error('Request cancelled.');
      return await new Promise((resolve, reject) => {
        const child = spawn(settings.get('juliaExecutable', 'julia'), ['--startup-file=no', `--project=${project}`,
          '-e', cancellableJulia('using PerfChecker; exit(perfchecker_main(ARGS))'), '--', command, `--source=${source}`,
          ...(command === 'advise' ? [] : [`--advisor-config=${configuration}`]), `--project=${project}`],
        {cwd: folder.uri.fsPath, windowsHide: true, detached: process.platform !== 'win32',
          env: {...process.env, JULIA_LOAD_PATH: process.env.PERFCHECKER_LOAD_PATH || `@${path.delimiter}@stdlib`}});
        this.child = child;
        const cancellation = controllerCancellation(child, message => {this.status = message; this.publish();});
        this.cancellation = cancellation;
        const output: Buffer[] = [], errorDecoder = new StringDecoder('utf8');
        let error = '', size = 0, exceeded = false, timedOut = false;
        const duration = Number(config.timeout ?? 90);
        const timeout = setTimeout(() => {timedOut = true; this.cancel();},
          (Math.min(Number.isFinite(duration) && duration > 0 ? duration : 90, 3600) + 60) * 1000);
        child.stdout?.on('data', data => {
          size += data.length;
          if (size > 2_000_000) {exceeded = true; this.cancel();} else output.push(Buffer.from(data));
        });
        child.stderr?.on('data', data => {error = (error + errorDecoder.write(data)).slice(-4000);});
        const release = () => {
          clearTimeout(timeout); cancellation.dispose();
          if (this.child === child) {this.child = undefined; this.cancellation = undefined;}
        };
        child.on('error', value => {release(); reject(value);});
        child.on('close', code => {
          release();
          error = (error + errorDecoder.end()).slice(-4000);
          if (cancellation.forced) return reject(new Error(`${exceeded?'Advisor output exceeded 2 MB. ':''}Forced stop: advisor controller cleanup did not finish. Allocation traces or private inventories may remain; inspect the PerfChecker output.`));
          if (exceeded) return reject(new Error('Advisor output exceeded 2 MB.'));
          if (timedOut) return reject(new Error(`Advisor request timed out.${code && code !== 130 && error ? ` ${error}` : ''}`));
          if (this.cancelled) return reject(new Error(code && code !== 130 && error ? error :
            'Request cancelled after local worker cleanup. The remote server may still finish its work.'));
          try {resolve(JSON.parse(Buffer.concat(output).toString('utf8')));} catch {reject(new Error(code ? error || 'Julia chat worker failed. Update the PerfChecker controller if chat is unavailable.' : 'Invalid advisor response.'));}
        });
      });
    } finally {await fs.rm(directory, {recursive: true, force: true});}
  }
  cancel(closeConnection = false) {
    if (!this.busy && !closeConnection) return;
    if (this.busy) {
      this.cancelled = true; this.status = 'Cancelling advisor request…';
      this.actionCancellation?.abort();
      this.cancellation?.request();
    }
    const workspace = this.workspace;
    if (workspace && localAdvisorConnection(workspace)?.kind === 'stdio')
      void vscode.commands.executeCommand('perfchecker.cancelMcpStdio', workspace)
        .then(undefined, error => {void vscode.window.showErrorMessage(`PerfChecker: ${error}`);});
    this.publish();
  }
  dispose() {this.disposed = true; this.cancel(true); this.panel?.dispose();}
}

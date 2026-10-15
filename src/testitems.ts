import * as vscode from 'vscode';
import {spawn} from 'node:child_process';
import {promises as fs} from 'node:fs';
import * as path from 'node:path';
import {randomUUID} from 'node:crypto';
import {selectedTestItems, nativeItemDuration} from './investigationModel';
import {resolveControllerProject, resolveWorkspaceFolder} from './workspace-root';
import {cancellableJulia, controllerCancellation} from './controllerCancellation';

interface NativeItem {id: string; name: string; file: string; tags: string[]; source_sha256: string}
interface NativeInvocation {
  readonly folder: string; readonly root: string; readonly project: string; readonly reason: string;
  readonly executable: string; readonly tags: readonly string[]; readonly excludeTags: readonly string[];
}
const discoveryShutdowns = new Set<() => void>();

/** Stop queued discoveries before deactivation snapshots the active controller processes. */
export function shutdownNativeTestItems(): void {
  for (const stop of [...discoveryShutdowns]) stop();
}

/** Native TestItemRunner declarations, with one controller per workspace folder. */
export function registerNativeTestItems(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('PerfChecker test items');
  context.subscriptions.push(output);
  const controls = new Map<string, {refresh: () => Promise<void>; run: (request: vscode.TestRunRequest, token: vscode.CancellationToken) => Promise<void>; stop: () => void}>();
  let stopped = false;
  const stoppedError = () => new Error('Native test item discovery has stopped.');
  const stop = () => {
    if (stopped) return;
    stopped = true;
    for (const control of controls.values()) control.stop();
    discoveryShutdowns.delete(stop);
  };
  discoveryShutdowns.add(stop);
  context.subscriptions.push({dispose:stop});
  const ensureController = (folder: vscode.WorkspaceFolder) => {
    if (stopped) throw stoppedError();
    const existing = controls.get(folder.uri.toString());
    if (existing) return existing;
    const tests = vscode.tests.createTestController(`perfchecker.testitems.${folder.uri.toString()}`, `PerfChecker — measures · ${folder.name}`);
    context.subscriptions.push(tests);
    let declarations: NativeItem[] = [];
    let busy = false;
    type Discovery = {invocation: NativeInvocation; generation: number; promise: Promise<void>;
      resolve: () => void; reject: (error: unknown) => void};
    type DiscoveryQueue = {running: Discovery; queued?: Discovery};
    const discoveries = new Map<string, DiscoveryQueue>();
    let latestDiscovery = 0;
    const setting = <T>(key: string, fallback: T) => vscode.workspace.getConfiguration('perfchecker', folder.uri).get<T>(key, fallback);
    const assertWorkspace = () => {
      if (stopped) throw stoppedError();
      if (!vscode.workspace.isTrusted || !vscode.workspace.workspaceFolders?.some(f => f.uri.toString() === folder.uri.toString()))
        throw new Error('Open the original trusted workspace before executing test items.');
    };
    const captureInvocation = (): NativeInvocation => {
      assertWorkspace();
      const configuration = vscode.workspace.getConfiguration('perfchecker', folder.uri);
      const controller = resolveControllerProject(folder.uri.fsPath, configuration);
      return Object.freeze({folder:folder.uri.toString(),root:folder.uri.fsPath,...controller,
        executable:configuration.get('juliaExecutable','julia'),
        tags:Object.freeze([...configuration.get<string[]>('testItemTags',[])]),
        excludeTags:Object.freeze([...configuration.get<string[]>('testItemExcludeTags',[])])});
    };
    const invocationKey = (invocation: NativeInvocation) => JSON.stringify([
      invocation.folder,invocation.root,invocation.project,invocation.executable,invocation.tags,invocation.excludeTags]);
    const invoke = async (args: string[], token?: vscode.CancellationToken,
        invocation: NativeInvocation = captureInvocation(),
        lifecycle?: {closed?: Promise<void>; physicallyClosed?: boolean; beforeSpawn?: () => void}): Promise<{code: number; payload: any}> => {
      output.appendLine(`Controller project: ${invocation.project} (${invocation.reason})`);
      const directory = path.join(context.globalStorageUri.fsPath, 'native-testitems', randomUUID());
      await fs.mkdir(directory, {recursive:true});
      const destination = path.join(directory, 'result.json');
      const project = invocation.project;
      const env: NodeJS.ProcessEnv = {...process.env, JULIA_LOAD_PATH:['@','@stdlib'].join(path.delimiter)};
      delete env.JULIA_PROJECT;
      const code = await new Promise<number>((resolve,reject) => {
        if (token?.isCancellationRequested) {resolve(130); return;}
        assertWorkspace();
        lifecycle?.beforeSpawn?.();
        const child = spawn(invocation.executable, ['--startup-file=no',`--project=${project}`,
          '-e',cancellableJulia('using PerfChecker, TestItemRunner; exit(perfchecker_main(ARGS))'),'--','testitems',
          `--root=${invocation.root}`,`--project=${project}`,`--output=${destination}`, ...args],
          {cwd:invocation.root,windowsHide:true,detached:process.platform!=='win32',env});
        if (lifecycle) lifecycle.closed = new Promise<void>(resolve => child.once('close', () => {lifecycle.physicallyClosed = true; resolve();}));
        const stop = controllerCancellation(child, (message, forced) => {
          output.appendLine(message); if (forced) void vscode.window.showWarningMessage(message);
        });
        const subscription = token?.onCancellationRequested(() => stop.request());
        child.stdout.on('data',chunk=>output.append(String(chunk)));
        child.stderr.on('data',chunk=>output.append(String(chunk)));
        child.on('error',error=>{subscription?.dispose();stop.dispose();reject(error);});
        child.on('close',value=>{subscription?.dispose();stop.dispose();resolve(value??2);});
        if (token?.isCancellationRequested) stop.request();
      });
      if (token?.isCancellationRequested && code !== 0 && code !== 130)
        throw new Error('Cancellation failed during controller cleanup. Inspect PerfChecker output.');
      if (token?.isCancellationRequested) return {code:130,payload:undefined};
      const stat = await fs.stat(destination).catch(()=>undefined);
      if (!stat) throw new Error(`TestItemRunner did not return evidence (exit ${code}). Ensure PerfChecker and TestItemRunner >= 1.3.2 are in ${project}. See the output channel.`);
      if (stat.size > 32_000_000) throw new Error('Test item report exceeds 32 MB.');
      const payload = JSON.parse(await fs.readFile(destination,'utf8'));
      output.appendLine(`Evidence: ${destination}`);
      return {code,payload};
    };
    const selectionArgs = (invocation: NativeInvocation) => [`--tags=${invocation.tags.join(',')}`,
      `--exclude-tags=${invocation.excludeTags.join(',')}`];
    const createDiscovery = (invocation: NativeInvocation, generation: number): Discovery => {
      let resolve!: () => void, reject!: (error: unknown) => void;
      const promise = new Promise<void>((completed, failed) => {resolve = completed; reject = failed;});
      return {invocation,generation,promise,resolve,reject};
    };
    const startDiscovery = (key: string, queue: DiscoveryQueue, discovery: Discovery, deferred = false): void => {
      const invocation = discovery.invocation;
      const lifecycle: {closed?: Promise<void>; physicallyClosed?: boolean; beforeSpawn?: () => void} = {};
      if (deferred) lifecycle.beforeSpawn = () => {
        if (invocationKey(captureInvocation()) !== key)
          throw new Error('The test item discovery settings changed before the queued refresh started. Refresh again.');
      };
      const pending = (async () => {
        const {code,payload} = await invoke(['--list',...selectionArgs(invocation)],undefined,invocation,lifecycle);
        if (code || payload.schema_version !== 'perfchecker-testitems/1' || !Array.isArray(payload.items)) throw new Error('Unsupported test item listing.');
        if (latestDiscovery !== discovery.generation) return;
        try {if (invocationKey(captureInvocation()) !== key) return;} catch {return;}
        declarations = payload.items;
        tests.items.replace(declarations.map(item=>{
          const test = tests.createTestItem(item.id,item.name,vscode.Uri.file(path.resolve(invocation.root,item.file)));
          test.description = `${item.file} · ${item.tags.join(', ') || 'shared'}`;
          test.tags = item.tags.map(tag=>new vscode.TestTag(tag));
          return test;
        }));
      })();
      const release = () => {
        if (discoveries.get(key) !== queue || queue.running !== discovery) return;
        const next = queue.queued;
        if (next) {queue.queued = undefined; queue.running = next; startDiscovery(key,queue,next,true);}
        else discoveries.delete(key);
      };
      void pending.then(() => {release(); discovery.resolve();}, error => {
        // A spawn error can reject invoke before physical close. Preserve that
        // error immediately, but keep the signature occupied until close.
        if (!lifecycle.closed || lifecycle.physicallyClosed) release();
        else void lifecycle.closed.then(release);
        discovery.reject(error);
      });
    };
    const refresh = (force = false): Promise<void> => {
      const generation = ++latestDiscovery;
      let invocation: NativeInvocation;
      try {invocation = captureInvocation();} catch (error) {return Promise.reject(error);}
      const key = invocationKey(invocation),existing = discoveries.get(key);
      if (existing) {
        const joined = existing.queued ?? (force ? undefined : existing.running);
        if (joined) {joined.generation = generation; return joined.promise;}
        const queued = createDiscovery(invocation,generation);
        existing.queued = queued;
        return queued.promise;
      }
      const running = createDiscovery(invocation,generation),queue = {running};
      discoveries.set(key,queue); startDiscovery(key,queue,running);
      return running.promise;
    };
    const run = async (request: vscode.TestRunRequest, token: vscode.CancellationToken) => {
      if (busy) throw new Error('A native test item run is already active in this folder.');
      busy = true;
      const execution = tests.createTestRun(request);
      const appendDiagnostic = (message: string, item?: vscode.TestItem) => {
        execution.appendOutput(`${message.replace(/\r?\n/g, '\r\n')}\r\n`, undefined, item);
        output.appendLine(message);
      };
      let selected: vscode.TestItem[] = [];
      try {
        if (token.isCancellationRequested) return;
        if (!declarations.length) await refresh();
        const all: vscode.TestItem[] = []; tests.items.forEach(item=>all.push(item));
        selected = selectedTestItems(all,request.include,request.exclude);
        if (!selected.length) return;
        if (selected.some(item=>!declarations.some(d=>d.id===item.id))) throw new Error('Selection is stale; refresh the test items.');
        if (vscode.workspace.textDocuments.some(doc=>doc.isDirty && vscode.workspace.getWorkspaceFolder(doc.uri)?.uri.toString()===folder.uri.toString()))
          throw new Error('Save workspace changes before measuring the test items.');
        selected.forEach(item=>execution.enqueued(item));
        for (const item of selected) {
          if (token.isCancellationRequested) {execution.skipped(item);continue;}
          execution.started(item);
          const samples = setting('testItemSamples',1);
          const invocation = captureInvocation();
          const {code,payload} = await invoke([`--item-id=${item.id}`,...selectionArgs(invocation),
            `--samples=${samples}`,`--timeout=${setting('analysisTimeout',120)}`],token,invocation);
          if (token.isCancellationRequested) {execution.skipped(item);continue;}
          const rows = payload?.schema_version==='perfchecker-testitem-run/1' ? payload.runs?.filter((r:any)=>r.item?.id===item.id) : undefined;
          const details=rows?.[0]?.samples?.map((sample:any)=>sample.message).filter((message:any)=>typeof message==='string').join('\n')??'';
          const project=resolveControllerProject(folder.uri.fsPath,vscode.workspace.getConfiguration('perfchecker',folder.uri)).project;
          const message=`Item failed, skipped, timed out or had no passing assertions (exit ${code}). ${details}\nTestItemRunner executes in ${project}. Ensure the package under test and its test dependencies are available in that controller environment, then discover and run again. Controller setup installs PerfChecker and collectors only; it does not install your package. See https://perfchecker.mirageinteractive.fr/interfaces/vscode.html and the PerfChecker test items output.`;
          if (code !== 0) {execution.errored(item,new vscode.TestMessage(message));appendDiagnostic(message,item);}
          else if (rows?.length !== 1) {
            const evidenceMessage=`Missing or ambiguous current item evidence (exit ${code}). Inspect the output channel.`;
            execution.errored(item,new vscode.TestMessage(evidenceMessage));appendDiagnostic(evidenceMessage,item);
          }
          else if (rows[0].status==='validated' && payload.passed === true) {
            const duration = nativeItemDuration(rows[0].samples, samples);
            execution.passed(item, duration);
            execution.appendOutput(`${item.label}: ${duration.toFixed(2)} ms measured across ${samples} sample(s), including setup and assertions. Correctness validated; performance has not been compared to a budget.\r\n`,undefined,item);
          } else {
            execution.failed(item,new vscode.TestMessage(message));appendDiagnostic(message,item);
          }
        }
      } catch (error) {
        selected.forEach(item=>{execution.errored(item,new vscode.TestMessage(String(error)));appendDiagnostic(String(error),item);});
        if (!selected.length) appendDiagnostic(String(error));
        output.show(true);
      } finally {execution.end();busy=false;}
    };
    tests.resolveHandler = () => refresh();
    tests.refreshHandler = () => refresh(true);
    tests.createRunProfile('PerfChecker — measures',vscode.TestRunProfileKind.Run,run,true);
    const control = {refresh: () => refresh(true),run,stop: () => {
      ++latestDiscovery;
      for (const queue of discoveries.values()) {
        queue.queued?.reject(stoppedError());
        queue.queued = undefined;
      }
    }};
    controls.set(folder.uri.toString(),control);
    return control;
  };
  context.subscriptions.push(vscode.commands.registerCommand('perfchecker.discoverTestItems',async(requested?: vscode.Uri | vscode.WorkspaceFolder)=>{
    const folders = vscode.workspace.workspaceFolders ?? [];
    const folder = requested === undefined ?
      (folders.length===1 ? folders[0] : await vscode.window.showWorkspaceFolderPick()) :
      resolveWorkspaceFolder<vscode.WorkspaceFolder>(folders, requested);
    if (folder) await ensureController(folder).refresh();
  }));
}

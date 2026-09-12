import * as vscode from 'vscode';
import {spawn} from 'node:child_process';
import {promises as fs} from 'node:fs';
import * as path from 'node:path';
import {randomUUID} from 'node:crypto';
import {selectedTestItems, nativeItemDuration} from './investigationModel';

interface NativeItem {id: string; name: string; file: string; tags: string[]; source_sha256: string}

/** Native TestItemRunner declarations, with one controller per workspace folder. */
export function registerNativeTestItems(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('PerfChecker test items');
  context.subscriptions.push(output);
  const controls = new Map<string, {refresh: () => Promise<void>; run: (request: vscode.TestRunRequest, token: vscode.CancellationToken) => Promise<void>}>();
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const tests = vscode.tests.createTestController(`perfchecker.testitems.${folder.uri.toString()}`, `PerfChecker items · ${folder.name}`);
    context.subscriptions.push(tests);
    let declarations: NativeItem[] = [];
    let busy = false;
    const setting = <T>(key: string, fallback: T) => vscode.workspace.getConfiguration('perfchecker', folder.uri).get<T>(key, fallback);
    const assertWorkspace = () => {
      if (!vscode.workspace.isTrusted || !vscode.workspace.workspaceFolders?.some(f => f.uri.toString() === folder.uri.toString()))
        throw new Error('Open the original trusted workspace before executing test items.');
    };
    const invoke = async (args: string[], token?: vscode.CancellationToken): Promise<{code: number; payload: any}> => {
      assertWorkspace();
      const directory = path.join(context.globalStorageUri.fsPath, 'native-testitems', randomUUID());
      await fs.mkdir(directory, {recursive:true});
      const destination = path.join(directory, 'result.json');
      const project = path.resolve(folder.uri.fsPath, setting('runnerProject', 'perf'));
      const env: NodeJS.ProcessEnv = {...process.env, JULIA_LOAD_PATH:['@','@stdlib'].join(path.delimiter)};
      delete env.JULIA_PROJECT;
      const code = await new Promise<number>((resolve,reject) => {
        if (token?.isCancellationRequested) {resolve(130); return;}
        const child = spawn(setting('juliaExecutable','julia'), ['--startup-file=no',`--project=${project}`,
          '-e','using PerfChecker, TestItemRunner; exit(perfchecker_main(ARGS))','--','testitems',
          `--root=${folder.uri.fsPath}`,`--project=${project}`,`--output=${destination}`, ...args],
          {cwd:folder.uri.fsPath,windowsHide:true,detached:process.platform!=='win32',env});
        const cancel = () => {
          if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
          if (process.platform === 'win32') spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true}).on('error',()=>child.kill());
          else {try {process.kill(-child.pid,'SIGKILL');} catch {child.kill('SIGKILL');}}
        };
        const subscription = token?.onCancellationRequested(cancel);
        child.stdout.on('data',chunk=>output.append(String(chunk)));
        child.stderr.on('data',chunk=>output.append(String(chunk)));
        child.on('error',error=>{subscription?.dispose();reject(error);});
        child.on('close',value=>{subscription?.dispose();resolve(value??2);});
        if (token?.isCancellationRequested) cancel();
      });
      if (token?.isCancellationRequested) return {code:130,payload:undefined};
      const stat = await fs.stat(destination).catch(()=>undefined);
      if (!stat) throw new Error(`TestItemRunner did not return evidence (exit ${code}). Ensure PerfChecker and TestItemRunner >= 1.3.2 are in ${project}. See the output channel.`);
      if (stat.size > 32_000_000) throw new Error('Test item report exceeds 32 MB.');
      const payload = JSON.parse(await fs.readFile(destination,'utf8'));
      output.appendLine(`Evidence: ${destination}`);
      return {code,payload};
    };
    const selectionArgs = () => [`--tags=${setting<string[]>('testItemTags',[]).join(',')}`,
      `--exclude-tags=${setting<string[]>('testItemExcludeTags',[]).join(',')}`];
    const refresh = async () => {
      const {code,payload} = await invoke(['--list',...selectionArgs()]);
      if (code || payload.schema_version !== 'perfchecker-testitems/1' || !Array.isArray(payload.items)) throw new Error('Unsupported test item listing.');
      declarations = payload.items;
      tests.items.replace(declarations.map(item=>{
        const test = tests.createTestItem(item.id,item.name,vscode.Uri.file(path.resolve(folder.uri.fsPath,item.file)));
        test.description = `${item.file} · ${item.tags.join(', ') || 'shared'}`;
        test.tags = item.tags.map(tag=>new vscode.TestTag(tag));
        return test;
      }));
    };
    const run = async (request: vscode.TestRunRequest, token: vscode.CancellationToken) => {
      if (busy) throw new Error('A native test item run is already active in this folder.');
      busy = true;
      const execution = tests.createTestRun(request);
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
          const {code,payload} = await invoke([`--item-id=${item.id}`,...selectionArgs(),
            `--samples=${samples}`,`--timeout=${setting('analysisTimeout',120)}`],token);
          if (token.isCancellationRequested) {execution.skipped(item);continue;}
          const rows = payload?.schema_version==='perfchecker-testitem-run/1' ? payload.runs?.filter((r:any)=>r.item?.id===item.id) : undefined;
          if (code !== 0) execution.errored(item,new vscode.TestMessage(`Test item process exited with code ${code}. Inspect the output channel.`));
          else if (rows?.length !== 1) execution.errored(item,new vscode.TestMessage('Missing or ambiguous current item evidence.'));
          else if (rows[0].status==='validated' && payload.passed === true) {
            const duration = nativeItemDuration(rows[0].samples, samples);
            execution.passed(item, duration);
            execution.appendOutput(`${item.label}: ${duration.toFixed(2)} ms measured across ${samples} sample(s), including setup and assertions. Correctness validated; performance has not been compared to a budget.\r\n`,undefined,item);
          } else execution.failed(item,new vscode.TestMessage('Item failed, skipped, timed out or had no passing assertions. Inspect PerfChecker test items output.'));
        }
      } catch (error) {
        selected.forEach(item=>execution.errored(item,new vscode.TestMessage(String(error))));
        output.appendLine(String(error)); output.show(true);
      } finally {execution.end();busy=false;}
    };
    tests.resolveHandler = () => refresh();
    tests.refreshHandler = () => refresh();
    tests.createRunProfile('Measure existing test items',vscode.TestRunProfileKind.Run,run,true);
    controls.set(folder.uri.toString(),{refresh,run});
  }
  context.subscriptions.push(vscode.commands.registerCommand('perfchecker.discoverTestItems',async()=>{
    const folders = vscode.workspace.workspaceFolders ?? [];
    const folder = folders.length===1 ? folders[0] : await vscode.window.showWorkspaceFolderPick();
    if (folder) await controls.get(folder.uri.toString())?.refresh();
  }));
}

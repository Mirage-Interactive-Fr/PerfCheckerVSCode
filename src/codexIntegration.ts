import * as vscode from 'vscode';
import {CodexConnector, inspectCodex} from './codexConnector';
import {localAdvisorConnection, setLocalAdvisorConnection, disconnectLocalAdvisorConnection, beginLocalAdvisorConnectionOperation} from './advisorConnection';
import {currentWorkspaceFolder} from './workspace-root';

const shutdowns = new Set<() => Promise<void>>();
const closing = new Set<Promise<void>>();
export async function shutdownCodexConnections() {await Promise.allSettled([...shutdowns].map(stop => stop())); await Promise.allSettled([...closing]);}

export function registerCodexConnections(context: vscode.ExtensionContext, busy: () => boolean, changed: () => void) {
  const connectors = new Map<string, CodexConnector>();
  let connecting = false;
  let disposed = false, preflight: AbortController | undefined;
  const folder = () => currentWorkspaceFolder<vscode.WorkspaceFolder>(vscode.workspace.workspaceFolders);
  const workspaceUnchanged = (key: string, signal: AbortSignal) => {
    try {return !disposed && !signal.aborted && vscode.workspace.isTrusted && folder().uri.toString() === key;}
    catch {return false;}
  };
  const disconnect = async (key: string) => {
    const connector = connectors.get(key);
    await connector?.dispose();
    if (connectors.get(key) === connector) connectors.delete(key);
    if (localAdvisorConnection(key)?.kind === 'codex') setLocalAdvisorConnection(key);
    try {changed();} catch {/* a workspace may have been closed */}
  };
  const stop = async () => {disposed = true; preflight?.abort(); await Promise.all([...connectors.keys()].map(disconnect));};
  shutdowns.add(stop);
  const connect = async () => {
    if (!vscode.workspace.isTrusted) throw new Error('Trust the workspace before connecting Codex.');
    if (disposed) throw new Error('PerfChecker is shutting down. Reopen the workspace to reconnect.');
    if (busy() || connecting) throw new Error('Finish or cancel the current advisor request before reconnecting.');
    const selected = folder(), key = selected.uri.toString();
    const release = beginLocalAdvisorConnectionOperation(key);
    connecting = true;
    preflight = new AbortController();
    try {
      const signal = preflight.signal;
      const settings = vscode.workspace.getConfiguration('perfchecker', selected.uri);
      const cli = settings.get<string>('codexExecutable', 'codex').trim();
      if (!cli) throw new Error('Set PerfChecker: Codex Executable to your authenticated CLI, then reconnect.');
      const version = await inspectCodex(cli, selected.uri.fsPath, signal);
      if (!workspaceUnchanged(key, signal)) throw new Error('Workspace changed. Connect Codex again.');
      await disconnectLocalAdvisorConnection(key);
      const timeout = Math.min(Math.max(Number(settings.get('advisorTimeout', 90)) || 90, 1), 3600);
      const connector = await new CodexConnector({cli, root: selected.uri.fsPath, timeoutMs: timeout * 1000}).start();
      if (!workspaceUnchanged(key, signal)) {await connector.dispose(); throw new Error('Workspace changed before Codex connected. Reopen or select it, then connect again.');}
      connectors.set(key, connector);
      setLocalAdvisorConnection(key, {kind: 'codex', label: `${version} · local connector`,
        config: {protocol: 'mcp_http', endpoint: connector.endpoint, model: 'Codex CLI', timeout,
          mcp_tool: 'ask_perfchecker', mcp_prompt_argument: 'prompt', mcp_arguments: {}, mcp_response: 'text',
          mcp_version: '2026-07-28', api_key_env: connector.keyEnvironment, allow_remote: false},
        implementation: {tool: 'implement_perfchecker', promptArgument: 'prompt', workspaceArgument: 'workspace'}}, () => disconnect(key));
      changed();
      void vscode.window.showInformationMessage(`PerfChecker connected to ${version}. Saved provider settings are preserved. Open Chat to request advice.`);
      return {connected: true, label: version};
    } finally {connecting = false; preflight = undefined; release();}
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('perfchecker.connectCodex', async () => {
      try {return await connect();} catch (error) {void vscode.window.showErrorMessage(`PerfChecker: ${error}`); throw error;}
    }),
    vscode.commands.registerCommand('perfchecker.disconnectCodex', async () => {
      if (connecting || busy()) throw new Error('Finish or cancel the current advisor request before disconnecting.');
      const key = folder().uri.toString();
      if (localAdvisorConnection(key)?.kind === 'stdio') throw new Error('Use Disconnect local MCP server for this connection.');
      const release = beginLocalAdvisorConnectionOperation(key);
      try {await disconnectLocalAdvisorConnection(key); return {connected: false};} finally {release();}
    }),
    vscode.commands.registerCommand('perfchecker.codexConnectionState', () => ({connected: localAdvisorConnection(folder().uri.toString())?.kind === 'codex'})),
    {dispose: () => {const stopped = stop(); closing.add(stopped);
      void stopped.then(() => shutdowns.delete(stop), error => vscode.window.showErrorMessage(`PerfChecker: ${error}`))
        .finally(() => closing.delete(stopped));}});
  if (vscode.workspace.onDidChangeWorkspaceFolders) context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(event => {
    if (connecting && event.removed.length) preflight?.abort();
    for (const removed of event.removed) void disconnect(removed.uri.toString());
  }));
}

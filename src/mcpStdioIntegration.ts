import * as vscode from 'vscode';
import {McpStdioConnector, McpStdioOptions} from './mcpStdioConnector';
import {localAdvisorConnection, setLocalAdvisorConnection, disconnectLocalAdvisorConnection, beginLocalAdvisorConnectionOperation} from './advisorConnection';
import {currentWorkspaceFolder} from './workspace-root';

const shutdowns = new Set<() => Promise<void>>(), closing = new Set<Promise<void>>();
export async function shutdownMcpStdioConnections() {
  await Promise.allSettled([...shutdowns].map(stop => stop()));
  await Promise.allSettled([...closing]);
}
function toolArguments(value: unknown, reserved: string[]) {
  const result = value ?? {};
  if (!result || typeof result !== 'object' || Array.isArray(result) ||
    Buffer.byteLength(JSON.stringify(result), 'utf8') > 12000 || reserved.some(name => Object.hasOwn(result, name)))
    throw new Error('Use a JSON arguments object of at most 12 KB without reserved prompt/workspace arguments.');
  return result as Record<string, unknown>;
}
/** Explicit launches only, driven by the shared connection/schema panel. */
export function registerMcpStdioConnections(context: vscode.ExtensionContext, busy: () => boolean, changed: () => void) {
  const connectors = new Map<string, {connector: McpStdioConnector; signature: string}>();
  const cancellations = new Map<string, number>();
  let connecting = false, operating = false, disposed = false;
  const operate = async <T>(action: () => Promise<T>) => {
    if (operating) throw new Error('Finish or cancel the current MCP discovery or connection first.');
    const release = beginLocalAdvisorConnectionOperation(folder().uri.toString());
    operating = true;
    try {return await action();} finally {operating = false; release();}
  };
  const folder = () => currentWorkspaceFolder<vscode.WorkspaceFolder>(vscode.workspace.workspaceFolders);
  const disconnect = async (key: string) => {
    const entry = connectors.get(key);
    await entry?.connector.dispose();
    connectors.delete(key);
    if (localAdvisorConnection(key)?.kind === 'stdio') setLocalAdvisorConnection(key);
    try {changed();} catch {/* Folder removed. */}
  };
  const stop = async () => {disposed = true; await Promise.all([...connectors.keys()].map(disconnect));};
  const cancel = async (key: string) => {cancellations.set(key, (cancellations.get(key) ?? 0) + 1); await disconnect(key);};
  shutdowns.add(stop);
  const assertCurrent = (key: string) => {
    if (disposed || !vscode.workspace.isTrusted || folder().uri.toString() !== key) throw new Error('Workspace or trust changed while discovering MCP tools.');
  };
  const prepare = async (input: any) => {
    if (!vscode.workspace.isTrusted || disposed || connecting || busy()) throw new Error('Trust the workspace and finish the current operation before connecting MCP.');
    const selected = folder(), key = selected.uri.toString();
    const generation = cancellations.get(key) ?? 0;
    const options: McpStdioOptions = {command: input.stdio_command, args: input.stdio_args, cwd: input.stdio_cwd,
      version: input.mcp_version, timeoutMs: Math.min(Math.max(Number(input.timeout) || 90, 1), 3600) * 1000};
    const signature = JSON.stringify(options);
    const existing = connectors.get(key);
    if (existing?.signature === signature) return {key, selected, connector: existing.connector};
    connecting = true;
    try {
      await disconnectLocalAdvisorConnection(key);
      await disconnect(key); // Also retire a prior discovery-only connection.
      assertCurrent(key);
      if ((cancellations.get(key) ?? 0) !== generation) throw new Error('Local MCP connection cancelled before launch.');
      let connector: McpStdioConnector;
      connector = new McpStdioConnector({...options, onClosed: () => {
        if (connectors.get(key)?.connector !== connector) return;
        connectors.delete(key);
        if (localAdvisorConnection(key)?.kind === 'stdio') setLocalAdvisorConnection(key);
        try {changed();} catch {/* Folder removed. */}
      }});
      // Retain failed cleanup handles for explicit disconnect/deactivation.
      connectors.set(key, {connector, signature});
      await connector.start();
      if (disposed || !vscode.workspace.isTrusted || folder().uri.toString() !== key) {
        await disconnect(key); throw new Error('Workspace or trust changed while connecting MCP.');
      }
      return {key, selected, connector};
    } finally {connecting = false;}
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('perfchecker.discoverMcpStdio', input => operate(async () => {
      const key = folder().uri.toString();
      try {
        const {connector} = await prepare(input);
        const tools = await connector.discover();
        assertCurrent(key);
        return {status: 'complete', message: `${connector.serverName}: select an advice tool and optionally an implementation tool, then connect. No tool was called.`, tools};
      } catch (error) {await disconnect(key); throw error;}
    })),
    vscode.commands.registerCommand('perfchecker.connectMcpStdio', async input => {
      if (!input) return vscode.commands.executeCommand('perfchecker.configureAdvisor', {stdio: true});
      return operate(async () => {
      const key = folder().uri.toString();
      try {
      const {connector} = await prepare(input);
      const tools = await connector.discover();
      assertCurrent(key);
      const select = (name: unknown, prompt: unknown, workspace?: unknown) => {
        if (typeof name !== 'string' || !tools.some(tool => tool.name === name)) throw new Error('Discover and select an available MCP tool.');
        if (typeof prompt !== 'string' || !/^[A-Za-z_][A-Za-z_0-9.-]{0,127}$/.test(prompt) ||
          (workspace !== undefined && (typeof workspace !== 'string' || !/^[A-Za-z_][A-Za-z_0-9.-]{0,127}$/.test(workspace) || workspace === prompt)))
          throw new Error('Choose distinct valid prompt/workspace argument names from the selected schema.');
      };
      select(input.mcp_tool, input.mcp_prompt_argument);
      const adviceArguments = toolArguments(input.mcp_arguments, [input.mcp_prompt_argument]);
      const implementation = input.implementation ?? {};
      if (implementation.tool) select(implementation.tool, implementation.promptArgument, implementation.workspaceArgument);
      const implementationArguments = toolArguments(implementation.arguments, [implementation.promptArgument ?? 'prompt', implementation.workspaceArgument ?? 'workspace']);
      for (const selection of [{name: input.mcp_tool, args: adviceArguments, reserved: [input.mcp_prompt_argument]},
        ...(implementation.tool ? [{name: implementation.tool, args: implementationArguments, reserved: [implementation.promptArgument, implementation.workspaceArgument]}] : [])]) {
        const required = tools.find(tool => tool.name === selection.name)!.inputSchema.required;
        const supplied = new Set([...Object.keys(selection.args), ...selection.reserved]);
        if (Array.isArray(required) && required.some(name => typeof name !== 'string' || !supplied.has(name))) throw new Error('Supply all required arguments displayed in the tool schema.');
      }
      setLocalAdvisorConnection(key, {kind: 'stdio', label: `${connector.serverName} · local MCP stdio`,
        config: {protocol: 'mcp_http', endpoint: connector.endpoint, model: connector.serverName,
          timeout: Math.min(Math.max(Number(input.timeout) || 90, 1), 3600), instructions: input.instructions ?? '',
          mcp_tool: input.mcp_tool, mcp_prompt_argument: input.mcp_prompt_argument, mcp_arguments: adviceArguments,
          mcp_response: 'text', mcp_version: input.mcp_version, api_key_env: connector.keyEnvironment, allow_remote: false},
        implementation: {tool: implementation.tool ?? '', promptArgument: implementation.promptArgument ?? 'prompt',
          workspaceArgument: implementation.workspaceArgument ?? 'workspace', arguments: implementationArguments},
        connectionConfiguration: {...input, protocol: 'mcp_stdio'}}, () => disconnect(key));
      changed();
      return {status: 'complete', message: 'Local MCP server connected for this editor session. Saved provider configuration is preserved. No advice request was sent.'};
      } catch (error) {await disconnect(key); throw error;}
      });
    }),
    vscode.commands.registerCommand('perfchecker.disconnectMcpStdio', async () => {
      if (connecting || operating || busy()) throw new Error('Finish or cancel the current advisor request before disconnecting.');
      const key = folder().uri.toString();
      const release = beginLocalAdvisorConnectionOperation(key);
      try {
        if (localAdvisorConnection(key)?.kind === 'stdio') await disconnectLocalAdvisorConnection(key);
        else await disconnect(key); // A discovery-only server also has an explicit disconnect.
      } finally {release();}
      return {connected: false};
    }),
    vscode.commands.registerCommand('perfchecker.cancelMcpStdio', key => cancel(key ?? folder().uri.toString())),
    vscode.commands.registerCommand('perfchecker.closeMcpStdioDiscovery', key => localAdvisorConnection(key)?.kind === 'stdio' ? undefined : disconnect(key)),
    {dispose: () => {
      const promise = stop(); closing.add(promise);
      void promise.then(() => shutdowns.delete(stop), error => vscode.window.showErrorMessage(`PerfChecker: ${error}`))
        .finally(() => closing.delete(promise));
    }});
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(event => {
    for (const removed of event.removed) void cancel(removed.uri.toString()).catch(error => vscode.window.showErrorMessage(`PerfChecker: ${error}`));
  }));
}

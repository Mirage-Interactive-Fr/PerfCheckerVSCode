/** Ephemeral local connections never replace persisted provider settings or credentials. */
export interface LocalAdvisorConnection {
  kind?: 'codex' | 'stdio';
  label: string;
  config: Record<string, unknown>;
  connectionConfiguration?: Record<string, unknown>;
  implementation: {tool: string; promptArgument: string; workspaceArgument: string; arguments?: Record<string, unknown>};
}
const connections = new Map<string, LocalAdvisorConnection>();
const disconnectors = new Map<string, () => Promise<void>>();
const listeners = new Set<(workspace: string) => void>();
const operations = new Set<string>();
/** Serialize explicit local connectors across transports for one workspace. */
export function beginLocalAdvisorConnectionOperation(workspace: string) {
  if (operations.has(workspace)) throw new Error('Finish or cancel the current local connector operation first.');
  operations.add(workspace);
  return () => operations.delete(workspace);
}
/** An unset implementation override preserves the existing provider arguments. */
export function implementationMcpArguments(previous: unknown, override: unknown, prompt: string, workspace: string) {
  const value = override === undefined ? (previous ?? {}) : override;
  const invalid = 'Implementation arguments must be a JSON object of at most 12 KB without the prompt or workspace argument.';
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.hasOwn(value, prompt) || Object.hasOwn(value, workspace)) throw new Error(invalid);
  let snapshot: unknown;
  try {
    // VS Code configuration values are clone-on-write proxies with a JSON view.
    // Snapshot that view once for both the byte limit and the worker payload.
    const serialized = JSON.stringify(value);
    if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > 12000) throw new Error(invalid);
    snapshot = JSON.parse(serialized);
  } catch { throw new Error(invalid); }
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) ||
    Object.hasOwn(snapshot, prompt) || Object.hasOwn(snapshot, workspace)) throw new Error(invalid);
  return snapshot as Record<string, unknown>;
}
export function onLocalAdvisorConnectionChanged(listener: (workspace: string) => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
/** This namespace belongs to in-memory connectors, including ones already disconnected. */
export function assertSavedAdvisorConfiguration(config: Record<string, unknown> | null | undefined) {
  if (typeof config?.api_key_env === 'string' && /^PERFCHECKER_(CODEX|MCP)_TOKEN_/.test(config.api_key_env))
    throw new Error('A temporary local connector endpoint must not be saved. Reopen connection settings to load your saved provider.');
}
export function localAdvisorConnection(workspace: string): LocalAdvisorConnection | undefined {
  const current = connections.get(workspace);
  return current && {...current, config: structuredClone(current.config), implementation: structuredClone(current.implementation),
    connectionConfiguration: current.connectionConfiguration && structuredClone(current.connectionConfiguration)};
}
export async function disconnectLocalAdvisorConnection(workspace: string) {
  const disconnect = disconnectors.get(workspace);
  await disconnect?.();
  // Retain the retry handle and visible owner if cleanup fails. A connection
  // replaced by another callback must not be cleared by this older completion.
  if (disconnectors.get(workspace) === disconnect) setLocalAdvisorConnection(workspace);
}
export function setLocalAdvisorConnection(workspace: string, connection?: LocalAdvisorConnection, disconnect?: () => Promise<void>) {
  const changed = connection !== undefined || connections.has(workspace);
  if (connection) connections.set(workspace, connection); else connections.delete(workspace);
  if (disconnect) disconnectors.set(workspace, disconnect);
  else if (!connection) disconnectors.delete(workspace);
  if (changed) for (const listener of listeners) listener(workspace);
}

/** Ephemeral local connections never replace persisted provider settings or credentials. */
export interface LocalAdvisorConnection {
  label: string;
  config: Record<string, unknown>;
  implementation: {tool: string; promptArgument: string; workspaceArgument: string};
}
const connections = new Map<string, LocalAdvisorConnection>();
const listeners = new Set<(workspace: string) => void>();
export function onLocalAdvisorConnectionChanged(listener: (workspace: string) => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
/** This namespace belongs to in-memory connectors, including ones already disconnected. */
export function assertSavedAdvisorConfiguration(config: Record<string, unknown> | null | undefined) {
  if (typeof config?.api_key_env === 'string' && config.api_key_env.startsWith('PERFCHECKER_CODEX_TOKEN_'))
    throw new Error('A temporary Codex endpoint must not be saved. Reopen Advisor settings to load your saved provider.');
}
export function localAdvisorConnection(workspace: string): LocalAdvisorConnection | undefined {
  const current = connections.get(workspace);
  return current && {...current, config: {...current.config}, implementation: {...current.implementation}};
}
export function setLocalAdvisorConnection(workspace: string, connection?: LocalAdvisorConnection) {
  const changed = connection !== undefined || connections.has(workspace);
  if (connection) connections.set(workspace, connection); else connections.delete(workspace);
  if (changed) for (const listener of listeners) listener(workspace);
}

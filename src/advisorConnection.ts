/** Ephemeral local connections never replace persisted provider settings or credentials. */
export interface LocalAdvisorConnection {
  label: string;
  config: Record<string, unknown>;
  implementation: {tool: string; promptArgument: string; workspaceArgument: string};
}
const connections = new Map<string, LocalAdvisorConnection>();
export function localAdvisorConnection(workspace: string): LocalAdvisorConnection | undefined {
  const current = connections.get(workspace);
  return current && {...current, config: {...current.config}, implementation: {...current.implementation}};
}
export function setLocalAdvisorConnection(workspace: string, connection?: LocalAdvisorConnection) {
  if (connection) connections.set(workspace, connection); else connections.delete(workspace);
}

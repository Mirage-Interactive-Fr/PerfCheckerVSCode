import {randomUUID} from 'node:crypto';

export type WorkflowAction = 'results' | 'analysis' | 'create-checks' | 'implementation' | 'verification' | 'restore' | 'accept';
export interface AgentSession {
  provider: string;
  connection: string;
  id: string;
}
export interface WorkflowNode {
  id: string;
  parent?: string;
  action: WorkflowAction;
  title: string;
  createdAt: string;
  contextKey?: string;
  data: Record<string, unknown>;
  agentSession?: AgentSession;
}
export interface SavedWorkflow {
  schema_version: 'perfchecker-workflow-history/1';
  workspace: string;
  current?: string;
  nodes: WorkflowNode[];
}
const actions: WorkflowAction[] = ['results', 'analysis', 'create-checks', 'implementation', 'verification', 'restore', 'accept'];

/** The application owns the action tree, including when the provider has no sessions. */
export class WorkflowHistory {
  private nodes: WorkflowNode[] = [];
  private current?: string;
  constructor(readonly workspace: string, saved?: unknown) {
    if (saved === undefined) return;
    const value = saved as SavedWorkflow;
    if (!value || value.schema_version !== 'perfchecker-workflow-history/1' || value.workspace !== workspace ||
        !Array.isArray(value.nodes) || value.nodes.length > 256 || Buffer.byteLength(JSON.stringify(value)) > 8_000_000)
      throw new Error('Saved workflow history is invalid.');
    const seen = new Set<string>();
    for (const node of value.nodes) {
      if (!node || typeof node.id !== 'string' || !/^[a-f0-9-]{36}$/.test(node.id) || seen.has(node.id) ||
          (node.parent !== undefined && !seen.has(node.parent)) || !actions.includes(node.action) ||
          typeof node.title !== 'string' || node.title.length > 240 || typeof node.createdAt !== 'string' ||
          !node.data || typeof node.data !== 'object' || Array.isArray(node.data))
        throw new Error('Saved workflow history contains an invalid branch.');
      if (node.agentSession && (['provider', 'connection', 'id'] as const).some(key =>
        typeof node.agentSession![key] !== 'string' || !node.agentSession![key] || node.agentSession![key].length > 512))
        throw new Error('Saved agent session is invalid.');
      seen.add(node.id);
    }
    if (value.current !== undefined && !seen.has(value.current)) throw new Error('Saved workflow checkpoint is missing.');
    this.nodes = structuredClone(value.nodes); this.current = value.current;
  }
  state(): SavedWorkflow {
    return {schema_version: 'perfchecker-workflow-history/1', workspace: this.workspace,
      current: this.current, nodes: structuredClone(this.nodes)};
  }
  get(id = this.current): WorkflowNode | undefined {
    const node = this.nodes.find(item => item.id === id);
    return node && structuredClone(node);
  }
  append(action: WorkflowAction, title: string, data: Record<string, unknown>, contextKey?: string, agentSession?: AgentSession): WorkflowNode {
    if (!actions.includes(action) || !title.trim() || title.length > 240 || this.nodes.length >= 256)
      throw new Error('This workflow is full. Start a new workflow from a saved result.');
    const node: WorkflowNode = {id: randomUUID(), parent: this.current, action, title,
      createdAt: new Date().toISOString(), contextKey, data: structuredClone(data),
      ...(agentSession ? {agentSession: {...agentSession}} : {})};
    if (Buffer.byteLength(JSON.stringify([...this.nodes, node])) > 8_000_000)
      throw new Error('This workflow reached its history limit. Start a new workflow from a saved result.');
    this.nodes.push(node); this.current = node.id;
    return structuredClone(node);
  }
  /** Selecting a checkpoint leaves every existing descendant intact. */
  checkout(id: unknown): WorkflowNode {
    if (typeof id !== 'string' || !this.nodes.some(node => node.id === id)) throw new Error('Choose an existing workflow checkpoint.');
    this.current = id; return this.get()!;
  }
  branch(): WorkflowNode[] {
    const result: WorkflowNode[] = [];
    let node = this.get();
    while (node) {result.unshift(node); node = node.parent ? this.get(node.parent) : undefined;}
    return result;
  }
  agentParent(): AgentSession | undefined {
    return this.branch().reverse().find(node => node.agentSession)?.agentSession;
  }
  /** Replay only this branch, retaining the actual agent output and trial feedback. */
  replay(): Record<string, unknown>[] {
    return this.branch().map(node => ({action: node.action, title: node.title,
      contextKey: node.contextKey, ...structuredClone(node.data)}));
  }
}

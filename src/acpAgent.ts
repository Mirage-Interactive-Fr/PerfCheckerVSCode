import {randomUUID} from 'node:crypto';
import {promises as fs} from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type {AgentRpc, McpTool, StdioAgentAdapter} from './mcpStdioConnector';

const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const identifier = (value: unknown): value is string => typeof value === 'string' && !!value && value.length <= 512;

/** Locate an explicitly requested installed agent; never download an adapter. */
export async function resolveAcpPreset(preset: 'vibe' | 'claude') {
  const find = async (name: string): Promise<string | undefined> => {
    for (const directory of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
      const candidate = path.join(directory, name);
      if ((await fs.stat(candidate).catch(() => undefined))?.isFile()) return candidate;
    }
  };
  const executable = await find(preset === 'vibe' ? 'vibe-acp' : process.platform === 'win32' ? 'claude-agent-acp.exe' : 'claude-agent-acp');
  if (!executable) return;
  if (process.platform === 'win32') return {command: executable, args: []};
  const handle = await fs.open(executable, 'r'); let header: string;
  try {const bytes = Buffer.alloc(1024); const {bytesRead} = await handle.read(bytes, 0, bytes.length, 0); header = bytes.subarray(0, bytesRead).toString('utf8').split('\n')[0];}
  finally {await handle.close();}
  const shebang = header.match(/^#!\s*(\/[^\s]+)(?:\s+([^\s]+))?\s*$/);
  if (!shebang) return {command: executable, args: []};
  const interpreter = path.basename(shebang[1]) === 'env' && shebang[2] ? await find(shebang[2]) : shebang[1];
  if (!interpreter) return;
  return {command: interpreter, args: [...(path.basename(shebang[1]) !== 'env' && shebang[2] ? [shebang[2]] : []), executable]};
}

/** ACP v1 sessions behind ordinary MCP tools; no vendor-specific session files or SDKs. */
export class AcpAgent implements StdioAgentAdapter {
  private connection = randomUUID();
  private forks = false;
  private sessions = new Set<string>();
  private busy = false;
  private active?: {id: string; root: string; editing: boolean; text: string};
  constructor(private root: string) {}
  async initialize(rpc: AgentRpc) {
    const initialized = await rpc('initialize', {protocolVersion: 1,
      clientInfo: {name: 'PerfChecker', version: '1.1.0'},
      clientCapabilities: {fs: {readTextFile: true, writeTextFile: true}, terminal: false}});
    if (initialized.protocolVersion !== 1 || !object(initialized.agentCapabilities)) throw new Error('This agent does not support ACP v1.');
    this.forks = object(initialized.agentCapabilities.sessionCapabilities?.fork);
    const tools: McpTool[] = [{name: 'ask_perfchecker', description: 'Analyze selected PerfChecker results without editing files.',
      inputSchema: {type: 'object', properties: {prompt: {type: 'string'}, ...(this.forks ? {parent_session: {type: 'string'}} : {})}, required: ['prompt'], additionalProperties: false},
      ...(this.forks ? {_meta: {'perfchecker/conversation': {provider: 'acp', connection: this.connection, forkArgument: 'parent_session'}}} : {})},
    {name: 'implement_perfchecker', description: 'Prepare a selected change in a PerfChecker isolated checkout.',
      inputSchema: {type: 'object', properties: {prompt: {type: 'string'}, workspace: {type: 'string'}}, required: ['prompt', 'workspace'], additionalProperties: false}}];
    return {name: typeof initialized.agentInfo?.name === 'string' ? initialized.agentInfo.name.slice(0, 128) : 'ACP agent', tools};
  }
  notification(method: string, params: Record<string, any>) {
    if (method !== 'session/update' || !this.active || params.sessionId !== this.active.id) return;
    const update = params.update;
    if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text' && typeof update.content.text === 'string') {
      if (this.active.text.length + update.content.text.length > 64000) throw new Error('The ACP reply exceeds the action limit.');
      this.active.text += update.content.text;
    }
  }
  private contains(root: string, file: string) {
    const relative = path.relative(root, file);
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  }
  private async file(value: unknown, write: boolean) {
    if (!this.active || !identifier(value) || !path.isAbsolute(value) || (write && !this.active.editing)) throw new Error('File access is unavailable for this action.');
    const file = path.resolve(value), root = await fs.realpath(this.active.root);
    if (!this.contains(root, file)) throw new Error('File access is outside the selected workspace.');
    let existing = file;
    while (true) {
      try {if (!this.contains(root, await fs.realpath(existing))) throw new Error('File access resolves outside the workspace.'); break;}
      catch (error: any) {if (error.code !== 'ENOENT' || !write || existing === path.dirname(existing)) throw error; existing = path.dirname(existing);}
    }
    return file;
  }
  async request(method: string, params: Record<string, any>): Promise<unknown> {
    if (!this.active || params.sessionId !== this.active.id) throw new Error('This ACP session is not active.');
    if (method === 'session/request_permission') {
      // File edits are reviewed later. Commands, network and other permissions
      // remain denied; package verification is owned by the extension.
      let scopedEdit = false;
      if (this.active.editing && params.toolCall?.kind === 'edit') {
        const paths = [...(Array.isArray(params.toolCall.locations) ? params.toolCall.locations.map((location: any) => location?.path) : []),
          ...['path', 'file_path', 'filePath'].map(key => params.toolCall.rawInput?.[key])].filter(value => value !== undefined);
        try {if (paths.length) {await Promise.all(paths.map(value => this.file(value, true))); scopedEdit = true;}} catch {/* Outside or unspecified edits remain denied. */}
      }
      const option = scopedEdit && Array.isArray(params.options) ?
        params.options.find((option: any) => option.kind === 'allow_once' && identifier(option.optionId)) : undefined;
      return {outcome: option ? {outcome: 'selected', optionId: option.optionId} : {outcome: 'cancelled'}};
    }
    if (method === 'fs/read_text_file') {
      const file = await this.file(params.path, false);
      if ((await fs.stat(file)).size > 128000) throw new Error('The requested source file exceeds the read limit.');
      const content = await fs.readFile(file, 'utf8');
      if (params.line === undefined && params.limit === undefined) return {content};
      const line = params.line ?? 1, limit = params.limit ?? 10000;
      if (!Number.isSafeInteger(line) || line < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 10000) throw new Error('Invalid source line range.');
      return {content: content.split('\n').slice(line - 1, line - 1 + limit).join('\n')};
    }
    if (method === 'fs/write_text_file') {
      const file = await this.file(params.path, true);
      if (typeof params.content !== 'string' || Buffer.byteLength(params.content) > 1_000_000) throw new Error('The proposed source file exceeds the edit limit.');
      await fs.mkdir(path.dirname(file), {recursive: true}); await fs.writeFile(file, params.content, 'utf8');
      return {};
    }
    throw new Error('This ACP client operation is unavailable.');
  }
  async invoke(rpc: AgentRpc, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (this.busy) throw new Error('An ACP agent action is already running.');
    const editing = name === 'implement_perfchecker';
    if ((!editing && name !== 'ask_perfchecker') || typeof args.prompt !== 'string' || !args.prompt.trim() || Buffer.byteLength(args.prompt) > 200000 ||
        Object.keys(args).some(key => !['prompt', editing ? 'workspace' : 'parent_session'].includes(key))) throw new Error('Invalid ACP agent action.');
    this.busy = true;
    try {
      let root = await fs.realpath(this.root);
      if (editing) {
        if (typeof args.workspace !== 'string' || !path.isAbsolute(args.workspace)) throw new Error('Choose a PerfChecker isolated checkout.');
        root = await fs.realpath(args.workspace);
        const relative = path.relative(await fs.realpath(os.tmpdir()), root).split(path.sep);
        if (relative.length !== 2 || !/^perfchecker-implementation-[^/\\]+$/.test(relative[0]) || relative[1] !== 'checkout') throw new Error('Implementation accepts only a PerfChecker isolated checkout.');
      }
      const parent = args.parent_session;
      if (parent !== undefined && (!this.forks || !identifier(parent) || !this.sessions.has(parent))) throw new Error('This agent checkpoint belongs to another connection.');
      const session = await rpc(parent ? 'session/fork' : 'session/new', {cwd: root, mcpServers: [], ...(parent ? {sessionId: parent} : {})}, signal);
      if (!identifier(session.sessionId) || (parent && session.sessionId === parent)) throw new Error('The ACP agent did not create a distinct session.');
      this.active = {id: session.sessionId, root, editing, text: ''};
      try {
        const modes = session.modes?.availableModes ?? [];
        const preferred = editing ? ['accept-edits', 'acceptEdits', 'default'] : ['ask', 'plan', 'read-only', 'readonly'];
        const mode = preferred.find(id => Array.isArray(modes) && modes.some((mode: any) => mode.id === id));
        if (mode && session.modes.currentModeId !== mode) await rpc('session/set_mode', {sessionId: session.sessionId, modeId: mode}, signal);
        const result = await rpc('session/prompt', {sessionId: session.sessionId, prompt: [{type: 'text', text:
          (editing ? 'Edit only the supplied isolated checkout. Leave changes for diff review. Do not publish or change external services.\n' :
            'Analyze the supplied evidence only. Do not edit files, run experiments or invoke external tools.\n') + args.prompt}]}, signal);
        if (result.stopReason !== 'end_turn') throw new Error('The ACP agent did not finish the requested action.');
        const text = this.active.text.trim();
        if (!text || [...text].length > 16000) throw new Error('The ACP agent returned an empty or oversized reply.');
        if (!editing) this.sessions.add(session.sessionId);
        return {content: [{type: 'text', text}], ...(!editing && this.forks ? {
          _meta: {'perfchecker/agentSession': {provider: 'acp', connection: this.connection, id: session.sessionId}},
        } : {})};
      } finally {this.active = undefined;}
    } finally {this.busy = false;}
  }
  cancel(notify: (method: string, params: Record<string, unknown>) => void) {
    if (this.active) notify('session/cancel', {sessionId: this.active.id});
  }
}

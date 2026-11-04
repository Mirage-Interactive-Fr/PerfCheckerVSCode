import {isIP} from 'node:net';
import type {AgentSession} from './workflowHistory';

const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const MAX_RESPONSE = 1_000_000;

function endpoint(config: Record<string, unknown>): URL {
  const url = new URL(String(config.endpoint ?? ''));
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const loopback = host === 'localhost' || host === '::1' || (isIP(host) === 4 && host.startsWith('127.'));
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash ||
      (!loopback && config.allow_remote !== true)) throw new Error('Choose an allowed MCP endpoint in the agent connection settings.');
  return url;
}

function response(value: unknown, id: number): Record<string, any> | undefined {
  if (!object(value) || value.jsonrpc !== '2.0') throw new Error('Invalid MCP response.');
  if (typeof value.method === 'string') {
    if (Object.hasOwn(value, 'id')) throw new Error('This action does not support MCP sampling, elicitation or roots requests.');
    return;
  }
  if (value.id !== id) throw new Error('MCP response does not match the requested action.');
  if (value.error) throw new Error(`MCP action failed (${String(value.error.code ?? 'unknown')}).`);
  if (!object(value.result) || (value.result.resultType ?? 'complete') !== 'complete' || Object.hasOwn(value.result, 'inputRequests'))
    throw new Error('The MCP action requires unsupported client interaction.');
  return value.result;
}

/** Consume a bounded JSON or SSE reply, without waiting for an SSE connection to close. */
async function readResponse(reply: Response, id: number): Promise<Record<string, any>> {
  const type = (reply.headers.get('content-type') ?? '').toLowerCase();
  if (!reply.body || (!type.startsWith('application/json') && !type.startsWith('text/event-stream')))
    throw new Error('The MCP endpoint returned an unsupported response type.');
  const reader = reply.body.getReader(), decoder = new TextDecoder('utf-8', {fatal: true});
  let bytes = 0, buffer = '', lines: string[] = [], previousCR = false;
  const line = (value: string) => {
    if (!value && lines.length) {
      const result = response(JSON.parse(lines.join('\n')), id); lines = []; return result;
    }
    if (value.startsWith('data:')) lines.push(value.slice(5).replace(/^ /, ''));
  };
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.length;
      if (bytes > MAX_RESPONSE) throw new Error('The MCP response exceeds the action size limit.');
      const text = decoder.decode(chunk.value, {stream: true});
      if (type.startsWith('application/json')) {buffer += text; continue;}
      for (const character of text) {
        if (character === '\n' && previousCR) {previousCR = false; continue;}
        previousCR = character === '\r';
        if (character === '\r' || character === '\n') {
          const result = line(buffer); buffer = '';
          if (result) return result;
        } else buffer += character;
      }
    }
    buffer += decoder.decode();
    if (type.startsWith('application/json')) {
      const result = response(JSON.parse(buffer), id);
      if (result) return result;
    }
    throw new Error('The MCP stream ended without an action result.');
  } finally {await reader.cancel().catch(() => {});}
}

function toolHeaders(schema: unknown, argumentsValue: Record<string, unknown>): Record<string, string> {
  const headers: Record<string, string> = {};
  const walk = (node: unknown, value: unknown) => {
    if (!object(node)) return;
    if (Object.hasOwn(node, 'x-mcp-header')) {
      const name = node['x-mcp-header'];
      if (typeof name !== 'string' || !/^Mcp-Param-[A-Za-z0-9-]+$/i.test(name) || Object.keys(headers).some(key => key.toLowerCase() === name.toLowerCase()))
        throw new Error('The MCP tool declares an unsupported argument header.');
      if (value !== undefined) {
        if (!['string', 'number', 'boolean'].includes(typeof value) || /[^\x20-\x7e]/.test(String(value)))
          throw new Error('An MCP argument cannot be represented in its declared header.');
        headers[name] = String(value);
      }
    }
    if (object(node.properties)) for (const [key, child] of Object.entries(node.properties))
      walk(child, object(value) ? value[key] : undefined);
    for (const key of ['items', 'oneOf', 'anyOf', 'allOf', '$ref']) {
      if (node[key] && JSON.stringify(node[key]).includes('x-mcp-header'))
        throw new Error('The MCP tool uses an unsupported conditional argument header.');
    }
  };
  walk(schema, argumentsValue); return headers;
}

export interface McpActionResult {
  text: string;
  historyMode: 'native-fork' | 'context-replay' | 'new';
  agentSession?: AgentSession;
}

/** One explicitly chosen tool per action. Discovery never grants additional tools to an agent. */
export async function callMcpAction(config: Record<string, unknown>, request: {
  prompt: string; replayPrompt?: string; parentSession?: AgentSession;
  arguments?: Record<string, unknown>;
}, cancellation?: AbortSignal): Promise<McpActionResult> {
  if (config.protocol !== 'mcp_http') throw new Error('Connect an MCP agent before running this action.');
  const url = endpoint(config), version = String(config.mcp_version ?? '2026-07-28');
  const tool = String(config.mcp_tool ?? ''), promptArgument = String(config.mcp_prompt_argument ?? 'prompt');
  if (!['2025-11-25', '2026-07-28'].includes(version) || !/^[A-Za-z0-9_.-]{1,128}$/.test(tool) ||
      !/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(promptArgument)) throw new Error('Choose an MCP tool and its prompt argument in the connection settings.');
  const headers: Record<string, string> = {'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', 'MCP-Protocol-Version': version};
  const credential = String(config.api_key_env ?? '');
  if (credential) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(credential) || !process.env[credential] || /[\r\n]/.test(process.env[credential]!))
      throw new Error('The configured MCP credential is unavailable.');
    headers.Authorization = `Bearer ${process.env[credential]}`;
  }
  const timeout = new AbortController();
  const duration = Math.min(Math.max(Number(config.timeout) || 120, 1), 3600);
  const timer = setTimeout(() => timeout.abort(), duration * 1000);
  const signal = cancellation ? AbortSignal.any([cancellation, timeout.signal]) : timeout.signal;
  let session = '', sequence = 0;
  const post = async (method: string, parameters: Record<string, unknown> = {}, notification = false, extra: Record<string, string> = {}) => {
    const id = ++sequence;
    const params = version === '2026-07-28' ? {...parameters, _meta: {
      'io.modelcontextprotocol/protocolVersion': version,
      'io.modelcontextprotocol/clientInfo': {name: 'PerfChecker', version: '1.1.0'},
      'io.modelcontextprotocol/clientCapabilities': {},
    }} : parameters;
    const reply = await fetch(url, {method: 'POST', redirect: 'error', signal,
      headers: {...headers, ...(session ? {'Mcp-Session-Id': session} : {}),
        ...(version === '2026-07-28' ? {'Mcp-Method': method, ...(typeof params.name === 'string' ? {'Mcp-Name': params.name} : {})} : {}), ...extra},
      body: JSON.stringify({jsonrpc: '2.0', ...(notification ? {} : {id}), method, params})});
    if (reply.status !== (notification ? 202 : 200)) {await reply.body?.cancel(); throw new Error(`MCP endpoint returned HTTP ${reply.status}. Check the agent connection.`);}
    const receivedSession = reply.headers.get('mcp-session-id');
    if (receivedSession) {
      if (receivedSession.length > 1024 || /[^\x21-\x7e]/.test(receivedSession)) throw new Error('Invalid MCP session identifier.');
      session = receivedSession;
    }
    if (notification) {await reply.body?.cancel(); return {};}
    return readResponse(reply, id);
  };
  try {
    if (version !== '2026-07-28') {
      const initialized = await post('initialize', {protocolVersion: version, capabilities: {}, clientInfo: {name: 'PerfChecker', version: '1.1.0'}});
      if (initialized.protocolVersion !== version || !object(initialized.capabilities?.tools)) throw new Error('The MCP agent did not negotiate the selected tool protocol.');
      await post('notifications/initialized', {}, true);
    }
    let selected: any, cursor: string | undefined;
    for (let page = 0; page < 32; page++) {
      const catalog = await post('tools/list', cursor ? {cursor} : {});
      if (!Array.isArray(catalog.tools)) throw new Error('Invalid MCP tool catalogue.');
      const matching = catalog.tools.filter((item: any) => item?.name === tool);
      if (matching.length > 1) throw new Error('The selected MCP tool is ambiguous.');
      if (matching.length) {selected = matching[0]; break;}
      if (catalog.nextCursor === undefined) break;
      if (typeof catalog.nextCursor !== 'string' || catalog.nextCursor.length > 1024) throw new Error('Invalid MCP catalogue cursor.');
      cursor = catalog.nextCursor;
    }
    if (!selected) throw new Error('The selected agent tool is unavailable. Reconnect the agent.');
    const declared = selected._meta?.['perfchecker/conversation'];
    const identifier = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 512;
    const capability = object(declared) && identifier(declared.provider) && identifier(declared.connection) ? declared : undefined;
    const parent = request.parentSession;
    const native = parent && object(capability) && capability.provider === parent.provider && capability.connection === parent.connection &&
      typeof capability.forkArgument === 'string' && /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(capability.forkArgument) && capability.forkArgument !== promptArgument &&
      !Object.hasOwn(request.arguments ?? {}, capability.forkArgument) && !Object.hasOwn(config.mcp_arguments ?? {}, capability.forkArgument);
    const instructions = config.instructions ?? '';
    if (typeof instructions !== 'string' || instructions.length > 16000) throw new Error('The saved agent instructions exceed the action size limit.');
    const selectedPrompt = !native && request.replayPrompt ? request.replayPrompt : request.prompt;
    const prompt = instructions ? `${instructions}\n\n${selectedPrompt}` : selectedPrompt;
    if (!prompt.trim() || Buffer.byteLength(prompt) > 200_000) throw new Error('This branch exceeds the agent context limit. Continue from a nearer checkpoint.');
    const base = config.mcp_arguments ?? {};
    if (!object(base) || Object.hasOwn(base, promptArgument) || Buffer.byteLength(JSON.stringify(base)) > 12000)
      throw new Error('Invalid configured MCP tool arguments.');
    const argumentsValue = {...base, ...request.arguments, [promptArgument]: prompt,
      ...(native ? {[capability.forkArgument]: parent!.id} : {})};
    const schema = selected.inputSchema ?? {};
    if (!Array.isArray(schema.required ?? []) || (schema.required ?? []).some((key: unknown) => typeof key !== 'string' || !Object.hasOwn(argumentsValue, key)))
      throw new Error('The selected agent tool requires additional configured arguments.');
    const result = await post('tools/call', {name: tool, arguments: argumentsValue}, false,
      version === '2026-07-28' ? toolHeaders(schema, argumentsValue) : {});
    if (result.isError === true) throw new Error('The agent tool reported an unsuccessful action.');
    const blocks = result.content ?? [];
    if (!Array.isArray(blocks)) throw new Error('Invalid MCP action content.');
    const text = blocks.filter((block: any) => block?.type === 'text' && typeof block.text === 'string').map((block: any) => block.text).join('\n') ||
      (object(result.structuredContent) ? JSON.stringify(result.structuredContent) : '');
    if (!text.trim() || [...text].length > 16000) throw new Error('The agent returned an empty or oversized action result.');
    const returned = result._meta?.['perfchecker/agentSession'];
    const agentSession = object(capability) && object(returned) && returned.provider === capability.provider && returned.connection === capability.connection &&
      identifier(returned.id) ? returned as AgentSession : undefined;
    if (native && agentSession?.id === parent?.id) throw new Error('The agent resumed the parent conversation instead of returning a fork. Reconnect and replay this branch.');
    return {text, historyMode: native ? 'native-fork' : request.replayPrompt ? 'context-replay' : 'new', agentSession};
  } catch (error) {
    if (timeout.signal.aborted) throw new Error(`The agent action timed out after ${duration} seconds.`);
    if (cancellation?.aborted) throw new Error('Agent action cancelled.');
    throw error;
  } finally {
    clearTimeout(timer);
    if (session) await fetch(url, {method: 'DELETE', redirect: 'error', headers: {...headers, 'Mcp-Session-Id': session},
      signal: AbortSignal.timeout(1500)}).then(reply => reply.body?.cancel()).catch(() => {});
  }
}

import {spawn, ChildProcess, execFile} from 'node:child_process';
import {createServer, Server, IncomingMessage, ServerResponse} from 'node:http';
import {randomBytes, timingSafeEqual} from 'node:crypto';
import {readFile, readdir, realpath, stat} from 'node:fs/promises';
import {StringDecoder} from 'node:string_decoder';
import {promisify} from 'node:util';
import * as path from 'node:path';
import {spawnWindowsOwnedProcess} from './windowsOwnedProcess';

export type McpVersion = '2025-11-25' | '2026-07-28';
export interface McpTool {name: string; description?: string; inputSchema: Record<string, unknown>}
export interface McpStdioOptions {
  command: string; args: string[]; cwd: string; version: McpVersion;
  timeoutMs?: number; onClosed?: () => void;
}
interface Identity {pid: number; parent: number; group: number; start: string; exe: string}
const execute = promisify(execFile), MAX_BYTES = 1_000_000;
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);

/** A selected local MCP server, never a bundled agent or an implicit shell.
 * The HTTP endpoint exists only to adapt the existing Julia MCP client. Neither
 * this adapter nor MCP enforces an implementation tool's filesystem boundary.
 */
export class McpStdioConnector {
  readonly token = randomBytes(32).toString('base64url');
  readonly keyEnvironment = `PERFCHECKER_MCP_TOKEN_${randomBytes(8).toString('hex').toUpperCase()}`;
  endpoint = '';
  serverName = 'Local MCP server';
  tools: McpTool[] = [];
  private child?: ChildProcess;
  private server?: Server;
  private sequence = 0;
  private pending = new Map<number, {method: string; resolve: (value: any) => void; reject: (error: Error) => void}>();
  private requests = new Set<Promise<void>>();
  private closing?: Promise<void>;
  private failure?: Error;
  private closed = false;
  private childClosed = false;
  private known = new Map<number, Identity>();
  private groups = new Set<number>();
  private groupGone = false;
  private observer?: ReturnType<typeof setInterval>;
  private observation: Promise<void> = Promise.resolve();
  constructor(private options: McpStdioOptions) {}

  async start() {
    if (this.child || this.closed) throw new Error('This local MCP connection cannot be restarted. Connect again explicitly.');
    if (!path.isAbsolute(this.options.command) || !path.isAbsolute(this.options.cwd) ||
      !Array.isArray(this.options.args) || this.options.args.some(value => typeof value !== 'string' || value.includes('\0')) ||
      this.options.args.length > 256 || this.options.args.join('').length > 32000 ||
      !['2025-11-25', '2026-07-28'].includes(this.options.version))
      throw new Error('Choose an absolute native executable, an argument array, an absolute directory and an explicit MCP revision.');
    const command = await realpath(this.options.command), cwd = await realpath(this.options.cwd);
    if (!(await stat(cwd)).isDirectory() || !(await stat(command)).isFile()) throw new Error('The MCP executable or working directory is unavailable.');
    // Cancel may finish while filesystem validation yields. Never spawn after
    // its cleanup handle has already been retired.
    if (this.closed || this.closing) throw new Error('Local MCP connection cancelled before launch.');
    const env = {...process.env};
    // Never give an external server the private tokens of another local bridge.
    for (const name of Object.keys(env)) if (/^PERFCHECKER_(MCP|CODEX)_TOKEN_/.test(name)) delete env[name];
    this.child = process.platform === 'win32' ? spawnWindowsOwnedProcess(command, this.options.args, {cwd, env}) :
      spawn(command, this.options.args, {cwd, env, detached: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
    const child = this.child, decoder = new StringDecoder('utf8');
    let buffer = '', bufferedBytes = 0;
    child.stdin?.on('error', () => {if (!this.closing) this.fail(new Error('The local MCP input stream closed.'));});
    // stderr is deliberately drained without treating logs as failures or
    // exposing arbitrary server output (which may contain credentials).
    child.stderr?.on('data', () => {});
    child.stdout?.on('data', (chunk: Buffer) => {
      bufferedBytes += chunk.length;
      if (bufferedBytes > MAX_BYTES) {this.fail(new Error('An MCP message exceeds 1 MB.')); return;}
      buffer += decoder.write(chunk);
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        bufferedBytes = Buffer.byteLength(buffer, 'utf8');
        if (!line.trim()) {this.fail(new Error('The MCP server wrote an empty protocol message.')); return;}
        try {this.receive(JSON.parse(line));}
        catch {this.fail(new Error('The MCP server wrote an invalid or unsupported JSON-RPC message.')); return;}
      }
    });
    const outputClosed = () => {
      if (!this.closing) this.fail(new Error(bufferedBytes ?
        'The local MCP output stream ended with an incomplete protocol message.' :
        'The local MCP output stream closed. Connect again explicitly.'));
    };
    child.stdout?.once('end', outputClosed);
    child.stdout?.once('close', outputClosed);
    child.stdout?.once('error', outputClosed);
    child.once('error', () => {this.childClosed = true; this.fail(new Error('The MCP server could not be launched. Check its executable and arguments.'));});
    child.once('close', () => {
      this.childClosed = true;
      if (!this.closing) this.fail(new Error('The MCP server exited. Connect again explicitly.'));
    });
    child.once('exit', () => {if (!this.closing) this.fail(new Error('The MCP server exited. Connect again explicitly.'));});
    try {
      if (process.platform !== 'win32') {
        // The detached spawn creates a new session/group. Qualify its actual
        // kernel identity before accepting any protocol result or group signal.
        for (let attempt = 0; !this.known.size && attempt < 20; attempt++) {
          await this.observe(true, command);
          if (!this.known.size) await delay(10);
        }
        if (!this.known.has(child.pid!)) throw new Error('The MCP server process identity could not be established.');
        this.observer = setInterval(() => {
          this.observation = this.observation.then(async () => {await this.observe();}).catch(() => {
            // Do not make shutdown await its own observation callback.
            setImmediate(() => this.fail(new Error('The private MCP process group could not be inspected.')));
          });
        }, 250);
      }
      if (this.options.version === '2025-11-25') {
        const result = await this.rpc('initialize', {protocolVersion: this.options.version, capabilities: {},
          clientInfo: {name: 'PerfChecker', version: '1.0.1'}});
        if (result.protocolVersion !== this.options.version || !object(result.capabilities?.tools))
          throw new Error('The selected MCP revision or tools capability is unavailable.');
        this.serverName = this.name(result.serverInfo);
        this.notify('notifications/initialized', {});
      } else {
        const result = await this.rpc('server/discover', {});
        if (!Array.isArray(result.supportedVersions) || !result.supportedVersions.includes(this.options.version) || !object(result.capabilities?.tools))
          throw new Error('The selected MCP revision or tools capability is unavailable.');
        this.serverName = this.name(result._meta?.['io.modelcontextprotocol/serverInfo']);
      }
      this.tools = await this.discover();
      this.server = createServer((request, response) => {
        const pending = this.respond(request, response); this.requests.add(pending);
        void pending.finally(() => this.requests.delete(pending));
      });
      this.server.headersTimeout = 10000;
      await new Promise<void>((resolve, reject) => {this.server!.once('error', reject); this.server!.listen(0, '127.0.0.1', resolve);});
      if (this.closed || this.closing) throw new Error('Local MCP connection cancelled before endpoint publication.');
      const address = this.server.address();
      if (!address || typeof address === 'string') throw new Error('The private MCP endpoint is unavailable.');
      this.endpoint = `http://127.0.0.1:${address.port}/mcp`;
      process.env[this.keyEnvironment] = this.token;
      return this;
    } catch (error) {await this.dispose(); throw error;}
  }
  private name(info: any) {return typeof info?.name === 'string' ? info.name.slice(0, 128) : 'Local MCP server';}
  private receive(message: any) {
    if (!object(message) || message.jsonrpc !== '2.0') throw new Error('Invalid JSON-RPC.');
    if (typeof message.method === 'string') {
      if (Object.hasOwn(message, 'id')) throw new Error('Server requests are unsupported.');
      return; // No roots, sampling, elicitation or subscription capability offered.
    }
    if (!Number.isSafeInteger(message.id) || !this.pending.has(message.id)) throw new Error('Unexpected MCP response ID.');
    const pending = this.pending.get(message.id)!; this.pending.delete(message.id);
    if (object(message.error)) {pending.reject(new Error(`MCP request failed (${Number.isInteger(message.error.code) ? message.error.code : 'unknown'}).`)); return;}
    if (!object(message.result) || (this.options.version === '2026-07-28' && message.result.resultType !== 'complete') || Object.hasOwn(message.result, 'inputRequests')) {
      pending.reject(new Error('This MCP tool requires unsupported client interaction.')); return;
    }
    pending.resolve(message.result);
  }
  private write(message: unknown) {
    if (this.childClosed || !this.child?.stdin?.writable) throw new Error('The local MCP server is disconnected.');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  private notify(method: string, params: Record<string, unknown>) {this.write({jsonrpc: '2.0', method, params});}
  private async rpc(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
    if (this.failure || this.closed || this.closing) throw this.failure ?? new Error('The local MCP server is disconnected.');
    if (signal?.aborted) throw new Error('MCP request cancelled.');
    const id = ++this.sequence;
    if (this.options.version === '2026-07-28') params = {...params, _meta: {
      'io.modelcontextprotocol/protocolVersion': this.options.version,
      'io.modelcontextprotocol/clientInfo': {name: 'PerfChecker', version: '1.0.1'},
      'io.modelcontextprotocol/clientCapabilities': {}}};
    let timer: ReturnType<typeof setTimeout>;
    const stop = () => {
      try {if (method !== 'initialize') this.notify('notifications/cancelled', {requestId: id});} catch {/* EOF may already be observed. */}
      this.fail(new Error(signal?.aborted ? 'MCP request cancelled. Reconnect the local server to continue.' : 'MCP request timed out. Reconnect the local server to continue.'));
    };
    try {
      return await new Promise((resolve, reject) => {
        this.pending.set(id, {method, resolve, reject});
        timer = setTimeout(stop, Math.min(Math.max(this.options.timeoutMs ?? 90000, 1), 3600000));
        signal?.addEventListener('abort', stop, {once: true});
        try {this.write({jsonrpc: '2.0', id, method, params});} catch (error) {this.pending.delete(id); reject(error);}
        if (signal?.aborted) stop();
      });
    } finally {clearTimeout(timer!); signal?.removeEventListener('abort', stop);}
  }
  async discover(signal?: AbortSignal): Promise<McpTool[]> {
    const bounded = new AbortController();
    const cancel = () => bounded.abort();
    signal?.addEventListener('abort', cancel, {once: true});
    if (signal?.aborted) cancel();
    const timer = setTimeout(() => {
      this.fail(new Error('MCP tool discovery timed out. Reconnect the local server to continue.')); cancel();
    }, Math.min(Math.max(this.options.timeoutMs ?? 90000, 1), 3600000));
    try {
    const tools: McpTool[] = [], seen = new Set<string>(), cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 32; page++) {
      const result = await this.rpc('tools/list', cursor === undefined ? {} : {cursor}, bounded.signal);
      if (!Array.isArray(result.tools)) throw new Error('Invalid MCP tool inventory.');
      for (const tool of result.tools) {
        if (!object(tool) || !/^[A-Za-z0-9_.-]{1,128}$/.test(tool.name) || seen.has(tool.name) || !object(tool.inputSchema))
          throw new Error('Invalid or duplicate MCP tool description.');
        seen.add(tool.name); tools.push(tool as McpTool);
      }
      if (result.nextCursor === undefined) return tools;
      if (typeof result.nextCursor !== 'string' || cursors.has(result.nextCursor)) throw new Error('Invalid MCP pagination cursor.');
      cursor = result.nextCursor; cursors.add(result.nextCursor);
    }
    throw new Error('MCP tool inventory exceeds 32 pages.');
    } finally {clearTimeout(timer); signal?.removeEventListener('abort', cancel);}
  }
  private async respond(request: IncomingMessage, response: ServerResponse) {
    const expected = Buffer.from(`Bearer ${this.token}`), actual = Buffer.from(String(request.headers.authorization ?? ''));
    if (request.headers.origin || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {response.writeHead(401); response.end(); return;}
    if (request.url !== '/mcp') {response.writeHead(404); response.end(); return;}
    if (request.method === 'DELETE') {response.writeHead(204); response.end(); return;} // Legacy Julia request session, not the explicitly connected server.
    if (request.method !== 'POST') {response.writeHead(405); response.end(); return;}
    const abort = new AbortController();
    const bodyTimer = setTimeout(() => {abort.abort(); request.destroy();}, 10000);
    response.once('close', () => {if (!response.writableEnded) abort.abort();});
    let id: any = null;
    const send = (value: unknown, error = false) => {
      if (!response.destroyed) {response.writeHead(200, {'Content-Type': 'application/json'}); response.end(JSON.stringify({jsonrpc: '2.0', id, [error ? 'error' : 'result']: value}));}
    };
    try {
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of request) {bytes += chunk.length; if (bytes > 250000) throw new Error('Local MCP connector request exceeds 250 KB.'); chunks.push(Buffer.from(chunk));}
      clearTimeout(bodyTimer);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); id = body.id ?? null;
      if (!object(body) || body.jsonrpc !== '2.0' || typeof body.method !== 'string' ||
        String(request.headers['mcp-protocol-version']) !== this.options.version) throw new Error('Invalid MCP revision or request.');
      if (body.method === 'notifications/initialized') {response.writeHead(202); response.end(); return;}
      if (body.method === 'initialize') {
        if (this.options.version !== '2025-11-25' || body.params?.protocolVersion !== this.options.version) throw new Error('MCP revision mismatch.');
        send({protocolVersion: this.options.version, capabilities: {tools: {}}, serverInfo: {name: this.serverName, version: '1.0.1'}});
      } else if (body.method === 'server/discover' && this.options.version === '2026-07-28') send({resultType: 'complete', ttlMs: 0, cacheScope: 'private', supportedVersions: [this.options.version], capabilities: {tools: {}},
        _meta: {'io.modelcontextprotocol/serverInfo': {name: this.serverName, version: '1.0.1'}}});
      else if (body.method === 'tools/list') {this.tools = await this.discover(abort.signal); send({tools: this.tools,
        ...(this.options.version === '2026-07-28' ? {resultType: 'complete', ttlMs: 0, cacheScope: 'private'} : {})});}
      else if (body.method === 'tools/call') {
        const tool = this.tools.find(tool => tool.name === body.params?.name);
        if (!tool || !object(body.params?.arguments)) throw new Error('Select an available MCP tool and an arguments object.');
        const result = await this.rpc('tools/call', {name: tool.name, arguments: body.params.arguments}, abort.signal);
        send(result);
      } else throw new Error('This MCP method is not supported by the local connector.');
    } catch {send({code: -32000, message: 'Local MCP request failed. Check the selected tool, its arguments and connection state.'}, true);}
    finally {clearTimeout(bodyTimer);}
  }

  private fail(error: Error) {
    this.failure ??= error;
    for (const pending of this.pending.values()) pending.reject(this.failure);
    this.pending.clear();
    if (!this.closed) void this.dispose().catch(() => {}); // An explicit retry retains ownership after cleanup errors.
  }
  private async group(initial = false): Promise<Identity[]> {
    const group = this.child?.pid;
    if (!group || this.groupGone) return [];
    const metadata: Array<Omit<Identity, 'exe'>> = [];
    if (process.platform === 'linux') {
      for (const name of await readdir('/proc')) {
        if (!/^\d+$/.test(name)) continue;
        try {
          const raw = await readFile(`/proc/${name}/stat`, 'utf8'), fields = raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/);
          if (![fields[1], fields[2], fields[19]].every(value => /^[0-9]+$/.test(value) && Number.isSafeInteger(Number(value)))) throw new Error('Invalid process identity.');
          if (['Z', 'X'].includes(fields[0])) continue;
          metadata.push({pid: Number(name), parent: Number(fields[1]), group: Number(fields[2]), start: fields[19]});
        } catch (error) {if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;}
      }
    } else {
      const result = await execute('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,stat=,lstart='], {timeout: 2000, maxBuffer: 2_000_000});
      for (const line of result.stdout.split('\n')) {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
        if (!match || /^[ZX]/.test(match[4])) continue;
        metadata.push({pid: Number(match[1]), parent: Number(match[2]), group: Number(match[3]), start: match[5]});
      }
    }
    const selected = new Map<number, Omit<Identity, 'exe'>>();
    for (const row of metadata) if ((initial && row.pid === group) || this.known.get(row.pid)?.start === row.start) selected.set(row.pid, row);
    // Ascendance is inspected while parents still exist. Previously observed
    // incarnations remain owned after reparenting; unseen daemonization is not
    // claimed. Private groups require an observed owned group leader.
    for (let changed = true; changed;) {
      changed = false;
      for (const row of metadata) if (!selected.has(row.pid) && selected.has(row.parent)) {selected.set(row.pid, row); changed = true;}
    }
    for (const privateGroup of this.groups) {
      const members = metadata.filter(row => row.group === privateGroup);
      if (members.length && !members.some(row => selected.has(row.pid))) throw new Error('A private MCP group has no qualified live incarnation.');
      for (const row of members) selected.set(row.pid, row);
    }
    const rows: Identity[] = [];
    for (const row of selected.values()) {
      const {pid} = row;
      if (process.platform === 'linux') {
        try {
          let exe: string;
          try {exe = await realpath(`/proc/${pid}/exe`);}
          catch (error) {
            const current = await readFile(`/proc/${pid}/stat`, 'utf8').catch(error => {
              if (['ENOENT', 'ESRCH'].includes(error.code)) return ''; throw error;
            });
            if (!current || ['Z', 'X'].includes(current.slice(current.lastIndexOf(')') + 2).trim().split(/\s+/)[0])) continue;
            throw new Error('A live private MCP process has no observable executable.');
          }
          const after = await readFile(`/proc/${pid}/stat`, 'utf8'), fields = after.slice(after.lastIndexOf(')') + 2).trim().split(/\s+/);
          if (fields[19] !== row.start || Number(fields[1]) !== row.parent || Number(fields[2]) !== row.group) throw new Error('Process identity changed while inspecting.');
          if (!['Z','X'].includes(fields[0])) rows.push({...row, exe});
        } catch (error) {if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;}
        continue;
      }
      try {
        const txt = await execute('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'txt', '-Fn'], {timeout: 2000, maxBuffer: 1_000_000});
        const filename = txt.stdout.split('\n').find(line => line.startsWith('n/'))?.slice(1);
        if (!filename) throw new Error('The MCP executable mapping is unavailable.');
        const exe = await realpath(filename);
        const after = await execute('/bin/ps', ['-p', String(pid), '-o', 'pid=,ppid=,pgid=,stat=,lstart='], {timeout: 2000});
        const again = after.stdout.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
        if (!again || Number(again[1]) !== row.pid || Number(again[2]) !== row.parent || Number(again[3]) !== row.group || again[5] !== row.start) throw new Error('MCP process identity changed while inspecting its executable.');
        if (!/^[ZX]/.test(again[4])) rows.push({...row, exe});
      } catch (error) {
        const current = await execute('/bin/ps', ['-p', String(pid), '-o', 'pid=,stat=,lstart='], {timeout: 2000}).catch(error => {
          if (error.code === 1 && !String(error.stdout ?? '').trim() && !String(error.stderr ?? '').trim()) return {stdout: ''}; throw error;
        });
        if (current.stdout.trim() && !/^\s*\d+\s+[ZX]/.test(current.stdout)) throw error;
      }
    }
    return rows;
  }
  private async observe(initial = false, command?: string) {
    const rows = await this.group(initial);
    if (initial && rows.length && !rows.some(row => row.pid === this.child?.pid && row.parent === process.pid && row.group === row.pid && row.exe === command))
      throw new Error('The MCP process group is not anchored to the launched executable.');
    if (!initial && rows.length && !rows.some(row => this.known.get(row.pid)?.start === row.start)) throw new Error('The MCP process group lost its owned identity.');
    for (const row of rows) {
      const known = this.known.get(row.pid);
      if (known && (known.start !== row.start || known.exe !== row.exe)) throw new Error('An MCP process identity or executable changed.');
      this.known.set(row.pid, row);
      if (row.group === row.pid && (initial || rows.some(parent => parent.pid === row.parent) || this.groups.has(row.group))) this.groups.add(row.group);
    }
    if (!rows.length && this.known.size) this.groupGone = true;
    return rows;
  }
  private async stop() {
    const until = Date.now() + 10000;
    this.closed = true;
    delete process.env[this.keyEnvironment];
    if (this.observer) clearInterval(this.observer);
    for (const [id, pending] of this.pending) {
      try {if (pending.method !== 'initialize') this.notify('notifications/cancelled', {requestId: id});} catch {/* The transport may already have closed. */}
      pending.reject(this.failure ?? new Error('Local MCP server disconnected.'));
    }
    this.pending.clear();
    await this.observation;
    const child = this.child;
    child?.stdin?.end();
    const gone = async () => process.platform === 'win32' ? this.childClosed : !(await this.observe()).length && this.childClosed;
    const wait = async (ms: number) => {const deadline = Math.min(until, Date.now() + ms); while (Date.now() < deadline) {if (await gone()) return true; await delay(25);} return gone();};
    if (child?.pid && !await wait(2000)) {
      const signal = async (kind: NodeJS.Signals) => {
        if (process.platform === 'win32') {if (!this.childClosed) child.kill(kind);}
        else {
          const rows = await this.observe();
          for (const group of this.groups) if (rows.some(row => row.group === group)) {
            try {process.kill(-group, kind);} catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;}
          }
          for (const row of rows.filter(row => !this.groups.has(row.group))) {
            const current = (await this.observe()).find(current => current.pid === row.pid && current.start === row.start && current.exe === row.exe);
            if (current) {try {process.kill(row.pid, kind);} catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;}}
          }
        }
      };
      await signal('SIGTERM');
      if (!await wait(2000)) {await signal('SIGKILL'); if (!await wait(5000)) throw new Error('Owned MCP server cleanup is incomplete.');}
    }
    if (this.server) {this.server.closeAllConnections(); await new Promise<void>(resolve => this.server!.close(() => resolve())); this.server = undefined;}
    await Promise.allSettled([...this.requests]);
    this.options.onClosed?.();
  }
  dispose(): Promise<void> {
    if (!this.closing) {
      const closing = this.stop(); this.closing = closing;
      void closing.catch(() => {if (this.closing === closing) this.closing = undefined;});
    }
    return this.closing;
  }
}

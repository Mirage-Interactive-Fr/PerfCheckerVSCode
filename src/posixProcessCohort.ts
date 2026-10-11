import {ChildProcess, execFile} from 'node:child_process';
import {readFile, readdir, realpath} from 'node:fs/promises';
import {promisify} from 'node:util';

export interface PosixProcessIdentity {pid: number; parent: number; group: number; session: number | string; start: string; exe: string}
type Identity = PosixProcessIdentity;
const execute = promisify(execFile);
const remaining = (deadline: number) => {
  const value = deadline - Date.now();
  if (value <= 0) throw new Error('Owned process inspection deadline expired; cleanup is incomplete.');
  return Math.max(1, Math.min(2000, value));
};

/** Kernel identities of a launched private process and its observed descendants.
 * PID birth and executable qualify ownership. A recorded descendant may change
 * its parent, process group or session without becoming an unrelated process.
 * An unobserved daemon is never adopted from its name or working directory.
 */
export class PosixProcessCohort {
  readonly known = new Map<number, Identity>();
  groups = new Set<number>();
  private groupGone = false;
  constructor(private child: ChildProcess, private followSessionChanges = false) {}
  private knownReparent(row: Omit<Identity, 'exe'>, exe: string, parent: string, initial: boolean) {
    const known = initial ? undefined : this.known.get(row.pid);
    return /^\d+$/.test(parent) && Number.isSafeInteger(Number(parent)) &&
      known?.start === row.start && known.exe === exe && (this.followSessionChanges || (known.group === row.group && known.session === row.session && this.groups.has(row.group)));
  }
  private async metadata(leaderOnly = false, deadline = Infinity): Promise<Array<Omit<Identity, 'exe'>>> {
    const group = this.child.pid;
    if (!group) return [];
    const metadata: Array<Omit<Identity, 'exe'>> = [];
    if (process.platform === 'linux') {
      for (const name of leaderOnly ? [String(group)] : await readdir('/proc')) {
        remaining(deadline);
        if (!/^\d+$/.test(name)) continue;
        try {
          const raw = await readFile(`/proc/${name}/stat`, 'utf8'), fields = raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/);
          if (![fields[1], fields[2], fields[3], fields[19]].every(value => /^[0-9]+$/.test(value) && Number.isSafeInteger(Number(value)))) throw new Error('Invalid process identity.');
          if (['Z', 'X'].includes(fields[0])) continue;
          metadata.push({pid: Number(name), parent: Number(fields[1]), group: Number(fields[2]), session: Number(fields[3]), start: fields[19]});
        } catch (error) {if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;}
      }
    } else {
      const result = await execute('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,sess=,stat=,lstart='], {timeout: remaining(deadline), maxBuffer: 2_000_000});
      for (const line of result.stdout.split('\n')) {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.+)$/);
        if (!match || /^[ZX]/.test(match[5])) continue;
        metadata.push({pid: Number(match[1]), parent: Number(match[2]), group: Number(match[3]), session: match[4], start: match[6]});
      }
    }
    return metadata;
  }
  /** A closed, never-qualified leader is not proof that its private group is empty. */
  async assertUnobservedExit(deadline = Infinity) {
    const pid = this.child.pid;
    const rows = await this.metadata(false, deadline);
    if (rows.some(row => row.pid === pid || row.group === pid || row.session === pid))
      throw new Error('An unqualified Codex process incarnation remains; cleanup cannot be proved.');
  }
  async group(initial = false, deadline = Infinity): Promise<Identity[]> {
    if (!this.child.pid || this.groupGone) return [];
    const group = this.child.pid;
    // Preserve the established stdio full scan. Codex qualifies its leader
    // before sending stdin, avoiding races with short preflight commands.
    const metadata = await this.metadata(initial && this.followSessionChanges, deadline);
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
      if (!this.followSessionChanges) for (const row of members) selected.set(row.pid, row);
    }
    const rows: Identity[] = [];
    for (const row of selected.values()) {
      const current = await this.identity(row, initial, deadline);
      if (current) rows.push(current);
    }
    return rows;
  }
  private async identity(row: Omit<Identity, 'exe'>, initial = false, deadline = Infinity): Promise<Identity | undefined> {
      remaining(deadline);
      const {pid} = row;
      const refusal = (message: string, observed?: Omit<Identity, 'exe'> & {state: string}, executable?: string, errno?: string) =>
        new Error(message, {cause: {kind: 'process-identity', platform: process.platform, initial,
          expected: {pid, parent: row.parent, group: row.group, session: row.session, start: row.start}, observed, executable, errno}});
      if (process.platform === 'linux') {
        const snapshot = (fields: string[]) => ({pid, parent: Number(fields[1]), group: Number(fields[2]), session: Number(fields[3]), start: fields[19], state: fields[0]});
        const sameBirth = (fields: string[]) => [fields[1], fields[2], fields[3], fields[19]].every(value => /^[0-9]+$/.test(value) && Number.isSafeInteger(Number(value))) && fields[19] === row.start;
        try {
          let exe: string;
          try {exe = await realpath(`/proc/${pid}/exe`);}
          catch (error) {
            const current = await readFile(`/proc/${pid}/stat`, 'utf8').catch(error => {
              if (['ENOENT', 'ESRCH'].includes(error.code)) return ''; throw error;
            });
            if (!current) return undefined;
            const fields = current.slice(current.lastIndexOf(')') + 2).trim().split(/\s+/);
            if (!sameBirth(fields)) throw refusal('Process identity changed while inspecting.', snapshot(fields), undefined, (error as NodeJS.ErrnoException).code);
            if (['Z', 'X'].includes(fields[0])) return undefined;
            throw refusal('A live private MCP process has no observable executable.', snapshot(fields), undefined, (error as NodeJS.ErrnoException).code);
          }
          const after = await readFile(`/proc/${pid}/stat`, 'utf8'), fields = after.slice(after.lastIndexOf(')') + 2).trim().split(/\s+/);
          if (!sameBirth(fields)) throw refusal('Process identity changed while inspecting.', snapshot(fields), exe);
          // A dead incarnation needs no ownership transition or signal. Its
          // birth must still match before ignoring changed parent/group/session.
          if (['Z', 'X'].includes(fields[0])) return undefined;
          if ((!this.followSessionChanges && (Number(fields[2]) !== row.group || Number(fields[3]) !== row.session)) ||
              ((Number(fields[2]) !== row.group || Number(fields[3]) !== row.session || Number(fields[1]) !== row.parent) &&
                !this.knownReparent(row, exe, fields[1], initial))) throw refusal('Process identity changed while inspecting.', snapshot(fields), exe);
          if (this.followSessionChanges && await realpath(`/proc/${pid}/exe`) !== exe) throw refusal('Owned executable changed during its identity read.', snapshot(fields), exe);
          return {...row, parent: Number(fields[1]), group: Number(fields[2]), session: Number(fields[3]), exe};
        } catch (error) {if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;}
        return undefined;
      }
      try {
        const txt = await execute('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'txt', '-Fn'], {timeout: remaining(deadline), maxBuffer: 1_000_000});
        const filename = txt.stdout.split('\n').find(line => line.startsWith('n/'))?.slice(1);
        if (!filename) throw refusal('The MCP executable mapping is unavailable.');
        const exe = await realpath(filename);
        const after = await execute('/bin/ps', ['-p', String(pid), '-o', 'pid=,ppid=,pgid=,sess=,stat=,lstart='], {timeout: remaining(deadline)});
        const again = after.stdout.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.+)$/);
        const observed = again ? {pid: Number(again[1]), parent: Number(again[2]), group: Number(again[3]), session: again[4], state: again[5], start: again[6]} : undefined;
        if (!again || ![again[1], again[2], again[3]].every(value => Number.isSafeInteger(Number(value))) || Number(again[1]) !== row.pid || again[6] !== row.start)
          throw refusal('MCP process identity changed while inspecting its executable.', observed, exe);
        if (/^[ZX]/.test(again[5])) return undefined;
        if ((!this.followSessionChanges && (Number(again[3]) !== row.group || again[4] !== row.session)) ||
            ((Number(again[3]) !== row.group || again[4] !== row.session || Number(again[2]) !== row.parent) &&
              !this.knownReparent(row, exe, again[2], initial))) throw refusal('MCP process identity changed while inspecting its executable.', observed, exe);
        if (this.followSessionChanges) {
          const second = await execute('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'txt', '-Fn'], {timeout: remaining(deadline), maxBuffer: 1_000_000});
          const image = second.stdout.split('\n').find(line => line.startsWith('n/'))?.slice(1);
          if (!image || await realpath(image) !== exe) throw refusal('Owned executable changed during its identity read.', observed, exe);
        }
        return {...row, parent: Number(again[2]), group: Number(again[3]), session: again[4], exe};
      } catch (error) {
        const current = await execute('/bin/ps', ['-p', String(pid), '-o', 'pid=,stat=,lstart='], {timeout: remaining(deadline)}).catch(error => {
          if (error.code === 1 && !String(error.stdout ?? '').trim() && !String(error.stderr ?? '').trim()) return {stdout: ''}; throw error;
        });
        const final = current.stdout.trim().match(/^(\d+)\s+(\S+)\s+(.+)$/);
        if (current.stdout.trim() && (!final || Number(final[1]) !== pid || final[3] !== row.start || !/^[ZX]/.test(final[2]))) throw error;
      }
  }
  async observe(initial = false, command?: string, deadline = Infinity) {
    const rows = await this.group(initial, deadline);
    if (initial && rows.length && !rows.some(row => row.pid === this.child?.pid && row.parent === process.pid && row.group === row.pid && (process.platform !== 'linux' || row.session === row.pid) && (command === undefined || row.exe === command)))
      throw new Error('The MCP process group is not anchored to the launched executable.');
    if (!initial && rows.length && !rows.some(row => this.known.get(row.pid)?.start === row.start)) throw new Error('The MCP process group lost its owned identity.');
    const record = (row: Identity) => {
      this.known.set(row.pid, row);
      if (row.group === row.pid && (initial || rows.some(parent => parent.pid === row.parent) || this.groups.has(row.group))) this.groups.add(row.group);
    };
    const images: Identity[] = [];
    for (const row of rows) {
      const known = this.known.get(row.pid);
      if (known && known.start !== row.start) throw new Error('An MCP process birth identity changed.');
      if (known && known.exe !== row.exe) {
        if (!this.followSessionChanges) throw new Error('An MCP process identity or executable changed.');
        images.push(row);
      } else record(row);
    }
    // exec keeps a PID/birth, but a new image is accepted only while its current
    // parent remains a live, independently qualified owned incarnation. Never
    // infer that relationship from a reused group or a reparented daemon.
    while (images.length) {
      let accepted = false;
      for (let index = images.length - 1; index >= 0; index--) {
        const row = images[index], parent = rows.find(parent => parent.pid === row.parent);
        const direct = row.pid === this.child.pid && row.parent === process.pid;
        const knownParent = parent && this.known.get(parent.pid);
        if (!direct && (!parent || knownParent?.start !== parent.start || knownParent.exe !== parent.exe)) continue;
        const currentParent = direct ? undefined : await this.identity(parent!, false, deadline);
        if (!direct && (!currentParent || currentParent.start !== parent!.start || currentParent.exe !== parent!.exe)) continue;
        const current = await this.identity(row, false, deadline);
        if (!current || current.start !== row.start || current.exe !== row.exe || current.parent !== row.parent) continue;
        record(current); images.splice(index, 1); accepted = true;
      }
      if (!accepted) throw new Error('Owned executable changed without a currently qualified live parent; cleanup is incomplete.');
    }
    if (!rows.length && this.known.size) this.groupGone = true;
    return rows;
  }
  /** Signal only qualified incarnations, never a potentially reused group. */
  async signal(kind: NodeJS.Signals, deadline = Infinity) {
    const rows = await this.observe(false, undefined, deadline);
    for (const row of rows) {
      const current = await this.identity(row, false, deadline);
      if (current && (current.start !== row.start || current.exe !== row.exe)) throw new Error('Owned process incarnation changed before signalling.');
      if (current) {
        try {process.kill(current.pid, kind);}
        catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;}
      }
    }
  }
}

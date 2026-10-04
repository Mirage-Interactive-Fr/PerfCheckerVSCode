import {ChildProcess, spawn} from 'node:child_process';

export const CANCEL_REQUEST = 'PERFCHECKER_CANCEL/1';
export const CANCELLATION_GRACE_MS = 60_000;

/** The stdin reader runs in the controller, so cancellation unwinds its finally blocks. */
export function cancellableJulia(code: string): string {
  return `
const perfchecker_controller_task = current_task()
@async begin
    try
        for line in eachline(stdin)
            if line == "${CANCEL_REQUEST}"
                istaskdone(perfchecker_controller_task) ||
                    schedule(perfchecker_controller_task, InterruptException(); error=true)
                break
            end
        end
    catch error
        error isa EOFError || println(stderr, "PerfChecker cancellation input: ", sprint(showerror, error))
    end
end
try
    ${code}
catch error
    if error isa InterruptException
        println(stderr, "PerfChecker: cancelled after controller cleanup")
        exit(130)
    end
    rethrow()
end
`;
}

/** Only this owned controller tree is forcibly stopped if cooperative cleanup stalls. */
export function controllerCancellation(child: ChildProcess, notice: (message: string, forced?: boolean) => void,
    graceMs = CANCELLATION_GRACE_MS): {request: () => void; dispose: () => void; readonly forced: boolean} {
  let requested = false, forced = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const alive = () => !!child.pid && child.exitCode === null && child.signalCode === null;
  const dispose = () => {if (timer) clearTimeout(timer); timer = undefined;};
  const force = () => {
    dispose();
    if (!alive()) return;
    forced = true;
    notice('Forced stop: controller cleanup did not finish within one minute. Allocation traces or private inventories may remain; inspect the PerfChecker output.', true);
    if (process.platform === 'win32') {
      const fallback = () => {if (alive()) child.kill('SIGKILL');};
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {windowsHide: true})
        .on('error', fallback).on('close', code => {if (code !== 0) fallback();});
    } else {
      try {process.kill(-child.pid!, 'SIGKILL');} catch {child.kill('SIGKILL');}
    }
  };
  child.once('close', dispose);
  child.once('error', dispose);
  child.stdin?.on('error', error => {
    if (requested && alive()) notice(`Cancellation input unavailable: ${error.message}. Waiting before forced stop.`);
  });
  return {
    get forced() {return forced;}, dispose,
    request() {
      if (requested || !alive()) return;
      requested = true;
      notice('Cancelling… waiting for workers and allocation cleanup.');
      // Keep the pipe open until exit; EOF is not a cancellation request.
      child.stdin?.write(`${CANCEL_REQUEST}\n`, error => {
        if (error && alive()) notice(`Cancellation input unavailable: ${error.message}. Waiting before forced stop.`);
      });
      timer = setTimeout(force, graceMs);
    },
  };
}

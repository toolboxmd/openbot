export const DEFAULT_SCREEN_UPSTREAM = "http://127.0.0.1:6901";
export const SCREEN_SERVICE = "screen";

export type SupervisedChild = {
  pid?: number;
  kill: (signal?: NodeJS.Signals) => boolean;
  wait: () => Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
};

export type SuperviseDeps = {
  composeUp: (service: string) => Promise<void>;
  spawnDaemon: (env: NodeJS.ProcessEnv) => SupervisedChild;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  onSignal: (handler: (signal: NodeJS.Signals) => void) => () => void;
  log?: (message: string) => void;
  minRestartDelayMs?: number;
  maxRestartDelayMs?: number;
  stableAfterMs?: number;
};

export function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    SCREEN_UPSTREAM: env.SCREEN_UPSTREAM || DEFAULT_SCREEN_UPSTREAM,
  };
}

export async function superviseTalk(
  deps: SuperviseDeps,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const minRestartDelayMs = deps.minRestartDelayMs ?? 1_000;
  const maxRestartDelayMs = deps.maxRestartDelayMs ?? 30_000;
  const stableAfterMs = deps.stableAfterMs ?? 10_000;
  const log = deps.log ?? ((message) => console.error(message));

  await deps.composeUp(SCREEN_SERVICE);

  const daemonEnv = childEnv(env);
  let stopping = false;
  let current: SupervisedChild | undefined;
  let delay = minRestartDelayMs;
  let resumeStop!: () => void;
  const stopped = new Promise<void>((resolve) => {
    resumeStop = resolve;
  });

  const unsubscribe = deps.onSignal((signal) => {
    if (stopping) return;
    stopping = true;
    log(`OpenBot start: ${signal}, stopping Talk. Screens that are up stay up.`);
    resumeStop();
  });

  try {
    while (!stopping) {
      const started = deps.now();
      current = deps.spawnDaemon(daemonEnv);
      await Promise.race([current.wait(), stopped]);
      if (stopping) break;
      const lived = deps.now() - started;
      log(`OpenBot start: Talk exited after ${lived}ms; respawning.`);
      const waitFor = delay;
      if (lived >= stableAfterMs) delay = minRestartDelayMs;
      else delay = Math.min(delay * 2, maxRestartDelayMs);
      await Promise.race([deps.sleep(waitFor), stopped]);
    }

    if (current) {
      current.kill("SIGTERM");
      await current.wait();
    }
  } finally {
    unsubscribe();
  }
}

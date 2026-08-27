export type RequestOutcome = "success" | "failure" | "stale";

export type RequestIdentity = {
  signal: AbortSignal;
  isCurrent: () => boolean;
};

export type RequestCallbacks<T> = {
  pending?: () => void;
  success: (value: T) => void;
  failure: (error: unknown) => void;
  settled?: () => void;
};

export function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true
    || (error instanceof DOMException && error.name === "AbortError");
}

export function createLatestRequestScope() {
  let generation = 0;
  let controller: AbortController | null = null;

  function begin(): RequestIdentity {
    controller?.abort();
    const requestController = new AbortController();
    const requestGeneration = ++generation;
    controller = requestController;
    return {
      signal: requestController.signal,
      isCurrent: () => (
        requestGeneration === generation && !requestController.signal.aborted
      ),
    };
  }

  function cancel() {
    generation += 1;
    controller?.abort();
    controller = null;
  }

  async function run<T>(
    request: (signal: AbortSignal) => Promise<T>,
    callbacks: RequestCallbacks<T>,
  ): Promise<RequestOutcome> {
    const identity = begin();
    callbacks.pending?.();
    try {
      const value = await request(identity.signal);
      if (!identity.isCurrent()) return "stale";
      callbacks.success(value);
      return "success";
    } catch (error) {
      if (!identity.isCurrent() || isAbortError(error, identity.signal)) return "stale";
      callbacks.failure(error);
      return "failure";
    } finally {
      if (identity.isCurrent()) {
        controller = null;
        callbacks.settled?.();
      }
    }
  }

  return { begin, cancel, run };
}

export type KeyedRequestIdentity = RequestIdentity & {
  finish: () => boolean;
};

export function createKeyedRequestScope<K>() {
  const controllers = new Map<K, AbortController>();

  function begin(key: K): KeyedRequestIdentity {
    controllers.get(key)?.abort();
    const controller = new AbortController();
    controllers.set(key, controller);
    const isCurrent = () => (
      controllers.get(key) === controller && !controller.signal.aborted
    );
    return {
      signal: controller.signal,
      isCurrent,
      finish() {
        if (!isCurrent()) return false;
        controllers.delete(key);
        return true;
      },
    };
  }

  function cancelAll() {
    for (const controller of controllers.values()) controller.abort();
    controllers.clear();
  }

  return { begin, cancelAll };
}

export type RefreshedAction<T, R = T> =
  | { ok: true; value: T }
  | { ok: false; error: unknown; authoritative: R | null };

export async function runWithAuthoritativeRefresh<T, R = T>(
  action: (signal: AbortSignal) => Promise<T>,
  refresh: (signal: AbortSignal) => Promise<R>,
  signal: AbortSignal,
): Promise<RefreshedAction<T, R>> {
  try {
    const value = await action(signal);
    if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    return { ok: true, value };
  } catch (error) {
    if (isAbortError(error, signal)) throw signal.reason ?? error;
    let authoritative: R | null = null;
    try {
      authoritative = await refresh(signal);
      if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    } catch (refreshError) {
      if (isAbortError(refreshError, signal)) throw signal.reason ?? refreshError;
    }
    return { ok: false, error, authoritative };
  }
}

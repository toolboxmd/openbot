export type SetComputerZoom<T> = (botId: string | null, zoom: boolean) => Promise<T>;

export function createComputerZoomSynchronizer() {
  const transitions = new Map<string | null, Promise<unknown>>();

  function enqueue<T>(botId: string | null, zoom: boolean, setZoom: SetComputerZoom<T>): Promise<T> {
    const previous = transitions.get(botId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => setZoom(botId, zoom));
    transitions.set(botId, next);
    return next;
  }

  return function startComputerZoomSync<T>(
    botId: string | null,
    expanded: boolean,
    setZoom: SetComputerZoom<T>,
    onUpdate?: (computer: T) => void,
  ): () => void {
    let stopped = false;
    const requested = enqueue(botId, expanded, setZoom).then((computer) => {
      if (!stopped) onUpdate?.(computer);
    });
    void requested.catch(() => undefined);

    return () => {
      if (stopped) return;
      stopped = true;
      if (!expanded) return;
      void enqueue(botId, false, setZoom).catch(() => undefined);
    };
  };
}

export const startComputerZoomSync = createComputerZoomSynchronizer();

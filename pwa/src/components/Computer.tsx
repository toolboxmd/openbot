import {
  ComputerOwnershipTransitionError,
  computerCanWrite,
  getComputer,
  releaseComputerForNavigation,
  retryComputer,
  screenCanRetry,
  setComputerZoom,
  type Computer,
} from "@/lib/session";
import { startComputerZoomSync } from "@/lib/computer-zoom";
import { Button } from "@/components/ui/button";
import { Maximize2, MessageSquare } from "lucide-react";
import { createLatestRequestScope } from "@/lib/async-state";
import { cn } from "@/lib/utils";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

function screenSrc(path: string, botId: string | null, viewOnly: boolean): string {
  const url = new URL(path, "http://openbot.local");
  url.searchParams.set("autoconnect", "1");
  url.searchParams.set("resize", "scale");
  url.searchParams.set("path", botId ? `screen/${botId}/websockify` : "screen/websockify");
  // KasmVNC 1.5 disables clipboard_up/seamless when the client is in an iframe.
  // URL params override that default so host Cmd/Ctrl+V reaches the desktop.
  url.searchParams.set("clipboard_up", "true");
  url.searchParams.set("clipboard_down", "true");
  url.searchParams.set("clipboard_seamless", "true");
  // Kasm/noVNC: presence of view_only is truthy. Omit the param to grant control.
  if (viewOnly) url.searchParams.set("view_only", "true");
  return `${url.pathname}${url.search}`;
}

function transitionError(error: unknown): {
  message: string;
  computer: Computer | null;
} {
  if (error instanceof ComputerOwnershipTransitionError) {
    return {
      message: error.computer?.ownershipError ?? error.message,
      computer: error.computer,
    };
  }
  return {
    message: error instanceof Error ? error.message : "Could not change Computer write ownership.",
    computer: null,
  };
}

function ownershipMismatch(computer: Computer, expanded: boolean, botId: string | null): string | null {
  if (computer.ownership === "unknown") {
    return computer.ownershipError ?? "Computer write ownership is unknown.";
  }
  if (expanded && !computerCanWrite(computer, true, botId)) {
    return "Computer stayed view-only. Retry Computer to request write access.";
  }
  return null;
}

function computerMatchesSelection(computer: Computer, botId: string | null): boolean {
  return (computer.botId ?? null) === botId;
}

function screenIsUsable(
  computer: Computer,
  botId: string | null,
): computer is Computer & { path: string; screenState: "ready" } {
  return computerMatchesSelection(computer, botId)
    && computer.screenState === "ready"
    && computer.ready === true
    && typeof computer.path === "string";
}

function screenStateMessage(computer: Computer): string {
  if (computer.screenState === "ready" && computer.ownership === "unknown") {
    return "Computer access needs repair. Chat is still available.";
  }
  if (computer.screenState === "ready" && !computer.ready) {
    return "Screen is reconnecting. Chat is still available.";
  }
  if (computer.screenState === "attaching") {
    return "Screen is attaching. Chat is still available.";
  }
  if (computer.screenState === "unassigned") {
    return "No Screen display is assigned. Chat is still available.";
  }
  if (computer.screenState === "cleanup-required") {
    return computer.screenCleanupError?.message ?? "Screen cleanup is required before recovery can continue.";
  }
  return computer.screenError?.message ?? "Screen is unavailable. Chat is still available.";
}

export function ComputerOwnershipNotice({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div
      role="alert"
      aria-live="assertive"
      className="absolute inset-x-4 top-4 z-30 rounded-xl bg-background/95 p-4 text-sm shadow-lg"
    >
      <p>{message}</p>
      <Button type="button" size="sm" onClick={onRetry} className="mt-3">
        Retry Computer
      </Button>
    </div>
  );
}

export function ComputerScreenStateNotice({
  computer,
  expanded,
  retrying,
  error,
  onClose,
  onRepair,
  onRetry,
}: {
  computer: Computer;
  expanded: boolean;
  retrying: boolean;
  error?: string | null;
  onClose: () => void;
  onRepair?: () => void;
  onRetry?: () => void;
}) {
  return (
    <div
      role={computer.screenState === "cleanup-required" ? "alert" : "status"}
      aria-live="polite"
      className="absolute inset-0 z-40 flex items-center justify-center bg-background px-6"
    >
      <div className="max-w-sm text-center">
        <p className="text-sm text-muted-foreground">{screenStateMessage(computer)}</p>
        {error ? <p role="alert" className="mt-3 text-sm text-destructive">{error}</p> : null}
        {onRetry ? (
          <Button type="button" size="sm" onClick={onRetry} disabled={retrying} className="mt-4">
            {retrying ? "Retrying Screen…" : "Retry Screen"}
          </Button>
        ) : null}
        {onRepair ? (
          <Button type="button" size="sm" onClick={onRepair} className="mt-4">
            Retry Computer
          </Button>
        ) : null}
        {expanded ? (
          <Button type="button" size="sm" variant="outline" onClick={onClose} className="mt-4 ml-2">
            <MessageSquare />
            Chat
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function SelectedBotComputerPreview({
  botName,
  triggerRef,
  onOpen,
  children,
}: {
  botName: string;
  triggerRef: RefObject<HTMLButtonElement | null>;
  onOpen: () => void;
  children: ReactNode;
}) {
  return (
    <div
      data-testid="selected-bot-computer-preview"
      className="relative isolate aspect-[16/10] overflow-hidden rounded-[var(--radius-card)] border bg-black shadow-sm"
    >
      {children}
      <button
        ref={triggerRef}
        type="button"
        data-testid="open-computer-preview"
        aria-label={`Open ${botName}'s Computer`}
        onClick={onOpen}
        className="absolute inset-0 z-10 flex min-h-[var(--touch-min)] items-end justify-end p-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span className="inline-flex min-h-9 items-center gap-2 rounded-[var(--radius-control)] bg-background/90 px-3 text-xs font-medium text-foreground shadow-sm backdrop-blur-sm">
          <Maximize2 className="size-4" />
          Open Computer
        </span>
      </button>
    </div>
  );
}

function ComputerScreenLoadingNotice({
  expanded,
  onClose,
}: {
  expanded: boolean;
  onClose: () => void;
}) {
  return (
    <div
      role="status"
      className="absolute inset-0 z-40 flex items-center justify-center bg-background px-6"
    >
      <div className="text-center">
        <p className="text-sm text-muted-foreground">Opening Computer…</p>
        {expanded ? (
          <Button type="button" size="sm" variant="outline" onClick={onClose} className="mt-4">
            <MessageSquare />
            Chat
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function ComputerScreen({
  botId,
  expanded,
  onClose,
  onFailure,
  showChatButton = true,
}: {
  botId: string | null;
  expanded: boolean;
  onClose: () => void;
  onFailure?: (message: string) => void;
  showChatButton?: boolean;
}) {
  const [computer, setComputer] = useState<Computer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryingScreen, setRetryingScreen] = useState(false);
  const [loadedBotId, setLoadedBotId] = useState<string | null | undefined>(undefined);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const computerRef = useRef<Computer | null>(null);
  const computerRequestRef = useRef(createLatestRequestScope());
  const dismissRequestRef = useRef(createLatestRequestScope());
  const transitionVersion = useRef(0);
  const pendingTransitions = useRef(0);
  const loadSequence = useRef(0);
  const retryRequestSequence = useRef(0);
  const retryRequestRef = useRef<{ id: number; botId: string } | null>(null);
  const selectedBotRef = useRef(botId);
  const expandedRef = useRef(expanded);
  selectedBotRef.current = botId;
  expandedRef.current = expanded;
  computerRef.current = computer;

  useEffect(() => {
    computerRequestRef.current.cancel();
    dismissRequestRef.current.cancel();
    transitionVersion.current += 1;
    retryRequestRef.current = null;
    setRetryingScreen(false);
    setComputer(null);
    setError(null);
    setLoadedBotId(undefined);

    async function refresh(showFailure: boolean) {
      if (pendingTransitions.current > 0 || retryRequestRef.current !== null) return;
      const sequence = ++loadSequence.current;
      const version = transitionVersion.current;
      const canPublish = () => selectedBotRef.current === botId
        && loadSequence.current === sequence
        && pendingTransitions.current === 0
        && retryRequestRef.current === null
        && transitionVersion.current === version;
      await computerRequestRef.current.run(
        (signal) => getComputer(botId, signal),
        {
          success(data) {
            if (!canPublish() || !computerMatchesSelection(data, botId)) return;
            setComputer(data);
            setError(screenIsUsable(data, botId) ? ownershipMismatch(data, expandedRef.current, botId) : null);
            setLoadedBotId(botId);
          },
          failure() {
            if (!canPublish() || !showFailure) return;
            setError("Could not open Computer.");
            setLoadedBotId(botId);
          },
        },
      );
    }

    void refresh(true);
    const tick = window.setInterval(() => void refresh(false), 1500);
    return () => {
      computerRequestRef.current.cancel();
      dismissRequestRef.current.cancel();
      transitionVersion.current += 1;
      if (retryRequestRef.current?.botId === botId) retryRequestRef.current = null;
      loadSequence.current += 1;
      window.clearInterval(tick);
    };
  }, [botId]);

  useEffect(() => {
    if (botId && !computer) return;
    if (computer && !screenIsUsable(computer, botId)) return;

    const setComputerZoomForSelection = async (
      selectedBotId: string | null,
      zoom: boolean,
    ): Promise<Computer> => {
      const version = ++transitionVersion.current;
      pendingTransitions.current += 1;
      computerRequestRef.current.cancel();
      try {
        const data = await setComputerZoom(selectedBotId, zoom, { keepalive: !zoom });
        if (
          transitionVersion.current === version
          && selectedBotRef.current === selectedBotId
          && computerMatchesSelection(data, selectedBotId)
        ) {
          setComputer(data);
          setError(ownershipMismatch(data, zoom, selectedBotId));
          setLoadedBotId(selectedBotId);
        }
        return data;
      } catch (cause) {
        if (transitionVersion.current === version && selectedBotRef.current === selectedBotId) {
          const failure = transitionError(cause);
          if (failure.computer && computerMatchesSelection(failure.computer, selectedBotId)) {
            setComputer(failure.computer);
            setLoadedBotId(selectedBotId);
          }
          setError(failure.message);
        }
        throw cause;
      } finally {
        pendingTransitions.current -= 1;
      }
    };

    return startComputerZoomSync(
      botId,
      expanded,
      setComputerZoomForSelection,
    );
  }, [botId, expanded, computer?.path, computer?.screenState, computer?.ready, computer?.botId]);

  useEffect(() => {
    if (!expanded) return;
    function onHide() {
      if (botId && (!computerRef.current || !screenIsUsable(computerRef.current, botId))) return;
      void releaseComputerForNavigation(botId).catch(() => undefined);
    }
    window.addEventListener("pagehide", onHide);
    window.addEventListener("beforeunload", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      window.removeEventListener("beforeunload", onHide);
    };
  }, [botId, expanded]);

  const currentComputer = loadedBotId === botId ? computer : null;
  const currentError = loadedBotId === botId ? error : null;
  const canWrite = computerCanWrite(currentComputer, expanded, botId);

  useEffect(() => {
    if (!canWrite) return;
    const node = frameRef.current;
    if (!node) return;
    const focus = () => node.focus();
    focus();
    node.addEventListener("load", focus);
    return () => node.removeEventListener("load", focus);
  }, [canWrite, botId, computer?.path]);

  const applyDesiredOwnership = useCallback(async (zoom: boolean): Promise<boolean> => {
    const version = ++transitionVersion.current;
    pendingTransitions.current += 1;
    setError(null);
    try {
      const data = await setComputerZoom(botId, zoom, { keepalive: !zoom });
      if (transitionVersion.current !== version || !computerMatchesSelection(data, botId)) return false;
      setComputer(data);
      const mismatch = ownershipMismatch(data, zoom, botId);
      setError(mismatch);
      return mismatch === null;
    } catch (cause) {
      if (transitionVersion.current !== version) return false;
      const failure = transitionError(cause);
      if (failure.computer && computerMatchesSelection(failure.computer, botId)) {
        setComputer(failure.computer);
      }
      setError(failure.message);
      return false;
    } finally {
      pendingTransitions.current -= 1;
    }
  }, [botId]);

  const dismiss = useCallback(async () => {
    if (botId && (!computer || !screenIsUsable(computer, botId))) {
      onClose();
      return;
    }
    if (await applyDesiredOwnership(false)) {
      onClose();
      return;
    }
    onFailure?.("Could not close Computer. Try again.");
  }, [applyDesiredOwnership, botId, computer, onClose, onFailure]);

  const retryScreenAttachment = useCallback(async () => {
    if (
      !botId
      || !computer
      || !computerMatchesSelection(computer, botId)
      || !screenCanRetry(computer)
      || !computer.screenAttempt
      || retryRequestRef.current !== null
    ) return;
    const request = { id: ++retryRequestSequence.current, botId };
    retryRequestRef.current = request;
    const version = ++transitionVersion.current;
    loadSequence.current += 1;
    setRetryingScreen(true);
    setError(null);
    try {
      const data = await retryComputer(botId, computer.screenAttempt);
      if (
        retryRequestRef.current !== request
        || selectedBotRef.current !== request.botId
        || transitionVersion.current !== version
        || !computerMatchesSelection(data, request.botId)
      ) return;
      setComputer(data);
      setError(null);
    } catch {
      if (
        retryRequestRef.current !== request
        || selectedBotRef.current !== request.botId
        || transitionVersion.current !== version
      ) return;
      setError("Could not retry Screen. Refresh and try again.");
    } finally {
      if (retryRequestRef.current === request) {
        retryRequestRef.current = null;
        if (selectedBotRef.current === request.botId) setRetryingScreen(false);
      }
    }
  }, [botId, computer]);

  useEffect(() => {
    if (!expanded) return;
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      void dismiss();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dismiss, expanded]);

  if (currentError && !currentComputer) {
    return <p className="px-6 text-sm text-muted-foreground" role="alert">{currentError}</p>;
  }

  if (!currentComputer) {
    return <ComputerScreenLoadingNotice expanded={expanded} onClose={onClose} />;
  }

  if (!screenIsUsable(currentComputer, botId)) {
    const canRetrySelected = computerMatchesSelection(currentComputer, botId) && screenCanRetry(currentComputer);
    const canRepairOwnership = computerMatchesSelection(currentComputer, botId)
      && currentComputer.screenState === "ready"
      && currentComputer.ownership === "unknown";
    return (
      <ComputerScreenStateNotice
        computer={currentComputer}
        expanded={expanded}
        retrying={retryingScreen}
        error={error}
        onClose={onClose}
        onRepair={canRepairOwnership ? () => void applyDesiredOwnership(false) : undefined}
        onRetry={canRetrySelected ? () => void retryScreenAttachment() : undefined}
      />
    );
  }

  const viewOnly = !canWrite;
  const path = currentComputer.path;
  const visibleError = currentError ?? ownershipMismatch(currentComputer, expanded, botId);

  return (
    <>
      <iframe
        ref={frameRef}
        title="Computer"
        key={`${botId ?? "computer"}-${viewOnly ? "view" : "write"}`}
        src={screenSrc(path, botId, viewOnly)}
        tabIndex={canWrite ? 0 : -1}
        className={cn(
          "absolute inset-0 z-0 h-full w-full border-0 bg-black",
          canWrite ? "pointer-events-auto" : "pointer-events-none",
          currentComputer.ownership === "unknown" && "invisible",
        )}
        allow="clipboard-read; clipboard-write; fullscreen"
      />
      {visibleError ? (
        <ComputerOwnershipNotice
          message={visibleError}
          onRetry={() => void applyDesiredOwnership(expanded)}
        />
      ) : null}
      {expanded && showChatButton ? (
        <Button
          type="button"
          size="lg"
          aria-label="Back to chat"
          onClick={() => void dismiss()}
          className="absolute top-4 right-4 z-20 h-12 rounded-full px-6 text-base shadow-lg"
        >
          <MessageSquare />
          Chat
        </Button>
      ) : null}
    </>
  );
}

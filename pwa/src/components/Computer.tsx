import {
  ComputerOwnershipTransitionError,
  computerCanWrite,
  getComputer,
  releaseComputerForNavigation,
  setComputerZoom,
  type Computer,
} from "@/lib/session";
import { Button } from "@/components/ui/button";
import { MessageSquare } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCallback, useEffect, useRef, useState } from "react";

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

function ownershipMismatch(computer: Computer, expanded: boolean): string | null {
  if (computer.ownership === "unknown") {
    return computer.ownershipError ?? "Computer write ownership is unknown.";
  }
  if (expanded && !computerCanWrite(computer, true)) {
    return "Computer stayed view-only. Retry Computer to request write access.";
  }
  return null;
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

export function ComputerScreen({
  botId,
  expanded,
  onClose,
}: {
  botId: string | null;
  expanded: boolean;
  onClose: () => void;
}) {
  const [computer, setComputer] = useState<Computer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const transitionVersion = useRef(0);
  const pendingTransitions = useRef(0);
  const loadSequence = useRef(0);
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;

  useEffect(() => {
    let cancelled = false;
    setComputer(null);
    setError(null);
    const load = () => {
      const sequence = ++loadSequence.current;
      const version = transitionVersion.current;
      const startedDuringTransition = pendingTransitions.current > 0;
      const canPublish = () => !cancelled
        && loadSequence.current === sequence
        && !startedDuringTransition
        && pendingTransitions.current === 0
        && transitionVersion.current === version;
      void getComputer(botId)
        .then((data) => {
          if (!canPublish()) return;
          setComputer(data);
          setError(ownershipMismatch(data, expandedRef.current));
        })
        .catch(() => {
          if (canPublish()) setError("Could not open Computer.");
        });
    };
    load();
    const tick = window.setInterval(() => {
      load();
    }, 1500);
    return () => {
      cancelled = true;
      loadSequence.current += 1;
      window.clearInterval(tick);
    };
  }, [botId]);

  useEffect(() => {
    const version = ++transitionVersion.current;
    pendingTransitions.current += 1;
    void setComputerZoom(botId, expanded)
      .then((data) => {
        if (transitionVersion.current !== version) return;
        setComputer(data);
        setError(ownershipMismatch(data, expanded));
      })
      .catch((cause: unknown) => {
        if (transitionVersion.current !== version) return;
        const failure = transitionError(cause);
        if (failure.computer) setComputer(failure.computer);
        setError(failure.message);
      })
      .finally(() => {
        pendingTransitions.current -= 1;
      });
    return () => {
      transitionVersion.current += 1;
      if (expanded) {
        void releaseComputerForNavigation(botId).catch(() => undefined);
      }
    };
  }, [botId, expanded]);

  useEffect(() => {
    if (!expanded) return;
    function onHide() {
      void releaseComputerForNavigation(botId).catch(() => undefined);
    }
    window.addEventListener("pagehide", onHide);
    window.addEventListener("beforeunload", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      window.removeEventListener("beforeunload", onHide);
    };
  }, [botId, expanded]);

  const canWrite = computerCanWrite(computer, expanded, botId);

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
      if (transitionVersion.current !== version) return false;
      setComputer(data);
      const mismatch = ownershipMismatch(data, zoom);
      setError(mismatch);
      return mismatch === null;
    } catch (cause) {
      if (transitionVersion.current !== version) return false;
      const failure = transitionError(cause);
      if (failure.computer) setComputer(failure.computer);
      setError(failure.message);
      return false;
    } finally {
      pendingTransitions.current -= 1;
    }
  }, [botId]);

  const dismiss = useCallback(async () => {
    if (await applyDesiredOwnership(false)) onClose();
  }, [applyDesiredOwnership, onClose]);

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

  const viewOnly = !canWrite;
  const path = computer?.path ?? (botId ? `/screen/${botId}/` : "/screen/");
  const visibleError = error ?? (computer ? ownershipMismatch(computer, expanded) : null);

  if (error && !computer) {
    return (
      <ComputerOwnershipNotice
        message={error}
        onRetry={() => void applyDesiredOwnership(expanded)}
      />
    );
  }

  if (!computer) {
    return <p className="px-6 text-sm text-muted-foreground">Opening Computer…</p>;
  }

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
          computer.ownership === "unknown" && "invisible",
        )}
        allow="clipboard-read; clipboard-write; fullscreen"
      />
      {visibleError ? (
        <ComputerOwnershipNotice
          message={visibleError}
          onRetry={() => void applyDesiredOwnership(expanded)}
        />
      ) : null}
      {expanded ? (
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

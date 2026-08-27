import { getComputer, setComputerZoom, type Computer } from "@/lib/session";
import { startComputerZoomSync } from "@/lib/computer-zoom";
import { Button } from "@/components/ui/button";
import { MessageSquare } from "lucide-react";
import { createLatestRequestScope } from "@/lib/async-state";
import { cn } from "@/lib/utils";
import { useEffect, useRef, useState } from "react";

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
  const [loadedBotId, setLoadedBotId] = useState<string | null | undefined>(undefined);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const computerRequestRef = useRef(createLatestRequestScope());
  const dismissRequestRef = useRef(createLatestRequestScope());

  useEffect(() => {
    computerRequestRef.current.cancel();
    dismissRequestRef.current.cancel();
    setComputer(null);
    setError(null);
    setLoadedBotId(undefined);
    let inFlight = false;
    async function refresh(showFailure: boolean) {
      if (inFlight) return;
      inFlight = true;
      await computerRequestRef.current.run(
        (signal) => getComputer(botId, signal),
        {
          success(data) {
            setComputer(data);
            setError(null);
            setLoadedBotId(botId);
          },
          failure() {
            if (showFailure) {
              setError("Could not open Computer.");
              setLoadedBotId(botId);
            }
          },
        },
      );
      inFlight = false;
    }
    void refresh(true);
    const tick = window.setInterval(() => void refresh(false), 1500);
    return () => {
      computerRequestRef.current.cancel();
      dismissRequestRef.current.cancel();
      window.clearInterval(tick);
    };
  }, [botId]);

  useEffect(() => {
    return startComputerZoomSync(botId, expanded, setComputerZoom, (data) => {
      setComputer(data);
      setError(null);
      setLoadedBotId(botId);
    });
  }, [botId, expanded]);

  useEffect(() => {
    if (!expanded) return;
    function onHide() {
      void setComputerZoom(botId, false).catch(() => undefined);
    }
    window.addEventListener("pagehide", onHide);
    window.addEventListener("beforeunload", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      window.removeEventListener("beforeunload", onHide);
    };
  }, [botId, expanded]);

  useEffect(() => {
    if (!expanded) return;
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      void dismiss();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded, botId]);

  useEffect(() => {
    if (!expanded) return;
    const node = frameRef.current;
    if (!node) return;
    const focus = () => node.focus();
    focus();
    node.addEventListener("load", focus);
    return () => node.removeEventListener("load", focus);
  }, [expanded, botId, computer?.path]);

  async function dismiss() {
    await dismissRequestRef.current.run(
      (signal) => setComputerZoom(botId, false, signal),
      {
        success: onClose,
        failure: () => onFailure?.("Could not close Computer. Try again."),
      },
    );
  }

  const viewOnly = !expanded;
  const currentComputer = loadedBotId === botId ? computer : null;
  const currentError = loadedBotId === botId ? error : null;
  const path = currentComputer?.path ?? (botId ? `/screen/${botId}/` : "/screen/");

  if (currentError && !currentComputer) {
    return <p className="px-6 text-sm text-muted-foreground" role="alert">{currentError}</p>;
  }

  if (!currentComputer) {
    return <p className="px-6 text-sm text-muted-foreground" role="status">Opening Computer…</p>;
  }

  return (
    <>
      <iframe
        ref={frameRef}
        title="Computer"
        key={`${botId ?? "computer"}-${viewOnly ? "view" : "write"}`}
        src={screenSrc(path, botId, viewOnly)}
        tabIndex={expanded ? 0 : -1}
        className={cn(
          "absolute inset-0 z-0 h-full w-full border-0 bg-black",
          expanded ? "pointer-events-auto" : "pointer-events-none",
        )}
        allow="clipboard-read; clipboard-write; fullscreen"
      />
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

import { getComputer, setComputerZoom, type Computer } from "@/lib/session";
import { Button } from "@/components/ui/button";
import { MessageSquare } from "lucide-react";
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
}: {
  botId: string | null;
  expanded: boolean;
  onClose: () => void;
}) {
  const [computer, setComputer] = useState<Computer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getComputer(botId)
      .then((data) => {
        if (!cancelled) setComputer(data);
      })
      .catch(() => {
        if (!cancelled) setError("Could not open Computer.");
      });
    const tick = window.setInterval(() => {
      void getComputer(botId)
        .then((data) => {
          if (!cancelled) setComputer(data);
        })
        .catch(() => undefined);
    }, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(tick);
    };
  }, [botId]);

  useEffect(() => {
    let cancelled = false;
    void setComputerZoom(botId, expanded)
      .then((data) => {
        if (!cancelled) setComputer(data);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
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
    await setComputerZoom(botId, false).catch(() => undefined);
    onClose();
  }

  const viewOnly = !expanded;
  const path = computer?.path ?? (botId ? `/screen/${botId}/` : "/screen/");

  if (error && !computer) {
    return <p className="px-6 text-sm text-muted-foreground">{error}</p>;
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
        tabIndex={expanded ? 0 : -1}
        className={cn(
          "absolute inset-0 z-0 h-full w-full border-0 bg-black",
          expanded ? "pointer-events-auto" : "pointer-events-none",
        )}
        allow="clipboard-read; clipboard-write; fullscreen"
      />
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

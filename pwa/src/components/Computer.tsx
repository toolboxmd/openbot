import { getComputer, releaseTakeover, takeoverBot, viewComputer, type Computer } from "@/lib/session";
import { Button } from "@/components/ui/button";
import { useEffect, useState } from "react";

function screenSrc(path: string, botId: string, viewOnly: boolean): string {
  const url = new URL(path, "http://openbot.local");
  url.searchParams.set("autoconnect", "1");
  url.searchParams.set("resize", "scale");
  url.searchParams.set("path", `screen/${botId}/websockify`);
  // Kasm/noVNC: presence of view_only is truthy. Omit the param to grant control.
  if (viewOnly) url.searchParams.set("view_only", "true");
  return `${url.pathname}${url.search}`;
}

export function ComputerScreen({
  botId,
  screen,
  expanded,
  onClose,
}: {
  botId: string | null;
  screen?: string;
  expanded?: boolean;
  onClose?: () => void;
}) {
  const [computer, setComputer] = useState<Computer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!botId) {
      setComputer(null);
      return;
    }
    const load = expanded ? viewComputer(botId) : getComputer(botId);
    void load
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
  }, [botId, expanded]);

  const held = Boolean(computer?.takeover || computer?.write);
  const viewOnly = computer?.viewOnly !== false && !held;

  useEffect(() => {
    if (!botId || !held) return;
    function onHide() {
      if (!botId) return;
      void releaseTakeover(botId).catch(() => undefined);
    }
    window.addEventListener("pagehide", onHide);
    window.addEventListener("beforeunload", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      window.removeEventListener("beforeunload", onHide);
    };
  }, [botId, held]);

  useEffect(() => {
    if (!expanded) return;
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      void dismiss();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded, held, botId]);

  async function onTakeover() {
    if (!botId) return;
    setBusy(true);
    setError(null);
    try {
      await takeoverBot(botId);
      const data = await getComputer(botId);
      setComputer(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not Takeover.");
    } finally {
      setBusy(false);
    }
  }

  async function onHandBack() {
    if (!botId) return;
    setBusy(true);
    setError(null);
    try {
      await releaseTakeover(botId);
      const data = await getComputer(botId);
      setComputer(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not hand back.");
    } finally {
      setBusy(false);
    }
  }

  async function dismiss() {
    if (held && botId) {
      await releaseTakeover(botId).catch(() => undefined);
    }
    onClose?.();
  }

  if (error && !computer) {
    return <p className="px-6 text-sm text-muted-foreground">{error}</p>;
  }

  if (!botId) {
    return <p className="px-6 text-sm text-muted-foreground">Create a Bot to open a Screen.</p>;
  }

  if (!expanded && (screen === "asleep" || computer?.screen === "asleep")) {
    return <p className="px-6 text-sm text-muted-foreground">Screen is down.</p>;
  }

  if (
    screen === "waking" ||
    computer?.screen === "waking" ||
    (expanded && (screen === "asleep" || computer?.screen === "asleep" || (computer && !computer.ready)))
  ) {
    return <p className="px-6 text-sm text-muted-foreground">Screen is waking…</p>;
  }

  if (!computer) {
    return <p className="px-6 text-sm text-muted-foreground">Opening Computer…</p>;
  }

  if (!computer.ready || !computer.path || !computer.botId) {
    return <p className="px-6 text-sm text-muted-foreground">Screen is not up.</p>;
  }

  return (
    <>
      <iframe
        title="Computer"
        key={`${computer.botId}-${viewOnly ? "view" : "write"}`}
        src={screenSrc(computer.path, computer.botId, viewOnly)}
        className="absolute inset-0 h-full w-full border-0 bg-black"
        allow="clipboard-read; clipboard-write; fullscreen"
      />
      {held ? (
        <div
          data-testid="takeover-banner"
          className="absolute top-4 left-1/2 z-20 flex -translate-x-1/2 items-center gap-3 rounded-full bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground shadow-lg"
        >
          You have the Screen
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => void onHandBack()}
          >
            Hand back
          </Button>
        </div>
      ) : (
        <Button
          type="button"
          size="sm"
          variant={expanded ? "secondary" : "default"}
          disabled={busy}
          onClick={() => void onTakeover()}
          className="absolute bottom-4 left-4 z-20 rounded-full shadow-lg"
        >
          Takeover
        </Button>
      )}
      {expanded ? (
        <Button
          type="button"
          size="lg"
          aria-label="Back to chat"
          onClick={() => void dismiss()}
          className="absolute top-4 right-4 z-20 h-12 rounded-full px-6 text-base shadow-lg"
        >
          Chat
        </Button>
      ) : null}
      {error ? (
        <p className="absolute bottom-4 right-4 z-20 rounded-full bg-destructive px-3 py-1 text-xs text-destructive-foreground">
          {error}
        </p>
      ) : null}
    </>
  );
}

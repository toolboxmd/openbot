import { getComputer, type Computer } from "@/lib/session";
import { useEffect, useState } from "react";

function screenSrc(path: string, botId: string): string {
  const url = new URL(path, "http://openbot.local");
  url.searchParams.set("autoconnect", "1");
  url.searchParams.set("resize", "scale");
  url.searchParams.set("path", `screen/${botId}/websockify`);
  return `${url.pathname}${url.search}`;
}

export function ComputerScreen({ botId, screen }: { botId: string | null; screen?: string }) {
  const [computer, setComputer] = useState<Computer | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!botId) {
      setComputer(null);
      return;
    }
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

  if (error) {
    return <p className="px-6 text-sm text-muted-foreground">{error}</p>;
  }

  if (!botId) {
    return <p className="px-6 text-sm text-muted-foreground">Create a Bot to open a Screen.</p>;
  }

  if (screen === "asleep" || computer?.screen === "asleep") {
    return <p className="px-6 text-sm text-muted-foreground">Screen is asleep.</p>;
  }

  if (screen === "waking" || computer?.screen === "waking" || (computer && !computer.ready)) {
    return <p className="px-6 text-sm text-muted-foreground">Screen is waking…</p>;
  }

  if (!computer) {
    return <p className="px-6 text-sm text-muted-foreground">Opening Computer…</p>;
  }

  if (!computer.ready || !computer.path || !computer.botId) {
    return <p className="px-6 text-sm text-muted-foreground">Screen is not up.</p>;
  }

  return (
    <iframe
      title="Computer"
      src={screenSrc(computer.path, computer.botId)}
      className="absolute inset-0 h-full w-full border-0 bg-black"
      allow="clipboard-read; clipboard-write; fullscreen"
    />
  );
}

import { getComputer, type Computer } from "@/lib/session";
import { useEffect, useState } from "react";

function screenSrc(path: string): string {
  const url = new URL(path, "http://openbot.local");
  url.searchParams.set("autoconnect", "1");
  url.searchParams.set("resize", "remote");
  return `${url.pathname}${url.search}`;
}

export function ComputerScreen() {
  const [computer, setComputer] = useState<Computer | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getComputer()
      .then((data) => {
        if (!cancelled) setComputer(data);
      })
      .catch(() => {
        if (!cancelled) setError("Could not open Computer.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return <p className="px-6 text-sm text-muted-foreground">{error}</p>;
  }

  if (!computer) {
    return <p className="px-6 text-sm text-muted-foreground">Opening Computer…</p>;
  }

  if (!computer.ready) {
    return <p className="px-6 text-sm text-muted-foreground">Screen is not up.</p>;
  }

  return (
    <iframe
      title="Computer"
      src={screenSrc(computer.path)}
      className="h-full w-full border-0 bg-black"
      allow="clipboard-read; clipboard-write; fullscreen"
    />
  );
}

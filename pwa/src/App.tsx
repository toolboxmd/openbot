import { useEffect, useState } from "react";
import { Messenger } from "@/components/Messenger";
import { PasswordGate } from "@/components/PasswordGate";
import { readSession } from "@/lib/session";

type Gate = "loading" | "locked" | "open";

export function App() {
  const [gate, setGate] = useState<Gate>("loading");

  useEffect(() => {
    let cancelled = false;
    void readSession().then((ok) => {
      if (!cancelled) setGate(ok ? "open" : "locked");
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (gate === "loading") {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Opening the PWA…
      </div>
    );
  }

  if (gate === "locked") {
    return <PasswordGate onUnlocked={() => setGate("open")} />;
  }

  return <Messenger />;
}

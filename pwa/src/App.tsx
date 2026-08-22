import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Messenger } from "@/components/Messenger";
import { PasswordGate } from "@/components/PasswordGate";
import { TooltipProvider } from "@/components/ui/tooltip";
import { readSession } from "@/lib/session";

type Gate = "loading" | "locked" | "open";

const fade = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -6 },
};

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

  return (
    <TooltipProvider>
      <AnimatePresence mode="wait">
        {gate === "loading" ? (
          <motion.div
            key="loading"
            {...fade}
            transition={{ duration: 0.2 }}
            className="flex h-full items-center justify-center text-sm text-muted-foreground"
          >
            Opening…
          </motion.div>
        ) : gate === "locked" ? (
          <motion.div key="locked" {...fade} transition={{ duration: 0.25 }} className="h-full">
            <PasswordGate onUnlocked={() => setGate("open")} />
          </motion.div>
        ) : (
          <motion.div key="open" {...fade} transition={{ duration: 0.25 }} className="h-full">
            <Messenger />
          </motion.div>
        )}
      </AnimatePresence>
    </TooltipProvider>
  );
}

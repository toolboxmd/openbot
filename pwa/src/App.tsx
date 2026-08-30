import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Messenger } from "@/components/Messenger";
import { PasswordGate } from "@/components/PasswordGate";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import { createLatestRequestScope } from "@/lib/async-state";
import { readSession } from "@/lib/session";

type Gate = "loading" | "locked" | "open" | "error";

const fade = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -6 },
};

export function App() {
  const [gate, setGate] = useState<Gate>("loading");
  const [openingError, setOpeningError] = useState<string | null>(null);
  const [openingPending, setOpeningPending] = useState(false);
  const sessionRequestRef = useRef(createLatestRequestScope());

  function openSession() {
    void sessionRequestRef.current.run(
      (signal) => readSession(signal),
      {
        pending() {
          setOpeningPending(true);
        },
        success(result) {
          if (result.ok) {
            setGate(result.unlocked ? "open" : "locked");
            return;
          }
          setOpeningError(result.error);
          setGate("error");
        },
        failure() {
          setOpeningError("Could not open OpenBot. Try again.");
          setGate("error");
        },
        settled() {
          setOpeningPending(false);
        },
      },
    );
  }

  useEffect(() => {
    openSession();
    return () => {
      sessionRequestRef.current.cancel();
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
        ) : gate === "error" ? (
          <motion.main
            key="error"
            {...fade}
            transition={{ duration: 0.2 }}
            className="flex h-full items-center justify-center bg-sidebar px-6"
          >
            <div className="grid max-w-sm gap-4 rounded-[var(--radius-card)] border bg-background p-6 text-center">
              <p className="text-sm text-destructive" role="alert">
                {openingError ?? "Could not open OpenBot. Try again."}
              </p>
              <Button type="button" onClick={openSession} disabled={openingPending}>
                {openingPending ? "Opening…" : "Retry"}
              </Button>
            </div>
          </motion.main>
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

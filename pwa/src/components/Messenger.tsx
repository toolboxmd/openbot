import { FormEvent, useEffect, useState } from "react";
import { motion } from "framer-motion";
import { ArrowUp, Monitor } from "lucide-react";
import { ComputerScreen } from "@/components/Computer";
import { Eyes } from "@/components/Eyes";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { listBots, type BotList } from "@/lib/session";

type View = "thread" | "computer";

export function Messenger() {
  const [draft, setDraft] = useState("");
  const [bots, setBots] = useState<BotList["bots"] | null>(null);
  const [view, setView] = useState<View>("thread");

  useEffect(() => {
    let cancelled = false;
    void listBots()
      .then((data) => {
        if (!cancelled) setBots(data.bots);
      })
      .catch(() => {
        if (!cancelled) setBots([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
  }

  return (
    <div data-testid="messenger" className="flex h-full min-h-0 bg-background">
      <aside className="flex w-64 shrink-0 flex-col bg-sidebar text-sidebar-foreground">
        <div className="flex items-center gap-3 px-4 py-4">
          <Eyes size={32} />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">OpenBot</p>
            <button
              type="button"
              onClick={() => setView("computer")}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <Monitor className="size-3" />
              This Computer
            </button>
          </div>
        </div>
        <Separator />
        <div className="flex-1 px-3 py-3">
          {bots && bots.length > 0 ? (
            <ul className="space-y-1">
              {bots.map((bot) => (
                <li key={bot.id}>
                  <button
                    type="button"
                    onClick={() => setView("thread")}
                    className="flex w-full items-center gap-2 rounded-2xl px-3 py-2 text-left text-sm hover:bg-sidebar-accent"
                  >
                    <Eyes name={bot.name} size={28} />
                    {bot.name}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-3 py-4 text-sm text-muted-foreground">No Bots yet.</p>
          )}
        </div>
      </aside>
      <Separator orientation="vertical" />
      {view === "computer" ? (
        <section className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-14 items-center justify-between px-6">
            <h1 className="text-sm font-medium">Computer</h1>
            <Button type="button" variant="ghost" size="sm" onClick={() => setView("thread")}>
              Thread
            </Button>
          </header>
          <Separator />
          <div className="min-h-0 flex-1 bg-black">
            <ComputerScreen />
          </div>
        </section>
      ) : (
        <section className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-14 items-center justify-between px-6">
            <h1 className="text-sm font-medium">Thread</h1>
            <Button type="button" variant="ghost" size="sm" onClick={() => setView("computer")}>
              <Monitor className="size-3.5" />
              Computer
            </Button>
          </header>
          <Separator />
          <div className="flex flex-1 items-center justify-center px-6">
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
              className="flex flex-col items-center gap-4 text-center"
            >
              <Eyes size={140} />
              <p className="text-sm text-muted-foreground">No messages yet.</p>
            </motion.div>
          </div>
          <form onSubmit={onSubmit} className="px-4 pb-5 pt-2">
            <div className="mx-auto flex max-w-2xl items-end gap-2 rounded-[28px] bg-secondary p-2 pl-5">
              <Textarea
                name="draft"
                rows={1}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="Message a Bot…"
                className="min-h-10"
              />
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button type="submit" size="icon" disabled={draft.trim().length === 0} aria-label="Send">
                    <ArrowUp />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Send</TooltipContent>
              </Tooltip>
            </div>
          </form>
        </section>
      )}
    </div>
  );
}

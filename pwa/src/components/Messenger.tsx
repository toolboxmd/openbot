import { FormEvent, useEffect, useState } from "react";
import { motion } from "framer-motion";
import { ArrowUp, Bot, Monitor } from "lucide-react";
import { Mark } from "@/components/Mark";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { listBots, type BotList } from "@/lib/session";

export function Messenger() {
  const [draft, setDraft] = useState("");
  const [bots, setBots] = useState<BotList["bots"] | null>(null);

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
          <Mark size="sm" />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">OpenBot</p>
            <p className="flex items-center gap-1 text-xs text-muted-foreground">
              <Monitor className="size-3" />
              This Computer
            </p>
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
                    className="flex w-full items-center gap-2 rounded-2xl px-3 py-2 text-left text-sm hover:bg-sidebar-accent"
                  >
                    <Bot className="size-4 text-muted-foreground" />
                    {bot.name}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-2 text-center">
              <span className="flex size-10 items-center justify-center rounded-2xl bg-background">
                <Bot className="size-4 text-muted-foreground" />
              </span>
              <p className="text-sm text-muted-foreground">No Bots yet.</p>
            </div>
          )}
        </div>
      </aside>
      <Separator orientation="vertical" />
      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center px-6">
          <h1 className="text-sm font-medium">Thread</h1>
        </header>
        <Separator />
        <div className="flex flex-1 items-center justify-center px-6">
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
            className="flex flex-col items-center gap-3 text-center"
          >
            <span className="flex size-14 items-center justify-center rounded-3xl bg-secondary">
              <Bot className="size-6 text-muted-foreground" />
            </span>
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
    </div>
  );
}

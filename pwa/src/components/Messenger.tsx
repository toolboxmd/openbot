import { FormEvent, useEffect, useState } from "react";
import { ArrowUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
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
    <div data-testid="messenger" className="flex h-full min-h-0">
      <aside className="flex w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
        <div className="border-b border-sidebar-border px-4 py-4">
          <p className="text-xs font-medium tracking-[0.2em] text-primary uppercase">OpenBot</p>
          <p className="mt-1 text-sm text-muted-foreground">This Computer</p>
        </div>
        <div className="flex-1 px-4 py-4">
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Bots</p>
          {bots && bots.length > 0 ? (
            <ul className="mt-3 space-y-1">
              {bots.map((bot) => (
                <li key={bot.id} className="rounded-md px-2 py-2 text-sm">
                  {bot.name}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-4 rounded-lg border border-dashed border-sidebar-border px-3 py-6 text-center text-sm text-muted-foreground">
              No Bots yet.
            </p>
          )}
        </div>
      </aside>
      <section className="flex min-w-0 flex-1 flex-col bg-background">
        <header className="border-b border-border px-6 py-4">
          <h1 className="text-sm font-medium">Thread</h1>
          <p className="text-xs text-muted-foreground">Empty shell. Talk to a Bot comes later.</p>
        </header>
        <div className="flex flex-1 items-center justify-center px-6">
          <p className="max-w-sm text-center text-sm text-muted-foreground">
            No messages. Create a Bot on this Computer when that slice lands.
          </p>
        </div>
        <form onSubmit={onSubmit} className="border-t border-border p-4">
          <div className="mx-auto flex max-w-2xl items-end gap-2 rounded-xl border border-input bg-card p-2">
            <Textarea
              name="draft"
              rows={1}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Message a Bot…"
              className="min-h-10 resize-none border-0 shadow-none focus-visible:ring-0"
            />
            <Button type="submit" size="icon" disabled={draft.trim().length === 0} aria-label="Send">
              <ArrowUp />
            </Button>
          </div>
        </form>
      </section>
    </div>
  );
}

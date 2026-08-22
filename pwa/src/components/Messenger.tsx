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
          <p className="text-sm font-semibold">OpenBot</p>
          <p className="mt-0.5 text-sm text-muted-foreground">This Computer</p>
        </div>
        <div className="flex-1 px-3 py-3">
          {bots && bots.length > 0 ? (
            <ul className="space-y-1">
              {bots.map((bot) => (
                <li key={bot.id} className="rounded-xl px-3 py-2 text-sm">
                  {bot.name}
                </li>
              ))}
            </ul>
          ) : (
            <p className="rounded-xl px-3 py-6 text-sm text-muted-foreground">No Bots yet.</p>
          )}
        </div>
      </aside>
      <section className="flex min-w-0 flex-1 flex-col bg-background">
        <header className="border-b border-border px-6 py-4">
          <h1 className="text-sm font-medium">Thread</h1>
        </header>
        <div className="flex flex-1 items-center justify-center px-6">
          <p className="text-sm text-muted-foreground">No messages yet.</p>
        </div>
        <form onSubmit={onSubmit} className="p-4">
          <div className="mx-auto flex max-w-2xl items-end gap-2 rounded-3xl bg-secondary p-2 pl-4">
            <Textarea
              name="draft"
              rows={1}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Message a Bot…"
              className="min-h-10 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0"
            />
            <Button type="submit" size="icon" className="rounded-full" disabled={draft.trim().length === 0} aria-label="Send">
              <ArrowUp />
            </Button>
          </div>
        </form>
      </section>
    </div>
  );
}

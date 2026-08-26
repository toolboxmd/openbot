import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { getAllBotsAgents, getThisBotAgents, putAllBotsAgents, putThisBotAgents } from "@/lib/session";

export function AgentsEditors({ botId }: { botId: string }) {
  const [open, setOpen] = useState<"all" | "this" | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const load = open === "all" ? getAllBotsAgents() : getThisBotAgents(botId);
    void load.then((next) => {
      if (!cancelled) setText(next);
    });
    return () => {
      cancelled = true;
    };
  }, [botId, open]);

  async function onSave() {
    setBusy(true);
    try {
      if (open === "all") await putAllBotsAgents(text);
      else if (open === "this") await putThisBotAgents(botId, text);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex gap-1">
        <Button
          type="button"
          size="sm"
          variant={open === "all" ? "default" : "ghost"}
          data-testid="all-bots-editor-toggle"
          onClick={() => setOpen(open === "all" ? null : "all")}
          className="max-[47.999rem]:min-h-[var(--touch-min)]"
        >
          All Bots
        </Button>
        <Button
          type="button"
          size="sm"
          variant={open === "this" ? "default" : "ghost"}
          data-testid="this-bot-editor-toggle"
          onClick={() => setOpen(open === "this" ? null : "this")}
          className="max-[47.999rem]:min-h-[var(--touch-min)]"
        >
          This Bot
        </Button>
      </div>
      {open ? (
        <div data-testid={`${open === "all" ? "all-bots" : "this-bot"}-editor`} className="w-72 space-y-2">
          <Textarea
            rows={8}
            value={text}
            onChange={(event) => setText(event.target.value)}
            aria-label={open === "all" ? "All Bots" : "This Bot"}
            className="min-h-32 text-xs"
          />
          <Button type="button" size="sm" disabled={busy} onClick={() => void onSave()}>
            Save
          </Button>
        </div>
      ) : null}
    </div>
  );
}

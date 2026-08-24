import { FormEvent, useEffect, useState } from "react";
import { motion } from "framer-motion";
import { ArrowUp, Maximize2, Monitor, Plus } from "lucide-react";
import { ComputerScreen } from "@/components/Computer";
import { Eyes } from "@/components/Eyes";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { FaceMode, FaceShape } from "@/lib/face";
import {
  answerPermission,
  createBot,
  getBot,
  listBots,
  listHarnesses,
  pickHarness,
  sendMessage,
  type Bot,
  type Harness,
} from "@/lib/session";

export function Messenger() {
  const [draft, setDraft] = useState("");
  const [nameDraft, setNameDraft] = useState("");
  const [creating, setCreating] = useState(false);
  const [bots, setBots] = useState<Bot[]>([]);
  const [harnesses, setHarnesses] = useState<Harness[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [active, setActive] = useState<Bot | null>(null);
  const [computerOpen, setComputerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh(id = activeId) {
    const [listed, available] = await Promise.all([listBots(), listHarnesses()]);
    setBots(listed.bots);
    setHarnesses(available.harnesses);
    if (id) {
      const detail = await getBot(id);
      setActive(detail);
      return detail;
    }
    return null;
  }

  useEffect(() => {
    let cancelled = false;
    void listBots()
      .then(async (data) => {
        if (cancelled) return;
        setBots(data.bots);
        const first = data.bots[0];
        if (first) {
          setActiveId(first.id);
          setActive(await getBot(first.id));
        }
      })
      .catch(() => {
        if (!cancelled) setBots([]);
      });
    void listHarnesses()
      .then((data) => {
        if (!cancelled) setHarnesses(data.harnesses);
      })
      .catch(() => {
        if (!cancelled) setHarnesses([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!activeId) return;
    const tick = window.setInterval(() => {
      void getBot(activeId)
        .then((bot) => {
          setActive(bot);
          setBots((rows) => rows.map((row) => (row.id === bot.id ? { ...row, ...bot } : row)));
        })
        .catch(() => undefined);
    }, 600);
    return () => window.clearInterval(tick);
  }, [activeId]);

  async function onCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = nameDraft.trim();
    if (!name) return;
    setBusy(true);
    setError(null);
    try {
      const bot = await createBot(name);
      setNameDraft("");
      setCreating(false);
      setActiveId(bot.id);
      setActive(bot);
      await refresh(bot.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create Bot.");
    } finally {
      setBusy(false);
    }
  }

  async function onPick(harness: string) {
    if (!activeId || !harness) return;
    setBusy(true);
    setError(null);
    try {
      const bot = await pickHarness(activeId, harness);
      setActive(bot);
      await refresh(activeId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not pick Harness.");
    } finally {
      setBusy(false);
    }
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeId || draft.trim().length === 0) return;
    const text = draft.trim();
    setDraft("");
    setBusy(true);
    setError(null);
    try {
      const bot = await sendMessage(activeId, text);
      setActive(bot);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send.");
    } finally {
      setBusy(false);
    }
  }

  async function onPermission(optionId: string) {
    if (!activeId) return;
    setBusy(true);
    try {
      const bot = await answerPermission(activeId, optionId);
      setActive(bot);
    } finally {
      setBusy(false);
    }
  }

  const messages = active?.messages ?? [];
  const writing = active?.eyes.mode === "write";
  const sidebarMode = (bot: Bot): FaceMode => (bot.eyes.mode === "write" ? "idle" : (bot.eyes.mode as FaceMode));

  function openComputer() {
    setComputerOpen(true);
  }

  return (
    <div data-testid="messenger" className="flex h-full min-h-0 bg-background">
      <aside className="flex w-64 shrink-0 flex-col bg-sidebar text-sidebar-foreground">
        <div className="flex items-center gap-3 px-4 py-4">
          <Eyes size={32} />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">OpenBot</p>
            <p className="flex items-center gap-1 text-xs text-muted-foreground">
              <Monitor className="size-3" />
              This Computer
            </p>
          </div>
        </div>
        <Separator />
        <div className="flex-1 overflow-y-auto px-3 py-3">
          {creating ? (
            <form onSubmit={onCreate} className="mb-3 space-y-2 px-1">
              <Input
                autoFocus
                name="bot-name"
                placeholder="Name"
                value={nameDraft}
                onChange={(event) => setNameDraft(event.target.value)}
              />
              <div className="flex gap-2">
                <Button type="submit" size="sm" disabled={busy || nameDraft.trim().length === 0}>
                  Create
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setCreating(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="mb-3 w-full justify-start"
              onClick={() => setCreating(true)}
            >
              <Plus />
              New Bot
            </Button>
          )}
          {bots.length > 0 ? (
            <ul className="space-y-1">
              {bots.map((bot) => (
                <li key={bot.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setActiveId(bot.id);
                      void getBot(bot.id).then(setActive);
                    }}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-2xl px-3 py-2 text-left text-sm hover:bg-sidebar-accent",
                      activeId === bot.id && "bg-sidebar-accent",
                    )}
                  >
                    <Eyes
                      name={bot.name}
                      color={bot.eyes.color}
                      shape={bot.eyes.shape as FaceShape}
                      mode={sidebarMode(bot)}
                      size={28}
                    />
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
      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center justify-between gap-3 px-6">
          <h1 className="truncate text-sm font-medium">{active?.name ?? "Thread"}</h1>
          {active ? (
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              Harness
              <select
                className="h-8 rounded-full border border-input bg-background px-3 text-sm text-foreground"
                value={active.harness ?? ""}
                disabled={busy}
                onChange={(event) => void onPick(event.target.value)}
              >
                <option value="">Pick a Harness</option>
                {harnesses.map((item) => (
                  <option key={item.id} value={item.id} disabled={!item.talk && item.id !== "codex"}>
                    {item.name}
                    {item.id !== "codex" ? " (detected)" : ""}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </header>
        <Separator />
        {active && messages.length > 0 ? (
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 py-4">
            <ul className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-3">
              {messages.filter((message) => message.text.length > 0).map((message) => (
                <li
                  key={message.id}
                  className={cn(
                    "max-w-[85%] rounded-2xl px-4 py-2 text-sm",
                    message.role === "user"
                      ? "self-end bg-primary text-primary-foreground"
                      : "self-start bg-secondary text-secondary-foreground",
                  )}
                >
                  {message.text}
                </li>
              ))}
            </ul>
            {writing ? (
              <div className="mx-auto mt-3 w-full max-w-2xl">
                <Eyes
                  name={active.name}
                  color={active.eyes.color}
                  shape={active.eyes.shape as FaceShape}
                  mode="write"
                  size={28}
                />
              </div>
            ) : null}
            {active.permission ? (
              <div className="mx-auto mt-3 w-full max-w-2xl rounded-2xl bg-secondary p-4 text-sm">
                <p className="font-medium">{active.permission.title}</p>
                {active.permission.description ? (
                  <p className="mt-1 text-muted-foreground">{active.permission.description}</p>
                ) : null}
                <div className="mt-3 flex flex-wrap gap-2">
                  {active.permission.options.map((option) => (
                    <Button
                      key={option.optionId}
                      type="button"
                      size="sm"
                      variant={option.kind?.startsWith("allow") ? "default" : "outline"}
                      disabled={busy}
                      onClick={() => void onPermission(option.optionId)}
                    >
                      {option.name}
                    </Button>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center px-6">
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
              className="flex flex-col items-center gap-4 text-center"
            >
              <Eyes
                name={active?.name ?? "OpenBot"}
                color={active?.eyes.color}
                shape={active?.eyes.shape as FaceShape | undefined}
                size={140}
              />
              <p className="text-sm text-muted-foreground">
                {active ? "No messages yet." : "Create a Bot to talk."}
              </p>
            </motion.div>
          </div>
        )}
        {error ? (
          <p className="px-6 pb-2 text-center text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        <form onSubmit={onSubmit} className="px-4 pb-5 pt-2">
          <div className="mx-auto flex max-w-2xl items-end gap-2 rounded-[28px] bg-secondary p-2 pl-5">
            <Textarea
              name="draft"
              rows={1}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              placeholder={active ? "Message a Bot…" : "Create a Bot first…"}
              disabled={!active}
              className="min-h-10 resize-none"
            />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="submit"
                  size="icon"
                  disabled={!active || draft.trim().length === 0 || busy || writing}
                  aria-label="Send"
                  className="shrink-0"
                >
                  <ArrowUp />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Send</TooltipContent>
            </Tooltip>
          </div>
        </form>
      </section>
      <Separator orientation="vertical" />
      <aside className="flex w-72 shrink-0 flex-col bg-sidebar text-sidebar-foreground">
        <div className="flex h-14 items-center justify-between gap-2 px-4">
          <div className="flex min-w-0 items-center gap-2">
            <Monitor className="size-3.5 text-muted-foreground" />
            <h2 className="text-sm font-medium">This Computer</h2>
          </div>
          {computerOpen ? null : (
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              data-testid="open-computer"
              aria-label="Open Computer"
              onClick={openComputer}
            >
              <Maximize2 />
            </Button>
          )}
        </div>
        <Separator />
        <div className="p-3">
          <div className={cn(!computerOpen && "relative aspect-video")}>
            <div
              data-testid={computerOpen ? "computer-expanded" : "computer-preview"}
              className={cn(
                "overflow-hidden bg-black",
                computerOpen ? "fixed inset-0 z-50" : "group relative isolate aspect-video rounded-2xl",
              )}
            >
              <ComputerScreen
                botId={activeId}
                expanded={computerOpen}
                onClose={() => setComputerOpen(false)}
              />
              {computerOpen ? null : (
                <button
                  type="button"
                  data-testid="open-computer-preview"
                  aria-label="Open Computer"
                  onClick={openComputer}
                  className="absolute inset-0 z-30 flex cursor-pointer items-center justify-center bg-transparent"
                >
                  <span className="pointer-events-none absolute right-2 top-2 inline-flex size-7 items-center justify-center rounded-full bg-black/60 text-white shadow">
                    <Maximize2 className="size-3.5" />
                  </span>
                  <span className="pointer-events-none inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground shadow-lg opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                    <Maximize2 className="size-4" />
                    Open
                  </span>
                </button>
              )}
            </div>
          </div>
        </div>
      </aside>
    </div>
  );
}

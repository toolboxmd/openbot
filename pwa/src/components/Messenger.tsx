import { FormEvent, Fragment, useEffect, useState, type ReactNode } from "react";
import { motion } from "framer-motion";
import { ArrowUp, Maximize2, Monitor, MoreHorizontal, Plus, Reply, Smile, Users, X } from "lucide-react";
import { ComputerScreen } from "@/components/Computer";
import { Eyes } from "@/components/Eyes";
import { StackedEyes } from "@/components/StackedEyes";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { FaceMode, FaceShape } from "@/lib/face";
import {
  botMembers,
  composerSendEnabled,
  groupDisplayTitle,
  sidebarGroups,
  type Channel,
} from "@/lib/channels";
import {
  answerPermission,
  createBot,
  createGroupChannel,
  getBot,
  getChannel,
  listBots,
  listChannels,
  listHarnesses,
  pickHarness,
  sendMessage,
  toggleReaction,
  type Bot,
  type Harness,
} from "@/lib/session";


type ChatMessage = NonNullable<Bot["messages"]>[number];

function autolink(text: string) {
  return text.split(/(https?:\/\/[^\s<]+)/g).map((part, index) => {
    if (!/^https?:\/\//.test(part)) return <span key={index}>{part}</span>;
    const href = part.replace(/[.,;:!?)]+$/, "");
    const trailing = part.slice(href.length);
    return (
      <span key={index}>
        <a href={href} target="_blank" rel="noreferrer noopener" className="underline underline-offset-2">
          {href}
        </a>
        {trailing}
      </span>
    );
  });
}

function dayLabel(iso: string | undefined, now = new Date()): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const startOfDay = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const diff = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function timeLabel(iso: string | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function sameMinute(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const left = new Date(a);
  const right = new Date(b);
  if (Number.isNaN(left.getTime()) || Number.isNaN(right.getTime())) return false;
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate() &&
    left.getHours() === right.getHours() &&
    left.getMinutes() === right.getMinutes()
  );
}

function receiptLabel(receipt: ChatMessage["receipt"]): string | null {
  if (receipt === "sent") return "Sent";
  if (receipt === "delivered") return "Delivered";
  if (receipt === "read") return "Read";
  return null;
}

/** iMessage-style: latest user bubble always shows its receipt; at most one Read. */
export function showReceipt(
  messages: Array<{ role: string; receipt?: ChatMessage["receipt"] }>,
  index: number,
): boolean {
  const msg = messages[index];
  if (!msg || msg.role !== "user") return false;
  let lastUser = -1;
  let lastRead = -1;
  for (let i = 0; i < messages.length; i++) {
    const row = messages[i];
    if (row.role !== "user") continue;
    lastUser = i;
    if (row.receipt === "read") lastRead = i;
  }
  if (index === lastUser) return true;
  if (msg.receipt !== "read") return false;
  if (lastUser >= 0 && messages[lastUser]?.receipt === "read") return false;
  return index === lastRead;
}

function isCancelledMessage(message: string): boolean {
  return /cancel/i.test(message);
}

function isWorkingMode(mode: FaceMode | undefined): boolean {
  return mode === "write" || mode === "work";
}

const TAPBACKS = ["❤️", "👍", "😂"] as const;

function previewText(text: string, max = 72): string {
  const one = text.replace(/\s+/g, " ").trim();
  if (one.length <= max) return one;
  return `${one.slice(0, max - 1)}…`;
}

function rootsOf(messages: ChatMessage[]): ChatMessage[] {
  const ids = new Set(messages.map((m) => m.id));
  return messages.filter((m) => !m.replyTo || !ids.has(m.replyTo));
}

function childrenOf(messages: ChatMessage[], id: string): ChatMessage[] {
  return messages.filter((m) => m.replyTo === id);
}

function TypingDots() {
  return (
    <span data-testid="typing-dots" aria-label="typing" className="inline-flex items-center gap-[5px] px-0.5 py-1">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="openbot-typing-dot inline-block size-[7px] rounded-full bg-muted-foreground/55"
          style={{ animationDelay: `${i * 140}ms` }}
        />
      ))}
    </span>
  );
}

function HoverActions({
  user,
  open,
  onReply,
  onReact,
  picker,
}: {
  user: boolean;
  open: boolean;
  onReply: () => void;
  onReact: () => void;
  picker: ReactNode;
}) {
  const reactBtn = (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type="button" size="icon-sm" variant="ghost" aria-label="React" onClick={onReact}>
          <Smile />
        </Button>
      </TooltipTrigger>
      <TooltipContent>React</TooltipContent>
    </Tooltip>
  );
  const replyBtn = (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type="button" size="icon-sm" variant="ghost" aria-label="Reply" onClick={onReply}>
          <Reply />
        </Button>
      </TooltipTrigger>
      <TooltipContent>Reply</TooltipContent>
    </Tooltip>
  );
  const moreBtn = (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type="button" size="icon-sm" variant="ghost" aria-label="More" disabled>
          <MoreHorizontal />
        </Button>
      </TooltipTrigger>
      <TooltipContent>More</TooltipContent>
    </Tooltip>
  );
  return (
    <div
      data-testid="bubble-hover-actions"
      onClick={(event) => event.stopPropagation()}
      className={cn(
        "relative flex shrink-0 items-center rounded-full border border-border bg-background/95 shadow-sm",
        "opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100",
        open && "opacity-100",
      )}
    >
      {user ? (
        <>
          {moreBtn}
          {replyBtn}
          {reactBtn}
        </>
      ) : (
        <>
          {reactBtn}
          {replyBtn}
          {moreBtn}
        </>
      )}
      {picker}
    </div>
  );
}

export function Messenger() {
  const [draft, setDraft] = useState("");
  const [nameDraft, setNameDraft] = useState("");
  const [creating, setCreating] = useState<false | "bot" | "group">(false);
  const [bots, setBots] = useState<Bot[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [harnesses, setHarnesses] = useState<Harness[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [active, setActive] = useState<Bot | null>(null);
  const [activeGroup, setActiveGroup] = useState<Channel | null>(null);
  const [groupTitleDraft, setGroupTitleDraft] = useState("");
  const [groupBotIds, setGroupBotIds] = useState<string[]>([]);
  const [computerOpen, setComputerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [reactingId, setReactingId] = useState<string | null>(null);

  async function refresh(id = activeId) {
    const [listed, available, channelList] = await Promise.all([listBots(), listHarnesses(), listChannels()]);
    setBots(listed.bots);
    setHarnesses(available.harnesses);
    setChannels(channelList.channels);
    if (id) {
      const detail = await getBot(id);
      setActive(detail);
      setActiveGroup(null);
      return detail;
    }
    if (activeGroup) {
      const detail = await getChannel(activeGroup.id);
      setActiveGroup(detail);
      return null;
    }
    return null;
  }

  useEffect(() => {
    let cancelled = false;
    void Promise.all([listBots(), listChannels()])
      .then(async ([data, channelList]) => {
        if (cancelled) return;
        setBots(data.bots);
        setChannels(channelList.channels);
        const first = data.bots[0];
        if (first) {
          setActiveId(first.id);
          setActive(await getBot(first.id));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setBots([]);
          setChannels([]);
        }
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
    setReplyTo(null);
    setReactingId(null);
  }, [activeId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setReactingId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
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
      setActiveGroup(null);
      await refresh(bot.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create Bot.");
    } finally {
      setBusy(false);
    }
  }

  async function onCreateGroup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (groupBotIds.length < 2) return;
    setBusy(true);
    setError(null);
    try {
      const channel = await createGroupChannel({
        title: groupTitleDraft.trim() || undefined,
        botIds: groupBotIds,
      });
      setGroupTitleDraft("");
      setGroupBotIds([]);
      setCreating(false);
      setActiveId(null);
      setActive(null);
      setActiveGroup(channel);
      await refresh();
      const detail = await getChannel(channel.id);
      setActiveGroup(detail);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create group Channel.");
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
    if (!composerSendEnabled(activeGroup ? "group" : active ? "direct" : null)) return;
    if (!activeId || draft.trim().length === 0) return;
    const text = draft.trim();
    const targetId = replyTo?.id;
    setDraft("");
    setBusy(true);
    setError(null);
    try {
      const bot = await sendMessage(activeId, text, targetId);
      setActive(bot);
      setReplyTo(null);
    } catch (err) {
      setDraft(text);
      const message = err instanceof Error ? err.message : "Could not send.";
      if (!isCancelledMessage(message)) setError(message);
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

  async function onReact(messageId: string, emoji: string) {
    if (!activeId) return;
    try {
      const bot = await toggleReaction(activeId, messageId, emoji);
      setActive(bot);
      setReactingId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not react.");
    }
  }

  function renderBubble(message: ChatMessage, prev: ChatMessage | undefined, nested: boolean) {
    const user = message.role === "user";
    const index = visible.findIndex((row) => row.id === message.id);
    const grouped = Boolean(prev && prev.role === message.role && sameMinute(prev.createdAt, message.createdAt));
    const time = grouped || nested ? null : timeLabel(message.createdAt);
    const receipt = user && showReceipt(visible, index) ? receiptLabel(message.receipt) : null;
    const kids = childrenOf(visible, message.id);
    const open = reactingId === message.id;
    const mine = (message.reactions ?? []).map((item) => item.emoji);
    const picker = open ? (
      <div
        data-testid="emoji-picker"
        className={cn(
          "absolute top-full z-20 mt-1 flex gap-1 rounded-full border border-border bg-background px-1.5 py-1 shadow-md",
          user ? "right-0" : "left-0",
        )}
      >
        {TAPBACKS.map((emoji) => (
          <button
            key={emoji}
            type="button"
            aria-label={`React ${emoji}`}
            aria-pressed={mine.includes(emoji)}
            onClick={() => void onReact(message.id, emoji)}
            className={cn(
              "flex size-8 items-center justify-center rounded-full text-base hover:bg-accent",
              mine.includes(emoji) && "bg-accent",
            )}
          >
            {emoji}
          </button>
        ))}
      </div>
    ) : null;
    return (
      <li
        key={message.id}
        data-reply-to={message.replyTo}
        className={cn(
          "group flex flex-col gap-1",
          nested ? "max-w-full" : "max-w-[85%]",
          user ? "self-end items-end" : "self-start items-start",
        )}
      >
        {time ? (
          <time className="px-1 text-[11px] text-muted-foreground" dateTime={message.createdAt}>
            {time}
          </time>
        ) : null}
        <div className={cn("flex items-end gap-1", user ? "flex-row-reverse" : "flex-row")}>
          <div className={cn("relative", message.reactions && message.reactions.length > 0 && "mb-2 pb-1")}>
            <div
              className={cn(
                "rounded-2xl px-4 py-2 text-sm whitespace-pre-wrap break-words",
                user ? "bg-primary text-primary-foreground" : "bg-secondary text-secondary-foreground",
                nested && "text-[13px]",
              )}
            >
              {autolink(message.text)}
            </div>
            {message.reactions && message.reactions.length > 0 ? (
              <div
                data-testid="reaction-badge"
                className={cn(
                  "absolute -bottom-2 flex gap-0.5 rounded-full border border-border bg-background px-1.5 py-0.5 text-[13px] leading-none shadow-sm",
                  user ? "left-1" : "right-1",
                )}
              >
                {message.reactions.map((item) => (
                  <span key={`${item.emoji}:${item.by}`}>{item.emoji}</span>
                ))}
              </div>
            ) : null}
          </div>
          <HoverActions
            user={user}
            open={open}
            onReply={() => {
              setReplyTo(message);
              setReactingId(null);
            }}
            onReact={() => setReactingId(open ? null : message.id)}
            picker={picker}
          />
        </div>
        {receipt ? <span className="px-1 text-[11px] text-muted-foreground">{receipt}</span> : null}
        {kids.length > 0 ? (
          <ul
            data-testid="reply-thread"
            className={cn(
              "mt-2 flex w-[calc(100%+0.5rem)] flex-col gap-2 border-border",
              user ? "mr-1 items-end border-r pr-3" : "ml-1 items-start border-l pl-3",
            )}
          >
            {kids.map((child, i) => (
              <Fragment key={child.id}>{renderBubble(child, i > 0 ? kids[i - 1] : message, true)}</Fragment>
            ))}
          </ul>
        ) : null}
      </li>
    );
  }

  const messages = active?.messages ?? [];
  const visible = messages.filter((message) => message.text.length > 0);
  const writing = isWorkingMode(active?.eyes.mode);
  const sidebarMode = (bot: Bot): FaceMode =>
    isWorkingMode(bot.eyes.mode) ? "idle" : (bot.eyes.mode as FaceMode);

  function openComputer() {
    setComputerOpen(true);
  }

  return (
    <div data-testid="messenger" className="flex h-full min-h-0 bg-background">
      <aside className="flex w-64 shrink-0 flex-col bg-sidebar text-sidebar-foreground">
        <div className="flex items-center gap-3 px-4 py-4">
          <Eyes size={32} className="aspect-square shrink-0" />
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
          {creating === "bot" ? (
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
          ) : creating === "group" ? (
            <form onSubmit={onCreateGroup} className="mb-3 space-y-2 px-1">
              <Input
                autoFocus
                name="group-title"
                placeholder="Title (optional)"
                value={groupTitleDraft}
                onChange={(event) => setGroupTitleDraft(event.target.value)}
              />
              <div className="space-y-1">
                {bots.map((bot) => (
                  <label key={bot.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={groupBotIds.includes(bot.id)}
                      onChange={(event) => {
                        setGroupBotIds((ids) =>
                          event.target.checked ? [...ids, bot.id] : ids.filter((id) => id !== bot.id),
                        );
                      }}
                    />
                    {bot.name}
                  </label>
                ))}
              </div>
              <div className="flex gap-2">
                <Button type="submit" size="sm" disabled={busy || groupBotIds.length < 2}>
                  Create
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setCreating(false);
                    setGroupBotIds([]);
                    setGroupTitleDraft("");
                  }}
                >
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <div className="mb-3 space-y-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="w-full justify-start"
                onClick={() => setCreating("bot")}
              >
                <Plus />
                New Bot
              </Button>
              {bots.length >= 2 ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="w-full justify-start"
                  data-testid="new-group"
                  onClick={() => setCreating("group")}
                >
                  <Users />
                  New group
                </Button>
              ) : null}
            </div>
          )}
          {bots.length > 0 ? (
            <ul className="space-y-1">
              {bots.map((bot) => (
                <li key={bot.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setActiveId(bot.id);
                      setActiveGroup(null);
                      void getBot(bot.id).then(setActive);
                    }}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-2xl px-3 py-2 text-left text-sm hover:bg-sidebar-accent",
                      activeId === bot.id && !activeGroup && "bg-sidebar-accent",
                    )}
                  >
                    <Eyes
                      name={bot.name}
                      color={bot.eyes.color}
                      shape={bot.eyes.shape as FaceShape}
                      mode={sidebarMode(bot)}
                      size={28}
                      className="aspect-square shrink-0"
                    />
                    {bot.name}
                  </button>
                </li>
              ))}
              {sidebarGroups(channels).map((channel) => (
                <li key={channel.id}>
                  <button
                    type="button"
                    data-testid="group-channel-row"
                    onClick={() => {
                      setActiveId(null);
                      setActive(null);
                      void getChannel(channel.id).then(setActiveGroup);
                    }}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-2xl px-3 py-2 text-left text-sm hover:bg-sidebar-accent",
                      activeGroup?.id === channel.id && "bg-sidebar-accent",
                    )}
                  >
                    <StackedEyes
                      faces={botMembers(channel).map((member) => ({
                        name: member.name,
                        color: member.eyes?.color,
                        shape: member.eyes?.shape,
                      }))}
                    />
                    <span className="truncate">{groupDisplayTitle(channel)}</span>
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
          <h1 className="truncate text-sm font-medium">
            {activeGroup ? groupDisplayTitle(activeGroup) : (active?.name ?? "Thread")}
          </h1>
          {active && !activeGroup ? (
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
        {activeGroup ? (
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 py-6">
            <div data-testid="group-members" className="mx-auto w-full max-w-2xl">
              <p className="mb-4 text-sm text-muted-foreground">Members</p>
              <ul className="space-y-2">
                {activeGroup.members.map((member) => (
                  <li key={`${member.kind}:${member.id}`} className="flex items-center gap-3 text-sm">
                    {member.kind === "bot" ? (
                      <Eyes
                        name={member.name}
                        color={member.eyes?.color}
                        shape={member.eyes?.shape as FaceShape | undefined}
                        size={32}
                        className="aspect-square shrink-0"
                      />
                    ) : (
                      <span className="flex size-8 items-center justify-center rounded-full bg-secondary text-xs font-medium">
                        You
                      </span>
                    )}
                    {member.name}
                  </li>
                ))}
              </ul>
              <p className="mt-6 text-sm text-muted-foreground">Sending in a group is not this slice.</p>
            </div>
          </div>
        ) : active && messages.length > 0 ? (
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 py-4">
            <ul className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-3">
              {rootsOf(visible).map((message, index, roots) => {
                const day = dayLabel(message.createdAt);
                const prevDay = index > 0 ? dayLabel(roots[index - 1]?.createdAt) : null;
                const showDay = Boolean(day && day !== prevDay);
                const prev = index > 0 ? roots[index - 1] : undefined;
                return (
                  <Fragment key={message.id}>
                    {showDay ? (
                      <li className="self-center py-2 text-[11px] font-medium text-muted-foreground">{day}</li>
                    ) : null}
                    {renderBubble(message, prev, false)}
                  </Fragment>
                );
              })}
              {writing ? (
                <li
                  data-testid="working-indicator"
                  className="flex max-w-[85%] flex-col items-start gap-1.5 self-start"
                >
                  <TypingDots />
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span
                        data-testid="working-eyes"
                        className="inline-flex"
                        title={`${active.name} is working`}
                        aria-label={`${active.name} is working`}
                      >
                        <Eyes
                          name={active.name}
                          color={active.eyes.color}
                          shape={active.eyes.shape as FaceShape}
                          mode={active.eyes.mode === "work" ? "work" : "write"}
                          size={28}
                        />
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>{`${active.name} is working`}</TooltipContent>
                  </Tooltip>
                </li>
              ) : null}
            </ul>
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
          <div className="mx-auto flex max-w-2xl flex-col gap-2">
            {replyTo ? (
              <div
                data-testid="reply-preview"
                className="flex items-center gap-2 rounded-2xl bg-secondary px-4 py-2 text-sm"
              >
                <Reply className="size-3.5 shrink-0 text-muted-foreground" />
                <p className="min-w-0 flex-1 truncate text-muted-foreground">
                  <span className="font-medium text-foreground">
                    {replyTo.role === "user" ? "You" : (active?.name ?? "Bot")}
                  </span>
                  {": "}
                  {previewText(replyTo.text)}
                </p>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Cancel reply"
                  onClick={() => setReplyTo(null)}
                >
                  <X />
                </Button>
              </div>
            ) : null}
            <div className="flex items-end gap-2 rounded-[28px] bg-secondary p-2 pl-5">
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
              placeholder={
                activeGroup
                  ? "Sending in a group is not this slice."
                  : !active
                    ? "Create a Bot first…"
                    : replyTo
                      ? "Reply…"
                      : "Message a Bot…"
              }
              disabled={!composerSendEnabled(activeGroup ? "group" : active ? "direct" : null)}
              className="min-h-10 resize-none"
            />
            {composerSendEnabled(activeGroup ? "group" : active ? "direct" : null) ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="submit"
                  size="icon"
                  data-testid="composer-send"
                  disabled={!active || draft.trim().length === 0 || busy}
                  aria-label="Send"
                  className="shrink-0"
                >
                  <ArrowUp />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Send</TooltipContent>
            </Tooltip>
            ) : null}
            </div>
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

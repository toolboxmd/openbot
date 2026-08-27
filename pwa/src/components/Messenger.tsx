import { FormEvent, Fragment, useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { ArrowUp, Menu, MessageSquare, Monitor, Plug, Plus, Reply, Settings, Smile, X } from "lucide-react";
import { AppSettings } from "@/components/AppSettings";
import { BotSettings } from "@/components/BotSettings";
import { ComputerScreen } from "@/components/Computer";
import { Eyes } from "@/components/Eyes";
import {
  BotsLoadError,
  ChatDetailError,
  ChatDetailLoading,
  EmptyChatStart,
  LoadingHome,
  Plugins,
  Welcome,
} from "@/components/FirstUse";
import { MessengerShell, type MobileSurface } from "@/components/MessengerShell";
import { NewBotDialog } from "@/components/NewBotDialog";
import { StackedEyes } from "@/components/StackedEyes";
import { useUiPreferences } from "@/components/UiPreferencesProvider";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { HostGrantCard } from "@/components/HostGrantCard";
import { isHostGrantPermission } from "@/lib/harness-home";
import {
  botSettingsHash,
  parseBotSettingsHash,
  type BotSettingsSection,
} from "@/lib/bot-settings";
import { computerPaneIsOpen } from "@/lib/ui-preferences";
import {
  botListViewState,
  canSendDirectMessage,
  chatDetailViewState,
  computerToCloseForDirectPluginsReturn,
  computerVisibleDuringPluginsReturn,
  globalRouteFromHash,
  isInternalPluginsEntry,
  pluginsDirectReturnDestination,
  pluginsHistoryState,
  resolvedPluginsReturnTarget,
  type GlobalRoute,
  type PluginsReturnTarget,
} from "@/lib/first-use";
import {
  answerHostGrant,
  answerPermission,
  createBot,
  getBot,
  getChannel,
  listBots,
  listChannels,
  listHarnesses,
  sendMessage,
  toggleReaction,
  type Bot,
  type Harness,
} from "@/lib/session";


type ChatMessage = NonNullable<Bot["messages"]>[number];
type RemoteListState = "loading" | "ready" | "error";

function clearBotSettingsLocation() {
  window.history.replaceState(
    window.history.state,
    "",
    `${window.location.pathname}${window.location.search}`,
  );
}

function botSettingsLocationCandidate(hash: string): boolean {
  return hash.startsWith("#bots/");
}

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
          {replyBtn}
          {reactBtn}
        </>
      ) : (
        <>
          {reactBtn}
          {replyBtn}
        </>
      )}
      {picker}
    </div>
  );
}

export function Messenger() {
  const [draft, setDraft] = useState("");
  const [bots, setBots] = useState<Bot[]>([]);
  const [botsReady, setBotsReady] = useState(false);
  const [botsLoadError, setBotsLoadError] = useState(false);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [channelsState, setChannelsState] = useState<RemoteListState>("loading");
  const [harnesses, setHarnesses] = useState<Harness[]>([]);
  const [harnessesState, setHarnessesState] = useState<RemoteListState>("loading");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [active, setActive] = useState<Bot | null>(null);
  const [activeDetailErrorId, setActiveDetailErrorId] = useState<string | null>(null);
  const [activeGroup, setActiveGroup] = useState<Channel | null>(null);
  const [mobileSurface, setMobileSurface] = useState<MobileSurface>("chat");
  const [globalRoute, setGlobalRoute] = useState<GlobalRoute>(() => globalRouteFromHash(window.location.hash));
  const [newBotOpen, setNewBotOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [reactingId, setReactingId] = useState<string | null>(null);
  const openChatsButtonRef = useRef<HTMLButtonElement | null>(null);
  const closeChatsButtonRef = useRef<HTMLButtonElement | null>(null);
  const computerButtonRef = useRef<HTMLButtonElement | null>(null);
  const closeComputerButtonRef = useRef<HTMLButtonElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const createMenuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const newBotOpenerRef = useRef<HTMLButtonElement | null>(null);
  const newBotDestinationRef = useRef<HTMLButtonElement | null>(null);
  const welcomePluginsRef = useRef<HTMLButtonElement | null>(null);
  const sidebarPluginsRef = useRef<HTMLButtonElement | null>(null);
  const loadingHomeRef = useRef<HTMLElement | null>(null);
  const botsLoadErrorRef = useRef<HTMLElement | null>(null);
  const welcomeDestinationRef = useRef<HTMLElement | null>(null);
  const chatRegionRef = useRef<HTMLElement | null>(null);
  const pluginsReturnTargetRef = useRef<PluginsReturnTarget | null>(null);
  const botSettingsOpenerRef = useRef<HTMLButtonElement | null>(null);
  const activeIdRef = useRef<string | null>(null);
  const activeGroupIdRef = useRef<string | null>(null);
  const botSettingsNavigationRef = useRef(0);
  const previousGlobalRouteRef = useRef(globalRoute);
  const [botSettingsOpen, setBotSettingsOpen] = useState(false);
  const [botSettingsSection, setBotSettingsSection] = useState<BotSettingsSection>("ai");
  const { preferences, updateComputerPane } = useUiPreferences();
  const computerOpen = computerPaneIsOpen(preferences, activeId);
  const visibleComputerOpen = computerVisibleDuringPluginsReturn({
    computerOpen,
    returnTarget: pluginsReturnTargetRef.current,
  });
  const composerKind = activeGroup ? "group" : active?.messages !== undefined ? "direct" : null;

  function activateBot(bot: Bot) {
    activeIdRef.current = bot.id;
    activeGroupIdRef.current = null;
    setActiveId(bot.id);
    setActive(bot);
    setActiveDetailErrorId(null);
    setActiveGroup(null);
  }

  function mergeBot(bot: Bot) {
    setBots((rows) => rows.map((row) => (row.id === bot.id ? { ...row, ...bot } : row)));
    if (activeIdRef.current === bot.id) {
      setActive(bot);
      if (bot.messages !== undefined) setActiveDetailErrorId(null);
    }
  }

  useEffect(() => {
    let cancelled = false;
    const navigation = ++botSettingsNavigationRef.current;
    void listBots()
      .then((data) => {
        if (cancelled) return;
        setBots(data.bots);
        setBotsLoadError(false);
        setBotsReady(true);
        const requestedSettings = parseBotSettingsHash(window.location.hash);
        const requestedBot = data.bots.find((bot) => bot.id === requestedSettings?.botId);
        if ((requestedSettings && !requestedBot) || (!requestedSettings && botSettingsLocationCandidate(window.location.hash))) {
          clearBotSettingsLocation();
        }
        const selected = requestedBot ?? data.bots[0];
        if (!selected) return;
        activateBot(selected);
        void getBot(selected.id)
          .then((bot) => {
            if (cancelled) return;
            mergeBot(bot);
            if (navigation !== botSettingsNavigationRef.current) return;
            if (requestedSettings?.botId === bot.id) {
              setBotSettingsSection(requestedSettings.section);
              setBotSettingsOpen(true);
            }
          })
          .catch(() => {
            if (cancelled) return;
            if (activeIdRef.current === selected.id) setActiveDetailErrorId(selected.id);
            if (navigation !== botSettingsNavigationRef.current) return;
            setBotSettingsOpen(false);
            if (requestedSettings) clearBotSettingsLocation();
          });
      })
      .catch(() => {
        if (!cancelled) {
          setBotsLoadError(true);
          setBotsReady(true);
        }
      });
    void listChannels()
      .then((data) => {
        if (cancelled) return;
        setChannels(data.channels);
        setChannelsState("ready");
      })
      .catch(() => {
        if (!cancelled) setChannelsState("error");
      });
    void listHarnesses()
      .then((data) => {
        if (cancelled) return;
        setHarnesses(data.harnesses);
        setHarnessesState("ready");
      })
      .catch(() => {
        if (!cancelled) setHarnessesState("error");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const syncBotSettingsLocation = () => {
      const navigation = ++botSettingsNavigationRef.current;
      const requested = parseBotSettingsHash(window.location.hash);
      if (!requested) {
        setBotSettingsOpen(false);
        if (botSettingsLocationCandidate(window.location.hash)) clearBotSettingsLocation();
        return;
      }
      if (requested.botId === activeIdRef.current) {
        setBotSettingsSection(requested.section);
        setMobileSurface("chat");
        setBotSettingsOpen(true);
        return;
      }
      setBotSettingsOpen(false);
      void getBot(requested.botId)
        .then((bot) => {
          if (cancelled || navigation !== botSettingsNavigationRef.current) return;
          activateBot(bot);
          setBotSettingsSection(requested.section);
          setMobileSurface("chat");
          setBotSettingsOpen(true);
        })
        .catch(() => {
          if (cancelled || navigation !== botSettingsNavigationRef.current) return;
          setBotSettingsOpen(false);
          clearBotSettingsLocation();
        });
    };
    window.addEventListener("hashchange", syncBotSettingsLocation);
    window.addEventListener("popstate", syncBotSettingsLocation);
    return () => {
      cancelled = true;
      window.removeEventListener("hashchange", syncBotSettingsLocation);
      window.removeEventListener("popstate", syncBotSettingsLocation);
    };
  }, []);

  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  useEffect(() => {
    const syncGlobalRoute = () => {
      const next = globalRouteFromHash(window.location.hash);
      if (
        previousGlobalRouteRef.current === "plugins" &&
        next === "chat" &&
        pluginsReturnTargetRef.current === null
      ) {
        pluginsReturnTargetRef.current = "direct";
      }
      setGlobalRoute(next);
    };
    window.addEventListener("hashchange", syncGlobalRoute);
    window.addEventListener("popstate", syncGlobalRoute);
    return () => {
      window.removeEventListener("hashchange", syncGlobalRoute);
      window.removeEventListener("popstate", syncGlobalRoute);
    };
  }, []);

  useEffect(() => {
    const previous = previousGlobalRouteRef.current;
    previousGlobalRouteRef.current = globalRoute;
    if (previous !== "plugins" || globalRoute !== "chat") return;
    const returnTarget = resolvedPluginsReturnTarget(pluginsReturnTargetRef.current);
    if (returnTarget === "direct") {
      pluginsReturnTargetRef.current = "direct";
      setMobileSurface("chat");
      return;
    }
    pluginsReturnTargetRef.current = null;
    if (returnTarget === "sidebar") setMobileSurface("sidebar");
    const frame = window.requestAnimationFrame(() => {
      if (returnTarget === "welcome") welcomePluginsRef.current?.focus();
      if (returnTarget === "sidebar") sidebarPluginsRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [globalRoute]);

  useEffect(() => {
    if (globalRoute !== "chat" || pluginsReturnTargetRef.current !== "direct") return;
    const destination = pluginsDirectReturnDestination({
      ready: botsReady,
      failed: botsLoadError,
      count: bots.length,
    });
    const computerToClose = computerToCloseForDirectPluginsReturn({
      activeId,
      computerOpen,
      destination,
    });
    if (computerToClose) {
      updateComputerPane(computerToClose, false);
      return;
    }
    if (destination === "chat" && (mobileSurface !== "chat" || computerOpen)) return;
    const frame = window.requestAnimationFrame(() => {
      const target = destination === "loading"
        ? loadingHomeRef.current
        : destination === "error"
          ? botsLoadErrorRef.current
          : destination === "welcome"
            ? welcomeDestinationRef.current
            : chatRegionRef.current;
      target?.focus();
      if (destination !== "loading" && target && document.activeElement === target) {
        pluginsReturnTargetRef.current = null;
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeId, bots.length, botsLoadError, botsReady, computerOpen, globalRoute, mobileSurface]);

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
    let cancelled = false;
    const tick = window.setInterval(() => {
      void getBot(activeId)
        .then((bot) => {
          if (!cancelled) mergeBot(bot);
        })
        .catch(() => undefined);
    }, 600);
    return () => {
      cancelled = true;
      window.clearInterval(tick);
    };
  }, [activeId]);

  function openCreatedBot(bot: Bot) {
    botSettingsNavigationRef.current += 1;
    setBotSettingsOpen(false);
    if (parseBotSettingsHash(window.location.hash)) clearBotSettingsLocation();
    setError(null);
    setBots((rows) => [...rows.filter((row) => row.id !== bot.id), bot]);
    setBotsReady(true);
    activateBot(bot);
    setMobileSurface("chat");
  }

  function openNewBot(event: MouseEvent<HTMLButtonElement>) {
    newBotOpenerRef.current = event.currentTarget;
    setNewBotOpen(true);
  }

  function openNewBotFromMenu() {
    newBotOpenerRef.current = createMenuTriggerRef.current;
    setNewBotOpen(true);
  }

  function openPlugins(returnTarget: PluginsReturnTarget) {
    pluginsReturnTargetRef.current = returnTarget;
    botSettingsNavigationRef.current += 1;
    setBotSettingsOpen(false);
    setMobileSurface("chat");
    setGlobalRoute("plugins");
    window.history.pushState(
      pluginsHistoryState(window.history.state),
      "",
      `${window.location.pathname}${window.location.search}#plugins`,
    );
  }

  function closePlugins() {
    pluginsReturnTargetRef.current ??= "direct";
    if (isInternalPluginsEntry(window.history.state)) {
      window.history.back();
      return;
    }
    setGlobalRoute("chat");
    clearBotSettingsLocation();
  }

  function chooseSuggestion(text: string) {
    setDraft(text);
    window.requestAnimationFrame(() => composerRef.current?.focus());
  }

  function retryActiveChat() {
    const botId = activeIdRef.current;
    if (!botId) return;
    setActiveDetailErrorId(null);
    void getBot(botId)
      .then((detail) => mergeBot(detail))
      .catch(() => {
        if (activeIdRef.current === botId) setActiveDetailErrorId(botId);
      });
  }

  function retryChannels() {
    setChannelsState("loading");
    void listChannels()
      .then((data) => {
        setChannels(data.channels);
        setChannelsState("ready");
      })
      .catch(() => setChannelsState("error"));
  }

  function retryHarnesses() {
    setHarnessesState("loading");
    void listHarnesses()
      .then((data) => {
        setHarnesses(data.harnesses);
        setHarnessesState("ready");
      })
      .catch(() => setHarnessesState("error"));
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!composerSendEnabled(composerKind)) return;
    if (
      !activeId ||
      active?.messages === undefined ||
      !canSendDirectMessage({
        active: Boolean(active),
        harness: active?.harness ?? null,
        draft,
        busy,
      })
    ) {
      return;
    }
    const botId = activeId;
    const text = draft.trim();
    const targetId = replyTo?.id;
    setDraft("");
    setBusy(true);
    setError(null);
    try {
      const bot = await sendMessage(botId, text, targetId);
      mergeBot(bot);
      if (activeIdRef.current === botId) setReplyTo(null);
    } catch (err) {
      if (activeIdRef.current === botId) {
        setDraft(text);
        const message = err instanceof Error ? err.message : "Could not send.";
        if (!isCancelledMessage(message)) setError(message);
      }
    } finally {
      setBusy(false);
    }
  }

  async function onPermission(optionId: string) {
    if (!activeId) return;
    const botId = activeId;
    setBusy(true);
    try {
      const bot = await answerPermission(botId, optionId);
      mergeBot(bot);
    } finally {
      setBusy(false);
    }
  }

  async function onHostGrant(access: "read" | "read-write" | "deny", duration: "once" | "session" | "until-revoked") {
    if (!activeId) return;
    const botId = activeId;
    setBusy(true);
    try {
      const bot = await answerHostGrant(botId, access, duration);
      mergeBot(bot);
    } finally {
      setBusy(false);
    }
  }

  async function onReact(messageId: string, emoji: string) {
    if (!activeId) return;
    const botId = activeId;
    try {
      const bot = await toggleReaction(botId, messageId, emoji);
      mergeBot(bot);
      if (activeIdRef.current === botId) setReactingId(null);
    } catch (err) {
      if (activeIdRef.current === botId) {
        setError(err instanceof Error ? err.message : "Could not react.");
      }
    }
  }

  function renderBubble(message: ChatMessage, prev: ChatMessage | undefined, nested: boolean) {
    if (message.kind === "host-grant") {
      return (
        <li key={message.id} className="self-center w-full max-w-2xl">
          <div data-testid="host-grant-history" className="rounded-2xl bg-secondary px-4 py-3 text-sm">
            <p className="font-medium">Host grant</p>
            <p className="mt-1 whitespace-pre-wrap break-all text-muted-foreground">{message.text}</p>
          </div>
        </li>
      );
    }
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
                user
                  ? "bg-bubble-outgoing text-bubble-outgoing-foreground"
                  : "bg-bubble-incoming text-bubble-incoming-foreground",
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
  const chatDetailState = active
    ? chatDetailViewState({
        messageCount: active.messages?.length,
        failed: activeDetailErrorId === active.id,
      })
    : null;
  const visible = messages.filter((message) => message.text.length > 0);
  const writing = isWorkingMode(active?.eyes.mode);
  const sidebarMode = (bot: Bot): FaceMode =>
    isWorkingMode(bot.eyes.mode) ? "idle" : (bot.eyes.mode as FaceMode);

  function focusOnNextFrame(ref: { current: HTMLElement | null }) {
    window.requestAnimationFrame(() => ref.current?.focus());
  }

  function openChats() {
    setMobileSurface("sidebar");
    focusOnNextFrame(closeChatsButtonRef);
  }

  function closeChats() {
    setMobileSurface("chat");
    focusOnNextFrame(openChatsButtonRef);
  }

  function openBot(bot: Bot) {
    botSettingsNavigationRef.current += 1;
    setBotSettingsOpen(false);
    if (parseBotSettingsHash(window.location.hash)) clearBotSettingsLocation();
    activateBot(bot);
    setMobileSurface("chat");
    void getBot(bot.id)
      .then((detail) => mergeBot(detail))
      .catch(() => {
        if (activeIdRef.current === bot.id) setActiveDetailErrorId(bot.id);
      });
  }

  function openGroup(channel: Channel) {
    botSettingsNavigationRef.current += 1;
    setBotSettingsOpen(false);
    if (parseBotSettingsHash(window.location.hash)) clearBotSettingsLocation();
    activeIdRef.current = null;
    activeGroupIdRef.current = channel.id;
    setActiveId(null);
    setActive(null);
    setActiveGroup(channel);
    setMobileSurface("chat");
    void getChannel(channel.id)
      .then((detail) => {
        if (activeGroupIdRef.current === channel.id) setActiveGroup(detail);
      })
      .catch(() => undefined);
  }

  function openBotSettings(event: MouseEvent<HTMLButtonElement>) {
    if (!activeId) return;
    botSettingsNavigationRef.current += 1;
    botSettingsOpenerRef.current = event.currentTarget;
    setBotSettingsSection("ai");
    setBotSettingsOpen(true);
    window.history.pushState(
      window.history.state,
      "",
      `${window.location.pathname}${window.location.search}${botSettingsHash(activeId, "ai")}`,
    );
  }

  function setBotSettingsOpenFromDialog(next: boolean) {
    if (!next) botSettingsNavigationRef.current += 1;
    setBotSettingsOpen(next);
    if (next || !parseBotSettingsHash(window.location.hash)) return;
    clearBotSettingsLocation();
  }

  function chooseBotSettingsSection(section: BotSettingsSection) {
    if (!activeId || section === botSettingsSection) return;
    botSettingsNavigationRef.current += 1;
    setBotSettingsSection(section);
    window.history.pushState(
      window.history.state,
      "",
      `${window.location.pathname}${window.location.search}${botSettingsHash(activeId, section)}`,
    );
  }

  function applyBotUpdate(bot: Bot) {
    mergeBot(bot);
  }

  function openComputer() {
    if (!activeId) return;
    updateComputerPane(activeId, true);
    focusOnNextFrame(closeComputerButtonRef);
  }

  function closeComputer() {
    if (!activeId) return;
    updateComputerPane(activeId, false);
    setMobileSurface("chat");
    focusOnNextFrame(computerButtonRef);
  }

  if (globalRoute === "plugins") {
    return <Plugins onBack={closePlugins} />;
  }

  const botView = botListViewState({ ready: botsReady, failed: botsLoadError, count: bots.length });

  if (botView === "loading") return <LoadingHome destinationRef={loadingHomeRef} />;

  if (botView === "error") {
    return (
      <BotsLoadError
        onRetry={() => window.location.reload()}
        destinationRef={botsLoadErrorRef}
      />
    );
  }

  if (botView === "empty") {
    return (
      <>
        <Welcome
          onNewBot={openNewBot}
          onPlugins={() => openPlugins("welcome")}
          pluginsRef={welcomePluginsRef}
          destinationRef={welcomeDestinationRef}
        />
        <NewBotDialog
          open={newBotOpen}
          onOpenChange={setNewBotOpen}
          openerRef={newBotOpenerRef}
          destinationRef={newBotDestinationRef}
          onCreate={createBot}
          onCreated={openCreatedBot}
        />
      </>
    );
  }

  return (
    <>
      <MessengerShell
        mobileSurface={mobileSurface}
        chatRef={chatRegionRef}
        sidebar={
        <>
          <div className="flex h-[var(--header-height)] items-center justify-between gap-3 px-4">
            <div className="flex min-w-0 items-center gap-3">
              <Eyes size={32} className="aspect-square shrink-0" />
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">OpenBot</p>
                <p className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Monitor className="size-3" />
                  This Computer
                </p>
              </div>
            </div>
            <div className="flex items-center gap-1">
              <DropdownMenu>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <DropdownMenuTrigger asChild>
                      <Button
                        ref={createMenuTriggerRef}
                        type="button"
                        size="icon"
                        variant="ghost"
                        aria-label="Create"
                        className="min-h-[var(--touch-min)] min-w-[var(--touch-min)]"
                      >
                        <Plus />
                      </Button>
                    </DropdownMenuTrigger>
                  </TooltipTrigger>
                  <TooltipContent>Create</TooltipContent>
                </Tooltip>
                <DropdownMenuContent align="end" aria-label="Create">
                  <DropdownMenuItem onSelect={openNewBotFromMenu}>
                    <Plus />
                    New Bot
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    ref={closeChatsButtonRef}
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label="Close Chats"
                    onClick={closeChats}
                    className="min-h-[var(--touch-min)] min-w-[var(--touch-min)] min-[48rem]:hidden"
                  >
                    <X />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Close Chats</TooltipContent>
              </Tooltip>
            </div>
          </div>
          <Separator />
        <div className="flex-1 overflow-y-auto px-3 py-3">
          {channelsState === "loading" ? (
            <p className="px-3 py-2 text-xs text-muted-foreground" role="status">
              Loading group Chats…
            </p>
          ) : channelsState === "error" ? (
            <div className="mb-2 grid gap-2 rounded-[var(--radius-card)] bg-muted p-3 text-xs" role="alert">
              <p>Could not load group Chats.</p>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={retryChannels}
                className="min-h-[var(--touch-min)] justify-self-start"
              >
                Retry
              </Button>
            </div>
          ) : null}
          <ul className="space-y-1">
              {bots.map((bot) => (
                <li key={bot.id}>
                  <button
                    type="button"
                    onClick={() => openBot(bot)}
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
                    onClick={() => openGroup(channel)}
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
        </div>
        <div className="grid gap-1 border-t border-sidebar-border p-3">
          <Button
            ref={sidebarPluginsRef}
            type="button"
            variant="ghost"
            className="min-h-[var(--touch-min)] w-full justify-start rounded-[var(--radius-control)]"
            onClick={() => openPlugins("sidebar")}
          >
            <Plug />
            Plugins
          </Button>
          <AppSettings />
        </div>
        </>
      }
        chat={
        <>
        <header className="flex min-h-[var(--header-height)] flex-wrap items-center justify-between gap-x-2 gap-y-1 px-3 py-1 min-[48rem]:h-[var(--header-height)] min-[48rem]:flex-nowrap min-[48rem]:gap-3 min-[48rem]:px-6 min-[48rem]:py-0">
          <div className="flex min-w-0 flex-1 items-center gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  ref={openChatsButtonRef}
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label="Open Chats"
                  onClick={openChats}
                  className="min-h-[var(--touch-min)] min-w-[var(--touch-min)] min-[48rem]:hidden"
                >
                  <Menu />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Open Chats</TooltipContent>
            </Tooltip>
            {active && !activeGroup ? (
              <button
                ref={newBotDestinationRef}
                type="button"
                onClick={openBotSettings}
                className="flex min-h-[var(--touch-min)] min-w-0 items-center gap-2 rounded-[var(--radius-control)] px-2 text-left transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Eyes
                  name={active.name}
                  color={active.eyes.color}
                  shape={active.eyes.shape as FaceShape}
                  mode={active.eyes.mode as FaceMode}
                  size={28}
                  className="aspect-square shrink-0"
                />
                <span className="truncate text-sm font-medium">{active.name}</span>
              </button>
            ) : (
              <h1 className="truncate text-sm font-medium">
                {activeGroup ? groupDisplayTitle(activeGroup) : "Thread"}
              </h1>
            )}
          </div>
          {active && !activeGroup ? (
            <div
              role="group"
              aria-label="Bot controls"
              className="flex shrink-0 items-center gap-1"
            >
              <Button
                ref={computerButtonRef}
                type="button"
                size="sm"
                variant="outline"
                data-testid={visibleComputerOpen ? "close-computer" : "open-computer"}
                aria-expanded={visibleComputerOpen}
                onClick={visibleComputerOpen ? closeComputer : openComputer}
                className="shrink-0 max-[47.999rem]:min-h-[var(--touch-min)]"
              >
                {visibleComputerOpen ? <MessageSquare /> : <Monitor />}
                {visibleComputerOpen ? "Hide Computer" : "Computer"}
              </Button>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label="Bot Settings"
                    onClick={openBotSettings}
                    className="min-h-[var(--touch-min)] min-w-[var(--touch-min)]"
                  >
                    <Settings />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Bot Settings</TooltipContent>
              </Tooltip>
            </div>
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
        ) : active && chatDetailState === "loading" ? (
          <ChatDetailLoading bot={active} />
        ) : active && chatDetailState === "error" ? (
          <ChatDetailError bot={active} onRetry={retryActiveChat} />
        ) : active && chatDetailState === "populated" ? (
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
            {active.permission && isHostGrantPermission(active.permission) && active.permission.hostGrant ? (
              <HostGrantCard
                grant={active.permission.hostGrant}
                busy={busy}
                onAnswer={(access, duration) => void onHostGrant(access, duration)}
              />
            ) : active.permission ? (
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
        ) : active && chatDetailState === "empty" ? (
          <EmptyChatStart bot={active} onSuggestion={chooseSuggestion} onOpenSettings={openBotSettings} />
        ) : (
          <div className="flex flex-1 items-center justify-center px-6 text-sm text-muted-foreground">
            Opening Chat…
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
              ref={composerRef}
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
                    : active.messages === undefined
                      ? "Opening Chat…"
                      : !active.harness
                        ? "Choose an AI connection to start…"
                        : replyTo
                          ? "Reply…"
                          : "Message a Bot…"
              }
              disabled={!composerSendEnabled(composerKind)}
              className="min-h-10 resize-none"
            />
            {composerSendEnabled(composerKind) ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="submit"
                  size="icon"
                  data-testid="composer-send"
                  disabled={
                    !canSendDirectMessage({
                      active: active?.messages !== undefined,
                      harness: active?.harness ?? null,
                      draft,
                      busy,
                    })
                  }
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
        </>
      }
        computer={
        visibleComputerOpen && activeId ? (
          <>
            <header className="flex h-[var(--header-height)] items-center justify-between gap-2 px-4">
              <div className="flex min-w-0 items-center gap-2">
                <Monitor className="size-[var(--icon-default)] text-muted-foreground" />
                <h2 className="truncate text-sm font-medium">
                  {active?.name ? `${active.name}'s Computer` : "Computer"}
                </h2>
              </div>
              <Button
                ref={closeComputerButtonRef}
                type="button"
                size="sm"
                variant="ghost"
                data-testid="close-computer-pane"
                onClick={closeComputer}
                className="min-h-[var(--touch-min)] shrink-0"
              >
                <MessageSquare />
                Chat
              </Button>
            </header>
            <Separator />
            <div
              data-testid="computer-expanded"
              className="relative isolate min-h-0 flex-1 overflow-hidden bg-black"
            >
              <ComputerScreen
                botId={activeId}
                expanded
                onClose={closeComputer}
                showChatButton={false}
              />
            </div>
          </>
        ) : null
      }
      />
      <NewBotDialog
        open={newBotOpen}
        onOpenChange={setNewBotOpen}
        openerRef={newBotOpenerRef}
        destinationRef={newBotDestinationRef}
        onCreate={createBot}
        onCreated={openCreatedBot}
      />
      {active && !activeGroup ? (
        <BotSettings
          key={active.id}
          bot={active}
          harnesses={harnesses}
          harnessesState={harnessesState}
          open={botSettingsOpen}
          onOpenChange={setBotSettingsOpenFromDialog}
          openerRef={botSettingsOpenerRef}
          fallbackFocusRef={newBotDestinationRef}
          onBotChange={applyBotUpdate}
          onRetryHarnesses={retryHarnesses}
          onOpenComputer={openComputer}
          section={botSettingsSection}
          onSectionChange={chooseBotSettingsSection}
        />
      ) : null}
    </>
  );
}

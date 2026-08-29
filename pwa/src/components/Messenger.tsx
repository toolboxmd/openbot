import {
  FormEvent,
  Fragment,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { ArrowUp, Check, Menu, MessageSquare, Monitor, MonitorCog, Plug, Plus, Reply, Search, Smile, X } from "lucide-react";
import { AppSettings } from "@/components/AppSettings";
import { BotSettings } from "@/components/BotSettings";
import {
  CommandPalette,
  buildCommandPaletteActions,
  executeCommandPaletteResult,
  type CommandPaletteResult,
} from "@/components/CommandPalette";
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
import { MessengerShell, SelectedBotSurface, type MobileSurface } from "@/components/MessengerShell";
import { NewBotDialog } from "@/components/NewBotDialog";
import { NewChannelDialog } from "@/components/NewChannelDialog";
import { StackedEyes } from "@/components/StackedEyes";
import { TranscriptCard } from "@/components/TranscriptCard";
import { useUiPreferences } from "@/components/UiPreferencesProvider";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItemIndicator,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Toast, ToastDescription, ToastProvider, ToastTitle, ToastViewport } from "@/components/ui/toast";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { FaceMode, FaceShape } from "@/lib/face";
import {
  botMembers,
  composerSendEnabled,
  groupDisplayTitle,
  type Channel,
} from "@/lib/channels";
import {
  botSettingsHash,
  INITIAL_SELECTED_BOT_PANEL_STATE,
  parseBotSettingsHash,
  reduceSelectedBotPanel,
  resolveSelectedBotPanelLocation,
  selectedBotPanelBlocksChat,
  type BotSettingsSection,
  type SelectedBotPanelEvent,
  type SelectedBotPanelState,
  syncSelectedBotPanelLocationAfterBotChange,
} from "@/lib/bot-settings";
import { computerPaneIsOpen } from "@/lib/ui-preferences";
import { appSettingsRequested } from "@/lib/app-settings";
import {
  createKeyedRequestScope,
  createLatestRequestScope,
  isAbortError,
  runWithAuthoritativeRefresh,
} from "@/lib/async-state";
import {
  acceptOrderedSnapshots,
  botDraftKey,
  buildChatInbox,
  canAcknowledgeChatRead,
  channelDraftKey,
  chatSurfaceIsVisible,
  filterChatInbox,
  formatRelativeActivityTime,
  inboxAnnouncement,
  inboxEyesMode,
  listSnapshotIsCurrent,
  mergeInboxSnapshots,
  observedActivityAfterRead,
  readChatDrafts,
  reserveSnapshotRequest,
  resolveSnapshotMembership,
  setChatDraft,
  shouldRestoreFailedDraft,
  writeChatDrafts,
  type ChatDrafts,
  type ChatInboxRow,
} from "@/lib/chat-inbox";
import {
  botListViewState,
  canSendDirectMessage,
  chatDetailViewState,
  computerToCloseForDirectPluginsReturn,
  computerVisibleDuringPluginsReturn,
  connectedFocusTarget,
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
  createGroupChannel,
  getBot,
  getChannel,
  listBots,
  listChannels,
  listHarnesses,
  listInbox,
  markBotRead,
  resolveNeedsYouCard,
  retryTranscriptCard,
  sendMessage,
  toggleReaction,
  type Bot,
  type Harness,
  type TranscriptCardAction,
} from "@/lib/session";
import {
  buildChatChronology,
  parseChatText,
  type ChatChronologyItem,
  type ChatInline,
} from "@/lib/chat-chronology";
import {
  buildFlatTranscriptRows,
  isNearTranscriptBottom,
  isPrimaryLongPressPointer,
  LONG_PRESS_DELAY_MS,
  observeTranscriptViewport,
  PHONE_ACTION_TARGET_CLASS,
  PHONE_COMPOSER_INPUT_CLASS,
  PHONE_COMPOSER_SEND_CLASS,
  remountedTranscriptScrollTop,
  subscribeTranscriptBreakpoint,
  TRANSCRIPT_DESKTOP_QUERY,
  transcriptHasLayout,
  transcriptContentRevision,
  transcriptViewportDecision,
} from "@/lib/chat-interactions";


type ChatMessage = NonNullable<Bot["messages"]>[number];
type RemoteListState = "loading" | "ready" | "error";

export function SelectedBotPanelControl({
  visibleComputerOpen,
  controlRef,
  onOpen,
  onClose,
}: {
  visibleComputerOpen: boolean;
  controlRef: RefObject<HTMLButtonElement | null>;
  onOpen: () => void;
  onClose: () => void;
}) {
  const label = visibleComputerOpen ? "Close Bot panel" : "Open Bot panel";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          ref={controlRef}
          type="button"
          size="icon"
          variant="ghost"
          data-testid={visibleComputerOpen ? "close-computer" : "open-computer"}
          aria-label={label}
          aria-controls="selected-bot-panel"
          aria-expanded={visibleComputerOpen}
          onClick={visibleComputerOpen ? onClose : onOpen}
          className="min-h-[var(--touch-min)] min-w-[var(--touch-min)]"
        >
          {visibleComputerOpen ? <X /> : <MonitorCog />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export function SelectedBotPanelAppSettings({
  open,
  selectedBotPanelOpen,
  harnesses,
  harnessesState,
  onOpenChange,
  onCloseSelectedBotPanel,
  onRetryHarnesses,
}: {
  open: boolean;
  selectedBotPanelOpen: boolean;
  harnesses?: Harness[];
  harnessesState?: RemoteListState;
  onOpenChange: (open: boolean) => void;
  onCloseSelectedBotPanel: (options: { restoreFocus: boolean }) => void;
  onRetryHarnesses?: () => void;
}) {
  return (
    <AppSettings
      open={open}
      harnesses={harnesses}
      harnessesState={harnessesState}
      onRetryHarnesses={onRetryHarnesses}
      onOpenChange={(next) => {
        if (next && selectedBotPanelOpen) {
          onCloseSelectedBotPanel({ restoreFocus: false });
        }
        onOpenChange(next);
      }}
    />
  );
}

export function MessengerCommandPalette({
  open,
  enabled,
  chats,
  selectedBot,
  appFocusRef,
  onOpenChange,
  onOpenChat,
  onNewBot,
  onAppSettings,
  onBotSettings,
  onPlugins,
  onComputer,
}: {
  open: boolean;
  enabled: boolean;
  chats: ChatInboxRow[];
  selectedBot: {
    id: string;
    name: string;
    settings: boolean;
    computer: boolean;
  } | null;
  appFocusRef: RefObject<HTMLElement | null>;
  onOpenChange: (open: boolean) => void;
  onOpenChat: (chat: ChatInboxRow) => void;
  onNewBot: () => void;
  onAppSettings: () => void;
  onBotSettings: (botId: string) => void;
  onPlugins: () => void;
  onComputer: (botId: string) => void;
}) {
  const actions = buildCommandPaletteActions({
    newBot: true,
    appSettings: true,
    plugins: true,
    selectedBot,
  });
  const handlers = {
    openChat: onOpenChat,
    newBot: onNewBot,
    appSettings: onAppSettings,
    botSettings: onBotSettings,
    plugins: onPlugins,
    computer: onComputer,
  };

  return (
    <CommandPalette
      open={open}
      enabled={enabled}
      chats={chats}
      actions={actions}
      appFocusRef={appFocusRef}
      onOpenChange={onOpenChange}
      onSelect={(result: CommandPaletteResult) => executeCommandPaletteResult(
        result,
        selectedBot?.id ?? null,
        handlers,
      )}
    />
  );
}

function replaceLocationHash(hash: string) {
  window.history.replaceState(
    window.history.state,
    "",
    `${window.location.pathname}${window.location.search}${hash}`,
  );
}

function clearBotSettingsLocation() {
  replaceLocationHash("");
}

function renderChatInline(inline: ChatInline, index: number) {
  if (inline.kind === "link") {
    return (
      <a
        key={index}
        href={inline.href}
        target="_blank"
        rel="noreferrer noopener"
        className="font-medium underline underline-offset-2"
      >
        {inline.text}
      </a>
    );
  }
  if (inline.kind === "strong") return <strong key={index}>{inline.text}</strong>;
  if (inline.kind === "emphasis") return <em key={index}>{inline.text}</em>;
  if (inline.kind === "code") {
    return (
      <code key={index} className="rounded bg-[var(--message-code-surface)] px-1 py-0.5 font-mono text-[0.9em]">
        {inline.text}
      </code>
    );
  }
  return <span key={index}>{inline.text}</span>;
}

function ChatMessageText({ text }: { text: string }) {
  const blocks = parseChatText(text);
  return (
    <div className="grid gap-2">
      {blocks.map((block, index) => block.kind === "code-block" ? (
        <pre
          key={index}
          data-testid="chat-code-block"
          data-language={block.language}
          className="max-h-64 max-w-full overflow-auto rounded-lg bg-[var(--message-code-surface)] p-2 font-mono text-xs leading-relaxed"
        >
          <code>{block.text}</code>
        </pre>
      ) : (
        <span key={index} className="whitespace-pre-wrap">
          {(block.inlines ?? []).map(renderChatInline)}
        </span>
      ))}
    </div>
  );
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

function HoverActions({
  user,
  open,
  onReply,
  pickerOpen,
  onPickerOpenChange,
  picker,
}: {
  user: boolean;
  open: boolean;
  onReply: () => void;
  pickerOpen: boolean;
  onPickerOpenChange: (open: boolean) => void;
  picker: ReactNode;
}) {
  const reactBtn = (
    <DropdownMenu open={pickerOpen} onOpenChange={onPickerOpenChange}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label="React"
              className={PHONE_ACTION_TARGET_CLASS}
            >
              <Smile />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>React</TooltipContent>
      </Tooltip>
      {picker}
    </DropdownMenu>
  );
  const replyBtn = (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Reply"
          onClick={onReply}
          className={PHONE_ACTION_TARGET_CLASS}
        >
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
        "pointer-events-none relative flex shrink-0 items-center rounded-full border border-border bg-background/95 opacity-0 shadow-sm transition-opacity",
        "group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100",
        open && "pointer-events-auto opacity-100",
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
    </div>
  );
}

export function Messenger() {
  const [drafts, setDrafts] = useState<ChatDrafts>(() => {
    try {
      return readChatDrafts(window.localStorage);
    } catch {
      return {};
    }
  });
  const [inboxQuery, setInboxQuery] = useState("");
  const [inboxNow, setInboxNow] = useState(() => new Date());
  const [inboxLive, setInboxLive] = useState({ serial: 0, text: "" });
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
  const [appSettingsOpen, setAppSettingsOpenState] = useState(() => appSettingsRequested(window.location.hash));
  const [newBotOpen, setNewBotOpenState] = useState(false);
  const [selectedBotPanel, setSelectedBotPanel] = useState(INITIAL_SELECTED_BOT_PANEL_STATE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [reactingId, setReactingId] = useState<string | null>(null);
  const [actionMessageId, setActionMessageId] = useState<string | null>(null);
  const [pendingCardIds, setPendingCardIds] = useState<Set<string>>(() => new Set());
  const [newMessagesAvailable, setNewMessagesAvailable] = useState(false);
  const [desktopLayout, setDesktopLayout] = useState(
    () => window.matchMedia(TRANSCRIPT_DESKTOP_QUERY).matches,
  );
  const [commandPaletteOpen, setCommandPaletteOpenState] = useState(false);
  const [newChannelOpen, setNewChannelOpenState] = useState(false);
  const openChatsButtonRef = useRef<HTMLButtonElement | null>(null);
  const closeChatsButtonRef = useRef<HTMLButtonElement | null>(null);
  const computerButtonRef = useRef<HTMLButtonElement | null>(null);
  const closeComputerButtonRef = useRef<HTMLButtonElement | null>(null);
  const computerPreviewRef = useRef<HTMLButtonElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const transcriptScrollRef = useRef<HTMLDivElement | null>(null);
  const transcriptNearBottomRef = useRef(true);
  const transcriptScrollTopByChatRef = useRef(new Map<string, number>());
  const previousTranscriptBotIdRef = useRef<string | null>(null);
  const previousTranscriptRevisionRef = useRef("");
  const previousTranscriptWritingRef = useRef(false);
  const previousTranscriptMountedRef = useRef(false);
  const previousTranscriptDesktopRef = useRef(desktopLayout);
  const messageBubbleRefs = useRef(new Map<string, HTMLElement>());
  const longPressTimerRef = useRef<number | null>(null);
  const inboxSearchRef = useRef<HTMLInputElement | null>(null);
  const createMenuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const newBotOpenerRef = useRef<HTMLButtonElement | null>(null);
  const newBotDestinationRef = useRef<HTMLElement | null>(null);
  const welcomePluginsRef = useRef<HTMLButtonElement | null>(null);
  const sidebarPluginsRef = useRef<HTMLButtonElement | null>(null);
  const loadingHomeRef = useRef<HTMLElement | null>(null);
  const botsLoadErrorRef = useRef<HTMLElement | null>(null);
  const welcomeDestinationRef = useRef<HTMLElement | null>(null);
  const chatRegionRef = useRef<HTMLElement | null>(null);
  const pluginsReturnTargetRef = useRef<PluginsReturnTarget | null>(null);
  const botSettingsOpenerRef = useRef<HTMLButtonElement | null>(null);
  const mountedRef = useRef(true);
  const activeIdRef = useRef<string | null>(null);
  const activeGroupIdRef = useRef<string | null>(null);
  const draftRevisionsRef = useRef<Record<string, number>>({});
  const previousInboxRowsRef = useRef<ChatInboxRow[] | null>(null);
  const inboxMutationGenerationRef = useRef(0);
  const botSnapshotSequenceRef = useRef(0);
  const botSnapshotAppliedRef = useRef(new Map<string, number>());
  const latestBotSnapshotsRef = useRef(new Map<string, Bot>());
  const createdBotSequencesRef = useRef(new Map<string, number>());
  const botMutationCountsRef = useRef(new Map<string, number>());
  const channelSnapshotSequenceRef = useRef(0);
  const channelSnapshotAppliedRef = useRef(new Map<string, number>());
  const latestChannelSnapshotsRef = useRef(new Map<string, Channel>());
  const channelListAppliedSequenceRef = useRef(0);
  const botSettingsNavigationRef = useRef(0);
  const selectionGenerationRef = useRef(0);
  const botDetailRequestRef = useRef(createLatestRequestScope());
  const channelDetailRequestRef = useRef(createLatestRequestScope());
  const routeBotRequestRef = useRef(createLatestRequestScope());
  const channelListRequestRef = useRef(createLatestRequestScope());
  const harnessListRequestRef = useRef(createLatestRequestScope());
  const createBotRequestRef = useRef(createLatestRequestScope());
  const cardActionRequestRef = useRef(createKeyedRequestScope<string>());
  const readReceiptControllersRef = useRef(new Map<string, AbortController>());
  const sendRequestControllerRef = useRef<AbortController | null>(null);
  const reactionRequestControllerRef = useRef<AbortController | null>(null);
  const sendRequestGenerationRef = useRef(0);
  const previousGlobalRouteRef = useRef(globalRoute);
  const appSettingsOpenRef = useRef(appSettingsOpen);
  const newBotOpenRef = useRef(newBotOpen);
  const selectedBotPanelRef = useRef(selectedBotPanel);
  const globalRouteRef = useRef(globalRoute);
  const mobileSurfaceRef = useRef(mobileSurface);
  const desktopLayoutRef = useRef(desktopLayout);
  const { preferences, updateComputerPane } = useUiPreferences();
  const preferencesRef = useRef(preferences);
  const updateComputerPaneRef = useRef(updateComputerPane);
  const commandPaletteOpenRef = useRef(commandPaletteOpen);
  const appSettingsEntryRef = useRef<HTMLDivElement | null>(null);
  const computerOpen = computerPaneIsOpen(preferences, activeId);
  const selectedBotPanelOpen = selectedBotPanel.open && selectedBotPanel.botId === activeId;
  const botSettingsSection = selectedBotPanel.section;
  const computerExpanded = selectedBotPanel.computerExpanded;
  const visibleComputerOpen = computerVisibleDuringPluginsReturn({
    computerOpen: selectedBotPanelOpen,
    returnTarget: pluginsReturnTargetRef.current,
  });
  const visibleComputerOpenRef = useRef(visibleComputerOpen);
  const createdChannelSequencesRef = useRef(new Map<string, number>());
  const createChannelRequestRef = useRef(createLatestRequestScope());
  const newChannelOpenRef = useRef(newChannelOpen);
  globalRouteRef.current = globalRoute;
  mobileSurfaceRef.current = mobileSurface;
  desktopLayoutRef.current = desktopLayout;
  selectedBotPanelRef.current = selectedBotPanel;
  preferencesRef.current = preferences;
  updateComputerPaneRef.current = updateComputerPane;
  visibleComputerOpenRef.current = visibleComputerOpen;
  commandPaletteOpenRef.current = commandPaletteOpen;
  const selectedBotPanelBlocksCurrentChat = selectedBotPanelBlocksChat({
    desktopLayout,
    panelOpen: selectedBotPanelOpen,
  });
  const paletteShortcutEnabled = !appSettingsOpen
    && !newBotOpen
    && !newChannelOpen
    && !selectedBotPanelBlocksCurrentChat;
  const blockingChatSurfaceOpen = commandPaletteOpen
    || appSettingsOpen
    || newBotOpen
    || newChannelOpen
    || selectedBotPanelBlocksCurrentChat;
  const composerKind = activeGroup ? "group" : active?.messages !== undefined ? "direct" : null;
  const activeDraftKey = activeGroup
    ? channelDraftKey(activeGroup.id)
    : activeId
      ? botDraftKey(activeId)
      : null;
  const draft = activeDraftKey ? drafts[activeDraftKey] ?? "" : "";

  function setAppSettingsOpen(next: boolean) {
    appSettingsOpenRef.current = next;
    setAppSettingsOpenState(next);
  }

  function setNewBotOpen(next: boolean) {
    newBotOpenRef.current = next;
    setNewBotOpenState(next);
  }

  function setNewChannelOpen(next: boolean) {
    newChannelOpenRef.current = next;
    setNewChannelOpenState(next);
  }

  function setCommandPaletteOpen(next: boolean) {
    commandPaletteOpenRef.current = next;
    setCommandPaletteOpenState(next);
  }

  function transitionSelectedBotPanel(
    event: SelectedBotPanelEvent,
    {
      persist = true,
      restoreFocus = true,
    }: { persist?: boolean; restoreFocus?: boolean } = {},
  ) {
    const previous = selectedBotPanelRef.current;
    const next = reduceSelectedBotPanel(previous, event);
    selectedBotPanelRef.current = next;
    setSelectedBotPanel(next);

    if (restoreFocus && previous.open && !next.open) {
      window.requestAnimationFrame(() => {
        connectedFocusTarget(
          botSettingsOpenerRef.current,
          newBotDestinationRef.current,
        )?.focus();
      });
    }

    if (!persist) return next;
    const preferenceBotId = next.botId ?? previous.botId;
    if (!preferenceBotId) return next;
    const preferenceOpen = next.botId === preferenceBotId ? next.open : false;
    if (computerPaneIsOpen(preferencesRef.current, preferenceBotId) !== preferenceOpen) {
      updateComputerPaneRef.current(preferenceBotId, preferenceOpen);
    }
    return next;
  }

  function closeSelectedBotPanelForAppSettings(options: { restoreFocus: boolean }) {
    if (!selectedBotPanelRef.current.open) return;
    botSettingsNavigationRef.current += 1;
    transitionSelectedBotPanel({ kind: "close" }, options);
  }

  function blockingChatSurfaceIsOpen(): boolean {
    const panel = selectedBotPanelRef.current;
    const panelOpen = panel.open && panel.botId === activeIdRef.current;
    return commandPaletteOpenRef.current
      || appSettingsOpenRef.current
      || newBotOpenRef.current
      || newChannelOpenRef.current
      || selectedBotPanelBlocksChat({ desktopLayout: desktopLayoutRef.current, panelOpen });
  }

  function clearLongPressTimer() {
    if (longPressTimerRef.current === null) return;
    window.clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = null;
  }

  function startLongPress(event: ReactPointerEvent<HTMLDivElement>, messageId: string) {
    if (!isPrimaryLongPressPointer(event)) return;
    clearLongPressTimer();
    longPressTimerRef.current = window.setTimeout(() => {
      longPressTimerRef.current = null;
      setReactingId(null);
      setActionMessageId(messageId);
    }, LONG_PRESS_DELAY_MS);
  }

  function focusTranscriptMessage(messageId: string) {
    const target = messageBubbleRefs.current.get(messageId);
    if (!target) return;
    const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? "auto"
      : "smooth";
    target.scrollIntoView({ behavior, block: "center" });
    target.focus({ preventScroll: true });
  }

  function onTranscriptScroll() {
    const transcript = transcriptScrollRef.current;
    if (!transcript) return;
    if (activeDraftKey) {
      transcriptScrollTopByChatRef.current.set(activeDraftKey, transcript.scrollTop);
    }
    const nearBottom = isNearTranscriptBottom(transcript);
    transcriptNearBottomRef.current = nearBottom;
    if (nearBottom) setNewMessagesAvailable(false);
  }

  function scrollToLatest() {
    const transcript = transcriptScrollRef.current;
    if (!transcript) return;
    const bubbles = Array.from(messageBubbleRefs.current.values());
    const latestBubble = bubbles.at(-1);
    transcriptNearBottomRef.current = true;
    if (activeDraftKey) {
      transcriptScrollTopByChatRef.current.set(activeDraftKey, transcript.scrollHeight);
    }
    transcript.scrollTo({
      top: transcript.scrollHeight,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
    latestBubble?.focus({ preventScroll: true });
    setNewMessagesAvailable(false);
  }

  function storeDraft(key: string, text: string): number {
    const revision = (draftRevisionsRef.current[key] ?? 0) + 1;
    draftRevisionsRef.current[key] = revision;
    setDrafts((current) => {
      const next = setChatDraft(current, key, text);
      try {
        writeChatDrafts(window.localStorage, next);
      } catch {
        // The in-memory draft still works when browser storage is unavailable.
      }
      return next;
    });
    return revision;
  }

  function setDraft(text: string) {
    if (activeDraftKey) storeDraft(activeDraftKey, text);
  }

  function cancelCardActions() {
    cardActionRequestRef.current.cancelAll();
    setPendingCardIds(new Set());
  }

  function beginSelection(): number {
    selectionGenerationRef.current += 1;
    sendRequestGenerationRef.current += 1;
    botDetailRequestRef.current.cancel();
    channelDetailRequestRef.current.cancel();
    routeBotRequestRef.current.cancel();
    sendRequestControllerRef.current?.abort();
    sendRequestControllerRef.current = null;
    reactionRequestControllerRef.current?.abort();
    reactionRequestControllerRef.current = null;
    cancelCardActions();
    for (const controller of readReceiptControllersRef.current.values()) controller.abort();
    readReceiptControllersRef.current.clear();
    setBusy(false);
    setError(null);
    return selectionGenerationRef.current;
  }

  function selectionIsCurrent(generation: number, botId?: string): boolean {
    return generation === selectionGenerationRef.current
      && (botId === undefined || activeIdRef.current === botId);
  }

  function activateBot(bot: Bot, generation: number): SelectedBotPanelState | null {
    if (generation !== selectionGenerationRef.current) return null;
    activeIdRef.current = bot.id;
    activeGroupIdRef.current = null;
    const panel = transitionSelectedBotPanel({
      kind: "select-bot",
      botId: bot.id,
      rememberedOpen: computerPaneIsOpen(preferencesRef.current, bot.id),
    });
    setActiveId(bot.id);
    setActive(bot);
    setActiveDetailErrorId(null);
    setActiveGroup(null);
    return panel;
  }

  function nextBotSnapshotSequence(): number {
    botSnapshotSequenceRef.current += 1;
    return botSnapshotSequenceRef.current;
  }

  function rememberBotSnapshot(bot: Bot): Bot {
    const current = latestBotSnapshotsRef.current.get(bot.id);
    const remembered = current ? mergeInboxSnapshots([current], [bot])[0] ?? bot : bot;
    latestBotSnapshotsRef.current.set(bot.id, remembered);
    return remembered;
  }

  function botMutationPending(botId: string): boolean {
    return (botMutationCountsRef.current.get(botId) ?? 0) > 0;
  }

  function mergeBot(
    bot: Bot,
    snapshotSequence: number,
    invalidateInbox = false,
    ownedMutation = false,
  ): Bot | null {
    if (!ownedMutation && botMutationPending(bot.id)) return null;
    const accepted = acceptOrderedSnapshots(botSnapshotAppliedRef.current, [bot], snapshotSequence)[0];
    if (!accepted) return null;
    const remembered = rememberBotSnapshot(accepted);
    if (invalidateInbox) inboxMutationGenerationRef.current += 1;
    setBots((rows) => rows.map((row) => (
      row.id === remembered.id ? mergeInboxSnapshots([row], [remembered])[0] ?? remembered : row
    )));
    if (activeIdRef.current === remembered.id) {
      setActive((current) => current
        ? mergeInboxSnapshots([current], [remembered])[0] ?? remembered
        : remembered);
      if (remembered.messages !== undefined) setActiveDetailErrorId(null);
    }
    return remembered;
  }

  function mergeBotSummaries(next: Bot[], snapshotSequence: number): Bot[] {
    const eligible = next.filter((bot) => !botMutationPending(bot.id));
    const accepted = acceptOrderedSnapshots(botSnapshotAppliedRef.current, eligible, snapshotSequence)
      .map(rememberBotSnapshot);
    const resolved = resolveSnapshotMembership(eligible, accepted, latestBotSnapshotsRef.current);
    setBots((current) => mergeInboxSnapshots(current, resolved));
    setActive((current) => {
      if (!current) return current;
      const summary = resolved.find((bot) => bot.id === current.id);
      if (!summary) return current;
      const merged = mergeInboxSnapshots([current], [summary])[0] ?? current;
      return { ...merged, messages: current.messages };
    });
    return resolved;
  }

  async function performBotMutation(
    botId: string,
    request: () => Promise<Bot>,
    signal?: AbortSignal,
    requestIsCurrent: () => boolean = () => true,
  ): Promise<Bot> {
    botMutationCountsRef.current.set(botId, (botMutationCountsRef.current.get(botId) ?? 0) + 1);
    inboxMutationGenerationRef.current += 1;
    try {
      const { snapshot, sequence } = await reserveSnapshotRequest(nextBotSnapshotSequence, request);
      if (signal?.aborted || !requestIsCurrent()) {
        return latestBotSnapshotsRef.current.get(botId) ?? snapshot;
      }
      return mergeBot(snapshot, sequence, true, true)
        ?? latestBotSnapshotsRef.current.get(botId)
        ?? snapshot;
    } finally {
      const remaining = (botMutationCountsRef.current.get(botId) ?? 1) - 1;
      if (remaining > 0) botMutationCountsRef.current.set(botId, remaining);
      else botMutationCountsRef.current.delete(botId);
    }
  }

  function nextChannelSnapshotSequence(): number {
    channelSnapshotSequenceRef.current += 1;
    return channelSnapshotSequenceRef.current;
  }

  function rememberChannelSnapshot(channel: Channel): Channel {
    const current = latestChannelSnapshotsRef.current.get(channel.id);
    const remembered = current ? mergeInboxSnapshots([current], [channel])[0] ?? channel : channel;
    latestChannelSnapshotsRef.current.set(channel.id, remembered);
    return remembered;
  }

  function mergeChannel(channel: Channel, snapshotSequence: number): Channel | null {
    const accepted = acceptOrderedSnapshots(channelSnapshotAppliedRef.current, [channel], snapshotSequence)[0];
    if (!accepted) return null;
    const remembered = rememberChannelSnapshot(accepted);
    setChannels((current) => current.map((row) => (
      row.id === remembered.id ? mergeInboxSnapshots([row], [remembered])[0] ?? remembered : row
    )));
    if (activeGroupIdRef.current === remembered.id) {
      setActiveGroup((current) => current
        ? mergeInboxSnapshots([current], [remembered])[0] ?? remembered
        : remembered);
    }
    return remembered;
  }

  function mergeChannelSummaries(next: Channel[], snapshotSequence: number): Channel[] | null {
    if (!listSnapshotIsCurrent(channelListAppliedSequenceRef.current, snapshotSequence)) return null;
    channelListAppliedSequenceRef.current = snapshotSequence;
    const accepted = acceptOrderedSnapshots(channelSnapshotAppliedRef.current, next, snapshotSequence)
      .map(rememberChannelSnapshot);
    const resolved = resolveSnapshotMembership(next, accepted, latestChannelSnapshotsRef.current);
    setChannels((current) => mergeInboxSnapshots(current, resolved));
    setActiveGroup((current) => {
      if (!current) return current;
      const summary = resolved.find((channel) => channel.id === current.id);
      return summary ? mergeInboxSnapshots([current], [summary])[0] ?? current : current;
    });
    setChannelsState("ready");
    return resolved;
  }

  function failChannelList(snapshotSequence: number) {
    if (!listSnapshotIsCurrent(channelListAppliedSequenceRef.current, snapshotSequence)) return;
    channelListAppliedSequenceRef.current = snapshotSequence;
    setChannelsState("error");
  }

  function applyBotActivity(botId: string, activity: Bot["activity"]) {
    inboxMutationGenerationRef.current += 1;
    const remembered = latestBotSnapshotsRef.current.get(botId);
    if (remembered) {
      latestBotSnapshotsRef.current.set(botId, {
        ...remembered,
        activity: observedActivityAfterRead(remembered.activity, activity),
      });
    }
    setBots((current) => current.map((bot) => (bot.id === botId
      ? { ...bot, activity: observedActivityAfterRead(bot.activity, activity) }
      : bot)));
    setActive((current) => (current?.id === botId
      ? { ...current, activity: observedActivityAfterRead(current.activity, activity) }
      : current));
  }

  function chatIsVisible(): boolean {
    return chatSurfaceIsVisible({
      route: globalRouteRef.current,
      desktop: desktopLayoutRef.current,
      mobileSurface: mobileSurfaceRef.current,
      computerVisible: visibleComputerOpenRef.current,
      documentVisible: document.visibilityState === "visible",
      blockingDialog: blockingChatSurfaceIsOpen(),
    });
  }

  function maybeMarkBotRead(bot: Bot, openingBlockingDialog = false) {
    if (!canAcknowledgeChatRead({
      hasTranscript: bot.messages !== undefined,
      unread: bot.activity.unread,
      surfaceVisible: chatIsVisible(),
      active: activeIdRef.current === bot.id,
      blockingDialog: blockingChatSurfaceIsOpen(),
      openingBlockingDialog,
    })) return;
    const selectionGeneration = selectionGenerationRef.current;
    if (readReceiptControllersRef.current.has(bot.id)) return;
    const controller = new AbortController();
    readReceiptControllersRef.current.set(bot.id, controller);
    void markBotRead(bot.id, bot.activity.cursor, controller.signal)
      .then((activity) => {
        if (selectionIsCurrent(selectionGeneration, bot.id)) applyBotActivity(bot.id, activity);
      })
      .catch(() => undefined)
      .finally(() => {
        if (readReceiptControllersRef.current.get(bot.id) === controller) {
          readReceiptControllersRef.current.delete(bot.id);
        }
      });
  }

  useEffect(() => {
    const media = window.matchMedia(TRANSCRIPT_DESKTOP_QUERY);
    const sync = () => setDesktopLayout(media.matches);
    sync();
    return subscribeTranscriptBreakpoint(media, sync);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;
    const controller = new AbortController();
    const navigation = ++botSettingsNavigationRef.current;
    const listSequence = nextBotSnapshotSequence();
    const channelListSequence = nextChannelSnapshotSequence();
    void listBots(controller.signal)
      .then((data) => {
        if (cancelled) return;
        const acceptedBots = mergeBotSummaries(data.bots, listSequence);
        setBotsLoadError(false);
        setBotsReady(true);
        const initialSettingsLocation = resolveSelectedBotPanelLocation(window.location.hash);
        const requestedSettings = initialSettingsLocation.kind === "open"
          ? initialSettingsLocation
          : null;
        const requestedBot = acceptedBots.find((bot) => bot.id === requestedSettings?.botId);
        const invalidSettingsLocation = (requestedSettings && !requestedBot)
          || (initialSettingsLocation.kind === "close" && initialSettingsLocation.clearInvalidHash);
        if (invalidSettingsLocation) {
          clearBotSettingsLocation();
        }
        const selected = requestedBot ?? acceptedBots[0];
        if (!selected) return;
        const selectionGeneration = beginSelection();
        if (!activateBot(selected, selectionGeneration)) return;
        if (invalidSettingsLocation) transitionSelectedBotPanel({ kind: "close" });
        void botDetailRequestRef.current.run(
          (signal) => reserveSnapshotRequest(
            nextBotSnapshotSequence,
            () => getBot(selected.id, signal),
          ),
          {
            success({ snapshot, sequence }) {
              if (cancelled || !selectionIsCurrent(selectionGeneration, selected.id)) return;
              const merged = mergeBot(snapshot, sequence);
              if (merged) maybeMarkBotRead(merged, requestedSettings?.botId === snapshot.id);
              if (navigation !== botSettingsNavigationRef.current) return;
              if (requestedSettings?.botId === snapshot.id) {
                transitionSelectedBotPanel({
                  kind: "open",
                  botId: snapshot.id,
                  section: requestedSettings.section,
                });
              }
            },
            failure() {
              if (cancelled || !selectionIsCurrent(selectionGeneration, selected.id)) return;
              setActiveDetailErrorId(selected.id);
              if (navigation !== botSettingsNavigationRef.current) return;
              transitionSelectedBotPanel({ kind: "close" });
              if (requestedSettings) clearBotSettingsLocation();
            },
          },
        );
      })
      .catch(() => {
        if (!cancelled) {
          setBotsLoadError(true);
          setBotsReady(true);
        }
      });
    void listChannels(controller.signal)
      .then((data) => {
        if (cancelled) return;
        mergeChannelSummaries(data.channels, channelListSequence);
      })
      .catch(() => {
        if (!cancelled) failChannelList(channelListSequence);
      });
    void listHarnesses(controller.signal)
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
      mountedRef.current = false;
      selectionGenerationRef.current += 1;
      sendRequestGenerationRef.current += 1;
      controller.abort();
      botDetailRequestRef.current.cancel();
      channelDetailRequestRef.current.cancel();
      routeBotRequestRef.current.cancel();
      channelListRequestRef.current.cancel();
      harnessListRequestRef.current.cancel();
      createBotRequestRef.current.cancel();
      createChannelRequestRef.current.cancel();
      sendRequestControllerRef.current?.abort();
      sendRequestControllerRef.current = null;
      reactionRequestControllerRef.current?.abort();
      reactionRequestControllerRef.current = null;
      cardActionRequestRef.current.cancelAll();
      for (const readController of readReceiptControllersRef.current.values()) {
        readController.abort();
      }
      readReceiptControllersRef.current.clear();
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setInboxNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!botsReady) return;
    let cancelled = false;
    let inFlight = false;
    const controller = new AbortController();
    const refresh = () => {
      if (inFlight) return;
      inFlight = true;
      const mutationGeneration = inboxMutationGenerationRef.current;
      const botSnapshotSequence = nextBotSnapshotSequence();
      const channelSnapshotSequence = nextChannelSnapshotSequence();
      void listInbox(controller.signal)
        .then((data) => {
          if (cancelled) return;
          if (mutationGeneration === inboxMutationGenerationRef.current) {
            mergeBotSummaries(data.bots, botSnapshotSequence);
          }
          mergeChannelSummaries(data.channels, channelSnapshotSequence);
        })
        .catch(() => undefined)
        .finally(() => {
          inFlight = false;
        });
    };
    const timer = window.setInterval(refresh, 1_000);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearInterval(timer);
    };
  }, [botsReady]);

  useEffect(() => {
    let cancelled = false;
    const syncBotSettingsLocation = () => {
      const navigation = ++botSettingsNavigationRef.current;
      const location = resolveSelectedBotPanelLocation(window.location.hash);
      if (location.kind === "close") {
        routeBotRequestRef.current.cancel();
        transitionSelectedBotPanel(
          { kind: "close" },
          { restoreFocus: location.restoreFocus },
        );
        if (location.clearInvalidHash) clearBotSettingsLocation();
        return;
      }
      const requested = location;
      if (requested.botId === activeIdRef.current) {
        routeBotRequestRef.current.cancel();
        setMobileSurface("chat");
        transitionSelectedBotPanel({
          kind: "open",
          botId: requested.botId,
          section: requested.section,
        });
        return;
      }
      transitionSelectedBotPanel({ kind: "close" });
      const selectionGeneration = beginSelection();
      void routeBotRequestRef.current.run(
        (signal) => reserveSnapshotRequest(
          nextBotSnapshotSequence,
          () => getBot(requested.botId, signal),
        ),
        {
          success({ snapshot, sequence }) {
            if (
              cancelled
              || navigation !== botSettingsNavigationRef.current
              || selectionGeneration !== selectionGenerationRef.current
            ) return;
            const selected = mergeBot(snapshot, sequence)
              ?? latestBotSnapshotsRef.current.get(snapshot.id);
            if (!selected) return;
            if (!activateBot(selected, selectionGeneration)) return;
            setMobileSurface("chat");
            transitionSelectedBotPanel({
              kind: "open",
              botId: requested.botId,
              section: requested.section,
            });
          },
          failure() {
            if (
              cancelled
              || navigation !== botSettingsNavigationRef.current
              || selectionGeneration !== selectionGenerationRef.current
            ) return;
            setError("Could not open Bot Settings. Try again.");
            transitionSelectedBotPanel({ kind: "close" });
            clearBotSettingsLocation();
          },
        },
      );
    };
    window.addEventListener("hashchange", syncBotSettingsLocation);
    window.addEventListener("popstate", syncBotSettingsLocation);
    return () => {
      cancelled = true;
      routeBotRequestRef.current.cancel();
      window.removeEventListener("hashchange", syncBotSettingsLocation);
      window.removeEventListener("popstate", syncBotSettingsLocation);
    };
  }, []);

  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  useEffect(() => {
    if (!activeId) return;
    const rememberedOpen = computerOpen;
    const current = selectedBotPanelRef.current;
    if (current.botId !== activeId) {
      transitionSelectedBotPanel(
        { kind: "select-bot", botId: activeId, rememberedOpen },
        { persist: false },
      );
      return;
    }
    if (current.open !== rememberedOpen) {
      transitionSelectedBotPanel(
        { kind: "sync-remembered", botId: activeId, open: rememberedOpen },
        { persist: false },
      );
    }
  }, [activeId, computerOpen]);

  useEffect(() => {
    const syncGlobalRoute = () => {
      const next = globalRouteFromHash(window.location.hash);
      if (next !== globalRouteRef.current) beginSelection();
      setAppSettingsOpen(appSettingsRequested(window.location.hash));
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
      computerOpen: selectedBotPanelOpen,
      destination,
    });
    if (computerToClose) {
      transitionSelectedBotPanel({ kind: "close" });
      return;
    }
    if (destination === "chat" && (mobileSurface !== "chat" || selectedBotPanelOpen)) return;
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
  }, [activeId, bots.length, botsLoadError, botsReady, globalRoute, mobileSurface, selectedBotPanelOpen]);

  useEffect(() => {
    clearLongPressTimer();
    setReplyTo(null);
    setReactingId(null);
    setActionMessageId(null);
    setPendingCardIds(new Set());
  }, [activeId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setActionMessageId(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      clearLongPressTimer();
    };
  }, []);

  useEffect(() => {
    if (!activeId) return;
    let cancelled = false;
    let inFlight = false;
    const controller = new AbortController();
    const tick = () => {
      if (inFlight || botMutationPending(activeId)) return;
      inFlight = true;
      const selectionGeneration = selectionGenerationRef.current;
      const snapshotSequence = nextBotSnapshotSequence();
      void getBot(activeId, controller.signal)
        .then((bot) => {
          const merged = cancelled || !selectionIsCurrent(selectionGeneration, activeId)
            ? null
            : mergeBot(bot, snapshotSequence);
          if (merged) {
            maybeMarkBotRead(merged);
          }
        })
        .catch(() => undefined)
        .finally(() => {
          inFlight = false;
        });
    };
    const timer = window.setInterval(tick, 600);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearInterval(timer);
    };
  }, [activeId, blockingChatSurfaceOpen, globalRoute, mobileSurface]);

  useEffect(() => {
    if (active) maybeMarkBotRead(active);
  }, [active?.activity.unread, blockingChatSurfaceOpen, globalRoute, mobileSurface]);

  async function createOrderedBot(name: string): Promise<Bot> {
    const identity = createBotRequestRef.current.begin();
    const { snapshot, sequence } = await reserveSnapshotRequest(
      nextBotSnapshotSequence,
      () => createBot(name, identity.signal),
    );
    if (!identity.isCurrent()) throw identity.signal.reason ?? new DOMException("Aborted", "AbortError");
    createdBotSequencesRef.current.set(snapshot.id, sequence);
    return snapshot;
  }

  function openCreatedBot(bot: Bot) {
    inboxMutationGenerationRef.current += 1;
    const snapshotSequence = createdBotSequencesRef.current.get(bot.id) ?? nextBotSnapshotSequence();
    createdBotSequencesRef.current.delete(bot.id);
    const accepted = acceptOrderedSnapshots(botSnapshotAppliedRef.current, [bot], snapshotSequence)[0];
    const remembered = accepted
      ? rememberBotSnapshot(accepted)
      : latestBotSnapshotsRef.current.get(bot.id);
    if (!remembered) return;
    botSettingsNavigationRef.current += 1;
    const currentHash = window.location.hash;
    setError(null);
    setBots((rows) => [...rows.filter((row) => row.id !== remembered.id), remembered]);
    setBotsReady(true);
    const selectionGeneration = beginSelection();
    const panel = activateBot(remembered, selectionGeneration);
    if (!panel) return;
    syncSelectedBotPanelLocationAfterBotChange({
      currentHash,
      selectedBotId: remembered.id,
      panel,
      replaceHash: replaceLocationHash,
    });
    setMobileSurface("chat");
  }

  async function createOrderedChannel(input: { title: string; botIds: string[] }): Promise<Channel> {
    const identity = createChannelRequestRef.current.begin();
    const { snapshot, sequence } = await reserveSnapshotRequest(
      nextChannelSnapshotSequence,
      () => createGroupChannel(input, identity.signal),
    );
    if (!identity.isCurrent()) throw identity.signal.reason ?? new DOMException("Aborted", "AbortError");
    createdChannelSequencesRef.current.set(snapshot.id, sequence);
    return snapshot;
  }

  function openCreatedGroup(channel: Channel) {
    inboxMutationGenerationRef.current += 1;
    const snapshotSequence = createdChannelSequencesRef.current.get(channel.id) ?? nextChannelSnapshotSequence();
    createdChannelSequencesRef.current.delete(channel.id);
    const accepted = acceptOrderedSnapshots(channelSnapshotAppliedRef.current, [channel], snapshotSequence)[0];
    const remembered = accepted
      ? rememberChannelSnapshot(accepted)
      : latestChannelSnapshotsRef.current.get(channel.id);
    if (!remembered) return;
    setError(null);
    setChannels((current) => mergeInboxSnapshots(current, [remembered]));
    setChannelsState("ready");
    openGroup(remembered);
  }

  function openNewBot(event: MouseEvent<HTMLButtonElement>) {
    newBotOpenerRef.current = event.currentTarget;
    setNewBotOpen(true);
  }

  function openNewBotFromMenu() {
    newBotOpenerRef.current = createMenuTriggerRef.current;
    setNewBotOpen(true);
  }

  function openNewChannelFromMenu() {
    setNewChannelOpen(true);
  }

  function openPlugins(returnTarget: PluginsReturnTarget) {
    beginSelection();
    pluginsReturnTargetRef.current = returnTarget;
    botSettingsNavigationRef.current += 1;
    transitionSelectedBotPanel({ kind: "close" });
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
    const selectionGeneration = selectionGenerationRef.current;
    setActiveDetailErrorId(null);
    void botDetailRequestRef.current.run(
      (signal) => reserveSnapshotRequest(
        nextBotSnapshotSequence,
        () => getBot(botId, signal),
      ),
      {
        success({ snapshot, sequence }) {
          if (selectionIsCurrent(selectionGeneration, botId)) mergeBot(snapshot, sequence);
        },
        failure() {
          if (selectionIsCurrent(selectionGeneration, botId)) setActiveDetailErrorId(botId);
        },
      },
    );
  }

  function retryChannels() {
    const snapshotSequence = nextChannelSnapshotSequence();
    void channelListRequestRef.current.run(
      async (signal) => ({
        snapshot: await listChannels(signal),
        sequence: snapshotSequence,
      }),
      {
        pending: () => setChannelsState("loading"),
        success: ({ snapshot, sequence }) => mergeChannelSummaries(snapshot.channels, sequence),
        failure: () => failChannelList(snapshotSequence),
      },
    );
  }

  function retryHarnesses() {
    void harnessListRequestRef.current.run(
      (signal) => listHarnesses(signal),
      {
        pending: () => setHarnessesState("loading"),
        success(data) {
          setHarnesses(data.harnesses);
          setHarnessesState("ready");
        },
        failure: () => setHarnessesState("error"),
      },
    );
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
    const submittedDraft = draft;
    const text = submittedDraft.trim();
    const targetId = replyTo?.id;
    const draftKey = botDraftKey(botId);
    const clearedRevision = storeDraft(draftKey, "");
    const selectionGeneration = selectionGenerationRef.current;
    const requestGeneration = ++sendRequestGenerationRef.current;
    sendRequestControllerRef.current?.abort();
    const controller = new AbortController();
    sendRequestControllerRef.current = controller;
    setBusy(true);
    setError(null);
    try {
      await performBotMutation(
        botId,
        () => sendMessage(botId, text, targetId, controller.signal),
        controller.signal,
        () => selectionIsCurrent(selectionGeneration, botId),
      );
      if (selectionIsCurrent(selectionGeneration, botId)) setReplyTo(null);
    } catch (err) {
      if (isAbortError(err, controller.signal)) return;
      if (
        mountedRef.current
        && shouldRestoreFailedDraft(draftRevisionsRef.current[draftKey] ?? 0, clearedRevision)
      ) {
        storeDraft(draftKey, submittedDraft);
      }
      if (selectionIsCurrent(selectionGeneration, botId)) {
        const message = err instanceof Error ? err.message : "Could not send.";
        if (!isCancelledMessage(message)) setError(message);
      }
    } finally {
      if (sendRequestControllerRef.current === controller) {
        sendRequestControllerRef.current = null;
      }
      if (sendRequestGenerationRef.current === requestGeneration) setBusy(false);
    }
  }

  async function onCardAction(
    messageId: string,
    action: TranscriptCardAction,
    duration?: "once" | "session" | "until-revoked",
  ) {
    if (!activeId) return;
    const botId = activeId;
    const selectionGeneration = selectionGenerationRef.current;
    if (action.command.kind === "open-computer") {
      openComputerFor(botId);
      return;
    }
    const initiatingCard = messageBubbleRefs.current.get(messageId) ?? null;
    const actionKey = `${selectionGeneration}:${botId}:${messageId}`;
    const identity = cardActionRequestRef.current.begin(actionKey);
    setCardPending(messageId, true);
    setError(null);
    try {
      const result = await runWithAuthoritativeRefresh(
        async (signal) => {
          if (action.command.kind === "permission") {
            const optionId = action.command.optionId;
            return performBotMutation(
              botId,
              () => answerPermission(botId, messageId, optionId, signal),
              signal,
            );
          }
          if (action.command.kind === "host-grant") {
            if (!duration) throw new Error("Choose how long this Host grant should last.");
            const access = action.command.access;
            return performBotMutation(
              botId,
              () => answerHostGrant(botId, messageId, access, duration, signal),
              signal,
            );
          }
          if (action.command.kind === "retry-message") {
            return performBotMutation(
              botId,
              () => retryTranscriptCard(botId, messageId, signal),
              signal,
            );
          }
          if (action.command.kind === "resolve-needs-you") {
            const eventId = action.command.eventId;
            const resolution = action.command.resolution;
            return performBotMutation(
              botId,
              () => resolveNeedsYouCard(botId, messageId, eventId, resolution, signal),
              signal,
            );
          }
          throw new Error("Could not complete this action.");
        },
        (signal) => reserveSnapshotRequest(
          nextBotSnapshotSequence,
          () => getBot(botId, signal),
        ),
        identity.signal,
      );
      if (!selectionIsCurrent(selectionGeneration, botId) || result.ok) return;
      if (result.authoritative) {
        mergeBot(result.authoritative.snapshot, result.authoritative.sequence);
      }
      setError(result.error instanceof Error ? result.error.message : "Could not complete this action.");
    } catch (err) {
      if (!isAbortError(err, identity.signal) && selectionIsCurrent(selectionGeneration, botId)) {
        setError(err instanceof Error ? err.message : "Could not complete this action.");
      }
    } finally {
      const ownsPendingState = identity.finish();
      if (ownsPendingState && selectionIsCurrent(selectionGeneration, botId)) {
        setCardPending(messageId, false);
        window.requestAnimationFrame(() => {
          if (activeIdRef.current !== botId || !selectionIsCurrent(selectionGeneration, botId)) return;
          const activeElement = document.activeElement;
          const focusStayedWithCard = Boolean(
            initiatingCard && activeElement && initiatingCard.contains(activeElement),
          );
          const focusNeedsRecovery = activeElement === document.body || !activeElement?.isConnected;
          if (focusStayedWithCard || focusNeedsRecovery) {
            messageBubbleRefs.current.get(messageId)?.focus();
          }
        });
      }
    }
  }

  function setCardPending(messageId: string, pending: boolean) {
    setPendingCardIds((current) => {
      const next = new Set(current);
      if (pending) next.add(messageId);
      else next.delete(messageId);
      return next;
    });
  }

  async function onReact(messageId: string, emoji: string) {
    if (!activeId) return;
    const botId = activeId;
    const selectionGeneration = selectionGenerationRef.current;
    reactionRequestControllerRef.current?.abort();
    const controller = new AbortController();
    reactionRequestControllerRef.current = controller;
    try {
      await performBotMutation(
        botId,
        () => toggleReaction(botId, messageId, emoji, controller.signal),
        controller.signal,
        () => selectionIsCurrent(selectionGeneration, botId),
      );
      if (selectionIsCurrent(selectionGeneration, botId)) {
        setReactingId(null);
        setActionMessageId(null);
      }
    } catch (err) {
      if (!isAbortError(err, controller.signal) && selectionIsCurrent(selectionGeneration, botId)) {
        setError(err instanceof Error ? err.message : "Could not react.");
      }
    } finally {
      if (reactionRequestControllerRef.current === controller) {
        reactionRequestControllerRef.current = null;
      }
    }
  }

  function renderDaySeparator(
    message: ChatMessage,
    presentation: ChatChronologyItem | undefined,
  ) {
    if (!presentation?.dayLabel) return null;
    return (
      <li
        role="separator"
        className="self-center px-3 pb-1 pt-4 text-[11px] font-medium text-muted-foreground"
      >
        <time dateTime={message.createdAt}>{presentation.dayLabel}</time>
      </li>
    );
  }

  function renderBubble(
    message: ChatMessage,
    presentation: ChatChronologyItem | undefined,
    replyTarget: ChatMessage | null,
  ) {
    const spacingClass = presentation?.spacing === "compact"
      ? "mt-[var(--message-burst-gap)]"
      : "mt-[var(--message-inter-burst-gap)]";
    if (message.kind === "card" && message.card) {
      const card = (
        <TranscriptCard
          ref={(node) => {
            if (node) messageBubbleRefs.current.set(message.id, node);
            else messageBubbleRefs.current.delete(message.id);
          }}
          card={message.card}
          busy={pendingCardIds.has(message.id)}
          onAction={(action, duration) => void onCardAction(message.id, action, duration)}
        />
      );
      return (
        <li
          key={message.id}
          data-message-id={message.id}
          data-burst="card"
          data-tail="none"
          className={cn("w-full max-w-[var(--message-max-width)] self-center", spacingClass)}
        >
          {presentation?.exactTime ? (
            <Tooltip>
              <TooltipTrigger asChild>{card}</TooltipTrigger>
              <TooltipContent>
                <time dateTime={message.createdAt}>{presentation.exactTime}</time>
              </TooltipContent>
            </Tooltip>
          ) : card}
        </li>
      );
    }
    if (message.kind === "host-grant") {
      const card = (
        <div
          ref={(node) => {
            if (node) messageBubbleRefs.current.set(message.id, node);
            else messageBubbleRefs.current.delete(message.id);
          }}
          data-testid="host-grant-history"
          tabIndex={0}
          className="rounded-2xl bg-secondary px-4 py-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <p className="font-medium">Host grant</p>
          <p className="mt-1 whitespace-pre-wrap break-all text-muted-foreground">{message.text}</p>
        </div>
      );
      return (
        <li
          key={message.id}
          data-message-id={message.id}
          data-burst="card"
          data-tail="none"
          className={cn("w-full max-w-[var(--message-max-width)] self-center", spacingClass)}
        >
          {presentation?.exactTime ? (
            <Tooltip>
              <TooltipTrigger asChild>{card}</TooltipTrigger>
              <TooltipContent>
                <time dateTime={message.createdAt}>{presentation.exactTime}</time>
              </TooltipContent>
            </Tooltip>
          ) : card}
        </li>
      );
    }
    const user = message.role === "user";
    const receipt = presentation?.receipt ?? null;
    const pickerOpen = reactingId === message.id;
    const actionsOpen = actionMessageId === message.id || pickerOpen;
    const mine = (message.reactions ?? []).map((item) => item.emoji);
    const picker = pickerOpen ? (
      <DropdownMenuContent
        data-testid="emoji-picker"
        side="bottom"
        align={user ? "end" : "start"}
        className="flex min-w-0 gap-1 rounded-full p-1"
      >
        {TAPBACKS.map((emoji) => (
          <DropdownMenuCheckboxItem
            key={emoji}
            aria-label={`React ${emoji}`}
            checked={mine.includes(emoji)}
            onSelect={() => void onReact(message.id, emoji)}
            className={cn("relative size-8 justify-center rounded-full p-0 text-base", PHONE_ACTION_TARGET_CLASS)}
          >
            {emoji}
            <DropdownMenuItemIndicator>
              <Check aria-hidden="true" className="absolute right-0.5 top-0.5 size-3 rounded-full bg-background" />
            </DropdownMenuItemIndicator>
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    ) : null;
    const bubble = (
      <div
        ref={(node) => {
          if (node) messageBubbleRefs.current.set(message.id, node);
          else messageBubbleRefs.current.delete(message.id);
        }}
        data-testid="message-bubble"
        data-message-id={message.id}
        data-tail={presentation?.tail ?? "none"}
        tabIndex={0}
        onPointerDown={(event) => startLongPress(event, message.id)}
        onPointerUp={clearLongPressTimer}
        onPointerCancel={clearLongPressTimer}
        onPointerLeave={clearLongPressTimer}
        onContextMenu={(event) => {
          if (!window.matchMedia("(pointer: coarse)").matches) return;
          event.preventDefault();
          clearLongPressTimer();
          setReactingId(null);
          setActionMessageId(message.id);
        }}
        className={cn(
          "openbot-chat-bubble relative touch-manipulation rounded-[var(--radius-bubble)] px-4 py-2.5 text-sm break-words focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          user
            ? "bg-bubble-outgoing text-bubble-outgoing-foreground"
            : "bg-bubble-incoming text-bubble-incoming-foreground",
        )}
      >
        {replyTarget ? (
          <button
            type="button"
            data-testid="reply-quote"
            aria-label={`View replied message from ${replyTarget.role === "user" ? "You" : (active?.name ?? "Bot")}: ${previewText(replyTarget.text)}`}
            onClick={(event) => {
              event.stopPropagation();
              focusTranscriptMessage(replyTarget.id);
            }}
            className={cn(
              "mb-2 flex w-full min-w-0 items-center gap-1.5 rounded-lg border-l-2 border-current/30 bg-[var(--message-code-surface)] px-2 py-1 text-left text-[11px] leading-snug hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current",
              PHONE_ACTION_TARGET_CLASS,
            )}
          >
            <Reply className="size-3 shrink-0" aria-hidden="true" />
            <span className="shrink-0 font-medium">
              {replyTarget.role === "user" ? "You" : (active?.name ?? "Bot")}
            </span>
            <span className="truncate opacity-75">{previewText(replyTarget.text)}</span>
          </button>
        ) : null}
        <ChatMessageText text={message.text} />
      </div>
    );
    return (
      <li
        key={message.id}
        data-message-id={message.id}
        data-burst={presentation?.burst ?? "none"}
        data-tail={presentation?.tail ?? "none"}
        data-reply-to={message.replyTo}
        className={cn(
          "group flex max-w-[var(--message-max-width-compact)] flex-col gap-1 min-[48rem]:max-w-[var(--message-max-width)]",
          spacingClass,
          user ? "self-end items-end" : "self-start items-start",
        )}
      >
        <div className={cn("flex items-end gap-1", user ? "flex-row-reverse" : "flex-row")}>
          <div className={cn("relative", message.reactions && message.reactions.length > 0 && "mb-2 pb-1")}>
            {presentation?.exactTime ? (
              <Tooltip>
                <TooltipTrigger asChild>{bubble}</TooltipTrigger>
                <TooltipContent>
                  <time dateTime={message.createdAt}>{presentation.exactTime}</time>
                </TooltipContent>
              </Tooltip>
            ) : bubble}
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
            open={actionsOpen}
            onReply={() => {
              setReplyTo(message);
              setReactingId(null);
              setActionMessageId(null);
              window.requestAnimationFrame(() => composerRef.current?.focus());
            }}
            pickerOpen={pickerOpen}
            onPickerOpenChange={(nextOpen) => {
              setActionMessageId(nextOpen ? message.id : null);
              setReactingId(nextOpen ? message.id : null);
            }}
            picker={picker}
          />
        </div>
        {receipt ? <span className="px-1 text-[11px] text-muted-foreground">{receipt}</span> : null}
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
  const transcriptRows = buildFlatTranscriptRows(visible);
  const transcriptRevision = transcriptContentRevision(visible);
  const chronologyNow = new Date();
  const chronology = buildChatChronology(
    visible,
    chronologyNow,
    undefined,
    { receiptOrder: visible },
  );
  const chronologyById = new Map(chronology.map((item) => [item.id, item]));
  const writing = isWorkingMode(active?.eyes.mode);
  useLayoutEffect(() => {
    const transcript = transcriptScrollRef.current;
    const transcriptMounted = transcriptHasLayout(transcript);
    const observation = observeTranscriptViewport(
      {
        botId: previousTranscriptBotIdRef.current,
        revision: previousTranscriptRevisionRef.current,
        writing: previousTranscriptWritingRef.current,
        mounted: previousTranscriptMountedRef.current,
      },
      { botId: activeId, revision: transcriptRevision, writing },
      transcriptMounted,
    );
    previousTranscriptBotIdRef.current = observation.snapshot.botId;
    previousTranscriptRevisionRef.current = observation.snapshot.revision;
    previousTranscriptWritingRef.current = observation.snapshot.writing;
    previousTranscriptMountedRef.current = observation.snapshot.mounted;
    const layoutChanged = previousTranscriptDesktopRef.current !== desktopLayout;
    previousTranscriptDesktopRef.current = desktopLayout;
    if (!transcript || !transcriptMounted) return;
    const { chatChanged, remounted, revisionChanged, writingChanged } = observation;

    const decision = transcriptViewportDecision({
      chatChanged,
      remounted,
      revisionChanged,
      writingChanged,
      layoutChanged,
      nearBottom: transcriptNearBottomRef.current,
    });
    const restoredScrollTop = remountedTranscriptScrollTop({
      remounted,
      chatChanged,
      nearBottom: transcriptNearBottomRef.current,
      savedScrollTop: activeDraftKey
        ? transcriptScrollTopByChatRef.current.get(activeDraftKey)
        : undefined,
    });
    transcriptNearBottomRef.current = decision.nearBottom;
    if (restoredScrollTop !== null) transcript.scrollTop = restoredScrollTop;
    else if (decision.scrollToBottom) transcript.scrollTop = transcript.scrollHeight;
    if (activeDraftKey) {
      transcriptScrollTopByChatRef.current.set(activeDraftKey, transcript.scrollTop);
    }
    if (decision.newMessages !== null) setNewMessagesAvailable(decision.newMessages);
  }, [
    activeId,
    activeDraftKey,
    chatDetailState,
    desktopLayout,
    globalRoute,
    mobileSurface,
    transcriptRevision,
    visibleComputerOpen,
    writing,
  ]);
  const inboxRows = buildChatInbox({ bots, channels, drafts });
  const filteredInboxRows = filterChatInbox(inboxRows, inboxQuery);
  const inboxRowsSignature = inboxRows
    .map((row) => `${row.key}\u0000${row.signal ?? ""}\u0000${row.activityAt}\u0000${row.preview}`)
    .join("\u0001");
  useEffect(() => {
    const announcement = inboxAnnouncement(previousInboxRowsRef.current, inboxRows);
    previousInboxRowsRef.current = inboxRows;
    if (announcement) {
      setInboxLive((current) => ({ serial: current.serial + 1, text: announcement }));
    }
  }, [inboxRowsSignature]);
  const inboxBots = new Map(bots.map((bot) => [bot.id, bot]));
  const inboxChannels = new Map(channels.map((channel) => [channel.id, channel]));

  function focusOnNextFrame(ref: { current: HTMLElement | null }) {
    window.requestAnimationFrame(() => ref.current?.focus());
  }

  function clearInboxSearch() {
    setInboxQuery("");
    focusOnNextFrame(inboxSearchRef);
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
    const currentHash = window.location.hash;
    const selectionGeneration = beginSelection();
    const panel = activateBot(bot, selectionGeneration);
    if (!panel) return;
    syncSelectedBotPanelLocationAfterBotChange({
      currentHash,
      selectedBotId: bot.id,
      panel,
      replaceHash: replaceLocationHash,
    });
    setMobileSurface("chat");
    void botDetailRequestRef.current.run(
      (signal) => reserveSnapshotRequest(
        nextBotSnapshotSequence,
        () => getBot(bot.id, signal),
      ),
      {
        success({ snapshot, sequence }) {
          if (!selectionIsCurrent(selectionGeneration, bot.id)) return;
          const merged = mergeBot(snapshot, sequence);
          if (merged) maybeMarkBotRead(merged);
        },
        failure() {
          if (selectionIsCurrent(selectionGeneration, bot.id)) setActiveDetailErrorId(bot.id);
        },
      },
    );
  }

  function openGroup(channel: Channel) {
    botSettingsNavigationRef.current += 1;
    transitionSelectedBotPanel({ kind: "clear-selection" });
    if (parseBotSettingsHash(window.location.hash)) clearBotSettingsLocation();
    const selectionGeneration = beginSelection();
    activeIdRef.current = null;
    activeGroupIdRef.current = channel.id;
    setActiveId(null);
    setActive(null);
    setActiveGroup(channel);
    setMobileSurface("chat");
    void channelDetailRequestRef.current.run(
      (signal) => reserveSnapshotRequest(
        nextChannelSnapshotSequence,
        () => getChannel(channel.id, signal),
      ),
      {
        success({ snapshot, sequence }) {
          if (
            selectionGeneration === selectionGenerationRef.current
            && activeGroupIdRef.current === channel.id
          ) mergeChannel(snapshot, sequence);
        },
        failure() {
          // The selected group summary remains visible when detail is temporarily unavailable.
        },
      },
    );
  }

  function openCommandPaletteChat(row: ChatInboxRow) {
    const bot = row.kind === "bot" ? inboxBots.get(row.id) : undefined;
    const channel = row.kind === "group" ? inboxChannels.get(row.id) : undefined;
    if (bot) openBot(bot);
    else if (channel) openGroup(channel);
    else return;
    focusOnNextFrame(chatRegionRef);
  }

  function openAppSettingsFromPalette() {
    if (!desktopLayoutRef.current) setMobileSurface("sidebar");
    appSettingsEntryRef.current?.querySelector<HTMLButtonElement>("button")?.click();
  }

  function openNewBotFromPalette() {
    if (!desktopLayoutRef.current) setMobileSurface("sidebar");
    openNewBotFromMenu();
  }

  function openBotSettingsFromPalette(botId: string) {
    if (activeIdRef.current !== botId || activeId !== botId) return;
    openBotSettings();
  }

  function openBotSettings(event?: MouseEvent<HTMLButtonElement>) {
    if (!activeId) return;
    botSettingsNavigationRef.current += 1;
    botSettingsOpenerRef.current = event?.currentTarget ?? computerButtonRef.current;
    transitionSelectedBotPanel({ kind: "open", botId: activeId, section: "ai" });
    window.history.pushState(
      window.history.state,
      "",
      `${window.location.pathname}${window.location.search}${botSettingsHash(activeId, "ai")}`,
    );
  }

  function setBotSettingsOpenFromPanel(next: boolean) {
    if (!next) botSettingsNavigationRef.current += 1;
    if (!next) {
      transitionSelectedBotPanel({ kind: "close" });
      setMobileSurface("chat");
    } else if (activeId) {
      transitionSelectedBotPanel({ kind: "open", botId: activeId, section: botSettingsSection });
    }
    if (next || !parseBotSettingsHash(window.location.hash)) return;
    clearBotSettingsLocation();
  }

  function chooseBotSettingsSection(section: BotSettingsSection) {
    if (!activeId || section === botSettingsSection) return;
    botSettingsNavigationRef.current += 1;
    transitionSelectedBotPanel({ kind: "section", section });
    window.history.pushState(
      window.history.state,
      "",
      `${window.location.pathname}${window.location.search}${botSettingsHash(activeId, section)}`,
    );
  }

  async function applyBotMutation(
    botId: string,
    request: () => Promise<Bot>,
    signal?: AbortSignal,
  ): Promise<Bot> {
    return performBotMutation(botId, request, signal);
  }

  function openComputerFor(botId: string) {
    if (activeId !== botId || activeIdRef.current !== botId) return;
    updateComputerPane(botId, true);
    transitionSelectedBotPanel({ kind: "open-computer", botId }, { persist: false });
    focusOnNextFrame(closeComputerButtonRef);
  }

  function openComputer() {
    if (!activeId) return;
    openComputerFor(activeId);
  }

  function openComputerFromPanel(botId: string) {
    if (activeIdRef.current !== botId) return;
    openComputer();
  }

  function closeComputer() {
    transitionSelectedBotPanel({ kind: "close-computer" });
    focusOnNextFrame(computerPreviewRef);
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
          newBotRef={newBotOpenerRef}
          pluginsRef={welcomePluginsRef}
          destinationRef={welcomeDestinationRef}
          appSettingsOpen={appSettingsOpen}
          onAppSettingsOpenChange={setAppSettingsOpen}
        />
        <NewBotDialog
          open={newBotOpen}
          onOpenChange={setNewBotOpen}
          openerRef={newBotOpenerRef}
          destinationRef={newBotDestinationRef}
          onCreate={createBot}
          onCreated={openCreatedBot}
        />
        <MessengerCommandPalette
          open={commandPaletteOpen}
          enabled={paletteShortcutEnabled}
          chats={[]}
          selectedBot={null}
          appFocusRef={welcomeDestinationRef}
          onOpenChange={setCommandPaletteOpen}
          onOpenChat={() => undefined}
          onNewBot={() => newBotOpenerRef.current?.click()}
          onAppSettings={() => {
            welcomeDestinationRef.current
              ?.querySelector<HTMLButtonElement>("[data-first-use-app-settings] button")
              ?.click();
          }}
          onBotSettings={() => undefined}
          onPlugins={() => welcomePluginsRef.current?.click()}
          onComputer={() => undefined}
        />
      </>
    );
  }

  return (
    <ToastProvider duration={3600} swipeDirection="right">
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        <span key={inboxLive.serial}>{inboxLive.text}</span>
      </p>
      <MessengerShell
        mobileSurface={mobileSurface}
        desktopLayout={desktopLayout}
        chatRef={chatRegionRef}
        sidebar={
        <>
          <div className="flex h-[var(--header-height)] items-center justify-between gap-3 px-4">
            <div className="flex min-w-0 items-center gap-3">
              <Eyes size={32} className="aspect-square shrink-0" />
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">OpenBot</p>
                <p className="text-xs text-muted-foreground">Chats</p>
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
                  <DropdownMenuItem onSelect={openNewChannelFromMenu}>
                    <MessageSquare />
                    New Channel
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
          <div className="px-3 pb-3">
            <div className="relative">
              <Search
                aria-hidden
                className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                ref={inboxSearchRef}
                type="text"
                value={inboxQuery}
                onChange={(event) => setInboxQuery(event.target.value)}
                aria-label="Search Chats"
                aria-describedby="chat-search-scope"
                placeholder="Search Chats"
                className="h-[var(--touch-min)] rounded-[var(--radius-control)] bg-background/75 pl-9 pr-10"
              />
              {inboxQuery ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      aria-label="Clear Chat search"
                      onClick={clearInboxSearch}
                      className="absolute right-0 top-1/2 min-h-[var(--touch-min)] min-w-[var(--touch-min)] -translate-y-1/2 rounded-[var(--radius-control)] text-muted-foreground hover:text-foreground"
                    >
                      <X className="size-[var(--icon-default)]" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Clear Chat search</TooltipContent>
                </Tooltip>
              ) : null}
            </div>
            <span id="chat-search-scope" className="sr-only">
              Filters current Chats by visible name and latest preview.
            </span>
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
          {filteredInboxRows.length === 0 ? (
            <div className="px-3 py-8 text-center text-sm text-muted-foreground" role="status">
              <p>{inboxQuery.trim() ? "No Chats match this search." : "No Chats yet."}</p>
              {inboxQuery.trim() ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={clearInboxSearch}
                  className="min-h-[var(--touch-min)] min-w-[var(--touch-min)]"
                >
                  Clear search
                </Button>
              ) : null}
            </div>
          ) : (
            <ul className="space-y-1" aria-label="Chats">
              {filteredInboxRows.map((row: ChatInboxRow) => {
                const bot = row.kind === "bot" ? inboxBots.get(row.id) : undefined;
                const channel = row.kind === "group" ? inboxChannels.get(row.id) : undefined;
                if ((!bot && row.kind === "bot") || (!channel && row.kind === "group")) return null;
                const selected = row.kind === "bot"
                  ? activeId === row.id && !activeGroup
                  : activeGroup?.id === row.id;
                const relativeTime = formatRelativeActivityTime(row.activityAt, inboxNow);
                const signalLabel = row.signal === "waiting"
                  ? "Waiting for you"
                  : row.signal === "unread"
                    ? "Unread"
                    : row.signal === "working"
                      ? "Working"
                      : null;
                const ordinaryPreview = row.draftPreview ?? (row.preview || "No messages yet");
                const accessiblePreview = signalLabel
                  ? `${signalLabel}${row.preview ? `, ${row.preview}` : ""}`
                  : row.draftPreview
                    ? `Draft, ${row.draftPreview}`
                    : ordinaryPreview;
                return (
                  <li key={row.key}>
                    <button
                      type="button"
                      data-testid={row.kind === "group" ? "group-channel-row" : "chat-inbox-row"}
                      data-inbox-signal={row.signal ?? "ordinary"}
                      aria-current={selected ? "page" : undefined}
                      aria-label={`${row.name}, ${accessiblePreview}, ${relativeTime}`}
                      onClick={() => (bot ? openBot(bot) : channel ? openGroup(channel) : undefined)}
                      className={cn(
                        "flex h-[4.5rem] w-full items-center gap-3 rounded-[var(--radius-control)] px-3 text-left hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        selected && "bg-sidebar-accent",
                      )}
                    >
                      {bot ? (
                        <Eyes
                          name={bot.name}
                          color={bot.eyes.color}
                          shape={bot.eyes.shape as FaceShape}
                          mode={inboxEyesMode(row.signal, bot.eyes.mode as FaceMode)}
                          size={32}
                          className="aspect-square shrink-0"
                        />
                      ) : channel ? (
                        <StackedEyes
                          faces={botMembers(channel).map((member) => ({
                            name: member.name,
                            color: member.eyes?.color,
                            shape: member.eyes?.shape,
                          }))}
                          size={30}
                        />
                      ) : null}
                      <span className="min-w-0 flex-1">
                        <span className="flex items-baseline gap-2">
                          <span className={cn("min-w-0 flex-1 truncate text-sm", row.signal === "unread" && "font-semibold")}>
                            {row.name}
                          </span>
                          <time
                            dateTime={row.activityAt}
                            title={new Date(row.activityAt).toLocaleString()}
                            className="shrink-0 text-[11px] text-muted-foreground"
                          >
                            {relativeTime}
                          </time>
                        </span>
                        <span className="mt-0.5 flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                          {signalLabel ? (
                            <span
                              className={cn(
                                "shrink-0 font-medium",
                                row.signal === "waiting" && "text-warning",
                                row.signal === "unread" && "text-info",
                                row.signal === "working" && "text-foreground",
                              )}
                            >
                              {signalLabel}
                            </span>
                          ) : row.draftPreview ? (
                            <span className="shrink-0 font-medium text-destructive">Draft</span>
                          ) : null}
                          {(signalLabel && row.preview) || row.draftPreview ? (
                            <span aria-hidden className="shrink-0">·</span>
                          ) : null}
                          <span className="min-w-0 flex-1 truncate">
                            {signalLabel ? row.preview : ordinaryPreview}
                          </span>
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
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
          <div ref={appSettingsEntryRef} className="contents">
            <SelectedBotPanelAppSettings
              open={appSettingsOpen}
              selectedBotPanelOpen={selectedBotPanel.open}
              harnesses={harnesses}
              harnessesState={harnessesState}
              onOpenChange={setAppSettingsOpen}
              onCloseSelectedBotPanel={closeSelectedBotPanelForAppSettings}
              onRetryHarnesses={retryHarnesses}
            />
          </div>
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
              <div
                ref={(node) => {
                  newBotDestinationRef.current = node;
                }}
                tabIndex={-1}
                className="flex min-h-[var(--touch-min)] min-w-0 items-center gap-2 px-2"
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
              </div>
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
              <SelectedBotPanelControl
                visibleComputerOpen={visibleComputerOpen}
                controlRef={computerButtonRef}
                onOpen={() => openBotSettings()}
                onClose={() => setBotSettingsOpenFromPanel(false)}
              />
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
          <div className="relative flex min-h-0 flex-1">
            <div
              ref={transcriptScrollRef}
              onScroll={onTranscriptScroll}
              className="flex min-h-0 flex-1 flex-col overflow-y-auto px-[var(--phone-edge)] py-4 min-[48rem]:px-6"
            >
            <ul className="mx-auto flex w-full max-w-[var(--transcript-max-width)] flex-1 flex-col">
              {transcriptRows.map(({ message, replyTarget }) => {
                const presentation = chronologyById.get(message.id);
                return (
                  <Fragment key={message.id}>
                    {renderDaySeparator(message, presentation)}
                    {renderBubble(message, presentation, replyTarget)}
                  </Fragment>
                );
              })}
              {writing ? (
                <li
                  data-testid="working-indicator"
                  role="status"
                  className="mt-[var(--message-inter-burst-gap)] flex max-w-[85%] items-start self-start"
                >
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span
                        data-testid="working-eyes"
                        tabIndex={0}
                        className="inline-flex rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background motion-reduce:ring-2 motion-reduce:ring-primary motion-reduce:ring-offset-2 motion-reduce:ring-offset-background"
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
            </div>
            {newMessagesAvailable ? (
              <Button
                type="button"
                size="sm"
                data-testid="new-messages"
                onClick={scrollToLatest}
                className={cn(
                  "absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-full shadow-md",
                  PHONE_ACTION_TARGET_CLASS,
                )}
              >
                New messages
              </Button>
            ) : null}
          </div>
        ) : active && chatDetailState === "empty" ? (
          <EmptyChatStart bot={active} onSuggestion={chooseSuggestion} onOpenSettings={openBotSettings} />
        ) : (
          <div className="flex flex-1 items-center justify-center px-6 text-sm text-muted-foreground">
            Opening Chat…
          </div>
        )}
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
                  className={PHONE_ACTION_TARGET_CLASS}
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
                        ? "Choose a Connection to start…"
                        : replyTo
                          ? "Reply…"
                          : "Message a Bot…"
              }
              disabled={!composerSendEnabled(composerKind)}
              className={cn("min-h-10 resize-none", PHONE_COMPOSER_INPUT_CLASS)}
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
                  className={PHONE_COMPOSER_SEND_CLASS}
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
        visibleComputerOpen && activeId && active ? (
          <SelectedBotSurface
            computerExpanded={computerExpanded}
            panel={(
              <BotSettings
                key={active.id}
                bot={active}
                harnesses={harnesses}
                harnessesState={harnessesState}
                open
                onOpenChange={setBotSettingsOpenFromPanel}
                onBotMutation={applyBotMutation}
                onRetryHarnesses={retryHarnesses}
                onOpenComputer={openComputerFromPanel}
                computerPreviewRef={computerPreviewRef}
                computerPreviewVisible={!computerExpanded}
                trapFocus={!desktopLayout}
                section={botSettingsSection}
                onSectionChange={chooseBotSettingsSection}
              />
            )}
            computer={(
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
                    aria-label="Back to Bot panel"
                    onClick={closeComputer}
                    className="min-h-[var(--touch-min)] shrink-0"
                  >
                    <MessageSquare />
                    Back
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
                    onFailure={setError}
                    showChatButton={false}
                  />
                </div>
              </>
            )}
          />
        ) : null
      }
      />
      <NewBotDialog
        open={newBotOpen}
        onOpenChange={setNewBotOpen}
        openerRef={newBotOpenerRef}
        destinationRef={newBotDestinationRef}
        onCreate={createOrderedBot}
        onCreated={openCreatedBot}
      />
      <NewChannelDialog
        open={newChannelOpen}
        onOpenChange={setNewChannelOpen}
        openerRef={createMenuTriggerRef}
        destinationRef={chatRegionRef}
        bots={bots}
        onCreate={createOrderedChannel}
        onCreated={openCreatedGroup}
      />
      <MessengerCommandPalette
        open={commandPaletteOpen}
        enabled={paletteShortcutEnabled}
        chats={inboxRows}
        selectedBot={active && !activeGroup ? {
          id: active.id,
          name: active.name,
          settings: true,
          computer: true,
        } : null}
        appFocusRef={chatRegionRef}
        onOpenChange={setCommandPaletteOpen}
        onOpenChat={openCommandPaletteChat}
        onNewBot={openNewBotFromPalette}
        onAppSettings={openAppSettingsFromPalette}
        onBotSettings={openBotSettingsFromPalette}
        onPlugins={() => openPlugins("direct")}
        onComputer={openComputerFor}
      />
      {error ? (
        <Toast
          open
          className="border-destructive"
          onOpenChange={(open) => {
            if (!open) setError(null);
          }}
        >
          <ToastTitle>Action not completed</ToastTitle>
          <ToastDescription>{error}</ToastDescription>
        </Toast>
      ) : null}
      <ToastViewport />
    </ToastProvider>
  );
}

import { filterChatInbox, type ChatInboxRow } from "../lib/chat-inbox.ts";

export type CommandPaletteShortcutEvent = {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  target: unknown;
  defaultPrevented: boolean;
  isComposing: boolean;
};

export function commandPaletteShortcutMatches(
  event: CommandPaletteShortcutEvent,
  platform: string,
): boolean {
  if (event.defaultPrevented || event.isComposing) return false;
  if (event.key.toLocaleLowerCase() !== "k" || event.altKey || event.shiftKey) return false;
  const mac = /mac|iphone|ipad|ipod/i.test(platform);
  return mac
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
}

export type CommandPaletteActionId =
  | "new-bot"
  | "app-settings"
  | "bot-settings"
  | "plugins"
  | "computer";

export type CommandPaletteAction = {
  id: CommandPaletteActionId;
  label: string;
  detail: string;
  botId?: string;
};

export type CommandPaletteAvailability = {
  newBot: boolean;
  appSettings: boolean;
  plugins: boolean;
  selectedBot: {
    id: string;
    name: string;
    settings: boolean;
    computer: boolean;
  } | null;
};

export type CommandPaletteResult =
  | {
      kind: "action";
      id: `action:${CommandPaletteActionId}`;
      label: string;
      detail: string;
      action: CommandPaletteAction;
    }
  | {
      kind: "chat";
      id: `chat:${string}`;
      label: string;
      detail: string;
      chat: ChatInboxRow;
    };

export type CommandPaletteHandlers = {
  openChat: (chat: ChatInboxRow) => void;
  newBot: () => void;
  appSettings: () => void;
  botSettings: (botId: string) => void;
  plugins: () => void;
  computer: (botId: string) => void;
};

export function buildCommandPaletteActions(
  availability: CommandPaletteAvailability,
): CommandPaletteAction[] {
  const actions: CommandPaletteAction[] = [];
  if (availability.newBot) {
    actions.push({ id: "new-bot", label: "New Bot", detail: "Create a named Bot" });
  }
  if (availability.appSettings) {
    actions.push({ id: "app-settings", label: "App Settings", detail: "Open global preferences" });
  }
  if (availability.selectedBot?.settings) {
    actions.push({
      id: "bot-settings",
      label: "Bot Settings",
      detail: `Settings for ${availability.selectedBot.name}`,
      botId: availability.selectedBot.id,
    });
  }
  if (availability.plugins) {
    actions.push({ id: "plugins", label: "Plugins", detail: "Open the Plugins destination" });
  }
  if (availability.selectedBot?.computer) {
    actions.push({
      id: "computer",
      label: "Computer",
      detail: `Open ${availability.selectedBot.name}'s Computer`,
      botId: availability.selectedBot.id,
    });
  }
  return actions;
}

function normalizedQuery(query: string): string {
  return query.replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

function visibleChatDetail(chat: ChatInboxRow): string {
  if (!chat.signal && chat.draftPreview) return `Draft · ${chat.draftPreview}`;
  return chat.preview || "No messages yet";
}

export function commandPaletteResults({
  chats,
  actions,
  query,
}: {
  chats: ChatInboxRow[];
  actions: CommandPaletteAction[];
  query: string;
}): CommandPaletteResult[] {
  const needle = normalizedQuery(query);
  const matchingActions = actions
    .filter((action) => !needle || action.label.toLocaleLowerCase().includes(needle))
    .map((action): CommandPaletteResult => ({
      kind: "action",
      id: `action:${action.id}`,
      label: action.label,
      detail: action.detail,
      action,
    }));
  const matchingChats = filterChatInbox(chats, query).map((chat): CommandPaletteResult => ({
    kind: "chat",
    id: `chat:${chat.key}`,
    label: chat.name,
    detail: visibleChatDetail(chat),
    chat,
  }));
  return [...matchingActions, ...matchingChats];
}

export function commandPaletteAnnouncement(count: number): string {
  if (count === 0) return "No results.";
  return count === 1 ? "1 result." : `${count} results.`;
}

export function moveCommandPaletteSelection(
  current: number,
  delta: -1 | 1,
  resultCount: number,
): number {
  if (resultCount === 0) return -1;
  const normalized = current < 0 || current >= resultCount ? 0 : current;
  return (normalized + delta + resultCount) % resultCount;
}

export function executeCommandPaletteResult(
  result: CommandPaletteResult,
  currentSelectedBotId: string | null,
  handlers: CommandPaletteHandlers,
): boolean {
  if (result.kind === "chat") {
    handlers.openChat(result.chat);
    return true;
  }

  const { action } = result;
  if (action.botId && action.botId !== currentSelectedBotId) return false;
  if (action.id === "new-bot") handlers.newBot();
  if (action.id === "app-settings") handlers.appSettings();
  if (action.id === "bot-settings" && action.botId) handlers.botSettings(action.botId);
  if (action.id === "plugins") handlers.plugins();
  if (action.id === "computer" && action.botId) handlers.computer(action.botId);
  return true;
}

export type FocusableTarget = {
  isConnected: boolean;
  focus: () => void;
};

export function restoreCommandPaletteFocus(
  returnTarget: FocusableTarget | null,
  appTarget: FocusableTarget | null,
  documentBody: FocusableTarget | null = null,
  documentRoot: FocusableTarget | null = null,
): FocusableTarget | null {
  const returnTargetIsUseful = returnTarget?.isConnected
    && returnTarget !== documentBody
    && returnTarget !== documentRoot;
  const target = returnTargetIsUseful
    ? returnTarget
    : appTarget?.isConnected
      ? appTarget
      : null;
  target?.focus();
  return target;
}

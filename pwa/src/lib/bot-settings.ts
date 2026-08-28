import type { Harness } from "./session";
import { appSettingsRequested } from "./app-settings";

export const BOT_SETTINGS_SECTIONS = ["ai", "instructions", "computer-access"] as const;
export type BotSettingsSection = (typeof BOT_SETTINGS_SECTIONS)[number];

export type SelectedBotPanelState = {
  botId: string | null;
  open: boolean;
  section: BotSettingsSection;
  computerExpanded: boolean;
};

export const INITIAL_SELECTED_BOT_PANEL_STATE: SelectedBotPanelState = {
  botId: null,
  open: false,
  section: "ai",
  computerExpanded: false,
};

export type SelectedBotPanelEvent =
  | { kind: "select-bot"; botId: string; rememberedOpen: boolean }
  | { kind: "open"; botId: string; section: BotSettingsSection }
  | { kind: "close" }
  | { kind: "clear-selection" }
  | { kind: "open-computer"; botId: string }
  | { kind: "close-computer" }
  | { kind: "section"; section: BotSettingsSection }
  | { kind: "sync-remembered"; botId: string; open: boolean };

export function reduceSelectedBotPanel(
  state: SelectedBotPanelState,
  event: SelectedBotPanelEvent,
): SelectedBotPanelState {
  if (event.kind === "select-bot") {
    const carryOpen = state.open || event.rememberedOpen;
    return {
      botId: event.botId,
      open: carryOpen,
      section: state.open ? state.section : "ai",
      computerExpanded: false,
    };
  }
  if (event.kind === "open") {
    return {
      botId: event.botId,
      open: true,
      section: event.section,
      computerExpanded: false,
    };
  }
  if (event.kind === "close") {
    return { ...state, open: false, computerExpanded: false };
  }
  if (event.kind === "clear-selection") {
    return { ...INITIAL_SELECTED_BOT_PANEL_STATE };
  }
  if (event.kind === "open-computer") {
    return {
      botId: event.botId,
      open: true,
      section: state.botId === event.botId ? state.section : "ai",
      computerExpanded: true,
    };
  }
  if (event.kind === "close-computer") {
    return { ...state, computerExpanded: false };
  }
  if (event.kind === "section") {
    return { ...state, section: event.section };
  }
  if (state.botId !== event.botId) return state;
  return {
    ...state,
    open: event.open,
    computerExpanded: event.open ? state.computerExpanded : false,
  };
}

export function selectedBotPanelBlocksChat({
  desktopLayout,
  panelOpen,
}: {
  desktopLayout: boolean;
  panelOpen: boolean;
}): boolean {
  return !desktopLayout && panelOpen;
}

export type BotInstructionScope = "all" | "bot";
export type BotInstructionValues = Record<BotInstructionScope, string>;
export type BotInstructionsState = {
  botId: string;
  status: "loading" | "ready" | "error";
  drafts: BotInstructionValues;
  saved: BotInstructionValues;
};

export function beginBotInstructions(botId: string): BotInstructionsState {
  return {
    botId,
    status: "loading",
    drafts: { all: "", bot: "" },
    saved: { all: "", bot: "" },
  };
}

export function acceptBotInstructions(
  state: BotInstructionsState,
  botId: string,
  values: BotInstructionValues,
): BotInstructionsState {
  if (state.botId !== botId) return state;
  return {
    botId,
    status: "ready",
    drafts: { ...values },
    saved: { ...values },
  };
}

export function failBotInstructions(
  state: BotInstructionsState,
  botId: string,
): BotInstructionsState {
  if (state.botId !== botId) return state;
  return { ...state, status: "error" };
}

export function editBotInstruction(
  state: BotInstructionsState,
  botId: string,
  scope: BotInstructionScope,
  value: string,
): BotInstructionsState {
  if (state.botId !== botId || state.status !== "ready") return state;
  return {
    ...state,
    drafts: { ...state.drafts, [scope]: value },
  };
}

export function acceptBotInstructionSave(
  state: BotInstructionsState,
  botId: string,
  scope: BotInstructionScope,
  value: string,
): BotInstructionsState {
  if (state.botId !== botId || state.status !== "ready") return state;
  return {
    ...state,
    drafts: { ...state.drafts, [scope]: value },
    saved: { ...state.saved, [scope]: value },
  };
}

export function selectableConnections(harnesses: Harness[]): Harness[] {
  return harnesses.filter((harness) => harness.id === "codex" && harness.talk);
}

export function selectableAiConnections(harnesses: Harness[]): Harness[] {
  return selectableConnections(harnesses);
}

export function botSettingsHash(botId: string, section: BotSettingsSection): string {
  return `#bots/${encodeURIComponent(botId)}/settings/${section}`;
}

export function parseBotSettingsHash(hash: string): { botId: string; section: BotSettingsSection } | null {
  const match = hash.match(/^#bots\/([^/]+)\/settings\/(ai|instructions|computer-access)$/);
  if (!match) return null;
  try {
    return {
      botId: decodeURIComponent(match[1]),
      section: match[2] as BotSettingsSection,
    };
  } catch {
    return null;
  }
}

export type SelectedBotPanelLocationResolution =
  | { kind: "open"; botId: string; section: BotSettingsSection }
  | { kind: "close"; restoreFocus: boolean; clearInvalidHash: boolean };

export function resolveSelectedBotPanelLocation(hash: string): SelectedBotPanelLocationResolution {
  const requested = parseBotSettingsHash(hash);
  if (requested) return { kind: "open", ...requested };
  return {
    kind: "close",
    restoreFocus: !appSettingsRequested(hash),
    clearInvalidHash: hash.startsWith("#bots/"),
  };
}

export function syncSelectedBotPanelLocationAfterBotChange({
  currentHash,
  selectedBotId,
  panel,
  replaceHash,
}: {
  currentHash: string;
  selectedBotId: string;
  panel: SelectedBotPanelState;
  replaceHash: (hash: string) => void;
}) {
  const nextHash = panel.open && panel.botId === selectedBotId
    ? botSettingsHash(selectedBotId, panel.section)
    : parseBotSettingsHash(currentHash)
      ? ""
      : null;
  if (nextHash === null || nextHash === currentHash) return;
  replaceHash(nextHash);
}

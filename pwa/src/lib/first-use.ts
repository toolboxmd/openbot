export const EMPTY_CHAT_SUGGESTIONS = [
  "Help me plan my next task",
  "Turn my rough notes into a clear draft",
  "Help me think through a decision",
] as const;

export type GlobalRoute = "chat" | "plugins";
export type BotListViewState = "loading" | "error" | "empty" | "ready";
export type ChatDetailViewState = "loading" | "error" | "empty" | "populated";
export type PluginsDirectReturnDestination = "loading" | "error" | "welcome" | "chat";
export type PluginsReturnTarget = "welcome" | "sidebar" | "direct";

const PLUGINS_HISTORY_MARKER = "openbot.plugins";

export function botNameValidation(value: string): {
  valid: boolean;
  name: string;
  error: string | null;
} {
  const name = value.trim();
  return name
    ? { valid: true, name, error: null }
    : { valid: false, name: "", error: "Enter a name for your Bot." };
}

export function globalRouteFromHash(hash: string): GlobalRoute {
  return hash === "#plugins" ? "plugins" : "chat";
}

export function botListViewState({
  ready,
  failed,
  count,
}: {
  ready: boolean;
  failed: boolean;
  count: number;
}): BotListViewState {
  if (!ready) return "loading";
  if (failed) return "error";
  return count === 0 ? "empty" : "ready";
}

export function pluginsDirectReturnDestination({
  ready,
  failed,
  count,
}: {
  ready: boolean;
  failed: boolean;
  count: number;
}): PluginsDirectReturnDestination {
  const view = botListViewState({ ready, failed, count });
  if (view === "empty") return "welcome";
  if (view === "ready") return "chat";
  return view;
}

export function connectedFocusTarget<T extends { isConnected: boolean }>(
  primary: T | null,
  fallback: T | null,
): T | null {
  if (primary?.isConnected) return primary;
  return fallback?.isConnected ? fallback : null;
}

export function resolvedPluginsReturnTarget(
  target: PluginsReturnTarget | null,
): PluginsReturnTarget {
  return target ?? "direct";
}

export function computerToCloseForDirectPluginsReturn({
  activeId,
  computerOpen,
  destination,
}: {
  activeId: string | null;
  computerOpen: boolean;
  destination: PluginsDirectReturnDestination;
}): string | null {
  return destination === "chat" && computerOpen ? activeId : null;
}

export function computerVisibleDuringPluginsReturn({
  computerOpen,
  returnTarget,
}: {
  computerOpen: boolean;
  returnTarget: PluginsReturnTarget | null;
}): boolean {
  return computerOpen && returnTarget !== "direct";
}

export function chatDetailViewState({
  messageCount,
  failed,
}: {
  messageCount: number | undefined;
  failed: boolean;
}): ChatDetailViewState {
  if (messageCount === undefined) return failed ? "error" : "loading";
  return messageCount === 0 ? "empty" : "populated";
}

export function pluginsHistoryState(state: unknown): Record<string, unknown> {
  const existing = typeof state === "object" && state !== null && !Array.isArray(state)
    ? (state as Record<string, unknown>)
    : {};
  return { ...existing, openbotRoute: PLUGINS_HISTORY_MARKER };
}

export function isInternalPluginsEntry(state: unknown): boolean {
  return (
    typeof state === "object" &&
    state !== null &&
    !Array.isArray(state) &&
    (state as Record<string, unknown>).openbotRoute === PLUGINS_HISTORY_MARKER
  );
}

export function canSendDirectMessage({
  active,
  harness,
  draft,
  busy,
}: {
  active: boolean;
  harness: string | null;
  draft: string;
  busy: boolean;
}): boolean {
  return active && Boolean(harness) && draft.trim().length > 0 && !busy;
}

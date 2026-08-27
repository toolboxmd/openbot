import { groupDisplayTitle, type Channel } from "./channels";
import type { FaceMode } from "./face";

export const CHAT_DRAFTS_KEY = "openbot.chat-drafts.v1";

export type ChatDrafts = Record<string, string>;
export type ChatInboxSignal = "waiting" | "unread" | "working";

export function acceptOrderedSnapshots<T extends { id: string }>(
  applied: Map<string, number>,
  snapshots: T[],
  sequence: number,
): T[] {
  const accepted: T[] = [];
  for (const snapshot of snapshots) {
    const lastApplied = applied.get(snapshot.id) ?? 0;
    if (sequence < lastApplied) continue;
    applied.set(snapshot.id, sequence);
    accepted.push(snapshot);
  }
  return accepted;
}

export async function reserveSnapshotRequest<T>(
  reserve: () => number,
  request: () => Promise<T>,
): Promise<{ sequence: number; snapshot: T }> {
  const sequence = reserve();
  const snapshot = await request();
  return { sequence, snapshot };
}

export function resolveSnapshotMembership<T extends { id: string }>(
  listed: T[],
  accepted: T[],
  latest: Map<string, T>,
): T[] {
  const acceptedById = new Map(accepted.map((snapshot) => [snapshot.id, snapshot]));
  return listed.map((snapshot) => (
    acceptedById.get(snapshot.id) ?? latest.get(snapshot.id) ?? snapshot
  ));
}

export function listSnapshotIsCurrent(appliedSequence: number, sequence: number): boolean {
  return sequence >= appliedSequence;
}

type InboxActivity = {
  latestText: string | null;
  lastActivityAt: string;
  unread: boolean;
  cursor: { sequence: number; revision: number };
};

export function observedActivityAfterRead<T extends InboxActivity>(
  observed: T,
  serverActivity: InboxActivity,
): T {
  const order = compareActivityCursor(serverActivity, observed);
  if (order < 0) return observed;
  if (order > 0) return { ...observed, unread: true };
  return { ...observed, unread: serverActivity.unread };
}

function compareActivityCursor(left: InboxActivity, right: InboxActivity): number {
  return left.cursor.sequence - right.cursor.sequence
    || left.cursor.revision - right.cursor.revision;
}

function monotonicInboxActivity<T extends InboxActivity>(current: T, incoming: T): T {
  const order = compareActivityCursor(incoming, current);
  if (order < 0) return current;
  if (order > 0) return incoming;
  return { ...current, ...incoming, unread: current.unread && incoming.unread };
}

export function mergeInboxSnapshots<T extends { id: string; activity: InboxActivity }>(
  current: T[],
  incoming: T[],
): T[] {
  const currentById = new Map(current.map((row) => [row.id, row]));
  const incomingIds = new Set(incoming.map((row) => row.id));
  const merged = incoming.map((row) => {
    const existing = currentById.get(row.id);
    if (!existing) return row;
    if (compareActivityCursor(row.activity, existing.activity) < 0) return existing;
    return { ...existing, ...row, activity: monotonicInboxActivity(existing.activity, row.activity) };
  });
  return [...merged, ...current.filter((row) => !incomingIds.has(row.id))];
}

type InboxBot = {
  id: string;
  name: string;
  eyes: { color: string; shape: string; mode: string };
  write: boolean;
  permission: unknown | null;
  needsYou: unknown | null;
  activity: InboxActivity;
};

type InboxChannel = Pick<Channel, "id" | "kind" | "title" | "createdAt" | "members" | "activity">;

export type ChatInboxRow = {
  key: string;
  kind: "bot" | "group";
  id: string;
  name: string;
  preview: string;
  draftPreview: string | null;
  signal: ChatInboxSignal | null;
  activityAt: string;
};

export function chatSurfaceIsVisible(input: {
  route: string;
  desktop: boolean;
  mobileSurface: "sidebar" | "chat";
  computerVisible: boolean;
  documentVisible: boolean;
  blockingDialog: boolean;
}): boolean {
  return input.route === "chat"
    && input.documentVisible
    && !input.blockingDialog
    && (input.desktop || (input.mobileSurface === "chat" && !input.computerVisible));
}

export function canAcknowledgeChatRead(input: {
  hasTranscript: boolean;
  unread: boolean;
  surfaceVisible: boolean;
  active: boolean;
  blockingDialog: boolean;
  openingBlockingDialog: boolean;
}): boolean {
  return input.hasTranscript
    && input.unread
    && input.surfaceVisible
    && input.active
    && !input.blockingDialog
    && !input.openingBlockingDialog;
}

export function inboxEyesMode(signal: ChatInboxSignal | null, underlying: FaceMode): FaceMode {
  if (signal === "waiting") return "needs-you";
  if (signal === "unread") return "idle";
  if (signal === "working") return underlying === "write" ? "write" : "work";
  return underlying;
}

export function shouldRestoreFailedDraft(currentRevision: number, clearedRevision: number): boolean {
  return currentRevision === clearedRevision;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseChatDrafts(raw: string | null): ChatDrafts {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => (
        typeof entry[1] === "string" && entry[1].length > 0
      )),
    );
  } catch {
    return {};
  }
}

export function readChatDrafts(storage: Pick<Storage, "getItem"> | null): ChatDrafts {
  if (!storage) return {};
  try {
    return parseChatDrafts(storage.getItem(CHAT_DRAFTS_KEY));
  } catch {
    return {};
  }
}

export function writeChatDrafts(
  storage: Pick<Storage, "setItem"> | null,
  drafts: ChatDrafts,
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(CHAT_DRAFTS_KEY, JSON.stringify(drafts));
    return true;
  } catch {
    return false;
  }
}

export function setChatDraft(drafts: ChatDrafts, key: string, text: string): ChatDrafts {
  if (!text) {
    const { [key]: _removed, ...rest } = drafts;
    return rest;
  }
  return { ...drafts, [key]: text };
}

export function botDraftKey(botId: string): string {
  return `bot:${botId}`;
}

export function channelDraftKey(channelId: string): string {
  return `channel:${channelId}`;
}

function oneLine(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

function botSignal(bot: InboxBot): ChatInboxSignal | null {
  if (bot.permission || bot.needsYou) return "waiting";
  if (bot.activity.unread) return "unread";
  if (bot.write || bot.eyes.mode === "write" || bot.eyes.mode === "work") return "working";
  return null;
}

function activityMillis(iso: string): number {
  const value = Date.parse(iso);
  return Number.isFinite(value) ? value : 0;
}

export function buildChatInbox(input: {
  bots: InboxBot[];
  channels: InboxChannel[];
  drafts: ChatDrafts;
}): ChatInboxRow[] {
  const botRows: ChatInboxRow[] = input.bots.map((bot) => ({
    key: botDraftKey(bot.id),
    kind: "bot",
    id: bot.id,
    name: bot.name,
    preview: oneLine(bot.activity.latestText),
    draftPreview: oneLine(input.drafts[botDraftKey(bot.id)]) || null,
    signal: botSignal(bot),
    activityAt: bot.activity.lastActivityAt,
  }));
  const groupRows: ChatInboxRow[] = input.channels
    .filter((channel) => channel.kind === "group")
    .map((channel) => ({
      key: channelDraftKey(channel.id),
      kind: "group" as const,
      id: channel.id,
      name: groupDisplayTitle(channel),
      preview: oneLine(channel.activity.latestText),
      draftPreview: oneLine(input.drafts[channelDraftKey(channel.id)]) || null,
      signal: channel.activity.unread ? "unread" as const : null,
      activityAt: channel.activity.lastActivityAt || channel.createdAt,
    }));

  return [...botRows, ...groupRows].sort((left, right) => (
    activityMillis(right.activityAt) - activityMillis(left.activityAt) || left.name.localeCompare(right.name)
  ));
}

export function filterChatInbox(rows: ChatInboxRow[], query: string): ChatInboxRow[] {
  const needle = oneLine(query).toLocaleLowerCase();
  if (!needle) return rows;
  return rows.filter((row) => {
    const visiblePreview = row.signal ? row.preview : row.draftPreview ?? row.preview;
    return row.name.toLocaleLowerCase().includes(needle) || visiblePreview.toLocaleLowerCase().includes(needle);
  });
}

export function inboxAnnouncement(previous: ChatInboxRow[] | null, next: ChatInboxRow[]): string | null {
  if (!previous) return null;
  const before = new Map(previous.map((row) => [row.key, row]));
  const announcements: string[] = [];
  for (const row of next) {
    const prior = before.get(row.key);
    if (!prior) continue;
    if (row.signal !== prior.signal && row.signal) {
      const label = row.signal === "waiting"
        ? "Waiting for you"
        : row.signal === "unread"
          ? "Unread"
          : "Working";
      announcements.push(`${row.name}: ${label}`);
      continue;
    }
    if (row.activityAt !== prior.activityAt && row.preview !== prior.preview) {
      announcements.push(`${row.name}: New message`);
    }
  }
  return announcements.length > 0 ? announcements.join(". ") : null;
}

export function formatRelativeActivityTime(
  iso: string,
  now = new Date(),
  locales?: Intl.LocalesArgument,
): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "";
  const deltaSeconds = (then.getTime() - now.getTime()) / 1000;
  const absolute = Math.abs(deltaSeconds);
  const formatter = new Intl.RelativeTimeFormat(locales, { numeric: "auto" });

  if (absolute < 60) return formatter.format(0, "second");
  if (absolute < 3_600) return formatter.format(Math.round(deltaSeconds / 60), "minute");
  if (absolute < 86_400) return formatter.format(Math.round(deltaSeconds / 3_600), "hour");
  if (absolute < 604_800) return formatter.format(Math.round(deltaSeconds / 86_400), "day");
  if (absolute < 2_629_746) return formatter.format(Math.round(deltaSeconds / 604_800), "week");
  if (absolute < 31_556_952) return formatter.format(Math.round(deltaSeconds / 2_629_746), "month");
  return formatter.format(Math.round(deltaSeconds / 31_556_952), "year");
}

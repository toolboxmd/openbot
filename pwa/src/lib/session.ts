import type { Channel } from "./channels";

export type SessionCheck =
  | { ok: true; unlocked: boolean }
  | { ok: false; error: string };

function throwIfAborted(error: unknown, signal?: AbortSignal): void {
  if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) {
    throw error;
  }
}

export async function readSession(signal?: AbortSignal): Promise<SessionCheck> {
  try {
    const res = await fetch("/api/session", { credentials: "same-origin", signal });
    if (res.ok) return { ok: true, unlocked: true };
    if (res.status === 401) return { ok: true, unlocked: false };
    return { ok: false, error: "Could not open OpenBot. Try again." };
  } catch (error) {
    throwIfAborted(error, signal);
    return { ok: false, error: "Could not open OpenBot. Try again." };
  }
}

export async function unlock(
  password: string,
  signal?: AbortSignal,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch("/api/session", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
      signal,
    });
    if (!res.ok) {
      return res.status === 401
        ? { ok: false, error: "Wrong Password." }
        : { ok: false, error: "Could not unlock OpenBot. Try again." };
    }
    return { ok: true };
  } catch (error) {
    throwIfAborted(error, signal);
    return { ok: false, error: "Could not unlock OpenBot. Try again." };
  }
}

export async function lockSession(signal?: AbortSignal): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch("/api/session", {
      method: "DELETE",
      credentials: "same-origin",
      signal,
    });
    if (!res.ok) {
      return { ok: false, error: "OpenBot could not lock. Try again." };
    }
    return { ok: true };
  } catch (error) {
    throwIfAborted(error, signal);
    return { ok: false, error: "OpenBot could not lock. Try again." };
  }
}

export type EyesMode = "idle" | "think" | "work" | "write" | "needs-you" | "sleep";

export type TranscriptCardAction = {
  id: string;
  label: string;
  intent: "primary" | "secondary";
  command:
    | { kind: "permission"; optionId: string }
    | { kind: "host-grant"; access: "read" | "read-write" | "deny" }
    | { kind: "retry-message"; messageId: string }
    | { kind: "open-computer"; eventId: string }
    | { kind: "resolve-needs-you"; eventId: string; resolution: "done" | "skip" };
};

export type TranscriptCard = {
  kind: "permission" | "host-grant" | "bot-failure" | "computer";
  title: string;
  body: string;
  preview?: string;
  needsYou?: { id: string; reason: "computer-help" };
  status: {
    tone: "neutral" | "waiting" | "success" | "danger";
    label: string;
  };
  actions: TranscriptCardAction[];
};

export type Bot = {
  id: string;
  name: string;
  harness: string | null;
  configMode?: "isolated" | "host";
  eyes: { color: string; shape: string; mode: EyesMode };
  write: boolean;
  zoom?: boolean;
  display?: number | null;
  permission: {
    cardId?: string;
    title: string;
    description?: string;
    options: Array<{ optionId: string; name: string; kind?: string }>;
    hostGrant?: { path: string; requested?: "read" | "read-write" };
  } | null;
  needsYou:
    | { reason: "login"; hint: string }
    | { reason: "computer-help"; hint: string; eventId: string; cardId: string }
    | null;
  activity: {
    latestText: string | null;
    lastActivityAt: string;
    unread: boolean;
    cursor: { sequence: number; revision: number };
  };
  messages?: Array<{
    id: string;
    role: "user" | "assistant";
    senderId: string;
    text: string;
    createdAt?: string;
    receipt?: "sent" | "delivered" | "read";
    replyTo?: string;
    reactions?: Array<{ emoji: string; by: "user" }>;
    kind?: "text" | "host-grant" | "card";
    card?: TranscriptCard;
  }>;
};

export type BotList = { bots: Bot[] };
export type InboxSnapshot = BotList & { channels: Channel[] };

export type { Channel, ChannelKind, ChannelMember } from "./channels";

export async function listChannels(signal?: AbortSignal): Promise<{ channels: Channel[] }> {
  const res = await fetch("/api/channels", { credentials: "same-origin", signal });
  if (!res.ok) {
    throw new Error("session expired");
  }
  return (await res.json()) as { channels: Channel[] };
}

export async function createGroupChannel(
  input: { title?: string; botIds: string[] },
  signal?: AbortSignal,
): Promise<Channel> {
  const res = await fetch("/api/channels", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "group", title: input.title, botIds: input.botIds }),
    signal,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "Could not create group Channel.");
  }
  return (await res.json()) as Channel;
}

export async function getChannel(id: string, signal?: AbortSignal): Promise<Channel> {
  const res = await fetch(`/api/channels/${encodeURIComponent(id)}`, { credentials: "same-origin", signal });
  if (!res.ok) {
    throw new Error("Channel not found");
  }
  return (await res.json()) as Channel;
}

export async function listBots(signal?: AbortSignal): Promise<BotList> {
  const res = await fetch("/api/bots", { credentials: "same-origin", signal });
  if (!res.ok) {
    throw new Error("session expired");
  }
  return (await res.json()) as BotList;
}

export async function listInbox(signal?: AbortSignal): Promise<InboxSnapshot> {
  const res = await fetch("/api/inbox", { credentials: "same-origin", signal });
  if (!res.ok) throw new Error("session expired");
  return (await res.json()) as InboxSnapshot;
}

export async function createBot(name: string, signal?: AbortSignal): Promise<Bot> {
  const res = await fetch("/api/bots", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
    signal,
  });
  if (!res.ok) {
    throw new Error("Could not create Bot.");
  }
  return (await res.json()) as Bot;
}

export async function getBot(id: string, signal?: AbortSignal): Promise<Bot> {
  const res = await fetch(`/api/bots/${encodeURIComponent(id)}`, { credentials: "same-origin", signal });
  if (!res.ok) {
    throw new Error("Bot not found");
  }
  return (await res.json()) as Bot;
}

export async function markBotRead(
  id: string,
  cursor: Bot["activity"]["cursor"],
  signal?: AbortSignal,
): Promise<Bot["activity"]> {
  const res = await fetch(`/api/bots/${encodeURIComponent(id)}/read`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cursor }),
    signal,
  });
  if (!res.ok) throw new Error("Could not mark Chat read.");
  const body = (await res.json()) as { activity: Bot["activity"] };
  return body.activity;
}

export async function markChannelRead(
  id: string,
  cursor: Channel["activity"]["cursor"],
  signal?: AbortSignal,
): Promise<Channel["activity"]> {
  const res = await fetch(`/api/channels/${encodeURIComponent(id)}/read`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cursor }),
    signal,
  });
  if (!res.ok) throw new Error("Could not mark Chat read.");
  const body = (await res.json()) as { activity: Channel["activity"] };
  return body.activity;
}

export type Harness = { id: string; name: string; bin: string; talk: boolean };

export async function listHarnesses(signal?: AbortSignal): Promise<{ harnesses: Harness[] }> {
  const res = await fetch("/api/harnesses", { credentials: "same-origin", signal });
  if (!res.ok) {
    throw new Error("session expired");
  }
  return (await res.json()) as { harnesses: Harness[] };
}

export async function pickHarness(botId: string, harness: string, signal?: AbortSignal): Promise<Bot> {
  const res = await fetch(`/api/bots/${encodeURIComponent(botId)}`, {
    method: "PATCH",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ harness }),
    signal,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "Could not pick Harness.");
  }
  return (await res.json()) as Bot;
}

export async function sendMessage(
  botId: string,
  text: string,
  replyTo?: string,
  signal?: AbortSignal,
): Promise<Bot> {
  const res = await fetch(`/api/bots/${encodeURIComponent(botId)}/messages`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(replyTo ? { text, replyTo } : { text }),
    signal,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "Could not send.");
  }
  return (await res.json()) as Bot;
}

export async function toggleReaction(
  botId: string,
  messageId: string,
  emoji: string,
  signal?: AbortSignal,
): Promise<Bot> {
  const res = await fetch(
    `/api/bots/${encodeURIComponent(botId)}/messages/${encodeURIComponent(messageId)}/reactions`,
    {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ emoji }),
      signal,
    },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "Could not react.");
  }
  return (await res.json()) as Bot;
}

export async function answerPermission(
  botId: string,
  cardId: string,
  optionId: string,
  signal?: AbortSignal,
): Promise<Bot> {
  const res = await fetch(`/api/bots/${encodeURIComponent(botId)}/permissions`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cardId, optionId }),
    signal,
  });
  if (!res.ok) {
    throw new Error("Could not answer permission.");
  }
  return (await res.json()) as Bot;
}

export async function retryTranscriptCard(
  botId: string,
  cardId: string,
  signal?: AbortSignal,
): Promise<Bot> {
  const res = await fetch(
    `/api/bots/${encodeURIComponent(botId)}/cards/${encodeURIComponent(cardId)}/retry`,
    { method: "POST", credentials: "same-origin", signal },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "Could not retry this message.");
  }
  return (await res.json()) as Bot;
}

export async function resolveNeedsYouCard(
  botId: string,
  cardId: string,
  eventId: string,
  resolution: "done" | "skip",
  signal?: AbortSignal,
): Promise<Bot> {
  const res = await fetch(
    `/api/bots/${encodeURIComponent(botId)}/cards/${encodeURIComponent(cardId)}/needs-you`,
    {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ eventId, resolution }),
      signal,
    },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "Could not resolve this action.");
  }
  return (await res.json()) as Bot;
}

export async function answerHostGrant(
  botId: string,
  cardId: string,
  access: string,
  duration: string,
  signal?: AbortSignal,
): Promise<Bot> {
  const res = await fetch(`/api/bots/${encodeURIComponent(botId)}/permissions`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cardId, access, duration }),
    signal,
  });
  if (!res.ok) {
    throw new Error("Could not answer Host grant.");
  }
  return (await res.json()) as Bot;
}

export async function setConfigMode(
  botId: string,
  configMode: "isolated" | "host",
  signal?: AbortSignal,
): Promise<Bot> {
  const res = await fetch(`/api/bots/${encodeURIComponent(botId)}`, {
    method: "PATCH",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ configMode }),
    signal,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "Could not set Isolated or Host.");
  }
  return (await res.json()) as Bot;
}

export async function getAllBotsAgents(signal?: AbortSignal): Promise<string> {
  const res = await fetch("/api/agents", { credentials: "same-origin", signal });
  if (!res.ok) throw new Error("Could not load All Bots.");
  const body = (await res.json()) as { text?: string };
  return body.text ?? "";
}

export async function putAllBotsAgents(text: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch("/api/agents", {
    method: "PUT",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
    signal,
  });
  if (!res.ok) throw new Error("Could not save All Bots.");
  const body = (await res.json()) as { text?: string };
  return body.text ?? text;
}

export async function getThisBotAgents(botId: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(`/api/bots/${encodeURIComponent(botId)}/agents`, { credentials: "same-origin", signal });
  if (!res.ok) throw new Error("Could not load This Bot.");
  const body = (await res.json()) as { text?: string };
  return body.text ?? "";
}

export async function putThisBotAgents(
  botId: string,
  text: string,
  signal?: AbortSignal,
): Promise<string> {
  const res = await fetch(`/api/bots/${encodeURIComponent(botId)}/agents`, {
    method: "PUT",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
    signal,
  });
  if (!res.ok) throw new Error("Could not save This Bot.");
  const body = (await res.json()) as { text?: string };
  return body.text ?? text;
}

export type Computer = {
  path: string;
  ready: boolean;
  botId?: string | null;
  write?: boolean;
  viewOnly?: boolean;
  zoom?: boolean;
  display?: number | null;
  container?: string;
};

export async function getComputer(
  botId?: string | null,
  signal?: AbortSignal,
): Promise<Computer> {
  const qs = botId ? `?botId=${encodeURIComponent(botId)}` : "";
  const res = await fetch(`/api/computer${qs}`, { credentials: "same-origin", signal });
  if (!res.ok) {
    throw new Error("session expired");
  }
  return (await res.json()) as Computer;
}

export async function setComputerZoom(
  botId: string | null,
  zoom: boolean,
  signal?: AbortSignal,
): Promise<Computer> {
  const res = await fetch("/api/computer/zoom", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ botId, zoom }),
    signal,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "Could not zoom Computer.");
  }
  return (await res.json()) as Computer;
}

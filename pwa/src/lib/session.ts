import type { Channel } from "./channels";

export async function readSession(): Promise<boolean> {
  const res = await fetch("/api/session", { credentials: "same-origin" });
  return res.ok;
}

export async function unlock(password: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await fetch("/api/session", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (!res.ok) {
    return { ok: false, error: "Wrong Password." };
  }
  return { ok: true };
}

export type EyesMode = "idle" | "think" | "work" | "write" | "needs-you" | "sleep";

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
    title: string;
    description?: string;
    options: Array<{ optionId: string; name: string; kind?: string }>;
    hostGrant?: { path: string; requested?: "read" | "read-write" };
  } | null;
  needsYou: { reason: "login"; hint: string } | null;
  messages?: Array<{
    id: string;
    role: "user" | "assistant";
    text: string;
    createdAt?: string;
    receipt?: "sent" | "delivered" | "read";
    replyTo?: string;
    reactions?: Array<{ emoji: string; by: "user" }>;
    kind?: "text" | "host-grant";
  }>;
};

export type BotList = { bots: Bot[] };

export type { Channel, ChannelKind, ChannelMember } from "./channels";

export async function listChannels(): Promise<{ channels: Channel[] }> {
  const res = await fetch("/api/channels", { credentials: "same-origin" });
  if (!res.ok) {
    throw new Error("session expired");
  }
  return (await res.json()) as { channels: Channel[] };
}

export async function createGroupChannel(input: { title?: string; botIds: string[] }): Promise<Channel> {
  const res = await fetch("/api/channels", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "group", title: input.title, botIds: input.botIds }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "Could not create group Channel.");
  }
  return (await res.json()) as Channel;
}

export async function getChannel(id: string): Promise<Channel> {
  const res = await fetch(`/api/channels/${encodeURIComponent(id)}`, { credentials: "same-origin" });
  if (!res.ok) {
    throw new Error("Channel not found");
  }
  return (await res.json()) as Channel;
}

export async function listBots(): Promise<BotList> {
  const res = await fetch("/api/bots", { credentials: "same-origin" });
  if (!res.ok) {
    throw new Error("session expired");
  }
  return (await res.json()) as BotList;
}

export async function createBot(name: string): Promise<Bot> {
  const res = await fetch("/api/bots", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    throw new Error("Could not create Bot.");
  }
  return (await res.json()) as Bot;
}

export async function getBot(id: string): Promise<Bot> {
  const res = await fetch(`/api/bots/${encodeURIComponent(id)}`, { credentials: "same-origin" });
  if (!res.ok) {
    throw new Error("Bot not found");
  }
  return (await res.json()) as Bot;
}

export type Harness = { id: string; name: string; bin: string; talk: boolean };

export async function listHarnesses(): Promise<{ harnesses: Harness[] }> {
  const res = await fetch("/api/harnesses", { credentials: "same-origin" });
  if (!res.ok) {
    throw new Error("session expired");
  }
  return (await res.json()) as { harnesses: Harness[] };
}

export async function pickHarness(botId: string, harness: string): Promise<Bot> {
  const res = await fetch(`/api/bots/${encodeURIComponent(botId)}`, {
    method: "PATCH",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ harness }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "Could not pick Harness.");
  }
  return (await res.json()) as Bot;
}

export async function sendMessage(botId: string, text: string, replyTo?: string): Promise<Bot> {
  const res = await fetch(`/api/bots/${encodeURIComponent(botId)}/messages`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(replyTo ? { text, replyTo } : { text }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "Could not send.");
  }
  return (await res.json()) as Bot;
}

export async function toggleReaction(botId: string, messageId: string, emoji: string): Promise<Bot> {
  const res = await fetch(
    `/api/bots/${encodeURIComponent(botId)}/messages/${encodeURIComponent(messageId)}/reactions`,
    {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ emoji }),
    },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "Could not react.");
  }
  return (await res.json()) as Bot;
}

export async function answerPermission(botId: string, optionId: string): Promise<Bot> {
  const res = await fetch(`/api/bots/${encodeURIComponent(botId)}/permissions`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ optionId }),
  });
  if (!res.ok) {
    throw new Error("Could not answer permission.");
  }
  return (await res.json()) as Bot;
}

export async function answerHostGrant(
  botId: string,
  access: string,
  duration: string,
): Promise<Bot> {
  const res = await fetch(`/api/bots/${encodeURIComponent(botId)}/permissions`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ access, duration }),
  });
  if (!res.ok) {
    throw new Error("Could not answer Host grant.");
  }
  return (await res.json()) as Bot;
}

export async function setConfigMode(botId: string, configMode: "isolated" | "host"): Promise<Bot> {
  const res = await fetch(`/api/bots/${encodeURIComponent(botId)}`, {
    method: "PATCH",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ configMode }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "Could not set Isolated or Host.");
  }
  return (await res.json()) as Bot;
}

export async function getAllBotsAgents(): Promise<string> {
  const res = await fetch("/api/agents", { credentials: "same-origin" });
  if (!res.ok) throw new Error("Could not load All Bots.");
  const body = (await res.json()) as { text?: string };
  return body.text ?? "";
}

export async function putAllBotsAgents(text: string): Promise<string> {
  const res = await fetch("/api/agents", {
    method: "PUT",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error("Could not save All Bots.");
  const body = (await res.json()) as { text?: string };
  return body.text ?? text;
}

export async function getThisBotAgents(botId: string): Promise<string> {
  const res = await fetch(`/api/bots/${encodeURIComponent(botId)}/agents`, { credentials: "same-origin" });
  if (!res.ok) throw new Error("Could not load This Bot.");
  const body = (await res.json()) as { text?: string };
  return body.text ?? "";
}

export async function putThisBotAgents(botId: string, text: string): Promise<string> {
  const res = await fetch(`/api/bots/${encodeURIComponent(botId)}/agents`, {
    method: "PUT",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
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

export async function getComputer(botId?: string | null): Promise<Computer> {
  const qs = botId ? `?botId=${encodeURIComponent(botId)}` : "";
  const res = await fetch(`/api/computer${qs}`, { credentials: "same-origin" });
  if (!res.ok) {
    throw new Error("session expired");
  }
  return (await res.json()) as Computer;
}

export async function setComputerZoom(botId: string | null, zoom: boolean): Promise<Computer> {
  const res = await fetch("/api/computer/zoom", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ botId, zoom }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "Could not zoom Computer.");
  }
  return (await res.json()) as Computer;
}

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
  eyes: { color: string; shape: string; mode: EyesMode };
  write: boolean;
  zoom?: boolean;
  display?: number | null;
  permission: {
    title: string;
    description?: string;
    options: Array<{ optionId: string; name: string; kind?: string }>;
  } | null;
  needsYou: { reason: "login"; hint: string } | null;
  messages?: Array<{
    id: string;
    role: "user" | "assistant";
    text: string;
    createdAt?: string;
    receipt?: "sent" | "delivered" | "read";
  }>;
};

export type BotList = { bots: Bot[] };

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

export async function sendMessage(botId: string, text: string): Promise<Bot> {
  const res = await fetch(`/api/bots/${encodeURIComponent(botId)}/messages`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "Could not send.");
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

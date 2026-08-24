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

export type EyesMode = "idle" | "think" | "work" | "write" | "needs-you" | "sleep" | "waking";

export type Bot = {
  id: string;
  name: string;
  harness: string | null;
  screen: "asleep" | "waking" | "active";
  eyes: { color: string; shape: string; mode: EyesMode };
  write: boolean;
  takeover: boolean;
  permission: {
    title: string;
    description?: string;
    options: Array<{ optionId: string; name: string; kind?: string }>;
  } | null;
  needsYou: { reason: "login" | "2fa"; hint: string } | null;
  messages?: Array<{ id: string; role: "user" | "assistant"; text: string }>;
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
  path: string | null;
  ready: boolean;
  botId?: string | null;
  screen?: "asleep" | "waking" | "active";
  cookieJar?: string;
  write?: boolean;
  viewOnly?: boolean;
  takeover?: boolean;
};

export async function viewComputer(botId: string): Promise<Computer> {
  const res = await fetch("/api/computer", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ botId }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "Could not open Computer.");
  }
  return (await res.json()) as Computer;
}

export async function getComputer(botId?: string | null, opts?: { start?: boolean }): Promise<Computer> {
  const params = new URLSearchParams();
  if (botId) params.set("botId", botId);
  if (opts?.start) params.set("start", "1");
  const qs = params.toString() ? `?${params.toString()}` : "";
  const res = await fetch(`/api/computer${qs}`, { credentials: "same-origin" });
  if (!res.ok) {
    throw new Error("session expired");
  }
  return (await res.json()) as Computer;
}

export async function sleepBot(id: string): Promise<Bot> {
  const res = await fetch(`/api/bots/${encodeURIComponent(id)}/sleep`, {
    method: "POST",
    credentials: "same-origin",
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "Could not Sleep.");
  }
  return (await res.json()) as Bot;
}

export async function wakeBot(id: string): Promise<Bot> {
  const res = await fetch(`/api/bots/${encodeURIComponent(id)}/wake`, {
    method: "POST",
    credentials: "same-origin",
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "Could not Wake.");
  }
  return (await res.json()) as Bot;
}

export async function takeoverBot(id: string): Promise<Bot> {
  const res = await fetch(`/api/bots/${encodeURIComponent(id)}/takeover`, {
    method: "POST",
    credentials: "same-origin",
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "Could not Takeover.");
  }
  return (await res.json()) as Bot;
}

export async function releaseTakeover(id: string): Promise<Bot> {
  const res = await fetch(`/api/bots/${encodeURIComponent(id)}/release`, {
    method: "POST",
    credentials: "same-origin",
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "Could not hand back.");
  }
  return (await res.json()) as Bot;
}

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
  computerOwnership?: "view-only" | "write" | "unknown";
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
  ownership?: "view-only" | "write" | "unknown";
  ownershipError?: string | null;
  ownershipEpoch?: string;
  write?: boolean | null;
  viewOnly?: boolean | null;
  zoom?: boolean;
  display?: number | null;
  container?: string;
};

export type ComputerZoomOptions = {
  keepalive?: boolean;
};

export type ComputerOwnershipTransition = (
  botId: string | null,
  zoom: boolean,
  options?: ComputerZoomOptions,
) => Promise<Computer>;

type ComputerOwnershipRequest = (
  botId: string | null,
  zoom: boolean,
  options?: ComputerZoomOptions,
  ownershipEpoch?: string,
) => Promise<Computer>;

type ComputerOwnershipGrantPreparation = (botId: string | null) => Promise<string>;

export type ComputerOwnershipTransitions = {
  transition: ComputerOwnershipTransition;
  releaseForNavigation: (botId: string | null) => Promise<Computer>;
};

export class ComputerOwnershipTransitionError extends Error {
  readonly computer: Computer | null;

  constructor(message: string, computer: Computer | null) {
    super(message);
    this.name = "ComputerOwnershipTransitionError";
    this.computer = computer;
  }
}

export function computerCanWrite(
  computer: Computer | null,
  expanded: boolean,
  botId: string | null = computer?.botId ?? null,
): boolean {
  return Boolean(
    expanded
      && computer?.ownership === "write"
      && computer.write === true
      && (computer.botId ?? null) === botId,
  );
}

export function createComputerOwnershipTransitions(
  request: ComputerOwnershipRequest,
  prepareGrant?: ComputerOwnershipGrantPreparation,
): ComputerOwnershipTransitions {
  let tail: Promise<void> = Promise.resolve();
  let navigationGeneration = 0;

  const transition: ComputerOwnershipTransition = (botId, zoom, options) => {
    const generation = navigationGeneration;
    const run = async () => {
      let ownershipEpoch: string | undefined;
      if (generation !== navigationGeneration) {
        throw new ComputerOwnershipTransitionError(
          "Computer ownership transition was superseded by navigation.",
          null,
        );
      }
      if (zoom && prepareGrant) {
        ownershipEpoch = await prepareGrant(botId);
        if (generation !== navigationGeneration) {
          throw new ComputerOwnershipTransitionError(
            "Computer ownership transition was superseded by navigation.",
            null,
          );
        }
      }
      return request(botId, zoom, options, ownershipEpoch);
    };
    const result = tail.then(
      run,
      run,
    );
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  function releaseForNavigation(botId: string | null): Promise<Computer> {
    navigationGeneration += 1;
    const previous = tail;
    let result: Promise<Computer>;
    try {
      result = request(botId, false, { keepalive: true });
    } catch (error) {
      result = Promise.reject(error);
    }
    tail = Promise.allSettled([previous, result]).then(() => undefined);
    return result;
  }

  return { transition, releaseForNavigation };
}

type ComputerAuthorityObservation = {
  order: number;
  releaseGeneration: number;
  blockedByRelease: boolean;
};

type ComputerReleaseAttempt = {
  order: number;
  releaseGeneration: number;
};

type ComputerGrantPreparation =
  | { kind: "cached"; token: string }
  | { kind: "preflight"; observation: ComputerAuthorityObservation };

function computerOwnershipToken(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 128
    ? value
    : null;
}

/** Owns the PWA's one cached opaque grant token and release authority. */
class ComputerOwnershipAuthority {
  private ownershipToken: string | null = null;
  private requestOrder = 0;
  private acceptedSourceOrder = 0;
  private releaseGeneration = 0;
  private pendingReleases = 0;
  private releaseWindowAmbiguous = false;

  beginGrant(): ComputerGrantPreparation | null {
    if (this.pendingReleases > 0) return null;
    if (this.ownershipToken !== null) {
      return { kind: "cached", token: this.ownershipToken };
    }
    return { kind: "preflight", observation: this.beginObservation() };
  }

  beginObservation(): ComputerAuthorityObservation {
    this.requestOrder += 1;
    return {
      order: this.requestOrder,
      releaseGeneration: this.releaseGeneration,
      blockedByRelease: this.pendingReleases > 0,
    };
  }

  observe(computer: Partial<Computer>, observation: ComputerAuthorityObservation): void {
    if (
      observation.blockedByRelease
      || observation.releaseGeneration !== this.releaseGeneration
      || this.pendingReleases > 0
      || observation.order < this.acceptedSourceOrder
    ) return;
    const token = computerOwnershipToken(computer.ownershipEpoch);
    if (token === null) return;
    this.ownershipToken = token;
    this.acceptedSourceOrder = observation.order;
  }

  finishGrantPreflight(
    computer: Partial<Computer>,
    observation: ComputerAuthorityObservation,
  ): string | null {
    if (
      observation.blockedByRelease
      || observation.releaseGeneration !== this.releaseGeneration
      || this.pendingReleases > 0
    ) return null;
    const token = computerOwnershipToken(computer.ownershipEpoch);
    if (token === null) return null;
    if (observation.order >= this.acceptedSourceOrder) {
      this.ownershipToken = token;
      this.acceptedSourceOrder = observation.order;
    }
    return token;
  }

  beginRelease(): ComputerReleaseAttempt {
    this.requestOrder += 1;
    this.releaseGeneration += 1;
    this.ownershipToken = null;
    if (this.pendingReleases > 0) this.releaseWindowAmbiguous = true;
    this.pendingReleases += 1;
    return {
      order: this.requestOrder,
      releaseGeneration: this.releaseGeneration,
    };
  }

  finishRelease(
    attempt: ComputerReleaseAttempt,
    computer: Partial<Computer> | null,
  ): void {
    const locallyUnambiguous = this.pendingReleases === 1
      && !this.releaseWindowAmbiguous
      && attempt.releaseGeneration === this.releaseGeneration;
    this.pendingReleases -= 1;
    const token = locallyUnambiguous
      ? computerOwnershipToken(computer?.ownershipEpoch)
      : null;
    this.ownershipToken = token;
    if (token !== null) {
      this.acceptedSourceOrder = Math.max(this.acceptedSourceOrder, attempt.order);
    }
    if (this.pendingReleases === 0) this.releaseWindowAmbiguous = false;
  }
}

const computerOwnershipAuthority = new ComputerOwnershipAuthority();

async function fetchComputer(botId?: string | null): Promise<Computer> {
  const qs = botId ? `?botId=${encodeURIComponent(botId)}` : "";
  const res = await fetch(`/api/computer${qs}`, { credentials: "same-origin" });
  if (!res.ok) {
    throw new Error("session expired");
  }
  return (await res.json()) as Computer;
}

export async function getComputer(botId?: string | null): Promise<Computer> {
  const observation = computerOwnershipAuthority.beginObservation();
  const computer = await fetchComputer(botId);
  computerOwnershipAuthority.observe(computer, observation);
  return computer;
}

async function requestComputerZoom(
  botId: string | null,
  zoom: boolean,
  options: ComputerZoomOptions = {},
  ownershipEpoch?: string,
): Promise<Computer> {
  if (zoom && computerOwnershipToken(ownershipEpoch) === null) {
    throw new ComputerOwnershipTransitionError(
      "Computer ownership epoch is unavailable. Refresh Computer before granting write.",
      null,
    );
  }
  const releaseAttempt = zoom ? null : computerOwnershipAuthority.beginRelease();
  const observation = zoom ? computerOwnershipAuthority.beginObservation() : null;
  let releaseResult: Partial<Computer> | null = null;
  try {
    const res = await fetch("/api/computer/zoom", {
      method: "POST",
      credentials: "same-origin",
      keepalive: options.keepalive,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        botId,
        zoom,
        ...(zoom ? { ownershipEpoch } : {}),
      }),
    });
    const body = (await res.json().catch(() => ({}))) as Partial<Computer> & { error?: string };
    if (zoom && observation) computerOwnershipAuthority.observe(body, observation);
    else releaseResult = body;
    if (!res.ok) {
      const computer = typeof body.path === "string" && typeof body.ready === "boolean"
        ? (body as Computer)
        : null;
      throw new ComputerOwnershipTransitionError(
        res.status === 409
          ? "Computer changed. Refresh and retry Computer."
          : (body.error ?? "Could not change Computer write ownership."),
        computer,
      );
    }
    return body as Computer;
  } finally {
    if (releaseAttempt) computerOwnershipAuthority.finishRelease(releaseAttempt, releaseResult);
  }
}

async function prepareComputerOwnershipGrant(botId: string | null): Promise<string> {
  const preparation = computerOwnershipAuthority.beginGrant();
  if (preparation?.kind === "cached") return preparation.token;
  if (preparation === null) {
    throw new ComputerOwnershipTransitionError(
      "Computer ownership epoch is unavailable. Refresh Computer before granting write.",
      null,
    );
  }
  const computer = await fetchComputer(botId);
  const token = computerOwnershipAuthority.finishGrantPreflight(
    computer,
    preparation.observation,
  );
  if (token === null) {
    throw new ComputerOwnershipTransitionError(
      "Computer ownership epoch is unavailable. Refresh Computer before granting write.",
      computer,
    );
  }
  return token;
}

const transitionComputerOwnership = createComputerOwnershipTransitions(
  requestComputerZoom,
  prepareComputerOwnershipGrant,
);

export function setComputerZoom(
  botId: string | null,
  zoom: boolean,
  options?: ComputerZoomOptions,
): Promise<Computer> {
  return transitionComputerOwnership.transition(botId, zoom, options);
}

export function releaseComputerForNavigation(botId: string | null): Promise<Computer> {
  return transitionComputerOwnership.releaseForNavigation(botId);
}

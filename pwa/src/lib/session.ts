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

export type ScreenState = "attaching" | "ready" | "unavailable" | "unassigned" | "cleanup-required";

export type ScreenError = {
  stage: "reserve" | "prepare" | "readiness" | "commit" | "ownership";
  code: string;
  message: string;
};

export type ScreenCleanupError = {
  code: "SCREEN_CLEANUP_FAILED";
  message: string;
};

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
  computerOwnership?: "view-only" | "write" | "unknown";
  display?: number | null;
  screenState: ScreenState;
  screenAttempt: string;
  screenError: ScreenError | null;
  screenCleanupError: ScreenCleanupError | null;
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
  input: { title: string; botIds: string[] },
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

export type AppSettingsDefaults = {
  defaultConnection: string | null;
  defaultConfigMode: "isolated" | "host";
};

export async function listHarnesses(signal?: AbortSignal): Promise<{ harnesses: Harness[] }> {
  const res = await fetch("/api/harnesses", { credentials: "same-origin", signal });
  if (!res.ok) {
    throw new Error("session expired");
  }
  return (await res.json()) as { harnesses: Harness[] };
}

export async function getAppSettings(signal?: AbortSignal): Promise<AppSettingsDefaults> {
  const res = await fetch("/api/app-settings", { credentials: "same-origin", signal });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "Could not load App Settings.");
  }
  return (await res.json()) as AppSettingsDefaults;
}

export async function updateAppSettings(
  patch: Partial<AppSettingsDefaults>,
  signal?: AbortSignal,
): Promise<AppSettingsDefaults> {
  const res = await fetch("/api/app-settings", {
    method: "PATCH",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
    signal,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "Could not save App Settings.");
  }
  return (await res.json()) as AppSettingsDefaults;
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
  path: string | null;
  ready: boolean;
  reachable?: boolean;
  botId?: string | null;
  screenState: ScreenState;
  screenAttempt: string | null;
  screenError: ScreenError | null;
  screenCleanupError: ScreenCleanupError | null;
  ownership?: "view-only" | "write" | "unknown";
  ownershipError?: string | null;
  ownershipEpoch?: string;
  write?: boolean | null;
  viewOnly?: boolean | null;
  zoom?: boolean;
  display?: number | null;
  container?: string;
};

export function screenCanRetry(computer: Computer): boolean {
  return Boolean(
    computer.botId
      && computer.screenAttempt
      && (computer.screenState === "unavailable" || computer.screenState === "unassigned"),
  );
}

export type ComputerZoomOptions = {
  keepalive?: boolean;
  signal?: AbortSignal;
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

type ComputerOwnershipGrantPreparation = (
  botId: string | null,
  options?: ComputerZoomOptions,
) => Promise<string>;

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
      && computer?.screenState === "ready"
      && computer.ready === true
      && typeof computer.path === "string"
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
        ownershipEpoch = await prepareGrant(botId, options);
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

async function fetchComputer(botId?: string | null, signal?: AbortSignal): Promise<Computer> {
  const qs = botId ? `?botId=${encodeURIComponent(botId)}` : "";
  const res = await fetch(`/api/computer${qs}`, { credentials: "same-origin", signal });
  if (!res.ok) {
    throw new Error("session expired");
  }
  const computer = (await res.json()) as Computer;
  if ((computer.botId ?? null) !== (botId ?? null)) {
    throw new Error("Computer response did not match the selected Bot.");
  }
  return computer;
}

export async function getComputer(
  botId?: string | null,
  signal?: AbortSignal,
): Promise<Computer> {
  const observation = computerOwnershipAuthority.beginObservation();
  const computer = await fetchComputer(botId, signal);
  computerOwnershipAuthority.observe(computer, observation);
  return computer;
}

export async function retryComputer(
  botId: string,
  screenAttempt: string,
  signal?: AbortSignal,
): Promise<Computer> {
  const res = await fetch("/api/computer/retry", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ botId, screenAttempt }),
    signal,
  });
  const body = (await res.json().catch(() => ({}))) as Partial<Computer> & { error?: string };
  if (!res.ok) throw new Error(body.error ?? "Could not retry Screen.");
  return body as Computer;
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
      signal: options.signal,
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
      const computer = (typeof body.path === "string" || body.path === null) && typeof body.ready === "boolean"
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

async function prepareComputerOwnershipGrant(
  botId: string | null,
  options?: ComputerZoomOptions,
): Promise<string> {
  const preparation = computerOwnershipAuthority.beginGrant();
  if (preparation?.kind === "cached") return preparation.token;
  if (preparation === null) {
    throw new ComputerOwnershipTransitionError(
      "Computer ownership epoch is unavailable. Refresh Computer before granting write.",
      null,
    );
  }
  const computer = await fetchComputer(botId, options?.signal);
  if (computer.screenState !== "ready" || computer.ready !== true || computer.path === null) {
    throw new ComputerOwnershipTransitionError(
      "Screen is not ready. Chat is still available.",
      computer,
    );
  }
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

import crypto from "node:crypto";
import fs from "node:fs";
import { pickColor, pickShape, type EyesMode, type FaceShape } from "./face.ts";
import {
  isHarnessId,
  listHarnessesOnPath,
  loginHint,
  spawnSpec,
  type HarnessId,
  type HarnessInfo,
  type SpawnSpec,
} from "./harness.ts";
import {
  HUMAN_MEMBER_ID,
  HomeStore,
  defaultWorkspaceDir,
  type ChannelKind,
  type ChannelMember,
  type MessageReceipt,
  type StoredBot,
  type StoredChannel,
  type TranscriptMessage,
} from "./home.ts";
import {
  isAuthError,
  isCancelled,
  spawnAcp,
  type AcpHandlers,
  type AssistantDelta,
  type PermissionPrompt,
} from "./acp.ts";
import { NoopComputerRuntime, type ComputerRuntime, type DisplayHandle } from "./computer.ts";

export { defaultHomeDir, defaultWorkspaceDir } from "./home.ts";
export type { MessageReaction, MessageReceipt } from "./home.ts";

export type PublicMessage = TranscriptMessage;

export type PublicPermission = {
  title: string;
  description?: string;
  options: Array<{ optionId: string; name: string; kind?: string }>;
};

export type PublicBot = {
  id: string;
  name: string;
  harness: HarnessId | null;
  channelId: string;
  eyes: { color: string; shape: FaceShape; mode: EyesMode };
  write: boolean;
  zoom: boolean;
  display: number | null;
  permission: PublicPermission | null;
  needsYou: { reason: "login"; hint: string } | null;
  messages?: PublicMessage[];
};

export type PublicChannel = {
  id: string;
  kind: ChannelKind;
  title: string | null;
  createdAt: string;
  members: ChannelMember[];
  messages?: PublicMessage[];
};

export type AcpSession = {
  close(): void;
  initialize(): Promise<unknown>;
  newSession(cwd: string): Promise<unknown>;
  prompt(text: string): Promise<string>;
  cancel(): void;
  respondPermission(rpcId: PermissionPrompt["rpcId"], optionId: string): void;
};

type Bot = {
  id: string;
  name: string;
  color: string;
  shape: FaceShape;
  harness: HarnessId | null;
  zoom: boolean;
  display: DisplayHandle | null;
  eyesMode: EyesMode;
  needsYou: { reason: "login"; hint: string } | null;
  permission: (PermissionPrompt & PublicPermission) | null;
};

type SessionRuntime = {
  botId: string;
  channelId: string;
  client: AcpSession | null;
  write: boolean;
  openAssistantId: string | null;
  activeUserId: string | null;
  turnSeq: number;
};

export type BotStoreDeps = {
  computer?: ComputerRuntime;
  spawnAcp?: (spec: SpawnSpec, cwd: string, handlers?: AcpHandlers) => AcpSession;
  listHarnesses?: () => HarnessInfo[];
  workspaceDir?: string;
};

function publicPermission(p: PermissionPrompt | null): PublicPermission | null {
  if (!p) return null;
  return { title: p.title, description: p.description, options: p.options };
}

export class BotStore {
  private readonly bots = new Map<string, Bot>();
  private readonly channels = new Map<string, StoredChannel>();
  private readonly directChannelIds = new Map<string, string>();
  private readonly sessions = new Map<string, SessionRuntime>();
  private readonly home: HomeStore;
  private readonly workspaceDir: string;
  private readonly computer: ComputerRuntime;
  private readonly spawnAcpFn: (spec: SpawnSpec, cwd: string, handlers?: AcpHandlers) => AcpSession;
  private readonly listHarnessesFn: () => HarnessInfo[];
  private zoomedId: string | null = null;

  constructor(homeDir: string, deps: BotStoreDeps = {}) {
    this.home = new HomeStore(homeDir);
    this.workspaceDir = deps.workspaceDir ?? defaultWorkspaceDir(homeDir);
    this.computer = deps.computer ?? new NoopComputerRuntime();
    this.spawnAcpFn = deps.spawnAcp ?? spawnAcp;
    this.listHarnessesFn = deps.listHarnesses ?? listHarnessesOnPath;
    fs.mkdirSync(this.workspaceDir, { recursive: true });
    this.load();
  }

  close(): void {
    for (const session of this.sessions.values()) session.client?.close();
    this.sessions.clear();
    this.home.close();
  }

  listHarnesses(): HarnessInfo[] {
    return this.listHarnessesFn();
  }

  hasAcpChild(id: string): boolean {
    this.require(id);
    return [...this.sessions.values()].some((session) => session.botId === id && session.client != null);
  }

  computerRuntime(): ComputerRuntime {
    return this.computer;
  }

  zoomedBotId(): string | null {
    return this.zoomedId;
  }

  isZoomed(id: string): boolean {
    return this.zoomedId === id;
  }

  list(): PublicBot[] {
    return [...this.bots.values()].map((bot) => this.toPublic(bot, false));
  }

  get(id: string): PublicBot | null {
    const bot = this.bots.get(id);
    return bot ? this.toPublic(bot, true) : null;
  }

  listChannels(): PublicChannel[] {
    return [...this.channels.values()].map((channel) => this.toPublicChannel(channel, false));
  }

  getChannel(id: string): PublicChannel | null {
    const channel = this.channels.get(id);
    return channel ? this.toPublicChannel(channel, true) : null;
  }

  messages(id: string): {
    channelId: string;
    messages: PublicMessage[];
    write: boolean;
    permission: PublicPermission | null;
    needsYou: PublicBot["needsYou"];
  } | null {
    const bot = this.bots.get(id);
    if (!bot) return null;
    const channel = this.directChannel(bot.id);
    const session = this.sessionFor(bot.id, channel.id);
    return {
      channelId: channel.id,
      messages: channel.messages,
      write: session.write,
      permission: publicPermission(bot.permission),
      needsYou: bot.needsYou,
    };
  }

  async create(name: string): Promise<PublicBot> {
    const trimmed = name.trim();
    if (!trimmed) throw Object.assign(new Error("name is required"), { status: 400 });
    const taken = [...this.bots.values()].map((bot) => bot.shape);
    const id = crypto.randomUUID();
    const createdAt = nowIso();
    const stored: StoredBot = {
      id,
      name: trimmed,
      color: pickColor(trimmed),
      shape: pickShape(trimmed, taken),
      harness: null,
      createdAt,
    };
    const display = await this.computer.allocate(id);
    const channel = this.home.createBot(stored, crypto.randomUUID());
    const bot = this.runtimeBot(stored, display);
    this.bots.set(id, bot);
    this.channels.set(channel.id, channel);
    this.directChannelIds.set(id, channel.id);
    return this.toPublic(bot, true);
  }

  zoom(id: string): PublicBot {
    const bot = this.require(id);
    if (this.zoomedId && this.zoomedId !== id) this.unzoom(this.zoomedId);
    bot.zoom = true;
    this.zoomedId = id;
    return this.toPublic(bot, true);
  }

  unzoom(id: string): PublicBot {
    const bot = this.require(id);
    bot.zoom = false;
    if (this.zoomedId === id) this.zoomedId = null;
    const session = this.directSession(bot.id);
    if (bot.needsYou || bot.permission) bot.eyesMode = "needs-you";
    else if (session.write) bot.eyesMode = "write";
    else bot.eyesMode = "idle";
    return this.toPublic(bot, true);
  }

  async pickHarness(id: string, harness: string): Promise<PublicBot> {
    const bot = this.require(id);
    if (!isHarnessId(harness)) throw Object.assign(new Error("unknown Harness"), { status: 400 });
    if (!this.listHarnesses().some((item) => item.id === harness)) {
      throw Object.assign(new Error("Harness is not on PATH"), { status: 400 });
    }
    if (harness !== "codex") {
      throw Object.assign(new Error("Talk spawn is Codex-only in this slice"), { status: 400 });
    }
    if (bot.harness === harness) return this.toPublic(bot, true);

    this.home.setHarness(bot.id, harness);
    this.closeSessionsForBot(bot.id);
    bot.harness = harness;
    bot.permission = null;
    bot.needsYou = null;
    bot.eyesMode = "idle";
    return this.toPublic(bot, true);
  }

  async send(id: string, text: string, replyTo?: string): Promise<PublicBot> {
    const bot = this.require(id);
    const trimmed = text.trim();
    if (!trimmed) throw Object.assign(new Error("text is required"), { status: 400 });
    if (!bot.harness) throw Object.assign(new Error("pick a Harness first"), { status: 400 });
    if (bot.harness !== "codex") {
      throw Object.assign(new Error("Talk spawn is Codex-only in this slice"), { status: 400 });
    }

    const channel = this.directChannel(bot.id);
    const session = this.sessionFor(bot.id, channel.id);
    const replyTarget = this.resolveReplyTarget(channel, replyTo);
    if (session.write) {
      try {
        session.client?.cancel();
      } catch {
        // The generation guard still drops stale assistant output.
      }
    }

    const history = session.client ? "" : channelHistory(channel.messages, bot.name);
    const client = await this.ensureClient(bot, channel, session);
    session.turnSeq += 1;
    const turnSeq = session.turnSeq;
    const userMessage: PublicMessage = {
      id: crypto.randomUUID(),
      role: "user",
      text: trimmed,
      createdAt: nowIso(),
      receipt: "sent",
    };
    if (replyTarget) userMessage.replyTo = replyTarget.id;
    this.home.appendMessage(channel.id, {
      ...userMessage,
      senderId: HUMAN_MEMBER_ID,
      recipientBotId: bot.id,
    });
    channel.messages.push(userMessage);
    session.activeUserId = userMessage.id;
    session.openAssistantId = null;
    session.write = true;
    bot.eyesMode = "write";
    bot.permission = null;

    const turnAt = channel.messages.length;
    void (async () => {
      try {
        const reply = await client.prompt(talkPrompt(trimmed, replyTarget?.text, history));
        if (turnSeq !== session.turnSeq) return;
        const assistants = channel.messages.slice(turnAt).filter((message) => message.role === "assistant" && message.text);
        if (assistants.length === 0) this.pushAssistant(bot, channel, session, reply || ".");
      } catch (err) {
        if (turnSeq !== session.turnSeq) return;
        if (isCancelled(err)) return;
        if (isAuthError(err) || isLikelyLogin(err)) {
          bot.eyesMode = "needs-you";
          bot.needsYou = { reason: "login", hint: loginHint("codex") };
          this.fillAssistant(bot, channel, session, loginHint("codex"));
        } else {
          this.fillAssistant(bot, channel, session, err instanceof Error ? err.message : "Harness error");
        }
      } finally {
        if (turnSeq !== session.turnSeq) return;
        session.openAssistantId = null;
        session.activeUserId = null;
        session.write = false;
        if (bot.eyesMode === "write") bot.eyesMode = bot.needsYou ? "needs-you" : "idle";
        bot.permission = null;
      }
    })();

    return this.toPublic(bot, true);
  }

  toggleReaction(id: string, messageId: string, emoji: string): PublicBot {
    const bot = this.require(id);
    const channel = this.directChannel(bot.id);
    const trimmed = emoji.trim();
    if (!trimmed) throw Object.assign(new Error("emoji is required"), { status: 400 });
    const message = channel.messages.find((item) => item.id === messageId);
    if (!message) throw Object.assign(new Error("message not found"), { status: 404 });
    const added = this.home.toggleReaction(message.id, trimmed, nowIso());
    const reactions = [...(message.reactions ?? [])].filter(
      (reaction) => !(reaction.emoji === trimmed && reaction.by === "user"),
    );
    if (added) reactions.push({ emoji: trimmed, by: "user" });
    if (reactions.length) message.reactions = reactions;
    else delete message.reactions;
    return this.toPublic(bot, true);
  }

  answerPermission(id: string, optionId: string): PublicBot {
    const bot = this.require(id);
    const session = this.directSession(bot.id);
    if (!bot.permission || !session.client) {
      throw Object.assign(new Error("no permission prompt"), { status: 409 });
    }
    if (!optionId) throw Object.assign(new Error("optionId is required"), { status: 400 });
    const rpcId = bot.permission.rpcId;
    bot.permission = null;
    bot.eyesMode = session.write ? "write" : "idle";
    session.client.respondPermission(rpcId, optionId);
    return this.toPublic(bot, true);
  }

  private load(): void {
    for (const stored of this.home.listBots()) this.bots.set(stored.id, this.runtimeBot(stored, null));
    for (const channel of this.home.listChannels()) {
      this.channels.set(channel.id, channel);
      if (channel.kind !== "direct") continue;
      const botMember = channel.members.find((member) => member.kind === "bot");
      if (botMember) this.directChannelIds.set(botMember.id, channel.id);
    }
  }

  private runtimeBot(stored: StoredBot, display: DisplayHandle | null): Bot {
    return {
      id: stored.id,
      name: stored.name,
      color: stored.color,
      shape: stored.shape,
      harness: stored.harness,
      zoom: false,
      display,
      eyesMode: "idle",
      needsYou: null,
      permission: null,
    };
  }

  private require(id: string): Bot {
    const bot = this.bots.get(id);
    if (!bot) throw Object.assign(new Error("Bot not found"), { status: 404 });
    return bot;
  }

  private directChannel(botId: string): StoredChannel {
    const channelId = this.directChannelIds.get(botId);
    const channel = channelId ? this.channels.get(channelId) : undefined;
    if (!channel) throw new Error("Bot has no direct Channel");
    return channel;
  }

  private directSession(botId: string): SessionRuntime {
    const channel = this.directChannel(botId);
    return this.sessionFor(botId, channel.id);
  }

  private sessionFor(botId: string, channelId: string): SessionRuntime {
    const key = sessionKey(botId, channelId);
    let session = this.sessions.get(key);
    if (!session) {
      session = {
        botId,
        channelId,
        client: null,
        write: false,
        openAssistantId: null,
        activeUserId: null,
        turnSeq: 0,
      };
      this.sessions.set(key, session);
    }
    return session;
  }

  private closeSessionsForBot(botId: string): void {
    for (const [key, session] of this.sessions) {
      if (session.botId !== botId) continue;
      session.client?.close();
      this.sessions.delete(key);
    }
  }

  private async ensureClient(bot: Bot, channel: StoredChannel, session: SessionRuntime): Promise<AcpSession> {
    if (session.client) return session.client;
    const harness = bot.harness;
    if (!harness) throw Object.assign(new Error("pick a Harness first"), { status: 400 });

    let spec: SpawnSpec;
    try {
      spec = spawnSpec(harness);
    } catch (err) {
      bot.eyesMode = "needs-you";
      bot.needsYou = { reason: "login", hint: loginHint(harness) };
      throw Object.assign(err instanceof Error ? err : new Error(loginHint(harness)), { status: 409 });
    }

    let client: AcpSession | undefined;
    try {
      client = this.spawnAcpFn(spec, this.workspaceDir, {
        onPermission: (prompt) => {
          bot.permission = prompt;
          bot.eyesMode = "needs-you";
        },
        onAssistant: (text, delta) => this.applyAssistant(bot, channel, session, text, delta),
        onPromptWritten: () => this.setUserReceipt(bot, channel, session, "delivered"),
        onPromptFlushed: () => this.setUserReceipt(bot, channel, session, "read"),
      });
      await client.initialize();
      await client.newSession(this.workspaceDir);
      session.client = client;
      bot.eyesMode = "idle";
      bot.needsYou = null;
      return client;
    } catch (err) {
      client?.close();
      session.client = null;
      bot.eyesMode = "needs-you";
      bot.needsYou = { reason: "login", hint: loginHint(harness) };
      const message =
        isAuthError(err) || isLikelyLogin(err)
          ? loginHint(harness)
          : err instanceof Error
            ? err.message
            : loginHint(harness);
      throw Object.assign(new Error(message), { status: 409 });
    }
  }

  private resolveReplyTarget(channel: StoredChannel, replyTo: string | undefined): PublicMessage | null {
    if (replyTo === undefined) return null;
    const targetId = replyTo.trim();
    if (!targetId) throw Object.assign(new Error("replyTo is required"), { status: 400 });
    const target = channel.messages.find((message) => message.id === targetId);
    if (!target) throw Object.assign(new Error("reply target not found"), { status: 400 });
    return target;
  }

  private pushAssistant(bot: Bot, channel: StoredChannel, session: SessionRuntime, text: string): void {
    session.openAssistantId = null;
    const message: PublicMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      text: capTalkBubble(text),
      createdAt: nowIso(),
    };
    this.home.appendMessage(channel.id, { ...message, senderId: bot.id });
    channel.messages.push(message);
  }

  private applyAssistant(
    bot: Bot,
    channel: StoredChannel,
    session: SessionRuntime,
    text: string,
    delta?: AssistantDelta,
  ): void {
    const capped = capTalkBubble(text);
    const startNew = Boolean(delta?.start) || !session.openAssistantId;
    if (startNew) {
      const message: PublicMessage = {
        id: crypto.randomUUID(),
        role: "assistant",
        text: capped,
        createdAt: nowIso(),
      };
      this.home.appendMessage(channel.id, { ...message, senderId: bot.id });
      channel.messages.push(message);
      session.openAssistantId = message.id;
    } else {
      const message = channel.messages.find((item) => item.id === session.openAssistantId);
      if (message) {
        this.home.updateMessageText(message.id, capped);
        message.text = capped;
      }
    }
    if (delta?.done) session.openAssistantId = null;
  }

  private setUserReceipt(
    bot: Bot,
    channel: StoredChannel,
    session: SessionRuntime,
    next: MessageReceipt,
  ): void {
    const message = session.activeUserId
      ? channel.messages.find((item) => item.id === session.activeUserId)
      : undefined;
    if (!message || message.role !== "user") return;
    const receipt = advanceReceipt(message.receipt, next);
    if (receipt === message.receipt) return;
    this.home.setReceipt(message.id, bot.id, receipt, nowIso());
    message.receipt = receipt;
  }

  private fillAssistant(bot: Bot, channel: StoredChannel, session: SessionRuntime, text: string): void {
    if (session.openAssistantId) {
      const message = channel.messages.find((item) => item.id === session.openAssistantId);
      if (message) {
        this.home.updateMessageText(message.id, text);
        message.text = text;
        session.openAssistantId = null;
        return;
      }
    }
    this.pushAssistant(bot, channel, session, text);
  }

  private toPublic(bot: Bot, withMessages: boolean): PublicBot {
    const channel = this.directChannel(bot.id);
    const session = this.sessionFor(bot.id, channel.id);
    const mode: EyesMode = session.write ? "write" : bot.eyesMode;
    const out: PublicBot = {
      id: bot.id,
      name: bot.name,
      harness: bot.harness,
      channelId: channel.id,
      eyes: { color: bot.color, shape: bot.shape, mode },
      write: session.write,
      zoom: bot.zoom,
      display: bot.display?.display ?? null,
      permission: publicPermission(bot.permission),
      needsYou: bot.needsYou,
    };
    if (withMessages) out.messages = channel.messages;
    return out;
  }

  private toPublicChannel(channel: StoredChannel, withMessages: boolean): PublicChannel {
    const out: PublicChannel = {
      id: channel.id,
      kind: channel.kind,
      title: channel.title,
      createdAt: channel.createdAt,
      members: channel.members,
    };
    if (withMessages) out.messages = channel.messages;
    return out;
  }
}

function sessionKey(botId: string, channelId: string): string {
  return `${botId}:${channelId}`;
}

function isLikelyLogin(err: unknown): boolean {
  return isAuthError(err) || /login|auth|not signed/i.test(String((err as Error)?.message ?? err));
}

const TALK_VOICE =
  "You are chatting in OpenBot. Reply like a person in iMessage. Send several short ACP agent messages (one or two sentences each). No markdown essays. No headings. No numbered dumps. No tool JSON or transcripts in chat. Code in a bubble is fine. Attach a screenshot only when it helps.";

const HISTORY_TURN_LIMIT = 20;
const HISTORY_CHARACTER_LIMIT = 64_000;

export function channelHistory(messages: PublicMessage[], botName: string): string {
  const userIndexes = messages.flatMap((message, index) => (message.role === "user" ? [index] : []));
  if (userIndexes.length === 0) return "";
  const firstTurn = userIndexes[Math.max(0, userIndexes.length - HISTORY_TURN_LIMIT)] ?? 0;
  const lines = messages.slice(firstTurn).map((message) => {
    const speaker = message.role === "user" ? "You" : botName;
    return `${speaker}: ${message.text}`;
  });
  let transcript = lines.join("\n");
  if (transcript.length > HISTORY_CHARACTER_LIMIT) {
    const marker = "[Earlier transcript clipped]\n";
    transcript = `${marker}${transcript.slice(-(HISTORY_CHARACTER_LIMIT - marker.length))}`;
  }
  return `Recent Channel transcript:\n${transcript}`;
}

export function talkPrompt(userText: string, replyToText?: string, history = ""): string {
  const parts = [TALK_VOICE];
  if (history) parts.push(history);
  if (replyToText) parts.push(`Replying to: ${replyToText}`);
  parts.push(`New message from You:\n${userText}`);
  return parts.join("\n\n");
}

const TALK_BUBBLE_CAP = 700;
const TALK_CODE_CAP = 2000;

export function capTalkBubble(text: string): string {
  const fenced = text.trimStart().startsWith("```");
  const limit = fenced ? TALK_CODE_CAP : TALK_BUBBLE_CAP;
  if (text.length <= limit) return text;
  const slice = text.slice(0, limit);
  const cut = slice.replace(/\s+\S*$/, "");
  return `${cut.length >= Math.floor(limit * 0.6) ? cut : slice}…`;
}

function nowIso(): string {
  return new Date().toISOString();
}

const RECEIPT_ORDER: MessageReceipt[] = ["sent", "delivered", "read"];

function advanceReceipt(current: MessageReceipt | undefined, next: MessageReceipt): MessageReceipt {
  const have = RECEIPT_ORDER.indexOf(current ?? "sent");
  const want = RECEIPT_ORDER.indexOf(next);
  return want > have ? next : (current ?? "sent");
}

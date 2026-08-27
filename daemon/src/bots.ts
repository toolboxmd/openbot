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
  type ChannelActivity,
  type ChannelCursor,
  type ChannelKind,
  type ChannelMember,
  type MessageReceipt,
  type StoredBot,
  type StoredChannel,
  type StoredChannelSummary,
  type TranscriptMessage,
} from "./home.ts";
import {
  botWorkspaceDir,
  ensureBotWorkspace,
  ensureHarnessHome,
  extractPermissionPaths,
  isConfigMode,
  isHostGrantAccess,
  isHostGrantDuration,
  isInsideWorkspace,
  isInsideScreenWorkspace,
  pickAllowOption,
  pickRejectOption,
  readAgentsFile,
  requestedAccessFromKind,
  thisBotAgentsPath,
  writeAgentsFile,
  allBotsAgentsPath,
  applyVendorHomeEnv,
  type ConfigMode,
  type HostGrantAccess,
  type HostGrantDuration,
} from "./harness-home.ts";
import {
  botFailureTranscriptCard,
  expiredTranscriptCard,
  hostGrantTranscriptCard,
  permissionTranscriptCard,
  resolvedHostGrantCard,
  resolvedPermissionCard,
  transcriptCardSummary,
} from "./transcript-card.ts";
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

export type PublicHostGrant = {
  path: string;
  requested: "read" | "read-write";
};

export type PublicPermission = {
  cardId?: string;
  title: string;
  description?: string;
  options: Array<{ optionId: string; name: string; kind?: string }>;
  hostGrant?: PublicHostGrant;
};

export type PublicBot = {
  id: string;
  name: string;
  harness: HarnessId | null;
  configMode: ConfigMode;
  eyes: { color: string; shape: FaceShape; mode: EyesMode };
  write: boolean;
  zoom: boolean;
  display: number | null;
  permission: PublicPermission | null;
  needsYou: { reason: "login"; hint: string } | null;
  activity: ChannelActivity;
  messages?: PublicMessage[];
};

export type PublicChannelMember = ChannelMember & {
  name: string;
  eyes?: { color: string; shape: FaceShape; mode: EyesMode };
};

export type PublicChannel = {
  id: string;
  kind: ChannelKind;
  title: string | null;
  createdAt: string;
  members: PublicChannelMember[];
  activity: ChannelActivity;
};

export type PublicInbox = {
  bots: PublicBot[];
  channels: PublicChannel[];
};

export type AcpSession = {
  close(): void;
  initialize(): Promise<unknown>;
  newSession(cwd: string): Promise<string>;
  loadSession?(sessionId: string): Promise<unknown>;
  resumeSession?(sessionId: string): Promise<unknown>;
  prompt(text: string, handlers?: AcpHandlers): Promise<string>;
  cancel(): void;
  respondPermission(rpcId: PermissionPrompt["rpcId"], optionId: string): void;
};

type BotPermission = PermissionPrompt & PublicPermission;

type Bot = {
  id: string;
  name: string;
  color: string;
  shape: FaceShape;
  harness: HarnessId | null;
  configMode: ConfigMode;
  write: boolean;
  zoom: boolean;
  display: DisplayHandle | null;
  eyesMode: EyesMode;
  needsYou: { reason: "login"; hint: string } | null;
  permission: BotPermission | null;
  openAssistantId: string | null;
  openAssistantCheckpoint: { id: string; text: string } | null;
  assistantMessageIds: Map<string, string>;
  activeUserId: string | null;
  turnSeq: number;
  client: AcpSession | null;
};

export type BotStoreDeps = {
  computer?: ComputerRuntime;
  spawnAcp?: (spec: SpawnSpec, cwd: string, handlers?: AcpHandlers) => AcpSession;
  listHarnesses?: () => HarnessInfo[];
  workspaceDir?: string;
};

function publicPermission(p: BotPermission | null): PublicPermission | null {
  if (!p) return null;
  const permissionCard = permissionTranscriptCard(p.toolKind, p.options);
  const card = p.hostGrant
    ? hostGrantTranscriptCard(p.hostGrant.path, p.hostGrant.requested, p.options)
    : permissionCard;
  const safeOptions = permissionCard.actions.flatMap((action) => {
    if (action.command.kind !== "permission") return [];
    const optionId = action.command.optionId;
    const source = p.options.find((option) => option.optionId === optionId);
    return [{
      optionId,
      name: action.label,
      ...(source?.kind ? { kind: source.kind } : {}),
    }];
  });
  const out: PublicPermission = {
    title: card.title,
    description: card.body,
    options: safeOptions,
  };
  if (p.cardId) out.cardId = p.cardId;
  if (p.hostGrant) out.hostGrant = p.hostGrant;
  return out;
}

function isExecutePlumbingPath(target: string, toolKind: string | undefined): boolean {
  if ((toolKind ?? "").toLowerCase() !== "execute") return false;
  return target === "/dev/null"
    || target.startsWith("/bin/")
    || target.startsWith("/sbin/")
    || target.startsWith("/usr/bin/")
    || target.startsWith("/usr/sbin/");
}

export class BotStore {
  private readonly bots = new Map<string, Bot>();
  private readonly home: HomeStore;
  private readonly workspaceDir: string;
  private readonly computer: ComputerRuntime;
  private readonly spawnAcpFn: (spec: SpawnSpec, cwd: string, handlers?: AcpHandlers) => AcpSession;
  private readonly listHarnessesFn: () => HarnessInfo[];
  private zoomedId: string | null = null;
  private readonly spawnEnvs = new Map<string, NodeJS.ProcessEnv>();
  private readonly spawnCwds = new Map<string, string>();

  constructor(homeDir: string, deps: BotStoreDeps = {}) {
    this.home = new HomeStore(homeDir);
    this.workspaceDir = deps.workspaceDir ?? defaultWorkspaceDir(homeDir);
    this.computer = deps.computer ?? new NoopComputerRuntime();
    this.spawnAcpFn = deps.spawnAcp ?? spawnAcp;
    this.listHarnessesFn = deps.listHarnesses ?? listHarnessesOnPath;
    fs.mkdirSync(this.workspaceDir, { recursive: true });
    ensureHarnessHome(this.home.homeDir, this.workspaceDir);
    this.home.expirePendingTranscriptCards();
    this.load();
  }

  close(): void {
    for (const bot of this.bots.values()) {
      bot.client?.close();
      bot.client = null;
    }
    this.home.close();
  }

  async reattachDisplays(): Promise<void> {
    for (const bot of this.bots.values()) {
      bot.display = await this.computer.allocate(bot.id);
    }
  }

  listHarnesses(): HarnessInfo[] {
    return this.listHarnessesFn();
  }

  hasAcpChild(id: string): boolean {
    return this.require(id).client != null;
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
    return this.publicBotSummaries(this.home.listChannelSummaries());
  }

  get(id: string): PublicBot | null {
    const bot = this.bots.get(id);
    return bot ? this.toPublic(bot, true) : null;
  }

  inbox(): PublicInbox {
    const summaries = this.home.listChannelSummaries();
    const storedBots = this.home.listBots();
    const byId = new Map(storedBots.map((bot) => [bot.id, bot]));
    return {
      bots: this.publicBotSummaries(summaries),
      channels: summaries
        .filter((channel) => channel.kind !== "bot-to-bot")
        .map((channel) => this.toPublicChannel(channel, byId)),
    };
  }

  messages(id: string): {
    messages: PublicMessage[];
    write: boolean;
    permission: PublicPermission | null;
    needsYou: PublicBot["needsYou"];
  } | null {
    const bot = this.bots.get(id);
    if (!bot) return null;
    return {
      messages: this.transcript(bot.id),
      write: bot.write,
      permission: publicPermission(bot.permission),
      needsYou: bot.needsYou,
    };
  }

  createGroup(input: { title?: unknown; botIds?: unknown }): PublicChannel {
    if (!Array.isArray(input.botIds) || input.botIds.some((id) => typeof id !== "string")) {
      throw Object.assign(new Error("botIds is required"), { status: 400 });
    }
    const title = typeof input.title === "string" ? input.title : undefined;
    const channel = this.home.createGroup({ title, memberBotIds: input.botIds as string[] });
    return this.toPublicChannel(channel);
  }

  listChannels(): PublicChannel[] {
    const storedBots = this.home.listBots();
    const byId = new Map(storedBots.map((bot) => [bot.id, bot]));
    return this.home
      .listChannelSummaries()
      .filter((channel) => channel.kind !== "bot-to-bot")
      .map((channel) => this.toPublicChannel(channel, byId));
  }

  getChannel(id: string): PublicChannel | null {
    const channel = this.home.getChannelSummary(id);
    if (!channel) return null;
    return this.toPublicChannel(channel);
  }

  markBotRead(id: string, cursor: ChannelCursor): ChannelActivity {
    this.require(id);
    const channelId = this.channelId(id);
    this.home.markChannelRead(channelId, cursor);
    return this.home.channelActivity(channelId);
  }

  markChannelRead(id: string, cursor: ChannelCursor): ChannelActivity {
    const channel = this.home.getChannelSummary(id);
    if (!channel || channel.kind === "bot-to-bot") {
      throw Object.assign(new Error("Channel not found"), { status: 404 });
    }
    this.home.markChannelRead(id, cursor);
    return this.home.channelActivity(id);
  }

  async create(name: string): Promise<PublicBot> {
    const trimmed = name.trim();
    if (!trimmed) throw Object.assign(new Error("name is required"), { status: 400 });
    const taken = [...this.bots.values()].map((bot) => bot.shape);
    const id = crypto.randomUUID();
    const stored: StoredBot = {
      id,
      name: trimmed,
      color: pickColor(trimmed),
      shape: pickShape(trimmed, taken),
      harness: null,
      configMode: "isolated",
      createdAt: nowIso(),
    };
    const display = await this.computer.allocate(id);
    this.home.createBot(stored, crypto.randomUUID());
    ensureBotWorkspace(this.workspaceDir, id);
    const bot = this.runtimeBot(stored, display);
    this.bots.set(id, bot);
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
    if (bot.needsYou || bot.permission) bot.eyesMode = "needs-you";
    else if (bot.write) bot.eyesMode = "write";
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
    this.expireActivePermission(bot);
    bot.client?.close();
    bot.client = null;
    bot.harness = harness;
    bot.write = false;
    bot.needsYou = null;
    bot.eyesMode = "idle";
    return this.toPublic(bot, true);
  }

  async setConfigMode(id: string, configMode: string): Promise<PublicBot> {
    const bot = this.require(id);
    if (!isConfigMode(configMode)) throw Object.assign(new Error("unknown config mode"), { status: 400 });
    if (bot.configMode === configMode) return this.toPublic(bot, true);
    this.home.setConfigMode(bot.id, configMode);
    this.expireActivePermission(bot);
    bot.client?.close();
    bot.client = null;
    bot.configMode = configMode;
    bot.write = false;
    bot.needsYou = null;
    bot.eyesMode = "idle";
    return this.toPublic(bot, true);
  }

  readAllBotsAgents(): string {
    return readAgentsFile(allBotsAgentsPath(this.workspaceDir));
  }

  writeAllBotsAgents(text: string): string {
    writeAgentsFile(allBotsAgentsPath(this.workspaceDir), text);
    return text;
  }

  readThisBotAgents(id: string): string {
    this.require(id);
    ensureBotWorkspace(this.workspaceDir, id);
    return readAgentsFile(thisBotAgentsPath(this.workspaceDir, id));
  }

  writeThisBotAgents(id: string, text: string): string {
    this.require(id);
    ensureBotWorkspace(this.workspaceDir, id);
    writeAgentsFile(thisBotAgentsPath(this.workspaceDir, id), text);
    return text;
  }

  botCwd(id: string): string {
    return botWorkspaceDir(this.workspaceDir, id);
  }

  lastSpawnEnv(id: string): NodeJS.ProcessEnv | null {
    return this.spawnEnvs.get(id) ?? null;
  }

  lastSpawnCwd(id: string): string | null {
    return this.spawnCwds.get(id) ?? null;
  }

  listHostGrants() {
    return this.home.listHostGrants();
  }

  async send(id: string, text: string, replyTo?: string): Promise<PublicBot> {
    const bot = this.require(id);
    const trimmed = text.trim();
    if (!trimmed) throw Object.assign(new Error("text is required"), { status: 400 });
    if (!bot.harness) throw Object.assign(new Error("pick a Harness first"), { status: 400 });
    if (bot.harness !== "codex") {
      throw Object.assign(new Error("Talk spawn is Codex-only in this slice"), { status: 400 });
    }

    const channelId = this.channelId(bot.id);
    const beforeInterrupt = this.home.listMessages(channelId);
    const replyTarget = this.resolveReplyTarget(beforeInterrupt, replyTo);
    if (bot.write && bot.openAssistantId && replyTarget?.id === bot.openAssistantId) {
      throw Object.assign(new Error("cannot reply to an unfinished response"), { status: 409 });
    }
    let attached: { client: AcpSession; skipHistory: boolean };
    try {
      attached = await this.ensureClient(bot);
    } catch (err) {
      return this.recordClientFailure(bot, channelId, trimmed, replyTarget, err);
    }
    const client = attached.client;

    if (bot.write) {
      try {
        client.cancel();
      } catch {
        /* local cancel still proceeds */
      }
      if (bot.openAssistantId) {
        if (bot.openAssistantCheckpoint?.id === bot.openAssistantId) {
          this.home.updateMessageText(bot.openAssistantId, bot.openAssistantCheckpoint.text);
        } else {
          this.home.deleteMessage(bot.openAssistantId);
        }
      }
      bot.openAssistantId = null;
      bot.openAssistantCheckpoint = null;
    }
    this.expireActivePermission(bot);
    bot.assistantMessageIds.clear();

    const prior = this.home.listMessages(channelId);
    const history = attached.skipHistory ? "" : channelHistory(prior, bot.name);

    bot.turnSeq += 1;
    const turnSeq = bot.turnSeq;
    const userMessage: PublicMessage = {
      id: crypto.randomUUID(),
      role: "user",
      text: trimmed,
      createdAt: nowIso(),
      receipt: "sent",
    };
    if (replyTarget) userMessage.replyTo = replyTarget.id;
    this.home.appendMessage(channelId, {
      ...userMessage,
      senderId: HUMAN_MEMBER_ID,
      recipientBotId: bot.id,
    });
    bot.activeUserId = userMessage.id;
    bot.openAssistantId = null;
    bot.openAssistantCheckpoint = null;
    bot.write = true;
    bot.eyesMode = "write";

    void (async () => {
      try {
        const reply = await client.prompt(talkPrompt(trimmed, replyTarget?.text, history), {
          onPermission: (prompt) => {
            if (turnSeq !== bot.turnSeq) return;
            this.handlePermission(bot, client, prompt);
          },
          onAssistant: (assistantText, delta) => {
            if (turnSeq !== bot.turnSeq) return;
            this.applyAssistant(bot, channelId, assistantText, delta);
          },
          onPromptWritten: () => {
            if (turnSeq !== bot.turnSeq) return;
            this.setUserReceipt(bot, channelId, "delivered");
          },
          onPromptFlushed: () => {
            if (turnSeq !== bot.turnSeq) return;
            this.setUserReceipt(bot, channelId, "read");
          },
        });
        if (turnSeq !== bot.turnSeq) return;
        const messages = this.home.listMessages(channelId);
        const userIdx = messages.findIndex((item) => item.id === userMessage.id);
        const assistants = messages.slice(userIdx + 1).filter((item) => item.role === "assistant" && item.text);
        if (assistants.length === 0) this.pushAssistant(bot, channelId, reply || ".");
      } catch (err) {
        if (turnSeq !== bot.turnSeq) return;
        if (isCancelled(err)) return;
        const needsSignIn = isAuthError(err) || isLikelyLogin(err);
        if (needsSignIn) {
          bot.eyesMode = "needs-you";
          bot.needsYou = { reason: "login", hint: loginHint("codex") };
        }
        this.discardUnfinishedAssistant(bot);
        this.expireActivePermission(bot);
        this.appendFailureCard(bot, channelId, userMessage.id, needsSignIn);
        bot.client?.close();
        bot.client = null;
      } finally {
        if (turnSeq !== bot.turnSeq) return;
        bot.openAssistantId = null;
        bot.openAssistantCheckpoint = null;
        bot.assistantMessageIds.clear();
        bot.activeUserId = null;
        bot.write = false;
        if (bot.eyesMode === "write") bot.eyesMode = bot.needsYou ? "needs-you" : "idle";
        this.expireActivePermission(bot);
      }
    })();

    return this.toPublic(bot, true);
  }

  toggleReaction(id: string, messageId: string, emoji: string): PublicBot {
    const bot = this.require(id);
    const trimmed = emoji.trim();
    if (!trimmed) throw Object.assign(new Error("emoji is required"), { status: 400 });
    const channelId = this.channelId(bot.id);
    const message = this.home.getMessage(channelId, messageId);
    if (!message) throw Object.assign(new Error("message not found"), { status: 404 });
    this.home.toggleReaction(message.id, trimmed, nowIso());
    return this.toPublic(bot, true);
  }

  answerPermission(id: string, optionId: string, cardId: string): PublicBot {
    const bot = this.require(id);
    if (!bot.permission || !bot.client) {
      throw Object.assign(new Error("no permission prompt"), { status: 409 });
    }
    if (!optionId) throw Object.assign(new Error("optionId is required"), { status: 400 });
    const activeCardId = bot.permission.cardId;
    if (!activeCardId) throw Object.assign(new Error("permission Card not found"), { status: 409 });
    if (!cardId) throw Object.assign(new Error("cardId is required"), { status: 400 });
    if (cardId !== activeCardId) {
      throw Object.assign(new Error("permission Card is no longer active"), { status: 409 });
    }
    const message = this.home.getMessage(this.channelId(bot.id), activeCardId);
    if (!message?.card || message.card.kind !== "permission") {
      throw Object.assign(new Error("permission Card not found"), { status: 409 });
    }
    const resolvedCard = resolvedPermissionCard(message.card, optionId);
    const rpcId = bot.permission.rpcId;
    const client = bot.client;
    this.home.updateMessageCard(message.id, resolvedCard);
    bot.permission = null;
    bot.eyesMode = bot.write ? "write" : "idle";
    try {
      client.respondPermission(rpcId, optionId);
    } catch {
      client.close();
      bot.client = null;
      throw Object.assign(new Error("Permission could not be sent to the Harness"), { status: 409 });
    }
    return this.toPublic(bot, true);
  }

  answerHostGrant(id: string, access: string, duration: string, cardId: string): PublicBot {
    const bot = this.require(id);
    if (!bot.permission?.hostGrant || !bot.client) {
      throw Object.assign(new Error("no Host grant prompt"), { status: 409 });
    }
    if (!isHostGrantAccess(access)) throw Object.assign(new Error("access is required"), { status: 400 });
    if (!isHostGrantDuration(duration)) throw Object.assign(new Error("duration is required"), { status: 400 });
    const activeCardId = bot.permission.cardId;
    if (!activeCardId) throw Object.assign(new Error("Host grant Card not found"), { status: 409 });
    if (!cardId) throw Object.assign(new Error("cardId is required"), { status: 400 });
    if (cardId !== activeCardId) {
      throw Object.assign(new Error("Host grant Card is no longer active"), { status: 409 });
    }
    const message = this.home.getMessage(this.channelId(bot.id), activeCardId);
    if (!message?.card || message.card.kind !== "host-grant") {
      throw Object.assign(new Error("Host grant Card not found"), { status: 409 });
    }
    const resolvedCard = resolvedHostGrantCard(message.card, access, duration);
    const requestPath = bot.permission.hostGrant.path;
    const rpcId = bot.permission.rpcId;
    const options = bot.permission.options;
    const optionId =
      access === "deny" ? pickRejectOption(options) : pickAllowOption(options);
    if (!optionId) throw Object.assign(new Error("no matching permission option"), { status: 409 });
    const client = bot.client;
    this.home.resolveHostGrantCard(message.id, resolvedCard, {
      path: requestPath,
      access,
      duration,
    });
    bot.permission = null;
    bot.eyesMode = bot.write ? "write" : "idle";
    try {
      client.respondPermission(rpcId, optionId);
    } catch {
      client.close();
      bot.client = null;
      throw Object.assign(new Error("Host grant could not be sent to the Harness"), { status: 409 });
    }
    return this.toPublic(bot, true);
  }

  private load(): void {
    for (const stored of this.home.listBots()) {
      ensureBotWorkspace(this.workspaceDir, stored.id);
      this.bots.set(stored.id, this.runtimeBot(stored, null));
    }
  }

  private runtimeBot(stored: StoredBot, display: DisplayHandle | null): Bot {
    return {
      id: stored.id,
      name: stored.name,
      color: stored.color,
      shape: stored.shape,
      harness: stored.harness,
      configMode: stored.configMode ?? "isolated",
      write: false,
      zoom: false,
      display,
      eyesMode: "idle",
      needsYou: null,
      permission: null,
      openAssistantId: null,
      openAssistantCheckpoint: null,
      assistantMessageIds: new Map(),
      activeUserId: null,
      turnSeq: 0,
      client: null,
    };
  }

  private require(id: string): Bot {
    const bot = this.bots.get(id);
    if (!bot) throw Object.assign(new Error("Bot not found"), { status: 404 });
    return bot;
  }

  private channelId(botId: string): string {
    const channelId = this.home.directChannelId(botId);
    if (!channelId) throw new Error("Bot has no direct Channel");
    return channelId;
  }

  private transcript(botId: string): PublicMessage[] {
    return this.home.listMessages(this.channelId(botId));
  }

  private async ensureClient(bot: Bot): Promise<{ client: AcpSession; skipHistory: boolean }> {
    if (bot.client) return { client: bot.client, skipHistory: true };
    const harness = bot.harness;
    if (!harness) throw Object.assign(new Error("pick a Harness first"), { status: 400 });

    const cwd = ensureBotWorkspace(this.workspaceDir, bot.id);
    let spec: SpawnSpec;
    try {
      spec = spawnSpec(harness, {
        mode: bot.configMode,
        homeDir: this.home.homeDir,
        cwd,
        botId: bot.id,
        screenContainer: this.computer.containerName(),
      });
    } catch (err) {
      if (this.spawnAcpFn === spawnAcp) {
        bot.eyesMode = "needs-you";
        bot.needsYou = { reason: "login", hint: loginHint(harness) };
        throw Object.assign(err instanceof Error ? err : new Error(loginHint(harness)), { status: 409 });
      }
      spec = {
        command: "injected-acp",
        args: [],
        env: spawnSpecEnvFallback(bot.configMode, this.home.homeDir, cwd, bot.id, this.computer.containerName()),
      };
    }

    const channelId = this.channelId(bot.id);
    let client: AcpSession | undefined;
    try {
      client = this.spawnAcpFn(spec, cwd, {
        onPermission: (prompt) => {
          if (!client) return;
          this.handlePermission(bot, client, prompt);
        },
        onAssistant: (text, delta) => this.applyAssistant(bot, channelId, text, delta),
        onPromptWritten: () => this.setUserReceipt(bot, channelId, "delivered"),
        onPromptFlushed: () => this.setUserReceipt(bot, channelId, "read"),
      });
      await client.initialize();
      const restored = await this.restoreOrCreateSession(bot, client, channelId);
      bot.client = client;
      this.spawnEnvs.set(bot.id, spec.env);
      this.spawnCwds.set(bot.id, cwd);
      bot.eyesMode = "idle";
      bot.needsYou = null;
      return { client, skipHistory: restored };
    } catch (err) {
      client?.close();
      bot.client = null;
      const needsSignIn = isAuthError(err) || isLikelyLogin(err);
      bot.eyesMode = needsSignIn ? "needs-you" : "idle";
      bot.needsYou = needsSignIn ? { reason: "login", hint: loginHint(harness) } : null;
      throw Object.assign(new Error(needsSignIn ? loginHint(harness) : "Harness could not start"), {
        status: 409,
        cause: err,
      });
    }
  }

  private async restoreOrCreateSession(bot: Bot, client: AcpSession, channelId: string): Promise<boolean> {
    const storedId = this.home.getSessionId(bot.id, channelId);
    const channelHarness = this.home.getChannelHarness(bot.id, channelId);
    const sameHarness = Boolean(bot.harness && channelHarness === bot.harness);
    if (storedId && sameHarness) {
      if (typeof client.loadSession === "function") {
        try {
          const loaded = await client.loadSession(storedId);
          const id = typeof loaded === "string" && loaded ? loaded : storedId;
          this.home.setSessionId(bot.id, channelId, id);
          return true;
        } catch {
          // Fall back to session/new plus Channel inject.
        }
      } else if (typeof client.resumeSession === "function") {
        try {
          const resumed = await client.resumeSession(storedId);
          const id = typeof resumed === "string" && resumed ? resumed : storedId;
          this.home.setSessionId(bot.id, channelId, id);
          return true;
        } catch {
          // Fall back to session/new plus Channel inject.
        }
      }
    }
    const created = await client.newSession(this.botCwd(bot.id));
    if (typeof created !== "string" || !created) {
      throw new Error("session/new did not return a sessionId");
    }
    this.home.setSessionId(bot.id, channelId, created);
    return false;
  }

  private resolveReplyTarget(messages: PublicMessage[], replyTo: string | undefined): PublicMessage | null {
    if (replyTo === undefined) return null;
    const targetId = replyTo.trim();
    if (!targetId) throw Object.assign(new Error("replyTo is required"), { status: 400 });
    const target = messages.find((item) => item.id === targetId);
    if (!target) throw Object.assign(new Error("reply target not found"), { status: 400 });
    return target;
  }

  private pushAssistant(bot: Bot, channelId: string, text: string): void {
    bot.openAssistantId = null;
    bot.openAssistantCheckpoint = null;
    const message: PublicMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      text: capTalkBubble(text),
      createdAt: nowIso(),
    };
    this.home.appendMessage(channelId, { ...message, senderId: bot.id });
  }

  private applyAssistant(bot: Bot, channelId: string, text: string, delta?: AssistantDelta): void {
    const capped = capTalkBubble(text);
    const protocolMessageId = delta?.messageId;
    const existingMessageId = protocolMessageId
      ? bot.assistantMessageIds.get(protocolMessageId)
      : undefined;
    if (existingMessageId) {
      if (!delta?.done && bot.openAssistantId !== existingMessageId) {
        const completed = this.home.getMessage(channelId, existingMessageId);
        bot.openAssistantCheckpoint = completed
          ? { id: existingMessageId, text: completed.text }
          : null;
      }
      this.home.updateMessageText(existingMessageId, capped);
      bot.openAssistantId = delta?.done ? null : existingMessageId;
      if (delta?.done) bot.openAssistantCheckpoint = null;
      return;
    }
    const startNew = Boolean(delta?.start) || !bot.openAssistantId;
    if (startNew) {
      const id = crypto.randomUUID();
      this.home.appendMessage(channelId, {
        id,
        role: "assistant",
        text: capped,
        createdAt: nowIso(),
        senderId: bot.id,
      });
      bot.openAssistantId = id;
      bot.openAssistantCheckpoint = null;
      if (protocolMessageId) bot.assistantMessageIds.set(protocolMessageId, id);
    } else if (bot.openAssistantId) {
      this.home.updateMessageText(bot.openAssistantId, capped);
    }
    if (delta?.done) {
      bot.openAssistantId = null;
      bot.openAssistantCheckpoint = null;
    }
  }

  private setUserReceipt(bot: Bot, channelId: string, next: MessageReceipt): void {
    const messageId = bot.activeUserId;
    if (!messageId) return;
    const message = this.home.getMessage(channelId, messageId);
    if (!message || message.role !== "user") return;
    const receipt = advanceReceipt(message.receipt, next);
    if (receipt === message.receipt) return;
    this.home.setReceipt(messageId, bot.id, receipt, nowIso());
  }

  private discardUnfinishedAssistant(bot: Bot): void {
    const openId = bot.openAssistantId;
    if (!openId) return;
    if (bot.openAssistantCheckpoint?.id === openId) {
      this.home.updateMessageText(openId, bot.openAssistantCheckpoint.text);
    } else {
      this.home.deleteMessage(openId);
    }
    bot.openAssistantId = null;
    bot.openAssistantCheckpoint = null;
  }

  private recordClientFailure(
    bot: Bot,
    channelId: string,
    text: string,
    replyTarget: PublicMessage | null,
    err: unknown,
  ): PublicBot {
    const needsSignIn = isAuthError(err) || isLikelyLogin(err);
    const userMessage: PublicMessage = {
      id: crypto.randomUUID(),
      role: "user",
      text,
      createdAt: nowIso(),
      receipt: "sent",
      ...(replyTarget ? { replyTo: replyTarget.id } : {}),
    };
    this.home.appendMessage(channelId, {
      ...userMessage,
      senderId: HUMAN_MEMBER_ID,
      recipientBotId: bot.id,
    });
    bot.write = false;
    bot.needsYou = needsSignIn ? { reason: "login", hint: loginHint("codex") } : null;
    bot.eyesMode = needsSignIn ? "needs-you" : "idle";
    this.appendFailureCard(bot, channelId, userMessage.id, needsSignIn);
    return this.toPublic(bot, true);
  }

  private appendFailureCard(bot: Bot, channelId: string, messageId: string, needsSignIn: boolean): void {
    const card = botFailureTranscriptCard(messageId, needsSignIn);
    this.home.appendMessage(channelId, {
      id: crypto.randomUUID(),
      role: "assistant",
      kind: "card",
      card,
      text: transcriptCardSummary(card),
      createdAt: nowIso(),
      senderId: bot.id,
    });
  }

  private expireActivePermission(bot: Bot): void {
    const cardId = bot.permission?.cardId;
    if (cardId) {
      const message = this.home.getMessage(this.channelId(bot.id), cardId);
      if (message?.card && message.card.status.tone === "waiting" && message.card.actions.length > 0) {
        this.home.updateMessageCard(message.id, expiredTranscriptCard(message.card));
      }
    }
    bot.permission = null;
  }

  private supersedeActivePermission(bot: Bot, client: AcpSession): boolean {
    const active = bot.permission;
    if (!active) return true;
    const reject = pickRejectOption(active.options);
    if (!reject) {
      try {
        client.cancel();
      } catch {
        client.close();
        bot.client = null;
      }
      this.expireActivePermission(bot);
      return false;
    }
    try {
      client.respondPermission(active.rpcId, reject);
    } catch {
      client.close();
      bot.client = null;
      this.expireActivePermission(bot);
      return false;
    }
    this.expireActivePermission(bot);
    return true;
  }

  private handlePermission(bot: Bot, client: AcpSession, prompt: PermissionPrompt): void {
    if (!this.supersedeActivePermission(bot, client)) return;
    const cwd = this.botCwd(bot.id);
    const requestPaths = extractPermissionPaths(prompt, cwd);
    const requested = requestedAccessFromKind(prompt.toolKind);
    const pathIsInJail = (target: string) =>
      isInsideWorkspace(target, this.workspaceDir)
      || (bot.configMode === "isolated" && isInsideScreenWorkspace(target));
    const requestPath = requestPaths.find((target) =>
      !pathIsInJail(target) && !isExecutePlumbingPath(target, prompt.toolKind))
      ?? requestPaths.find(pathIsInJail)
      ?? null;
    const inJail = requestPath ? pathIsInJail(requestPath) : false;
    if (inJail) {
      const allow = pickAllowOption(prompt.options);
      if (allow) {
        client.respondPermission(prompt.rpcId, allow);
        return;
      }
    }
    if (requestPath && !inJail) {
      const grant = this.home.matchHostGrant(requestPath, requested);
      if (grant) {
        if (grant.access === "deny") {
          const reject = pickRejectOption(prompt.options);
          if (reject) client.respondPermission(prompt.rpcId, reject);
        } else {
          const allow = pickAllowOption(prompt.options);
          if (allow) client.respondPermission(prompt.rpcId, allow);
        }
        if (grant.duration === "once") this.home.consumeHostGrant(grant.id);
        return;
      }
      const card = hostGrantTranscriptCard(
        requestPath,
        requested === "read" ? "read" : "read-write",
        prompt.options,
      );
      const cardId = crypto.randomUUID();
      this.home.appendMessage(this.channelId(bot.id), {
        id: cardId,
        role: "assistant",
        kind: "card",
        card,
        text: transcriptCardSummary(card),
        createdAt: nowIso(),
        senderId: bot.id,
      });
      bot.permission = {
        ...prompt,
        cardId,
        hostGrant: { path: requestPath, requested: requested === "read" ? "read" : "read-write" },
      };
      bot.eyesMode = "needs-you";
      return;
    }
    const card = permissionTranscriptCard(prompt.toolKind, prompt.options);
    const cardId = crypto.randomUUID();
    this.home.appendMessage(this.channelId(bot.id), {
      id: cardId,
      role: "assistant",
      kind: "card",
      card,
      text: transcriptCardSummary(card),
      createdAt: nowIso(),
      senderId: bot.id,
    });
    bot.permission = { ...prompt, cardId };
    bot.eyesMode = "needs-you";
  }

  private toPublicChannel(
    channel: StoredChannel | StoredChannelSummary,
    byId = new Map(this.home.listBots().map((bot) => [bot.id, bot])),
  ): PublicChannel {
    return {
      id: channel.id,
      kind: channel.kind,
      title: channel.title,
      createdAt: channel.createdAt,
      members: channel.members.map((member) => {
        if (member.kind === "user") {
          return { kind: "user" as const, id: member.id, name: "You" };
        }
        const bot = byId.get(member.id);
        const out: PublicChannelMember = {
          kind: "bot",
          id: member.id,
          name: bot?.name ?? member.id,
        };
        if (bot) {
          out.eyes = { color: bot.color, shape: bot.shape, mode: "idle" };
        }
        return out;
      }),
      activity: "activity" in channel ? channel.activity : this.home.channelActivity(channel.id),
    };
  }

  private publicBotSummaries(summaries: StoredChannelSummary[]): PublicBot[] {
    const activityByBot = new Map<string, ChannelActivity>();
    for (const channel of summaries) {
      if (channel.kind !== "direct") continue;
      const bot = channel.members.find((member) => member.kind === "bot");
      if (bot) activityByBot.set(bot.id, channel.activity);
    }
    return [...this.bots.values()].map((bot) => this.toPublic(bot, false, activityByBot.get(bot.id)));
  }

  private toPublic(bot: Bot, withMessages: boolean, activity?: ChannelActivity): PublicBot {
    const mode: EyesMode = bot.write ? "write" : bot.eyesMode;
    const out: PublicBot = {
      id: bot.id,
      name: bot.name,
      harness: bot.harness,
      configMode: bot.configMode,
      eyes: { color: bot.color, shape: bot.shape, mode },
      write: bot.write,
      zoom: bot.zoom,
      display: bot.display?.display ?? null,
      permission: publicPermission(bot.permission),
      needsYou: bot.needsYou,
      activity: activity ?? this.home.channelActivity(this.channelId(bot.id)),
    };
    if (withMessages) out.messages = this.transcript(bot.id);
    return out;
  }
}

function isLikelyLogin(err: unknown): boolean {
  return isAuthError(err) || /login|auth|not signed/i.test(String((err as Error)?.message ?? err));
}

const TALK_VOICE =
  "You are chatting in OpenBot. Reply like a person in iMessage. Send several short ACP agent messages (one or two sentences each). No markdown essays. No headings. No numbered dumps. No tool JSON or transcripts in chat. Code in a bubble is fine. Attach a screenshot only when it helps.";

const HISTORY_TURN_LIMIT = 20;
const HISTORY_CHARACTER_LIMIT = 64_000;

export function channelHistory(messages: PublicMessage[], botName: string): string {
  const heading = "Recent Channel transcript:\n";
  const transcriptLimit = HISTORY_CHARACTER_LIMIT - heading.length;
  const speech = messages.filter((message) => message.kind === undefined || message.kind === "text");
  const userIndexes = speech.flatMap((message, index) => (message.role === "user" ? [index] : []));
  if (userIndexes.length === 0) return "";
  const firstTurn = userIndexes[Math.max(0, userIndexes.length - HISTORY_TURN_LIMIT)] ?? 0;
  const lines = speech.slice(firstTurn).map((message) => {
    const speaker = message.role === "user" ? "You" : botName;
    return `${speaker}: ${message.text}`;
  });
  let transcript = lines.join("\n");
  if (transcript.length > transcriptLimit) {
    const marker = "[Earlier transcript clipped]\n";
    transcript = `${marker}${transcript.slice(-(transcriptLimit - marker.length))}`;
  }
  return `${heading}${transcript}`;
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

function spawnSpecEnvFallback(
  mode: ConfigMode,
  homeDir: string,
  botHome: string,
  botId: string,
  screenContainer: string,
): NodeJS.ProcessEnv {
  return applyVendorHomeEnv({ ...process.env }, mode, homeDir, botHome, { botId, screenContainer });
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

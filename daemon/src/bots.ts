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
  BotWorkspacePreparationError,
  botWorkspaceDir,
  ensureBotWorkspace,
  ensureHarnessHome,
  extractPermissionPath,
  isConfigMode,
  isHostGrantAccess,
  isHostGrantDuration,
  isInsideWorkspace,
  isInsideScreenWorkspace,
  pickAllowOption,
  pickRejectOption,
  prepareBotWorkspace,
  readAgentsFile,
  requestedAccessFromKind,
  rollbackPreparedBotWorkspace,
  thisBotAgentsPath,
  writeAgentsFile,
  allBotsAgentsPath,
  applyVendorHomeEnv,
  type BotWorkspaceRollback,
  type ConfigMode,
  type HostGrantAccess,
  type HostGrantDuration,
  type PreparedBotWorkspace,
} from "./harness-home.ts";
import {
  isAuthError,
  isCancelled,
  spawnAcp,
  type AcpHandlers,
  type AssistantDelta,
  type PermissionPrompt,
} from "./acp.ts";
import { NoopComputerRuntime, type ComputerRuntime, type DisplayHandle } from "./computer.ts";
import { pinchTabMcpServers, stripPinchTabFromPath } from "./pinchtab.ts";
import type { KasmWriteAuthority } from "./kasm.ts";

export { defaultHomeDir, defaultWorkspaceDir } from "./home.ts";
export type { MessageReaction, MessageReceipt } from "./home.ts";

export type PublicMessage = TranscriptMessage;

export type PublicHostGrant = {
  path: string;
  requested: "read" | "read-write";
};

export type ScreenState = "attaching" | "ready" | "unavailable" | "unassigned" | "cleanup-required";

export type ScreenAttachmentStage = "reserve" | "prepare" | "readiness" | "commit" | "ownership";

export type PublicScreenError = {
  stage: ScreenAttachmentStage;
  code:
    | "SCREEN_ATTACHMENT_FAILED"
    | "SCREEN_NOT_READY"
    | "SCREEN_ASSIGNMENT_MISSING"
    | "SCREEN_OWNERSHIP_FAILED";
  message: string;
};

export type PublicScreenCleanupError = {
  code: "SCREEN_CLEANUP_FAILED";
  message: string;
};

export type PublicPermission = {
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
  computerOwnership: KasmWriteAuthority;
  display: number | null;
  screenState: ScreenState;
  screenAttempt: string;
  screenError: PublicScreenError | null;
  screenCleanupError: PublicScreenCleanupError | null;
  permission: PublicPermission | null;
  needsYou: { reason: "login"; hint: string } | null;
  messages?: PublicMessage[];
};

export type BotScreenRuntimeState = Pick<
  PublicBot,
  | "id"
  | "computerOwnership"
  | "display"
  | "screenState"
  | "screenAttempt"
  | "screenError"
  | "screenCleanupError"
>;

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
};

export type AcpSession = {
  close(): void;
  initialize(): Promise<unknown>;
  newSession(cwd: string): Promise<string>;
  loadSession?(sessionId: string): Promise<unknown>;
  resumeSession?(sessionId: string): Promise<unknown>;
  prompt(text: string): Promise<string>;
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
  computerOwnership: KasmWriteAuthority;
  display: DisplayHandle | null;
  assignedDisplay: number | null;
  screenState: ScreenState;
  screenAttempt: string;
  screenError: PublicScreenError | null;
  screenCleanupError: PublicScreenCleanupError | null;
  eyesMode: EyesMode;
  needsYou: { reason: "login"; hint: string } | null;
  permission: BotPermission | null;
  openAssistantId: string | null;
  activeUserId: string | null;
  turnSeq: number;
  client: AcpSession | null;
};

export type BotStoreDeps = {
  computer?: ComputerRuntime;
  screenReady?: (upstream: string) => Promise<boolean>;
  spawnAcp?: (spec: SpawnSpec, cwd: string, handlers?: AcpHandlers) => AcpSession;
  listHarnesses?: () => HarnessInfo[];
  workspaceDir?: string;
};

const STALE_SCREEN_ATTACHMENT = Symbol("stale Screen attachment");

type ScreenRegistration = (botId: string) => Promise<KasmWriteAuthority> | KasmWriteAuthority;
type ScreenReleaseRegistration = (botId: string) => void;

type ScreenAttachmentAttempt = {
  id: string;
  promise: Promise<void>;
};

function publicPermission(p: BotPermission | null): PublicPermission | null {
  if (!p) return null;
  const out: PublicPermission = { title: p.title, description: p.description, options: p.options };
  if (p.hostGrant) out.hostGrant = p.hostGrant;
  return out;
}

export class BotStore {
  private readonly bots = new Map<string, Bot>();
  private readonly home: HomeStore;
  private readonly workspaceDir: string;
  private readonly computer: ComputerRuntime;
  private readonly screenReadyFn: (upstream: string) => Promise<boolean>;
  private readonly spawnAcpFn: (spec: SpawnSpec, cwd: string, handlers?: AcpHandlers) => AcpSession;
  private readonly listHarnessesFn: () => HarnessInfo[];
  private zoomedId: string | null = null;
  private readonly spawnEnvs = new Map<string, NodeJS.ProcessEnv>();
  private readonly spawnCwds = new Map<string, string>();
  private readonly spawnSpecs = new Map<string, SpawnSpec>();
  private screenAttachmentsClosing = false;
  private provisioningRecoveryComplete = false;
  private persistedAttachmentRecoveryStarted = false;
  private readonly screenAttachmentFlights = new Set<Promise<void>>();
  private readonly screenAttachmentByBot = new Map<string, ScreenAttachmentAttempt>();
  private screenAttachmentShutdown: Promise<void> | null = null;

  constructor(homeDir: string, deps: BotStoreDeps = {}) {
    this.home = new HomeStore(homeDir);
    this.workspaceDir = deps.workspaceDir ?? defaultWorkspaceDir(homeDir);
    this.computer = deps.computer ?? new NoopComputerRuntime();
    this.screenReadyFn = deps.screenReady ?? (async () => false);
    this.spawnAcpFn = deps.spawnAcp ?? spawnAcp;
    this.listHarnessesFn = deps.listHarnesses ?? listHarnessesOnPath;
    try {
      const storedBots = this.home.listBots();
      fs.mkdirSync(this.workspaceDir, { recursive: true });
      ensureHarnessHome(this.home.homeDir, this.workspaceDir);
      this.load(storedBots);
    } catch (error) {
      this.home.close();
      throw error;
    }
  }

  close(): void {
    this.beginScreenAttachmentShutdown();
    if (this.screenAttachmentFlights.size > 0) {
      throw new Error("Screen attachments are still settling; await stopScreenAttachments before closing BotStore");
    }
    for (const bot of this.bots.values()) {
      bot.client?.close();
      bot.client = null;
    }
    this.home.close();
  }

  stopScreenAttachments(): Promise<void> {
    this.beginScreenAttachmentShutdown();
    if (this.screenAttachmentShutdown) return this.screenAttachmentShutdown;
    const flights = [...this.screenAttachmentFlights];
    this.screenAttachmentShutdown = Promise.allSettled(flights).then((results) => {
      const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw Object.assign(new AggregateError(failures, "Screen attachment shutdown cleanup failed."), {
          status: 503,
        });
      }
    });
    return this.screenAttachmentShutdown;
  }

  async reattachDisplays(
    onReady: ScreenRegistration = () => "view-only",
    onReleased: ScreenReleaseRegistration = () => undefined,
  ): Promise<void> {
    if (this.screenAttachmentsClosing) return;
    if (!this.provisioningRecoveryComplete) await this.recoverBotProvisionings();
    if (this.screenAttachmentsClosing) return;
    if (this.persistedAttachmentRecoveryStarted) {
      await Promise.all([...this.screenAttachmentByBot.values()].map((attempt) => attempt.promise));
      return;
    }
    this.persistedAttachmentRecoveryStarted = true;
    const attachments: Promise<void>[] = [];
    for (const bot of this.bots.values()) {
      const persistedDisplay = this.home.botDisplay(bot.id);
      bot.assignedDisplay = persistedDisplay ?? null;
      bot.computerOwnership = "unknown";
      if (persistedDisplay === undefined) {
        bot.screenAttempt = crypto.randomUUID();
        bot.screenState = "unavailable";
        bot.screenError = missingScreenAssignmentError();
        bot.screenCleanupError = null;
        continue;
      }
      if (persistedDisplay === null) {
        bot.screenAttempt = crypto.randomUUID();
        bot.screenState = "unassigned";
        bot.screenError = null;
        bot.screenCleanupError = null;
        continue;
      }
      attachments.push(this.startScreenAttachment(bot, persistedDisplay, onReady, onReleased));
    }
    await Promise.all(attachments);
  }

  retryScreen(
    id: string,
    expectedAttempt: string,
    onReady: ScreenRegistration = () => "view-only",
    onReleased: ScreenReleaseRegistration = () => undefined,
  ): PublicBot {
    if (this.screenAttachmentsClosing) {
      throw Object.assign(new Error("Screen recovery is shutting down."), {
        status: 503,
        code: "SCREEN_RECOVERY_SHUTTING_DOWN",
      });
    }
    const bot = this.require(id);
    if (bot.screenAttempt !== expectedAttempt) throw staleScreenAttemptError();
    if (this.screenAttachmentByBot.has(id) || bot.screenState === "attaching") {
      throw Object.assign(new Error("Screen attachment is already in progress."), {
        status: 409,
        code: "SCREEN_ATTACHMENT_IN_PROGRESS",
      });
    }
    if (bot.screenState === "cleanup-required") {
      throw Object.assign(new Error("Screen cleanup is required before retry."), {
        status: 409,
        code: "SCREEN_CLEANUP_REQUIRED",
      });
    }
    if (bot.screenState === "ready") {
      throw Object.assign(new Error("Screen is already ready."), {
        status: 409,
        code: "SCREEN_ALREADY_READY",
      });
    }
    const persistedDisplay = this.home.botDisplay(id);
    if (persistedDisplay === undefined) {
      throw Object.assign(new Error("Screen display assignment is missing."), {
        status: 409,
        code: "SCREEN_ASSIGNMENT_MISSING",
      });
    }
    const attachment = this.startScreenAttachment(bot, persistedDisplay, onReady, onReleased);
    void attachment.catch(() => undefined);
    return this.toPublic(bot, false);
  }

  private startScreenAttachment(
    bot: Bot,
    persistedDisplay: number | null,
    onReady: ScreenRegistration,
    onReleased: ScreenReleaseRegistration,
  ): Promise<void> {
    const active = this.screenAttachmentByBot.get(bot.id);
    if (active) return active.promise;
    const attemptId = crypto.randomUUID();
    bot.screenAttempt = attemptId;
    bot.screenState = "attaching";
    bot.computerOwnership = "unknown";
    bot.screenError = null;
    bot.screenCleanupError = null;
    const attempt: ScreenAttachmentAttempt = { id: attemptId, promise: Promise.resolve() };
    this.screenAttachmentByBot.set(bot.id, attempt);
    const task = Promise.resolve().then(() => (
      this.attachPersistedDisplay(bot, persistedDisplay, attemptId, onReady, onReleased)
    ));
    let tracked!: Promise<void>;
    tracked = task.finally(() => {
      this.screenAttachmentFlights.delete(tracked);
      if (this.screenAttachmentByBot.get(bot.id)?.id === attemptId) {
        this.screenAttachmentByBot.delete(bot.id);
      }
    });
    attempt.promise = tracked;
    this.screenAttachmentFlights.add(tracked);
    return tracked;
  }

  private async attachPersistedDisplay(
    bot: Bot,
    persistedDisplay: number | null,
    attemptId: string,
    onReady: ScreenRegistration,
    onReleased: ScreenReleaseRegistration,
  ): Promise<void> {
    let reserved = false;
    let stage: ScreenAttachmentStage = "reserve";
    let failure: unknown = null;
    try {
      let reservation: DisplayHandle | undefined;
      if (persistedDisplay === null) {
        for (const candidate of this.home.availableBotDisplays()) {
          try {
            reservation = this.computer.reserve(bot.id, candidate);
            reserved = true;
            this.home.claimBotDisplay(bot.id, candidate);
            bot.assignedDisplay = candidate;
            break;
          } catch (error) {
            if (!reserved && (error as { status?: unknown })?.status === 409) continue;
            throw error;
          }
        }
        if (!reservation) throw new Error("No Screen display is available");
      } else {
        reservation = this.computer.reserve(bot.id, persistedDisplay);
        reserved = true;
      }
      stage = "prepare";
      await this.computer.prepare(bot.id);
      if (!this.screenAttachmentIsCurrent(bot, attemptId)) throw STALE_SCREEN_ATTACHMENT;
      stage = "readiness";
      if (this.computer.requiresReadiness && !(await this.screenReadyFn(reservation.upstream))) {
        throw new Error("Screen application is not ready");
      }
      if (!this.screenAttachmentIsCurrent(bot, attemptId)) throw STALE_SCREEN_ATTACHMENT;
      stage = "commit";
      const display = this.computer.commit(bot.id);
      if (display.display !== bot.assignedDisplay) {
        throw new Error("Screen committed a different display than the durable Bot assignment");
      }
      bot.display = display;
      bot.computerOwnership = "unknown";
      stage = "ownership";
      const ownership = await onReady(bot.id);
      if (ownership !== "view-only") {
        throw new Error("Screen ownership registration was not confirmed view-only");
      }
      if (!this.screenAttachmentIsCurrent(bot, attemptId)) throw STALE_SCREEN_ATTACHMENT;
      bot.computerOwnership = "view-only";
      bot.screenState = "ready";
      bot.screenError = null;
      bot.screenCleanupError = null;
      return;
    } catch (error) {
      failure = error;
    }

    let cleanupFailed = false;
    if (reserved) {
      try {
        await this.computer.release(bot.id);
        onReleased(bot.id);
      } catch {
        cleanupFailed = true;
      }
    }
    if (failure === STALE_SCREEN_ATTACHMENT || !this.screenAttachmentIsCurrent(bot, attemptId)) {
      if (cleanupFailed) {
        throw Object.assign(new Error("Screen cleanup did not complete during shutdown."), { status: 503 });
      }
      return;
    }
    bot.display = null;
    bot.screenState = cleanupFailed ? "cleanup-required" : bot.assignedDisplay === null ? "unassigned" : "unavailable";
    bot.screenError = bot.assignedDisplay === null ? missingScreenAssignmentError() : screenAttachmentError(stage);
    bot.screenCleanupError = cleanupFailed ? screenCleanupError() : null;
  }

  private screenAttachmentIsCurrent(bot: Bot, attemptId: string): boolean {
    return !this.screenAttachmentsClosing
      && bot.screenAttempt === attemptId
      && this.screenAttachmentByBot.get(bot.id)?.id === attemptId;
  }

  private beginScreenAttachmentShutdown(): void {
    if (this.screenAttachmentsClosing) return;
    this.screenAttachmentsClosing = true;
  }

  async recoverBotProvisionings(): Promise<void> {
    if (this.provisioningRecoveryComplete) return;
    for (const provisioning of this.home.listBotProvisionings()) {
      if (provisioning.display !== null) {
        const owner = this.home.botIdForDisplay(provisioning.display);
        if (owner && owner !== provisioning.botId) {
          const detail = `display ${provisioning.display} is durably owned by published Bot ${owner}; no cleanup was attempted`;
          this.home.markBotProvisioningCleanupRequired(provisioning.botId, detail);
          throw botProvisioningCleanupRequiredError(
            provisioning.botId,
            new Error("Interrupted Bot provisioning requires recovery"),
            detail,
          );
        }
      }
      await this.compensateBotProvisioning({
        botId: provisioning.botId,
        display: provisioning.display,
        workspace: provisioning.workspaceOwned
          ? { dir: botWorkspaceDir(this.workspaceDir, provisioning.botId), created: true }
          : null,
        cause: new Error("Interrupted Bot provisioning requires recovery"),
      });
    }
    this.provisioningRecoveryComplete = true;
  }

  private async compensateBotProvisioning(input: {
    botId: string;
    display: number | null;
    workspace: PreparedBotWorkspace | null;
    cause: unknown;
  }): Promise<void> {
    const failures: string[] = [];
    if (input.display !== null) {
      try {
        await this.computer.rollback(input.botId, input.display);
        this.home.setBotProvisioningDisplay(input.botId, null);
      } catch (error) {
        failures.push(`display ${input.display}: ${errorDetail(error)}`);
      }
    }
    const displayCleanupFailed = failures.length > 0;
    let workspaceRollback: BotWorkspaceRollback | null = null;
    if (input.workspace) {
      workspaceRollback = rollbackPreparedBotWorkspace(input.workspace);
      if (workspaceRollback.removed) {
        try {
          this.home.setBotProvisioningWorkspaceOwned(input.botId, false);
        } catch (error) {
          failures.push(`workspace state: ${errorDetail(error)}`);
        }
      } else {
        failures.push(
          `workspace ${JSON.stringify(workspaceRollback.preservedPath)}: ${workspaceRollback.reason}`,
        );
      }
    }
    if (failures.length > 0) {
      const detail = failures.join("; ");
      this.home.markBotProvisioningCleanupRequired(input.botId, detail);
      if (workspaceRollback && !workspaceRollback.removed && !displayCleanupFailed && failures.length === 1) {
        throw Object.assign(
          botWorkspaceCleanupRequiredError("Bot creation failed", input.cause, workspaceRollback),
          { provisioningId: input.botId },
        );
      }
      throw botProvisioningCleanupRequiredError(input.botId, input.cause, detail);
    }
    this.home.clearBotProvisioning(input.botId);
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
    return [...this.bots.values()].map((bot) => this.toPublic(bot, false));
  }

  get(id: string): PublicBot | null {
    const bot = this.bots.get(id);
    return bot ? this.toPublic(bot, true) : null;
  }

  screenRuntime(id: string): BotScreenRuntimeState | null {
    const bot = this.bots.get(id);
    if (!bot) return null;
    return {
      id: bot.id,
      computerOwnership: bot.computerOwnership,
      display: bot.assignedDisplay,
      screenState: bot.screenState,
      screenAttempt: bot.screenAttempt,
      screenError: bot.screenError,
      screenCleanupError: bot.screenCleanupError,
    };
  }

  listScreenRuntimes(): BotScreenRuntimeState[] {
    return [...this.bots.keys()].flatMap((id) => {
      const screen = this.screenRuntime(id);
      return screen ? [screen] : [];
    });
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
    return this.home
      .listChannels()
      .filter((channel) => channel.kind !== "bot-to-bot")
      .map((channel) => this.toPublicChannel(channel));
  }

  getChannel(id: string): PublicChannel | null {
    const channel = this.home.getChannel(id);
    if (!channel) return null;
    return this.toPublicChannel(channel);
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
    this.home.beginBotProvisioning(id);
    let preparedWorkspace: PreparedBotWorkspace;
    try {
      preparedWorkspace = prepareBotWorkspace(this.workspaceDir, id);
    } catch (error) {
      let bootstrapError = error;
      const prepared = error instanceof BotWorkspacePreparationError
        ? error.preparedWorkspace
        : { dir: botWorkspaceDir(this.workspaceDir, id), created: true };
      if (error instanceof BotWorkspacePreparationError) {
        bootstrapError = error.cause;
      }
      const rollback = rollbackPreparedBotWorkspace(prepared);
      if (!rollback.removed) {
        this.home.markBotProvisioningCleanupRequired(id, rollback.reason ?? "workspace cleanup failed");
        throw Object.assign(botWorkspaceCleanupRequiredError("Bot workspace bootstrap failed", bootstrapError, rollback), {
          provisioningId: id,
        });
      }
      this.home.setBotProvisioningWorkspaceOwned(id, false);
      this.home.clearBotProvisioning(id);
      const detail = bootstrapError instanceof Error ? bootstrapError.message : String(bootstrapError);
      throw Object.assign(new Error(`Bot workspace bootstrap failed: ${detail}`), {
        status: 503,
        code: "BOT_BOOTSTRAP_FAILED",
        recoverable: true,
      });
    }
    let display: DisplayHandle;
    let reservedDisplay: number | null = null;
    try {
      const claimedDisplay = this.home.claimBotProvisioningDisplay(id);
      const reservation = this.computer.reserve(id, claimedDisplay);
      reservedDisplay = reservation.display;
      if (reservedDisplay !== claimedDisplay) {
        throw new Error("Screen display reservation did not match the durable provisioning claim");
      }
      await this.computer.prepare(id);
      if (this.computer.requiresReadiness && !(await this.screenReadyFn(reservation.upstream))) {
        throw Object.assign(new Error("Screen application is not ready"), {
          status: 503,
          code: "SCREEN_NOT_READY",
          recoverable: true,
        });
      }
      display = this.computer.commit(id);
      this.home.commitProvisionedBot(stored, crypto.randomUUID());
    } catch (error) {
      await this.compensateBotProvisioning({
        botId: id,
        display: reservedDisplay,
        workspace: preparedWorkspace,
        cause: error,
      });
      throw error;
    }
    const bot = this.runtimeBot(stored, display);
    this.bots.set(id, bot);
    return this.toPublic(bot, true);
  }

  zoom(id: string): PublicBot {
    return this.setComputerOwnership(id, "write");
  }

  unzoom(id: string): PublicBot {
    return this.setComputerOwnership(id, "view-only");
  }

  setComputerOwnership(id: string, authority: KasmWriteAuthority): PublicBot {
    const bot = this.updateComputerOwnership(id, authority);
    return this.toPublic(bot, true);
  }

  publishComputerOwnership(id: string, authority: KasmWriteAuthority): void {
    this.updateComputerOwnership(id, authority);
  }

  private updateComputerOwnership(id: string, authority: KasmWriteAuthority): Bot {
    const bot = this.require(id);
    if (authority === "write" && this.zoomedId && this.zoomedId !== id) {
      const previous = this.require(this.zoomedId);
      previous.zoom = false;
      previous.computerOwnership = "view-only";
      this.restoreEyes(previous);
    }
    bot.computerOwnership = authority;
    bot.zoom = authority === "write";
    if (authority === "write") this.zoomedId = id;
    else if (this.zoomedId === id) this.zoomedId = null;
    this.restoreEyes(bot);
    return bot;
  }

  private restoreEyes(bot: Bot): void {
    if (bot.needsYou || bot.permission) bot.eyesMode = "needs-you";
    else if (bot.write) bot.eyesMode = "write";
    else bot.eyesMode = "idle";
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
    bot.client?.close();
    bot.client = null;
    bot.harness = harness;
    bot.write = false;
    bot.permission = null;
    bot.needsYou = null;
    bot.eyesMode = "idle";
    return this.toPublic(bot, true);
  }

  async setConfigMode(id: string, configMode: string): Promise<PublicBot> {
    const bot = this.require(id);
    if (!isConfigMode(configMode)) throw Object.assign(new Error("unknown config mode"), { status: 400 });
    if (bot.configMode === configMode) return this.toPublic(bot, true);
    this.home.setConfigMode(bot.id, configMode);
    bot.client?.close();
    bot.client = null;
    bot.configMode = configMode;
    bot.write = false;
    bot.permission = null;
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

  lastSpawnSpec(id: string): SpawnSpec | null {
    return this.spawnSpecs.get(id) ?? null;
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
    const prior = this.home.listMessages(channelId);
    const replyTarget = this.resolveReplyTarget(prior, replyTo);
    const attached = await this.ensureClient(bot);
    const history = attached.skipHistory ? "" : channelHistory(prior, bot.name);
    const client = attached.client;

    if (bot.write) {
      try {
        client.cancel();
      } catch {
        /* local cancel still proceeds */
      }
    }

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
    bot.write = true;
    bot.eyesMode = "write";
    bot.permission = null;

    void (async () => {
      try {
        const reply = await client.prompt(talkPrompt(trimmed, replyTarget?.text, history));
        if (turnSeq !== bot.turnSeq) return;
        const messages = this.home.listMessages(channelId);
        const userIdx = messages.findIndex((item) => item.id === userMessage.id);
        const assistants = messages.slice(userIdx + 1).filter((item) => item.role === "assistant" && item.text);
        if (assistants.length === 0) this.pushAssistant(bot, channelId, reply || ".");
      } catch (err) {
        if (turnSeq !== bot.turnSeq) return;
        if (isCancelled(err)) return;
        if (isAuthError(err) || isLikelyLogin(err)) {
          bot.eyesMode = "needs-you";
          bot.needsYou = { reason: "login", hint: loginHint("codex") };
          this.fillAssistant(bot, channelId, loginHint("codex"));
        } else {
          this.fillAssistant(bot, channelId, err instanceof Error ? err.message : "Harness error");
        }
      } finally {
        if (turnSeq !== bot.turnSeq) return;
        bot.openAssistantId = null;
        bot.activeUserId = null;
        bot.write = false;
        if (bot.eyesMode === "write") bot.eyesMode = bot.needsYou ? "needs-you" : "idle";
        bot.permission = null;
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

  answerPermission(id: string, optionId: string): PublicBot {
    const bot = this.require(id);
    if (!bot.permission || !bot.client) {
      throw Object.assign(new Error("no permission prompt"), { status: 409 });
    }
    if (!optionId) throw Object.assign(new Error("optionId is required"), { status: 400 });
    const rpcId = bot.permission.rpcId;
    bot.permission = null;
    bot.eyesMode = bot.write ? "write" : "idle";
    bot.client.respondPermission(rpcId, optionId);
    return this.toPublic(bot, true);
  }

  answerHostGrant(id: string, access: string, duration: string): PublicBot {
    const bot = this.require(id);
    if (!bot.permission?.hostGrant || !bot.client) {
      throw Object.assign(new Error("no Host grant prompt"), { status: 409 });
    }
    if (!isHostGrantAccess(access)) throw Object.assign(new Error("access is required"), { status: 400 });
    if (!isHostGrantDuration(duration)) throw Object.assign(new Error("duration is required"), { status: 400 });
    const requestPath = bot.permission.hostGrant.path;
    const rpcId = bot.permission.rpcId;
    const options = bot.permission.options;
    const optionId =
      access === "deny" ? pickRejectOption(options) : pickAllowOption(options);
    if (!optionId) throw Object.assign(new Error("no matching permission option"), { status: 409 });
    if (duration !== "once") {
      this.home.addHostGrant({ path: requestPath, access, duration });
    }
    bot.permission = null;
    bot.eyesMode = bot.write ? "write" : "idle";
    bot.client.respondPermission(rpcId, optionId);
    this.appendHostGrantCard(bot, requestPath, access, duration);
    return this.toPublic(bot, true);
  }

  private load(storedBots: StoredBot[]): void {
    for (const stored of storedBots) {
      ensureBotWorkspace(this.workspaceDir, stored.id);
      const assignedDisplay = this.home.botDisplay(stored.id) ?? null;
      this.bots.set(stored.id, this.runtimeBot(stored, null, assignedDisplay));
    }
  }

  private runtimeBot(
    stored: StoredBot,
    display: DisplayHandle | null,
    assignedDisplay = display?.display ?? null,
  ): Bot {
    return {
      id: stored.id,
      name: stored.name,
      color: stored.color,
      shape: stored.shape,
      harness: stored.harness,
      configMode: stored.configMode ?? "isolated",
      write: false,
      zoom: false,
      computerOwnership: display ? "view-only" : "unknown",
      display,
      assignedDisplay,
      screenState: display ? "ready" : assignedDisplay === null ? "unassigned" : "unavailable",
      screenAttempt: crypto.randomUUID(),
      screenError: null,
      screenCleanupError: null,
      eyesMode: "idle",
      needsYou: null,
      permission: null,
      openAssistantId: null,
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
    if (bot.client) {
      const attached = this.spawnSpecs.get(bot.id)?.mcpServers ?? [];
      if (attached.length > 0) return { client: bot.client, skipHistory: true };
      const next = await pinchTabMcpServers(this.computer, bot.id, this.spawnSpecs.get(bot.id)?.env);
      if (next.length === 0) return { client: bot.client, skipHistory: true };
      bot.client.close();
      bot.client = null;
    }
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
    spec.mcpServers = await pinchTabMcpServers(this.computer, bot.id, spec.env);
    this.spawnSpecs.set(bot.id, spec);

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
      this.spawnSpecs.set(bot.id, spec);
      bot.eyesMode = "idle";
      bot.needsYou = null;
      return { client, skipHistory: restored };
    } catch (err) {
      client?.close();
      bot.client = null;
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
    } else if (bot.openAssistantId) {
      this.home.updateMessageText(bot.openAssistantId, capped);
    }
    if (delta?.done) bot.openAssistantId = null;
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

  private fillAssistant(bot: Bot, channelId: string, text: string): void {
    if (bot.openAssistantId) {
      this.home.updateMessageText(bot.openAssistantId, text);
      bot.openAssistantId = null;
      return;
    }
    this.pushAssistant(bot, channelId, text);
  }

  private handlePermission(bot: Bot, client: AcpSession, prompt: PermissionPrompt): void {
    const cwd = this.botCwd(bot.id);
    const requestPath = extractPermissionPath(prompt, cwd);
    if (isPinchTabPermission(prompt)) {
      const allow = pickAllowOption(prompt.options);
      if (allow) {
        client.respondPermission(prompt.rpcId, allow);
        return;
      }
    }
    const requested = requestedAccessFromKind(prompt.toolKind);
    const inJail =
      (requestPath && isInsideWorkspace(requestPath, this.workspaceDir)) ||
      (requestPath && bot.configMode === "isolated" && isInsideScreenWorkspace(requestPath));
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
      bot.permission = {
        ...prompt,
        hostGrant: { path: requestPath, requested: requested === "read" ? "read" : "read-write" },
      };
      bot.eyesMode = "needs-you";
      return;
    }
    // Isolated v1 is not a jail (ADR 0010). Pathless commands auto-allow. Host grant is host paths only.
    const allow = pickAllowOption(prompt.options);
    if (allow) {
      client.respondPermission(prompt.rpcId, allow);
      return;
    }
    bot.permission = prompt;
    bot.eyesMode = "needs-you";
  }

  private appendHostGrantCard(
    bot: Bot,
    requestPath: string,
    access: HostGrantAccess,
    duration: HostGrantDuration,
  ): void {
    const accessLabel = access === "read-write" ? "Read and write" : access === "read" ? "Read" : "Deny";
    const durationLabel =
      duration === "session" ? "this Session" : duration === "until-revoked" ? "until revoked" : "once";
    this.home.appendMessage(this.channelId(bot.id), {
      id: crypto.randomUUID(),
      role: "user",
      kind: "host-grant",
      text: `${accessLabel} · ${durationLabel}\n${requestPath}`,
      createdAt: nowIso(),
      senderId: HUMAN_MEMBER_ID,
    });
  }

  private toPublicChannel(channel: StoredChannel): PublicChannel {
    const bots = this.home.listBots();
    const byId = new Map(bots.map((bot) => [bot.id, bot]));
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
    };
  }

  private toPublic(bot: Bot, withMessages: boolean): PublicBot {
    const mode: EyesMode = bot.write ? "write" : bot.eyesMode;
    const out: PublicBot = {
      id: bot.id,
      name: bot.name,
      harness: bot.harness,
      configMode: bot.configMode,
      eyes: { color: bot.color, shape: bot.shape, mode },
      write: bot.write,
      zoom: bot.zoom,
      computerOwnership: bot.computerOwnership,
      display: bot.assignedDisplay,
      screenState: bot.screenState,
      screenAttempt: bot.screenAttempt,
      screenError: bot.screenError,
      screenCleanupError: bot.screenCleanupError,
      permission: publicPermission(bot.permission),
      needsYou: bot.needsYou,
    };
    if (withMessages) out.messages = this.transcript(bot.id);
    return out;
  }
}

function botWorkspaceCleanupRequiredError(
  context: string,
  error: unknown,
  rollback: BotWorkspaceRollback,
): Error {
  const detail = error instanceof Error ? error.message : String(error);
  const status = typeof error === "object" && error !== null
    ? (error as { status?: unknown }).status
    : undefined;
  return Object.assign(
    new Error(
      `${context}: ${detail}. Bot workspace ${JSON.stringify(rollback.preservedPath)} was preserved because ${rollback.reason}. Inspect it, preserve anything you need, and remove the directory only if safe before retrying.`,
      { cause: error },
    ),
    {
      status: typeof status === "number" ? status : 503,
      code: "BOT_WORKSPACE_CLEANUP_REQUIRED",
      recoverable: true,
    },
  );
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function missingScreenAssignmentError(): PublicScreenError {
  return {
    stage: "reserve",
    code: "SCREEN_ASSIGNMENT_MISSING",
    message: "Screen display assignment is missing.",
  };
}

function screenAttachmentError(stage: ScreenAttachmentStage): PublicScreenError {
  if (stage === "readiness") {
    return {
      stage,
      code: "SCREEN_NOT_READY",
      message: "Screen application did not become ready.",
    };
  }
  if (stage === "ownership") {
    return {
      stage,
      code: "SCREEN_OWNERSHIP_FAILED",
      message: "Screen ownership registration failed.",
    };
  }
  return {
    stage,
    code: "SCREEN_ATTACHMENT_FAILED",
    message: `Screen attachment failed during ${stage}.`,
  };
}

function screenCleanupError(): PublicScreenCleanupError {
  return {
    code: "SCREEN_CLEANUP_FAILED",
    message: "Screen cleanup did not complete.",
  };
}

function staleScreenAttemptError(): Error {
  return Object.assign(new Error("Screen changed. Refresh and retry Screen."), {
    status: 409,
    code: "STALE_SCREEN_ATTEMPT",
  });
}

function botProvisioningCleanupRequiredError(botId: string, cause: unknown, cleanup: string): Error {
  const status = typeof cause === "object" && cause !== null
    ? (cause as { status?: unknown }).status
    : undefined;
  return Object.assign(
    new Error(
      `Bot provisioning failed: ${errorDetail(cause)}. Cleanup is incomplete for ${botId}: ${cleanup}. `
      + "The recoverable provisioning state was preserved for daemon restart or explicit retry.",
      { cause },
    ),
    {
      status: typeof status === "number" ? status : 503,
      code: "BOT_PROVISIONING_CLEANUP_REQUIRED",
      provisioningId: botId,
      recoverable: true,
    },
  );
}

function isPinchTabPermission(prompt: PermissionPrompt): boolean {
  const blob = `${prompt.title ?? ""}\n${prompt.description ?? ""}\n${prompt.toolKind ?? ""}\n${safePermissionJson(prompt.rawInput)}\n${safePermissionJson(prompt.meta)}\n${safePermissionJson(prompt.raw)}`;
  return /pinchtab|mcp__pinchtab/i.test(blob);
}

function safePermissionJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? "");
  } catch {
    return "";
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
  const userIndexes = messages.flatMap((message, index) => (message.role === "user" ? [index] : []));
  if (userIndexes.length === 0) return "";
  const firstTurn = userIndexes[Math.max(0, userIndexes.length - HISTORY_TURN_LIMIT)] ?? 0;
  const lines = messages.slice(firstTurn).map((message) => {
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
  const env = applyVendorHomeEnv({ ...process.env }, mode, homeDir, botHome, { botId, screenContainer });
  env.PATH = stripPinchTabFromPath(env.PATH ?? "");
  delete env.DISPLAY;
  delete env.PINCHTAB_TOKEN;
  delete env.OPENBOT_PINCHTAB;
  delete env.OPENBOT_PINCHTAB_SERVER;
  return env;
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

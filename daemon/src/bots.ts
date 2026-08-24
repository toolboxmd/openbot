import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pickColor, pickShape, type EyesMode, type FaceShape } from "./face.ts";
import {
  isHarnessId,
  listHarnessesOnPath,
  loginHint,
  spawnSpec,
  type HarnessId,
  type HarnessInfo,
} from "./harness.ts";
import { AcpClient, isAuthError, isCancelled, spawnAcp, type AcpHandlers, type AssistantDelta, type PermissionPrompt } from "./acp.ts";
import type { SpawnSpec } from "./harness.ts";
import { NoopComputerRuntime, type ComputerRuntime, type DisplayHandle } from "./computer.ts";

export type MessageReceipt = "sent" | "delivered" | "read";

export type MessageReaction = {
  emoji: string;
  by: "user";
};

export type PublicMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  receipt?: MessageReceipt;
  replyTo?: string;
  reactions?: MessageReaction[];
};

export type PublicPermission = {
  title: string;
  description?: string;
  options: Array<{ optionId: string; name: string; kind?: string }>;
};

export type PublicBot = {
  id: string;
  name: string;
  harness: HarnessId | null;
  eyes: { color: string; shape: FaceShape; mode: EyesMode };
  write: boolean;
  zoom: boolean;
  display: number | null;
  permission: PublicPermission | null;
  needsYou: { reason: "login"; hint: string } | null;
  messages?: PublicMessage[];
};

export type AcpSession = {
  close(): void;
  pause?(): void;
  resume?(): void;
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
  write: boolean;
  zoom: boolean;
  display: DisplayHandle | null;
  eyesMode: EyesMode;
  needsYou: { reason: "login"; hint: string } | null;
  permission: (PermissionPrompt & PublicPermission) | null;
  messages: PublicMessage[];
  openAssistantId: string | null;
  turnSeq: number;
  client: AcpSession | null;
};

export type BotStoreDeps = {
  computer?: ComputerRuntime;
  spawnAcp?: (spec: SpawnSpec, cwd: string, handlers?: AcpHandlers) => AcpSession;
  listHarnesses?: () => HarnessInfo[];
};

function publicPermission(p: PermissionPrompt | null): PublicPermission | null {
  if (!p) return null;
  return { title: p.title, description: p.description, options: p.options };
}

export class BotStore {
  private bots = new Map<string, Bot>();
  private workspaceDir: string;
  private persistPath: string;
  private computer: ComputerRuntime;
  private spawnAcpFn: (spec: SpawnSpec, cwd: string, handlers?: AcpHandlers) => AcpSession;
  private listHarnessesFn: () => HarnessInfo[];
  private zoomedId: string | null = null;

  constructor(workspaceDir: string, deps: BotStoreDeps = {}) {
    this.workspaceDir = workspaceDir;
    this.computer = deps.computer ?? new NoopComputerRuntime();
    this.spawnAcpFn = deps.spawnAcp ?? spawnAcp;
    this.listHarnessesFn = deps.listHarnesses ?? listHarnessesOnPath;
    fs.mkdirSync(this.workspaceDir, { recursive: true });
    this.persistPath = path.join(this.workspaceDir, "bots.json");
    this.load();
  }

  close(): void {
    for (const bot of this.bots.values()) {
      bot.client?.close();
      bot.client = null;
    }
  }

  listHarnesses() {
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

  messages(id: string): {
    messages: PublicMessage[];
    write: boolean;
    permission: PublicPermission | null;
    needsYou: PublicBot["needsYou"];
  } | null {
    const bot = this.bots.get(id);
    if (!bot) return null;
    return {
      messages: bot.messages,
      write: bot.write,
      permission: publicPermission(bot.permission),
      needsYou: bot.needsYou,
    };
  }

  async create(name: string): Promise<PublicBot> {
    const trimmed = name.trim();
    if (!trimmed) throw Object.assign(new Error("name is required"), { status: 400 });
    const taken = [...this.bots.values()].map((b) => b.shape);
    const id = crypto.randomUUID();
    const display = await this.computer.allocate(id);
    const bot: Bot = {
      id,
      name: trimmed,
      color: pickColor(trimmed),
      shape: pickShape(trimmed, taken),
      harness: null,
      write: false,
      zoom: false,
      display,
      eyesMode: "idle",
      needsYou: null,
      permission: null,
      messages: [],
      openAssistantId: null,
      turnSeq: 0,
      client: null,
    };
    this.bots.set(id, bot);
    this.persist();
    return this.toPublic(bot, true);
  }

  zoom(id: string): PublicBot {
    const bot = this.require(id);
    if (this.zoomedId && this.zoomedId !== id) {
      this.unzoom(this.zoomedId);
    }
    if (this.zoomedId === id) return this.toPublic(bot, true);
    bot.client?.pause?.();
    bot.zoom = true;
    this.zoomedId = id;
    return this.toPublic(bot, true);
  }

  unzoom(id: string): PublicBot {
    const bot = this.require(id);
    if (this.zoomedId !== id) {
      bot.zoom = false;
      return this.toPublic(bot, true);
    }
    bot.client?.resume?.();
    bot.zoom = false;
    this.zoomedId = null;
    if (bot.needsYou || bot.permission) bot.eyesMode = "needs-you";
    else if (bot.write) bot.eyesMode = "write";
    else bot.eyesMode = "idle";
    return this.toPublic(bot, true);
  }

  async pickHarness(id: string, harness: string): Promise<PublicBot> {
    const bot = this.require(id);
    if (!isHarnessId(harness)) {
      throw Object.assign(new Error("unknown Harness"), { status: 400 });
    }
    if (!this.listHarnesses().some((item) => item.id === harness)) {
      throw Object.assign(new Error("Harness is not on PATH"), { status: 400 });
    }
    if (harness !== "codex") {
      throw Object.assign(new Error("Talk spawn is Codex-only in this slice"), { status: 400 });
    }
    bot.client?.close();
    bot.client = null;
    bot.harness = harness;
    bot.write = false;
    bot.permission = null;
    bot.needsYou = null;
    bot.eyesMode = "idle";

    const cwd = this.workspaceDir;
    let spec: SpawnSpec;
    try {
      spec = spawnSpec(harness);
    } catch (err) {
      if (this.spawnAcpFn === spawnAcp) {
        bot.eyesMode = "needs-you";
        bot.needsYou = { reason: "login", hint: loginHint(harness) };
        this.pushAssistant(bot, err instanceof Error ? err.message : loginHint(harness));
        return this.toPublic(bot, true);
      }
      spec = { command: "injected-acp", args: [], env: { ...process.env } };
    }

    let client: AcpSession;
    try {
      client = this.spawnAcpFn(spec, cwd, {
        onPermission: (prompt) => {
          bot.permission = prompt;
          bot.eyesMode = "needs-you";
        },
        onAssistant: (text, delta) => {
          this.applyAssistant(bot, text, delta);
        },
        onPromptWritten: () => {
          this.setUserReceipt(bot, "delivered");
        },
        onPromptFlushed: () => {
          this.setUserReceipt(bot, "read");
        },
      });
    } catch (err) {
      bot.eyesMode = "needs-you";
      bot.needsYou = { reason: "login", hint: loginHint(harness) };
      this.pushAssistant(bot, err instanceof Error ? err.message : loginHint(harness));
      return this.toPublic(bot, true);
    }

    bot.client = client;
    try {
      await client.initialize();
      await client.newSession(cwd);
      bot.eyesMode = "idle";
      bot.needsYou = null;
    } catch (err) {
      bot.eyesMode = "needs-you";
      bot.needsYou = { reason: "login", hint: loginHint(harness) };
      this.pushAssistant(
        bot,
        isAuthError(err) || isLikelyLogin(err)
          ? loginHint(harness)
          : err instanceof Error
            ? err.message
            : loginHint(harness),
      );
      client.close();
      bot.client = null;
    }
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
    if (bot.zoom || this.zoomedId === id) {
      throw Object.assign(new Error("Computer is zoomed"), { status: 409 });
    }
    if (bot.needsYou?.reason === "login" || !bot.client) {
      throw Object.assign(new Error(bot.needsYou?.hint ?? loginHint("codex")), { status: 409 });
    }
    const replyTarget = this.resolveReplyTarget(bot, replyTo);
    if (bot.write) {
      try {
        bot.client.cancel();
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
    bot.messages.push(userMessage);
    this.persist();
    bot.openAssistantId = null;
    bot.write = true;
    bot.eyesMode = "write";
    bot.permission = null;

    const client = bot.client;
    const turnAt = bot.messages.length;
    void (async () => {
      try {
        const reply = await client.prompt(talkPrompt(trimmed, replyTarget?.text));
        if (turnSeq !== bot.turnSeq) return;
        const assistants = bot.messages.slice(turnAt).filter((m) => m.role === "assistant" && m.text);
        if (assistants.length === 0) {
          this.pushAssistant(bot, reply || ".");
        }
      } catch (err) {
        if (turnSeq !== bot.turnSeq) return;
        if (isCancelled(err)) return;
        if (isAuthError(err) || isLikelyLogin(err)) {
          bot.eyesMode = "needs-you";
          bot.needsYou = { reason: "login", hint: loginHint("codex") };
          this.fillAssistant(bot, loginHint("codex"));
        } else {
          this.fillAssistant(bot, err instanceof Error ? err.message : "Harness error");
        }
      } finally {
        if (turnSeq !== bot.turnSeq) return;
        bot.openAssistantId = null;
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
    const msg = bot.messages.find((item) => item.id === messageId);
    if (!msg) throw Object.assign(new Error("message not found"), { status: 404 });
    const reactions = [...(msg.reactions ?? [])];
    const idx = reactions.findIndex((item) => item.emoji === trimmed && item.by === "user");
    if (idx >= 0) reactions.splice(idx, 1);
    else reactions.push({ emoji: trimmed, by: "user" });
    if (reactions.length) msg.reactions = reactions;
    else delete msg.reactions;
    this.persist();
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

  private require(id: string): Bot {
    const bot = this.bots.get(id);
    if (!bot) throw Object.assign(new Error("Bot not found"), { status: 404 });
    return bot;
  }

  private resolveReplyTarget(bot: Bot, replyTo: string | undefined): PublicMessage | null {
    if (replyTo === undefined) return null;
    const targetId = replyTo.trim();
    if (!targetId) throw Object.assign(new Error("replyTo is required"), { status: 400 });
    const target = bot.messages.find((item) => item.id === targetId);
    if (!target) throw Object.assign(new Error("reply target not found"), { status: 400 });
    return target;
  }

  private pushAssistant(bot: Bot, text: string): void {
    bot.openAssistantId = null;
    bot.messages.push({ id: crypto.randomUUID(), role: "assistant", text: capTalkBubble(text), createdAt: nowIso() });
    this.persist();
  }

  private applyAssistant(bot: Bot, text: string, delta?: AssistantDelta): void {
    const capped = capTalkBubble(text);
    const startNew = Boolean(delta?.start) || !bot.openAssistantId;
    if (startNew) {
      const id = crypto.randomUUID();
      bot.messages.push({ id, role: "assistant", text: capped, createdAt: nowIso() });
      bot.openAssistantId = id;
    } else {
      const msg = bot.messages.find((item) => item.id === bot.openAssistantId);
      if (msg) msg.text = capped;
    }
    if (delta?.done) bot.openAssistantId = null;
    this.persist();
  }

  private setUserReceipt(bot: Bot, next: MessageReceipt): void {
    for (let i = bot.messages.length - 1; i >= 0; i--) {
      const msg = bot.messages[i];
      if (msg.role === "user") {
        msg.receipt = advanceReceipt(msg.receipt, next);
        this.persist();
        return;
      }
    }
  }

  private fillAssistant(bot: Bot, text: string): void {
    if (bot.openAssistantId) {
      const msg = bot.messages.find((item) => item.id === bot.openAssistantId);
      if (msg) {
        msg.text = text;
        bot.openAssistantId = null;
        this.persist();
        return;
      }
    }
    this.pushAssistant(bot, text);
  }

  private toPublic(bot: Bot, withMessages: boolean): PublicBot {
    const mode: EyesMode = bot.write ? "write" : bot.eyesMode;
    const out: PublicBot = {
      id: bot.id,
      name: bot.name,
      harness: bot.harness,
      eyes: { color: bot.color, shape: bot.shape, mode },
      write: bot.zoom || bot.write,
      zoom: bot.zoom,
      display: bot.display?.display ?? null,
      permission: publicPermission(bot.permission),
      needsYou: bot.needsYou,
    };
    if (withMessages) out.messages = bot.messages;
    return out;
  }

  private persist(): void {
    const bots = [...this.bots.values()].map((bot) => ({
      id: bot.id,
      name: bot.name,
      color: bot.color,
      shape: bot.shape,
      harness: bot.harness,
      messages: bot.messages,
    }));
    try {
      fs.writeFileSync(this.persistPath, `${JSON.stringify({ bots }, null, 2)}\n`);
    } catch {
      /* persist is best-effort; Talk still holds the Bot in RAM */
    }
  }

  private load(): void {
    if (!fs.existsSync(this.persistPath)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.persistPath, "utf8"));
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object" || !("bots" in parsed)) return;
    const rows = (parsed as { bots?: unknown }).bots;
    if (!Array.isArray(rows)) return;
    for (const row of rows) {
      const bot = reviveBot(row);
      if (bot) this.bots.set(bot.id, bot);
    }
  }
}

function isLikelyLogin(err: unknown): boolean {
  return isAuthError(err) || /login|auth|not signed/i.test(String((err as Error)?.message ?? err));
}

const TALK_VOICE =
  "You are chatting in OpenBot. Reply like a person in iMessage. Send several short ACP agent messages (one or two sentences each). No markdown essays. No headings. No numbered dumps. No tool JSON or transcripts in chat. Code in a bubble is fine. Attach a screenshot only when it helps.";

export function talkPrompt(userText: string, replyToText?: string): string {
  const body = replyToText ? `Replying to: ${replyToText}\n\n${userText}` : userText;
  return `${TALK_VOICE}\n\n${body}`;
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

function reviveBot(row: unknown): Bot | null {
  if (!row || typeof row !== "object") return null;
  const rec = row as Record<string, unknown>;
  if (typeof rec.id !== "string" || typeof rec.name !== "string") return null;
  const messages = Array.isArray(rec.messages)
    ? rec.messages.map(reviveMessage).filter((item): item is PublicMessage => item != null)
    : [];
  return {
    id: rec.id,
    name: rec.name,
    color: typeof rec.color === "string" ? rec.color : pickColor(rec.name),
    shape: typeof rec.shape === "string" ? (rec.shape as FaceShape) : pickShape(rec.name, []),
    harness: typeof rec.harness === "string" && isHarnessId(rec.harness) ? rec.harness : null,
    write: false,
    zoom: false,
    display: null,
    eyesMode: "idle",
    needsYou: null,
    permission: null,
    messages,
    openAssistantId: null,
    turnSeq: 0,
    client: null,
  };
}

function reviveMessage(row: unknown): PublicMessage | null {
  if (!row || typeof row !== "object") return null;
  const rec = row as Record<string, unknown>;
  if (typeof rec.id !== "string") return null;
  if (rec.role !== "user" && rec.role !== "assistant") return null;
  if (typeof rec.text !== "string") return null;
  const msg: PublicMessage = {
    id: rec.id,
    role: rec.role,
    text: rec.text,
    createdAt: typeof rec.createdAt === "string" ? rec.createdAt : new Date().toISOString(),
  };
  if (rec.receipt === "sent" || rec.receipt === "delivered" || rec.receipt === "read") msg.receipt = rec.receipt;
  if (typeof rec.replyTo === "string" && rec.replyTo) msg.replyTo = rec.replyTo;
  if (Array.isArray(rec.reactions)) {
    const reactions = rec.reactions.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const emoji = (item as { emoji?: unknown }).emoji;
      const by = (item as { by?: unknown }).by;
      if (typeof emoji !== "string" || !emoji.trim()) return [];
      if (by !== "user") return [];
      return [{ emoji, by: "user" as const }];
    });
    if (reactions.length) msg.reactions = reactions;
  }
  return msg;
}

export function defaultWorkspaceDir(): string {
  return path.resolve(process.cwd(), "workspace");
}

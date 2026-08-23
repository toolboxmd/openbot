import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pickColor, pickShape, SHAPES, type EyesMode, type FaceShape } from "./face.ts";
import {
  isHarnessId,
  listHarnessesOnPath,
  loginHint,
  spawnSpec,
  type HarnessId,
  type HarnessInfo,
} from "./harness.ts";
import { isAuthError, spawnAcp, type AcpHandlers, type PermissionPrompt } from "./acp.ts";
import type { SpawnSpec } from "./harness.ts";
import { NoopScreenRuntime, type ScreenRuntime } from "./screens.ts";

export type PublicMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
};

export type PublicPermission = {
  title: string;
  description?: string;
  options: Array<{ optionId: string; name: string; kind?: string }>;
};

export type ScreenState = "asleep" | "waking" | "active";

export type PublicBot = {
  id: string;
  name: string;
  harness: HarnessId | null;
  screen: ScreenState;
  eyes: { color: string; shape: FaceShape; mode: EyesMode };
  write: boolean;
  permission: PublicPermission | null;
  needsYou: { reason: "login"; hint: string } | null;
  messages?: PublicMessage[];
};

export type AcpSession = {
  close(): void;
  initialize(): Promise<unknown>;
  newSession(cwd: string): Promise<unknown>;
  prompt(text: string): Promise<string>;
  respondPermission(rpcId: PermissionPrompt["rpcId"], optionId: string): void;
};

type Bot = {
  id: string;
  name: string;
  color: string;
  shape: FaceShape;
  harness: HarnessId | null;
  screen: ScreenState;
  write: boolean;
  eyesMode: EyesMode;
  needsYou: { reason: "login"; hint: string } | null;
  permission: (PermissionPrompt & PublicPermission) | null;
  messages: PublicMessage[];
  client: AcpSession | null;
};

type PersistedBot = {
  id: string;
  name: string;
  color: string;
  shape: FaceShape;
  harness: HarnessId | null;
  messages: PublicMessage[];
};

export type BotStoreDeps = {
  screens?: ScreenRuntime;
  spawnAcp?: (spec: SpawnSpec, cwd: string, handlers?: AcpHandlers) => AcpSession;
  listHarnesses?: () => HarnessInfo[];
};

function publicPermission(p: PermissionPrompt | null): PublicPermission | null {
  if (!p) return null;
  return { title: p.title, description: p.description, options: p.options };
}

function isFaceShape(value: unknown): value is FaceShape {
  return typeof value === "string" && (SHAPES as readonly string[]).includes(value);
}

function visibleMessages(messages: PublicMessage[]): PublicMessage[] {
  return messages.filter((message) => !(message.role === "assistant" && message.text === ""));
}

function parseMessages(raw: unknown): PublicMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: PublicMessage[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.id !== "string" || !rec.id) continue;
    if (rec.role !== "user" && rec.role !== "assistant") continue;
    if (typeof rec.text !== "string") continue;
    if (rec.role === "assistant" && rec.text === "") continue;
    out.push({ id: rec.id, role: rec.role, text: rec.text });
  }
  return out;
}

function parsePersistedBot(raw: unknown): PersistedBot | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.id !== "string" || !rec.id) return null;
  if (typeof rec.name !== "string" || !rec.name.trim()) return null;
  if (typeof rec.color !== "string" || !rec.color) return null;
  if (!isFaceShape(rec.shape)) return null;
  let harness: HarnessId | null = null;
  if (typeof rec.harness === "string" && isHarnessId(rec.harness)) harness = rec.harness;
  return {
    id: rec.id,
    name: rec.name.trim(),
    color: rec.color,
    shape: rec.shape,
    harness,
    messages: parseMessages(rec.messages),
  };
}

export class BotStore {
  private bots = new Map<string, Bot>();
  private workspaceDir: string;
  private botsFile: string;
  private screens: ScreenRuntime;
  private spawnAcpFn: (spec: SpawnSpec, cwd: string, handlers?: AcpHandlers) => AcpSession;
  private listHarnessesFn: () => HarnessInfo[];

  constructor(workspaceDir: string, deps: BotStoreDeps = {}) {
    this.workspaceDir = workspaceDir;
    this.botsFile = path.join(this.workspaceDir, "bots.json");
    this.screens = deps.screens ?? new NoopScreenRuntime();
    this.spawnAcpFn = deps.spawnAcp ?? spawnAcp;
    this.listHarnessesFn = deps.listHarnesses ?? listHarnessesOnPath;
    fs.mkdirSync(this.workspaceDir, { recursive: true });
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

  activeId(): string | null {
    for (const bot of this.bots.values()) {
      if (bot.screen === "active" || bot.screen === "waking") return bot.id;
    }
    return null;
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

  create(name: string): PublicBot {
    const trimmed = name.trim();
    if (!trimmed) throw Object.assign(new Error("name is required"), { status: 400 });
    const taken = [...this.bots.values()].map((b) => b.shape);
    const id = crypto.randomUUID();
    const bot: Bot = {
      id,
      name: trimmed,
      color: pickColor(trimmed),
      shape: pickShape(trimmed, taken),
      harness: null,
      screen: "asleep",
      write: false,
      eyesMode: "sleep",
      needsYou: null,
      permission: null,
      messages: [],
      client: null,
    };
    this.bots.set(id, bot);
    this.persist();
    return this.toPublic(bot, true);
  }

  async sleep(id: string): Promise<PublicBot> {
    const bot = this.require(id);
    this.killChild(bot);
    bot.write = false;
    bot.permission = null;
    bot.screen = "asleep";
    bot.eyesMode = "sleep";
    await this.screens.sleep(id);
    this.persist();
    return this.toPublic(bot, true);
  }

  async wake(id: string): Promise<PublicBot> {
    const bot = this.require(id);
    const others = [...this.bots.values()].filter((other) => other.id !== id && other.screen !== "asleep");
    for (const other of others) {
      await this.sleep(other.id);
    }
    bot.screen = "waking";
    bot.eyesMode = "waking";
    this.persist();
    await this.screens.wake(id);
    bot.screen = "active";
    bot.eyesMode = bot.needsYou ? "needs-you" : "idle";
    if (bot.harness === "codex" && !bot.client) {
      await this.connectHarness(bot);
    }
    this.persist();
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
    this.killChild(bot);
    bot.harness = harness;
    bot.write = false;
    bot.permission = null;
    bot.needsYou = null;
    bot.eyesMode = bot.screen === "asleep" ? "sleep" : "idle";
    this.persist();
    if (bot.screen === "asleep") {
      return this.toPublic(bot, true);
    }
    await this.connectHarness(bot);
    return this.toPublic(bot, true);
  }

  async send(id: string, text: string): Promise<PublicBot> {
    const bot = this.require(id);
    const trimmed = text.trim();
    if (!trimmed) throw Object.assign(new Error("text is required"), { status: 400 });
    if (!bot.harness) throw Object.assign(new Error("pick a Harness first"), { status: 400 });
    if (bot.harness !== "codex") {
      throw Object.assign(new Error("Talk spawn is Codex-only in this slice"), { status: 400 });
    }
    if (bot.screen === "asleep") {
      throw Object.assign(new Error("Wake this Bot first"), { status: 409 });
    }
    if (bot.write) throw Object.assign(new Error("turn already in flight"), { status: 409 });
    if (bot.needsYou?.reason === "login" || !bot.client) {
      throw Object.assign(new Error(bot.needsYou?.hint ?? loginHint("codex")), { status: 409 });
    }

    bot.messages.push({ id: crypto.randomUUID(), role: "user", text: trimmed });
    bot.messages.push({ id: crypto.randomUUID(), role: "assistant", text: "" });
    bot.write = true;
    bot.eyesMode = "write";
    bot.permission = null;
    this.persist();

    const client = bot.client;
    void (async () => {
      try {
        const reply = await client.prompt(trimmed);
        this.fillAssistant(bot, reply || ".");
      } catch (err) {
        if (isAuthError(err) || isLikelyLogin(err)) {
          bot.eyesMode = "needs-you";
          bot.needsYou = { reason: "login", hint: loginHint("codex") };
          this.fillAssistant(bot, loginHint("codex"));
        } else {
          this.fillAssistant(bot, err instanceof Error ? err.message : "Harness error");
        }
      } finally {
        bot.write = false;
        if (bot.eyesMode === "write") {
          bot.eyesMode = bot.needsYou ? "needs-you" : bot.screen === "asleep" ? "sleep" : "idle";
        }
        bot.permission = null;
        this.persist();
      }
    })();

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
    bot.eyesMode = bot.write ? "write" : bot.screen === "asleep" ? "sleep" : "idle";
    bot.client.respondPermission(rpcId, optionId);
    return this.toPublic(bot, true);
  }

  private killChild(bot: Bot): void {
    bot.client?.close();
    bot.client = null;
    bot.write = false;
  }

  private async connectHarness(bot: Bot): Promise<void> {
    if (bot.harness !== "codex") return;
    const cwd = this.workspaceDir;
    let spec;
    try {
      spec = spawnSpec(bot.harness);
    } catch (err) {
      if (this.spawnAcpFn === spawnAcp) {
        bot.eyesMode = bot.screen === "asleep" ? "sleep" : "needs-you";
        bot.needsYou = { reason: "login", hint: loginHint("codex") };
        this.pushAssistant(bot, err instanceof Error ? err.message : loginHint("codex"));
        return;
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
        onAssistant: (text) => {
          const last = bot.messages[bot.messages.length - 1];
          if (last && last.role === "assistant" && bot.write) {
            last.text = text;
          }
        },
      });
    } catch (err) {
      bot.eyesMode = bot.screen === "asleep" ? "sleep" : "needs-you";
      bot.needsYou = { reason: "login", hint: loginHint("codex") };
      this.pushAssistant(bot, err instanceof Error ? err.message : loginHint("codex"));
      return;
    }

    bot.client = client;
    try {
      await client.initialize();
      await client.newSession(cwd);
      bot.eyesMode = bot.screen === "waking" ? "waking" : bot.screen === "asleep" ? "sleep" : "idle";
      bot.needsYou = null;
    } catch (err) {
      bot.eyesMode = "needs-you";
      bot.needsYou = { reason: "login", hint: loginHint("codex") };
      this.pushAssistant(
        bot,
        isAuthError(err) || isLikelyLogin(err)
          ? loginHint("codex")
          : err instanceof Error
            ? err.message
            : loginHint("codex"),
      );
      client.close();
      bot.client = null;
    }
  }

  private load(): void {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.botsFile, "utf8"));
    } catch {
      return;
    }
    if (!Array.isArray(raw)) return;
    for (const item of raw) {
      const record = parsePersistedBot(item);
      if (!record) continue;
      if (this.bots.has(record.id)) continue;
      const running = this.screens.running(record.id);
      const bot: Bot = {
        id: record.id,
        name: record.name,
        color: record.color,
        shape: record.shape,
        harness: record.harness,
        screen: running ? "active" : "asleep",
        write: false,
        eyesMode: running ? "idle" : "sleep",
        needsYou: null,
        permission: null,
        messages: record.messages,
        client: null,
      };
      this.bots.set(bot.id, bot);
    }
  }

  private persist(): void {
    const records: PersistedBot[] = [...this.bots.values()].map((bot) => ({
      id: bot.id,
      name: bot.name,
      color: bot.color,
      shape: bot.shape,
      harness: bot.harness,
      messages: visibleMessages(bot.messages),
    }));
    const tmp = `${this.botsFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(records, null, 2)}\n`);
    fs.renameSync(tmp, this.botsFile);
  }

  private require(id: string): Bot {
    const bot = this.bots.get(id);
    if (!bot) throw Object.assign(new Error("Bot not found"), { status: 404 });
    return bot;
  }

  private pushAssistant(bot: Bot, text: string): void {
    bot.messages.push({ id: crypto.randomUUID(), role: "assistant", text });
    this.persist();
  }

  private fillAssistant(bot: Bot, text: string): void {
    const last = bot.messages[bot.messages.length - 1];
    if (last && last.role === "assistant") {
      last.text = text;
      this.persist();
      return;
    }
    this.pushAssistant(bot, text);
  }

  private toPublic(bot: Bot, withMessages: boolean): PublicBot {
    let mode: EyesMode = bot.eyesMode;
    if (bot.screen === "asleep") mode = "sleep";
    else if (bot.screen === "waking") mode = "waking";
    else if (bot.write) mode = "write";
    const out: PublicBot = {
      id: bot.id,
      name: bot.name,
      harness: bot.harness,
      screen: bot.screen,
      eyes: { color: bot.color, shape: bot.shape, mode },
      write: bot.write,
      permission: publicPermission(bot.permission),
      needsYou: bot.needsYou,
    };
    if (withMessages) out.messages = bot.messages;
    return out;
  }
}

function isLikelyLogin(err: unknown): boolean {
  return isAuthError(err) || /login|auth|not signed/i.test(String((err as Error)?.message ?? err));
}

export function defaultWorkspaceDir(): string {
  return path.resolve(process.cwd(), "workspace");
}

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
} from "./harness.ts";
import { AcpClient, isAuthError, spawnAcp, type PermissionPrompt } from "./acp.ts";

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

export type PublicBot = {
  id: string;
  name: string;
  harness: HarnessId | null;
  eyes: { color: string; shape: FaceShape; mode: EyesMode };
  write: boolean;
  permission: PublicPermission | null;
  needsYou: { reason: "login"; hint: string } | null;
  messages?: PublicMessage[];
};

type Bot = {
  id: string;
  name: string;
  color: string;
  shape: FaceShape;
  harness: HarnessId | null;
  write: boolean;
  eyesMode: EyesMode;
  needsYou: { reason: "login"; hint: string } | null;
  permission: (PermissionPrompt & PublicPermission) | null;
  messages: PublicMessage[];
  client: AcpClient | null;
};

function publicPermission(p: PermissionPrompt | null): PublicPermission | null {
  if (!p) return null;
  return { title: p.title, description: p.description, options: p.options };
}

export class BotStore {
  private bots = new Map<string, Bot>();
  private workspaceDir: string;

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
    fs.mkdirSync(this.workspaceDir, { recursive: true });
  }

  close(): void {
    for (const bot of this.bots.values()) {
      bot.client?.close();
      bot.client = null;
    }
  }

  listHarnesses() {
    return listHarnessesOnPath();
  }

  list(): PublicBot[] {
    return [...this.bots.values()].map((bot) => this.toPublic(bot, false));
  }

  get(id: string): PublicBot | null {
    const bot = this.bots.get(id);
    return bot ? this.toPublic(bot, true) : null;
  }

  messages(id: string): { messages: PublicMessage[]; write: boolean; permission: PublicPermission | null; needsYou: PublicBot["needsYou"] } | null {
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
      write: false,
      eyesMode: "idle",
      needsYou: null,
      permission: null,
      messages: [],
      client: null,
    };
    this.bots.set(id, bot);
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
    let client: AcpClient;
    try {
      client = spawnAcp(spawnSpec(harness), cwd, {
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
      this.pushAssistant(bot, isAuthError(err) || isLikelyLogin(err) ? loginHint(harness) : err instanceof Error ? err.message : loginHint(harness));
      client.close();
      bot.client = null;
    }
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
    if (bot.write) throw Object.assign(new Error("turn already in flight"), { status: 409 });
    if (bot.needsYou?.reason === "login" || !bot.client) {
      throw Object.assign(new Error(bot.needsYou?.hint ?? loginHint("codex")), { status: 409 });
    }

    bot.messages.push({ id: crypto.randomUUID(), role: "user", text: trimmed });
    bot.messages.push({ id: crypto.randomUUID(), role: "assistant", text: "" });
    bot.write = true;
    bot.eyesMode = "write";
    bot.permission = null;

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
        if (bot.eyesMode === "write") bot.eyesMode = bot.needsYou ? "needs-you" : "idle";
        bot.permission = null;
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
    bot.eyesMode = bot.write ? "write" : "idle";
    bot.client.respondPermission(rpcId, optionId);
    return this.toPublic(bot, true);
  }

  private require(id: string): Bot {
    const bot = this.bots.get(id);
    if (!bot) throw Object.assign(new Error("Bot not found"), { status: 404 });
    return bot;
  }

  private pushAssistant(bot: Bot, text: string): void {
    bot.messages.push({ id: crypto.randomUUID(), role: "assistant", text });
  }

  private fillAssistant(bot: Bot, text: string): void {
    const last = bot.messages[bot.messages.length - 1];
    if (last && last.role === "assistant") {
      last.text = text;
      return;
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

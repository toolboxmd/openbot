import crypto from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { BotStore, type BotStoreDeps } from "./bots.ts";
import { defaultHomeDir, defaultWorkspaceDir, type ChannelCursor } from "./home.ts";
import { NoopComputerRuntime, type ComputerRuntime } from "./computer.ts";
import { kasmUpdateWrite } from "./kasm.ts";

export type BoxOptions = {
  password: string;
  pwaDir: string;
  host?: string;
  port?: number;
  screenUpstream?: string;
  kasmUser?: string;
  kasmPassword?: string;
  homeDir?: string;
  workspaceDir?: string;
  computer?: ComputerRuntime;
} & Pick<BotStoreDeps, "spawnAcp" | "listHarnesses">;

export type RunningBox = {
  url: string;
  port: number;
  close: () => Promise<void>;
};

const COOKIE = "openbot";
const MAX_AGE = 60 * 60 * 24 * 30;
const SCREEN_PREFIX = "/screen";

const MIME: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
};

function passwordsEqual(given: string, expected: string): boolean {
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function sign(payload: string, key: Buffer): string {
  const sig = crypto.createHmac("sha256", key).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

function verify(token: string, key: Buffer): boolean {
  const cut = token.lastIndexOf(".");
  if (cut <= 0) return false;
  const payload = token.slice(0, cut);
  const sig = token.slice(cut + 1);
  const expected = crypto.createHmac("sha256", key).update(payload).digest("base64url");
  const left = Buffer.from(sig);
  const right = Buffer.from(expected);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function readChannelCursor(value: unknown): ChannelCursor {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { sequence: Number.NaN, revision: Number.NaN };
  }
  const cursor = value as Record<string, unknown>;
  return {
    sequence: typeof cursor.sequence === "number" ? cursor.sequence : Number.NaN,
    revision: typeof cursor.revision === "number" ? cursor.revision : Number.NaN,
  };
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  data: unknown,
  headers: Record<string, string | number | string[]> = {},
): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

function hasSession(req: http.IncomingMessage, key: Buffer): boolean {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  return Boolean(token && verify(token, key));
}

function isScreenPath(pathname: string): boolean {
  return pathname === SCREEN_PREFIX || pathname.startsWith(`${SCREEN_PREFIX}/`);
}

function parseScreenPath(
  pathname: string,
  isBotId: (id: string) => boolean,
): { botId: string | null; rest: string } {
  if (pathname === SCREEN_PREFIX || pathname === `${SCREEN_PREFIX}/`) {
    return { botId: null, rest: "/" };
  }
  if (!pathname.startsWith(`${SCREEN_PREFIX}/`)) return { botId: null, rest: "/" };
  const rest = pathname.slice(SCREEN_PREFIX.length + 1);
  if (!rest) return { botId: null, rest: "/" };
  const cut = rest.indexOf("/");
  const first = decodeURIComponent(cut === -1 ? rest : rest.slice(0, cut));
  const tail = cut === -1 || cut === rest.length - 1 ? "/" : rest.slice(cut);
  if (first === "websockify") return { botId: null, rest: `/${rest}` };
  // Kasm 1.5 serves hashed UI under /assets. Only a real Bot id is a display prefix.
  if (isBotId(first)) return { botId: first, rest: tail || "/" };
  return { botId: null, rest: `/${rest}` };
}

function kasmAuthorization(options: BoxOptions): string | undefined {
  if (!options.kasmUser || options.kasmPassword === undefined) return undefined;
  return `Basic ${Buffer.from(`${options.kasmUser}:${options.kasmPassword}`).toString("base64")}`;
}

function requestFor(url: URL) {
  return url.protocol === "https:" ? https.request : http.request;
}

function copyHeaders(
  source: http.IncomingHttpHeaders,
  skip: string[],
): http.OutgoingHttpHeaders {
  const blocked = new Set(skip.map((name) => name.toLowerCase()));
  const out: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (blocked.has(key.toLowerCase())) continue;
    out[key] = value;
  }
  return out;
}

function proxyHttp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  dest: URL,
  auth: string | undefined,
): void {
  const headers = copyHeaders(req.headers, [
    "host",
    "cookie",
    "authorization",
    "connection",
    "keep-alive",
    "proxy-connection",
  ]);
  headers.host = dest.host;
  if (auth) headers.authorization = auth;

  const upstream = requestFor(dest)(
    dest,
    { method: req.method, headers },
    (upstreamRes) => {
      const out = copyHeaders(upstreamRes.headers, [
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailers",
        "transfer-encoding",
        "upgrade",
        "www-authenticate",
        // Kasm sets these for a top-level VNC page. Inside Talk's iframe they
        // isolate the client without giving it SharedArrayBuffer, and COEP
        // require-corp can stall the noVNC UI.
        "cross-origin-embedder-policy",
        "cross-origin-opener-policy",
        "cross-origin-resource-policy",
      ]);
      res.writeHead(upstreamRes.statusCode ?? 502, out);
      upstreamRes.pipe(res);
    },
  );
  upstream.on("error", () => {
    if (!res.headersSent) sendJson(res, 502, { error: "Screen is unreachable" });
    else res.destroy();
  });
  req.pipe(upstream);
}

function proxyUpgrade(
  req: http.IncomingMessage,
  socket: import("node:stream").Duplex,
  head: Buffer,
  dest: URL,
  auth: string | undefined,
): void {
  const headers = copyHeaders(req.headers, ["host", "cookie", "authorization"]);
  headers.host = dest.host;
  if (auth) headers.authorization = auth;

  const upstream = requestFor(dest)(dest, { method: "GET", headers });
  upstream.on("upgrade", (upstreamRes, upstreamSocket, upstreamHead) => {
    const lines = [`HTTP/1.1 ${upstreamRes.statusCode ?? 101} ${upstreamRes.statusMessage ?? "Switching Protocols"}`];
    for (const [key, value] of Object.entries(upstreamRes.headers)) {
      if (key.toLowerCase() === "www-authenticate") continue;
      if (value === undefined) continue;
      const rendered = Array.isArray(value) ? value : [value];
      for (const item of rendered) lines.push(`${key}: ${item}`);
    }
    socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head.length) upstreamSocket.write(head);
    if (upstreamHead.length) socket.write(upstreamHead);
    upstreamSocket.pipe(socket);
    socket.pipe(upstreamSocket);
  });
  upstream.on("error", () => {
    socket.destroy();
  });
  upstream.on("response", (upstreamRes) => {
    const lines = [`HTTP/1.1 ${upstreamRes.statusCode ?? 502} ${upstreamRes.statusMessage ?? "Error"}`];
    for (const [key, value] of Object.entries(upstreamRes.headers)) {
      if (key.toLowerCase() === "www-authenticate") continue;
      if (value === undefined) continue;
      const rendered = Array.isArray(value) ? value : [value];
      for (const item of rendered) lines.push(`${key}: ${item}`);
    }
    socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    upstreamRes.pipe(socket);
  });
  upstream.end();
}

async function servePwa(
  pwaDir: string,
  urlPath: string,
  res: http.ServerResponse,
): Promise<void> {
  const decoded = decodeURIComponent(urlPath.split("?")[0] || "/");
  const root = path.resolve(pwaDir);
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const target = path.resolve(root, relative);
  const inside = target === root || target.startsWith(root + path.sep);
  if (!inside) {
    sendJson(res, 400, { error: "bad path" });
    return;
  }

  try {
    const stat = await fs.stat(target);
    const file = stat.isDirectory() ? path.join(target, "index.html") : target;
    const bytes = await fs.readFile(file);
    const ext = path.extname(file);
    res.writeHead(200, {
      "Content-Type": MIME[ext] ?? "application/octet-stream",
      "Content-Length": bytes.length,
    });
    res.end(bytes);
    return;
  } catch {
    if (path.extname(relative)) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
  }

  try {
    const bytes = await fs.readFile(path.join(root, "index.html"));
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": bytes.length,
    });
    res.end(bytes);
  } catch {
    sendJson(res, 404, { error: "PWA is not built" });
  }
}

/** node:http only. Do not fetch+AbortSignal against Kasm (undici can crash the host). */
export function screenIsReachable(
  upstream: string | undefined,
  auth: string | undefined,
): Promise<boolean> {
  if (!upstream) return Promise.resolve(false);

  let dest: URL;
  try {
    dest = new URL(upstream);
  } catch {
    return Promise.resolve(false);
  }
  if (dest.protocol !== "http:" && dest.protocol !== "https:") {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };

    const headers: http.OutgoingHttpHeaders = {
      host: dest.host,
      connection: "close",
    };
    if (auth) headers.authorization = auth;

    let req: http.ClientRequest;
    try {
      req = requestFor(dest)(dest, {
        method: "GET",
        headers,
        timeout: 750,
      });
    } catch {
      done(false);
      return;
    }

    const kill = () => {
      try {
        req.destroy();
      } catch {
        // ignore
      }
    };

    req.setTimeout(750, () => {
      kill();
      done(false);
    });
    req.on("response", (res) => {
      res.resume();
      kill();
      done(true);
    });
    req.on("timeout", () => {
      kill();
      done(false);
    });
    req.on("error", () => {
      done(false);
    });
    req.on("socket", (socket) => {
      socket.setTimeout(750, () => {
        kill();
        done(false);
      });
    });
    try {
      req.end();
    } catch {
      kill();
      done(false);
    }
  });
}

function sendStoreError(res: http.ServerResponse, err: unknown): void {
  const status = typeof (err as { status?: unknown })?.status === "number" ? (err as { status: number }).status : 500;
  const message = err instanceof Error ? err.message : "box error";
  sendJson(res, status, { error: message });
}

export async function startBox(options: BoxOptions): Promise<RunningBox> {
  const host = options.host ?? "0.0.0.0";
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(options.password, salt, 32);
  const auth = kasmAuthorization(options);
  const computer: ComputerRuntime =
    options.computer ?? new NoopComputerRuntime(undefined, options.screenUpstream);
  const homeDir = path.resolve(options.homeDir ?? defaultHomeDir());
  const workspaceDir = path.resolve(options.workspaceDir ?? defaultWorkspaceDir(homeDir));
  fsSync.mkdirSync(workspaceDir, { recursive: true });
  const store = new BotStore(homeDir, {
    computer,
    spawnAcp: options.spawnAcp,
    listHarnesses: options.listHarnesses,
    workspaceDir,
  });
  await store.reattachDisplays();

  function upstreamFor(botId: string | null): string | undefined {
    if (botId && computer.upstream(botId)) return computer.upstream(botId);
    return computer.computerUpstream() ?? options.screenUpstream;
  }

  async function applyKasmWrite(botId: string | null, write: boolean): Promise<void> {
    if (!options.kasmUser || options.kasmPassword === undefined) return;
    const upstream = upstreamFor(botId);
    if (!upstream) return;
    await kasmUpdateWrite({
      upstream,
      user: options.kasmUser,
      password: options.kasmPassword,
      name: options.kasmUser,
      write,
    });
  }

  const server = http.createServer((req, res) => {
    void handle(req, res);
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
      const method = req.method ?? "GET";

      if (url.pathname === "/api/session" && method === "POST") {
        let body: { password?: unknown } = {};
        try {
          const raw = await readBody(req);
          body = raw ? (JSON.parse(raw) as { password?: unknown }) : {};
        } catch {
          sendJson(res, 400, { error: "invalid json" });
          return;
        }
        const given = typeof body.password === "string" ? body.password : "";
        if (!passwordsEqual(given, options.password)) {
          sendJson(res, 401, { error: "wrong Password" });
          return;
        }
        const token = sign(`v1.${Date.now()}`, key);
        sendJson(
          res,
          200,
          { ok: true },
          {
            "Set-Cookie": `${COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${MAX_AGE}`,
          },
        );
        return;
      }

      if (url.pathname === "/api/session" && method === "GET") {
        if (!hasSession(req, key)) {
          sendJson(res, 401, { error: "unauthenticated" });
          return;
        }
        sendJson(res, 200, { ok: true });
        return;
      }

      if (url.pathname === "/api/agents" && method === "GET") {
        if (!hasSession(req, key)) {
          sendJson(res, 401, { error: "unauthenticated" });
          return;
        }
        sendJson(res, 200, { text: store.readAllBotsAgents() });
        return;
      }

      if (url.pathname === "/api/agents" && method === "PUT") {
        if (!hasSession(req, key)) {
          sendJson(res, 401, { error: "unauthenticated" });
          return;
        }
        let body: Record<string, unknown> = {};
        try {
          const raw = await readBody(req);
          body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        } catch {
          sendJson(res, 400, { error: "invalid json" });
          return;
        }
        const text = typeof body.text === "string" ? body.text : "";
        sendJson(res, 200, { text: store.writeAllBotsAgents(text) });
        return;
      }

      if (url.pathname === "/api/host-grants" && method === "GET") {
        if (!hasSession(req, key)) {
          sendJson(res, 401, { error: "unauthenticated" });
          return;
        }
        sendJson(res, 200, { grants: store.listHostGrants() });
        return;
      }

      if (url.pathname === "/api/harnesses" && method === "GET") {
        if (!hasSession(req, key)) {
          sendJson(res, 401, { error: "unauthenticated" });
          return;
        }
        sendJson(res, 200, { harnesses: store.listHarnesses() });
        return;
      }

      if (url.pathname === "/api/bots" && method === "GET") {
        if (!hasSession(req, key)) {
          sendJson(res, 401, { error: "unauthenticated" });
          return;
        }
        sendJson(res, 200, { bots: store.list() });
        return;
      }

      if (url.pathname === "/api/inbox" && method === "GET") {
        if (!hasSession(req, key)) {
          sendJson(res, 401, { error: "unauthenticated" });
          return;
        }
        sendJson(res, 200, store.inbox());
        return;
      }

      if (url.pathname === "/api/bots" && method === "POST") {
        if (!hasSession(req, key)) {
          sendJson(res, 401, { error: "unauthenticated" });
          return;
        }
        let body: Record<string, unknown> = {};
        try {
          const raw = await readBody(req);
          body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        } catch {
          sendJson(res, 400, { error: "invalid json" });
          return;
        }
        try {
          const name = typeof body.name === "string" ? body.name : "";
          const bot = await store.create(name);
          sendJson(res, 201, bot);
        } catch (err) {
          sendStoreError(res, err);
        }
        return;
      }

      if (url.pathname === "/api/channels" && method === "GET") {
        if (!hasSession(req, key)) {
          sendJson(res, 401, { error: "unauthenticated" });
          return;
        }
        sendJson(res, 200, { channels: store.listChannels() });
        return;
      }

      if (url.pathname === "/api/channels" && method === "POST") {
        if (!hasSession(req, key)) {
          sendJson(res, 401, { error: "unauthenticated" });
          return;
        }
        let body: Record<string, unknown> = {};
        try {
          const raw = await readBody(req);
          body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        } catch {
          sendJson(res, 400, { error: "invalid json" });
          return;
        }
        if (body.kind !== "group") {
          sendJson(res, 400, { error: "kind must be group" });
          return;
        }
        try {
          const channel = store.createGroup({ title: body.title, botIds: body.botIds });
          sendJson(res, 201, channel);
        } catch (err) {
          sendStoreError(res, err);
        }
        return;
      }

      const channelMessagesMatch = url.pathname.match(/^\/api\/channels\/([^/]+)\/messages$/);
      if (channelMessagesMatch && method === "POST") {
        if (!hasSession(req, key)) {
          sendJson(res, 401, { error: "unauthenticated" });
          return;
        }
        const channelId = decodeURIComponent(channelMessagesMatch[1]);
        const channel = store.getChannel(channelId);
        if (!channel) {
          sendJson(res, 404, { error: "Channel not found" });
          return;
        }
        sendJson(res, 400, { error: "send is not available in a group Channel" });
        return;
      }

      const channelReadMatch = url.pathname.match(/^\/api\/channels\/([^/]+)\/read$/);
      if (channelReadMatch && method === "POST") {
        if (!hasSession(req, key)) {
          sendJson(res, 401, { error: "unauthenticated" });
          return;
        }
        let body: Record<string, unknown> = {};
        try {
          const raw = await readBody(req);
          body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        } catch {
          sendJson(res, 400, { error: "invalid json" });
          return;
        }
        const cursor = readChannelCursor(body.cursor);
        try {
          const activity = store.markChannelRead(decodeURIComponent(channelReadMatch[1]), cursor);
          sendJson(res, 200, { activity });
        } catch (err) {
          sendStoreError(res, err);
        }
        return;
      }

      const channelMatch = url.pathname.match(/^\/api\/channels\/([^/]+)$/);
      if (channelMatch && method === "GET") {
        if (!hasSession(req, key)) {
          sendJson(res, 401, { error: "unauthenticated" });
          return;
        }
        const channel = store.getChannel(decodeURIComponent(channelMatch[1]));
        if (!channel) {
          sendJson(res, 404, { error: "Channel not found" });
          return;
        }
        sendJson(res, 200, channel);
        return;
      }

      const reactionMatch = url.pathname.match(/^\/api\/bots\/([^/]+)\/messages\/([^/]+)\/reactions$/);
      if (reactionMatch && method === "POST") {
        if (!hasSession(req, key)) {
          sendJson(res, 401, { error: "unauthenticated" });
          return;
        }
        let body: Record<string, unknown> = {};
        try {
          const raw = await readBody(req);
          body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        } catch {
          sendJson(res, 400, { error: "invalid json" });
          return;
        }
        try {
          const emoji = typeof body.emoji === "string" ? body.emoji : "";
          const bot = store.toggleReaction(
            decodeURIComponent(reactionMatch[1]),
            decodeURIComponent(reactionMatch[2]),
            emoji,
          );
          sendJson(res, 200, bot);
        } catch (err) {
          sendStoreError(res, err);
        }
        return;
      }

      const botReadMatch = url.pathname.match(/^\/api\/bots\/([^/]+)\/read$/);
      if (botReadMatch && method === "POST") {
        if (!hasSession(req, key)) {
          sendJson(res, 401, { error: "unauthenticated" });
          return;
        }
        let body: Record<string, unknown> = {};
        try {
          const raw = await readBody(req);
          body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        } catch {
          sendJson(res, 400, { error: "invalid json" });
          return;
        }
        const cursor = readChannelCursor(body.cursor);
        try {
          const activity = store.markBotRead(decodeURIComponent(botReadMatch[1]), cursor);
          sendJson(res, 200, { activity });
        } catch (err) {
          sendStoreError(res, err);
        }
        return;
      }

      const messagesMatch = url.pathname.match(/^\/api\/bots\/([^/]+)\/messages$/);
      if (messagesMatch) {
        if (!hasSession(req, key)) {
          sendJson(res, 401, { error: "unauthenticated" });
          return;
        }
        const botId = decodeURIComponent(messagesMatch[1]);
        if (method === "GET") {
          const thread = store.messages(botId);
          if (!thread) {
            sendJson(res, 404, { error: "Bot not found" });
            return;
          }
          sendJson(res, 200, thread);
          return;
        }
        if (method === "POST") {
          let body: Record<string, unknown> = {};
          try {
            const raw = await readBody(req);
            body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
          } catch {
            sendJson(res, 400, { error: "invalid json" });
            return;
          }
          try {
            const text = typeof body.text === "string" ? body.text : "";
            const replyTo = typeof body.replyTo === "string" ? body.replyTo : undefined;
            const bot = await store.send(botId, text, replyTo);
            sendJson(res, 200, bot);
          } catch (err) {
            sendStoreError(res, err);
          }
          return;
        }
      }

      const permMatch = url.pathname.match(/^\/api\/bots\/([^/]+)\/permissions$/);
      if (permMatch && method === "POST") {
        if (!hasSession(req, key)) {
          sendJson(res, 401, { error: "unauthenticated" });
          return;
        }
        let body: Record<string, unknown> = {};
        try {
          const raw = await readBody(req);
          body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        } catch {
          sendJson(res, 400, { error: "invalid json" });
          return;
        }
        try {
          const botId = decodeURIComponent(permMatch[1]);
          if (typeof body.access === "string") {
            const duration = typeof body.duration === "string" ? body.duration : "session";
            const bot = store.answerHostGrant(botId, body.access, duration);
            sendJson(res, 200, bot);
          } else {
            const optionId = typeof body.optionId === "string" ? body.optionId : "";
            const bot = store.answerPermission(botId, optionId);
            sendJson(res, 200, bot);
          }
        } catch (err) {
          sendStoreError(res, err);
        }
        return;
      }

      const botAgentsMatch = url.pathname.match(/^\/api\/bots\/([^/]+)\/agents$/);
      if (botAgentsMatch) {
        if (!hasSession(req, key)) {
          sendJson(res, 401, { error: "unauthenticated" });
          return;
        }
        const botId = decodeURIComponent(botAgentsMatch[1]);
        if (method === "GET") {
          try {
            sendJson(res, 200, { text: store.readThisBotAgents(botId) });
          } catch (err) {
            sendStoreError(res, err);
          }
          return;
        }
        if (method === "PUT") {
          let body: Record<string, unknown> = {};
          try {
            const raw = await readBody(req);
            body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
          } catch {
            sendJson(res, 400, { error: "invalid json" });
            return;
          }
          try {
            const text = typeof body.text === "string" ? body.text : "";
            sendJson(res, 200, { text: store.writeThisBotAgents(botId, text) });
          } catch (err) {
            sendStoreError(res, err);
          }
          return;
        }
      }

      const harnessMatch = url.pathname.match(/^\/api\/bots\/([^/]+)\/harness$/);
      if (harnessMatch && method === "POST") {
        if (!hasSession(req, key)) {
          sendJson(res, 401, { error: "unauthenticated" });
          return;
        }
        let body: Record<string, unknown> = {};
        try {
          const raw = await readBody(req);
          body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        } catch {
          sendJson(res, 400, { error: "invalid json" });
          return;
        }
        try {
          const harness = typeof body.harness === "string" ? body.harness : "";
          const bot = await store.pickHarness(decodeURIComponent(harnessMatch[1]), harness);
          sendJson(res, 200, bot);
        } catch (err) {
          sendStoreError(res, err);
        }
        return;
      }

      const botMatch = url.pathname.match(/^\/api\/bots\/([^/]+)$/);
      if (botMatch) {
        if (!hasSession(req, key)) {
          sendJson(res, 401, { error: "unauthenticated" });
          return;
        }
        const botId = decodeURIComponent(botMatch[1]);
        if (method === "GET") {
          const bot = store.get(botId);
          if (!bot) {
            sendJson(res, 404, { error: "Bot not found" });
            return;
          }
          sendJson(res, 200, bot);
          return;
        }
        if (method === "PATCH") {
          let body: Record<string, unknown> = {};
          try {
            const raw = await readBody(req);
            body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
          } catch {
            sendJson(res, 400, { error: "invalid json" });
            return;
          }
          try {
            let bot = store.get(botId);
            if (!bot) {
              sendJson(res, 404, { error: "Bot not found" });
              return;
            }
            if (typeof body.configMode === "string") {
              bot = await store.setConfigMode(botId, body.configMode);
            }
            if (typeof body.harness === "string" && body.harness) {
              bot = await store.pickHarness(botId, body.harness);
            }
            sendJson(res, 200, bot);
          } catch (err) {
            sendStoreError(res, err);
          }
          return;
        }
      }

      if (url.pathname === "/api/computer/zoom" && method === "POST") {
        if (!hasSession(req, key)) {
          sendJson(res, 401, { error: "unauthenticated" });
          return;
        }
        let body: Record<string, unknown> = {};
        try {
          const raw = await readBody(req);
          body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        } catch {
          sendJson(res, 400, { error: "invalid json" });
          return;
        }
        const botId = typeof body.botId === "string" ? body.botId : "";
        const zoom = body.zoom !== false && body.zoom !== "false";
        try {
          if (!botId) {
            await applyKasmWrite(null, zoom);
            sendJson(res, 200, {
              path: `${SCREEN_PREFIX}/`,
              ready: true,
              botId: null,
              write: zoom,
              viewOnly: !zoom,
              zoom,
              container: computer.containerName(),
            });
            return;
          }
          const bot = zoom ? store.zoom(botId) : store.unzoom(botId);
          try {
            await applyKasmWrite(botId, zoom);
          } catch (err) {
            if (zoom) store.unzoom(botId);
            throw err;
          }
          sendJson(res, 200, {
            ...bot,
            path: `${SCREEN_PREFIX}/${botId}/`,
            ready: true,
            write: zoom,
            viewOnly: !zoom,
            zoom,
            container: computer.containerName(),
          });
        } catch (err) {
          sendStoreError(res, err);
        }
        return;
      }

      if (url.pathname === "/api/computer" && method === "GET") {
        if (!hasSession(req, key)) {
          sendJson(res, 401, { error: "unauthenticated" });
          return;
        }
        const requested = url.searchParams.get("botId");
        const bot = requested ? store.get(requested) : null;
        if (requested && !bot) {
          sendJson(res, 404, { error: "Bot not found" });
          return;
        }
        const botId = bot?.id ?? null;
        const upstream = upstreamFor(botId);
        const zoomed = botId ? store.isZoomed(botId) : false;
        const pathFor = botId ? `${SCREEN_PREFIX}/${botId}/` : `${SCREEN_PREFIX}/`;
        const ready = await screenIsReachable(upstream, auth);
        sendJson(res, 200, {
          path: upstream ? pathFor : pathFor,
          ready: Boolean(upstream) && ready,
          botId,
          write: zoomed,
          viewOnly: !zoomed,
          zoom: zoomed,
          display: bot?.display ?? (upstream ? 1 : null),
          container: computer.containerName(),
          cookieJar: computer.cookieJar(),
        });
        return;
      }

      if (url.pathname.startsWith("/api/")) {
        sendJson(res, 404, { error: "not found" });
        return;
      }

      if (isScreenPath(url.pathname)) {
        if (!hasSession(req, key)) {
          sendJson(res, 401, { error: "unauthenticated" });
          return;
        }
        const parsed = parseScreenPath(url.pathname, (id) => store.get(id) != null);
        const destBase = upstreamFor(parsed.botId);
        if (!destBase) {
          sendJson(res, 503, { error: "Computer is not up" });
          return;
        }
        const dest = new URL(`${parsed.rest}${url.search}`, destBase);
        proxyHttp(req, res, dest, auth);
        return;
      }

      if (method === "GET" || method === "HEAD") {
        await servePwa(options.pwaDir, url.pathname, res);
        return;
      }

      sendJson(res, 405, { error: "method not allowed" });
    } catch {
      sendJson(res, 500, { error: "box error" });
    }
  }

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    if (!isScreenPath(url.pathname)) {
      socket.destroy();
      return;
    }
    if (!hasSession(req, key)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const parsed = parseScreenPath(url.pathname, (id) => store.get(id) != null);
    const destBase = upstreamFor(parsed.botId);
    if (!destBase) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const dest = new URL(`${parsed.rest}${url.search}`, destBase);
    proxyUpgrade(req, socket, head, dest, auth);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 8080, host, () => resolve());
  });

  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("box failed to bind");
  }

  const hostname = host === "0.0.0.0" ? "127.0.0.1" : host;
  return {
    url: `http://${hostname}:${addr.port}`,
    port: addr.port,
    close: () =>
      new Promise((resolve, reject) => {
        store.close();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

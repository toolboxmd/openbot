import crypto from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { BotStore, type BotStoreDeps } from "./bots.ts";
import { defaultHomeDir, defaultWorkspaceDir } from "./home.ts";
import { NoopComputerRuntime, type ComputerRuntime } from "./computer.ts";
import { KasmWriteOwnership, kasmUpdateWrite } from "./kasm.ts";

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
  screenProxyDeadlines?: Partial<ScreenProxyDeadlines>;
} & Pick<BotStoreDeps, "spawnAcp" | "listHarnesses">;

export type ScreenProxyDeadlines = {
  connectMs: number;
  headerMs: number;
  bodyMs: number;
  totalMs: number;
};

export type RunningBox = {
  url: string;
  port: number;
  close: () => Promise<void>;
};

const COOKIE = "openbot";
const MAX_AGE = 60 * 60 * 24 * 30;
const SCREEN_PREFIX = "/screen";
const ROOT_COMPUTER_TARGET = "$computer";
const DEFAULT_SCREEN_PROXY_DEADLINES: ScreenProxyDeadlines = {
  connectMs: 1_000,
  headerMs: 5_000,
  bodyMs: 15_000,
  totalMs: 30_000,
};
const SCREEN_READINESS_MAX_BYTES = 128 * 1024;
const SCREEN_READINESS_TIMEOUT_MS = 750;

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

type UpstreamDeadlinePhase = "connect" | "headers" | "body" | "total";

function normalizeScreenProxyDeadlines(
  configured: Partial<ScreenProxyDeadlines> | undefined,
): ScreenProxyDeadlines {
  const positive = (value: number | undefined, fallback: number) =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.ceil(value) : fallback;
  return {
    connectMs: positive(configured?.connectMs, DEFAULT_SCREEN_PROXY_DEADLINES.connectMs),
    headerMs: positive(configured?.headerMs, DEFAULT_SCREEN_PROXY_DEADLINES.headerMs),
    bodyMs: positive(configured?.bodyMs, DEFAULT_SCREEN_PROXY_DEADLINES.bodyMs),
    totalMs: positive(configured?.totalMs, DEFAULT_SCREEN_PROXY_DEADLINES.totalMs),
  };
}

function superviseUpstreamDeadlines(
  request: http.ClientRequest,
  dest: URL,
  deadlines: ScreenProxyDeadlines,
  onTimeout: (phase: UpstreamDeadlinePhase) => void,
) {
  let active = true;
  let expired: UpstreamDeadlinePhase | null = null;
  let connectTimer: NodeJS.Timeout | undefined;
  let headerTimer: NodeJS.Timeout | undefined;
  let bodyTimer: NodeJS.Timeout | undefined;
  const totalTimer = setTimeout(() => timeout("total"), deadlines.totalMs);

  const clear = () => {
    clearTimeout(totalTimer);
    if (connectTimer) clearTimeout(connectTimer);
    if (headerTimer) clearTimeout(headerTimer);
    if (bodyTimer) clearTimeout(bodyTimer);
  };
  const timeout = (phase: UpstreamDeadlinePhase) => {
    if (!active) return;
    active = false;
    expired = phase;
    clear();
    onTimeout(phase);
  };
  const connected = () => {
    if (!active) return;
    if (connectTimer) clearTimeout(connectTimer);
    headerTimer = setTimeout(() => timeout("headers"), deadlines.headerMs);
  };

  request.once("socket", (socket) => {
    connectTimer = setTimeout(() => timeout("connect"), deadlines.connectMs);
    if (socket.connecting) {
      socket.once(dest.protocol === "https:" ? "secureConnect" : "connect", connected);
    } else {
      connected();
    }
  });

  return {
    response() {
      if (!active) return;
      if (connectTimer) clearTimeout(connectTimer);
      if (headerTimer) clearTimeout(headerTimer);
      if (bodyTimer) clearTimeout(bodyTimer);
      bodyTimer = setTimeout(() => timeout("body"), deadlines.bodyMs);
    },
    data() {
      if (!active) return;
      if (bodyTimer) clearTimeout(bodyTimer);
      bodyTimer = setTimeout(() => timeout("body"), deadlines.bodyMs);
    },
    finish() {
      if (!active) return;
      active = false;
      clear();
    },
    expired() {
      return expired;
    },
    terminal() {
      return !active;
    },
  };
}

function upstreamTimeoutMessage(phase: UpstreamDeadlinePhase): string {
  if (phase === "connect") return "Screen upstream timed out while connecting";
  if (phase === "headers") return "Screen upstream timed out waiting for headers";
  if (phase === "body") return "Screen upstream timed out waiting for body data";
  return "Screen upstream exceeded total deadline";
}

function endUpgradeFailure(
  socket: import("node:stream").Duplex,
  status: number,
  reason: string,
  message: string,
): void {
  if (socket.destroyed || !socket.writable) return;
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`,
  );
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
  deadlines: ScreenProxyDeadlines,
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

  let upstreamResponse: http.IncomingMessage | undefined;
  let controller: ReturnType<typeof superviseUpstreamDeadlines>;
  let upstream: http.ClientRequest;
  try {
    upstream = requestFor(dest)(dest, { method: req.method, headers }, (upstreamRes) => {
      if (controller.terminal() || res.destroyed || res.writableEnded) {
        upstreamRes.destroy();
        return;
      }
      upstreamResponse = upstreamRes;
      controller.response();
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
      upstreamRes.on("data", () => controller.data());
      upstreamRes.once("end", () => controller.finish());
      upstreamRes.once("aborted", () => {
        controller.finish();
        res.destroy();
      });
      upstreamRes.once("error", () => {
        controller.finish();
        res.destroy();
      });
      upstreamRes.pipe(res);
    });
  } catch {
    sendJson(res, 502, { error: "Screen is unreachable" });
    return;
  }
  controller = superviseUpstreamDeadlines(upstream, dest, deadlines, (phase) => {
    upstreamResponse?.destroy();
    upstream.destroy();
    if (!res.headersSent) {
      sendJson(res, 504, { error: upstreamTimeoutMessage(phase) }, { Connection: "close" });
    } else {
      res.destroy(new Error(upstreamTimeoutMessage(phase)));
    }
  });
  upstream.on("error", () => {
    if (controller.expired()) return;
    controller.finish();
    if (!res.headersSent) sendJson(res, 502, { error: "Screen is unreachable" });
    else res.destroy();
  });
  res.once("close", () => {
    const incomplete = !res.writableEnded;
    controller.finish();
    if (incomplete) {
      upstreamResponse?.destroy();
      upstream.destroy();
    }
  });
  req.pipe(upstream);
}

function proxyUpgrade(
  req: http.IncomingMessage,
  socket: import("node:stream").Duplex,
  head: Buffer,
  dest: URL,
  auth: string | undefined,
  deadlines: ScreenProxyDeadlines,
): void {
  const headers = copyHeaders(req.headers, ["host", "cookie", "authorization"]);
  headers.host = dest.host;
  if (auth) headers.authorization = auth;

  let responded = false;
  let terminalFailureSent = false;
  let upstreamResponse: http.IncomingMessage | undefined;
  let upstreamSocket: import("node:stream").Duplex | undefined;
  let upstream: http.ClientRequest;
  try {
    upstream = requestFor(dest)(dest, { method: "GET", headers });
  } catch {
    terminalFailureSent = true;
    endUpgradeFailure(socket, 502, "Bad Gateway", "Screen upstream is unreachable");
    return;
  }
  const controller = superviseUpstreamDeadlines(upstream, dest, deadlines, (phase) => {
    upstreamResponse?.destroy();
    upstreamSocket?.destroy();
    upstream.destroy();
    if (!responded && !socket.destroyed) {
      const message = upstreamTimeoutMessage(phase);
      socket.end(
        `HTTP/1.1 504 Gateway Timeout\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`,
      );
    } else {
      socket.destroy();
    }
  });
  upstream.on("upgrade", (upstreamRes, connectedSocket, upstreamHead) => {
    if (controller.terminal() || socket.destroyed || !socket.writable) {
      upstreamRes.destroy();
      connectedSocket.destroy();
      return;
    }
    responded = true;
    controller.finish();
    upstreamResponse = upstreamRes;
    upstreamSocket = connectedSocket;
    const lines = [`HTTP/1.1 ${upstreamRes.statusCode ?? 101} ${upstreamRes.statusMessage ?? "Switching Protocols"}`];
    for (const [key, value] of Object.entries(upstreamRes.headers)) {
      if (key.toLowerCase() === "www-authenticate") continue;
      if (value === undefined) continue;
      const rendered = Array.isArray(value) ? value : [value];
      for (const item of rendered) lines.push(`${key}: ${item}`);
    }
    socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head.length) connectedSocket.write(head);
    if (upstreamHead.length) socket.write(upstreamHead);
    connectedSocket.pipe(socket);
    socket.pipe(connectedSocket);
  });
  upstream.on("error", () => {
    if (controller.expired()) return;
    if (terminalFailureSent) return;
    controller.finish();
    if (!responded) {
      terminalFailureSent = true;
      endUpgradeFailure(socket, 502, "Bad Gateway", "Screen upstream is unreachable");
      return;
    }
    socket.destroy();
  });
  upstream.on("response", (upstreamRes) => {
    if (controller.terminal() || socket.destroyed || !socket.writable) {
      upstreamRes.destroy();
      return;
    }
    responded = true;
    upstreamResponse = upstreamRes;
    controller.response();
    const lines = [`HTTP/1.1 ${upstreamRes.statusCode ?? 502} ${upstreamRes.statusMessage ?? "Error"}`];
    for (const [key, value] of Object.entries(upstreamRes.headers)) {
      if (key.toLowerCase() === "www-authenticate") continue;
      if (value === undefined) continue;
      const rendered = Array.isArray(value) ? value : [value];
      for (const item of rendered) lines.push(`${key}: ${item}`);
    }
    socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    upstreamRes.on("data", () => controller.data());
    upstreamRes.once("end", () => controller.finish());
    upstreamRes.once("aborted", () => {
      controller.finish();
      socket.destroy();
    });
    upstreamRes.once("error", () => {
      controller.finish();
      socket.destroy();
    });
    upstreamRes.pipe(socket);
  });
  socket.once("close", () => {
    controller.finish();
    upstreamResponse?.destroy();
    upstreamSocket?.destroy();
    upstream.destroy();
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

export type ScreenReadiness = {
  reachable: boolean;
  ready: boolean;
};

function validKasmReadinessResponse(
  status: number | undefined,
  contentType: string | undefined,
  body: string,
): boolean {
  return status === 200
    && /^text\/html(?:;|$)/iu.test(contentType ?? "")
    && /<title[^>]*>\s*KasmVNC(?:\s|<|$)/iu.test(body);
}

/** node:http only. Do not fetch+AbortSignal against Kasm (undici can crash the host). */
export function screenReadiness(
  upstream: string | undefined,
  auth: string | undefined,
): Promise<ScreenReadiness> {
  if (!upstream) return Promise.resolve({ reachable: false, ready: false });

  let dest: URL;
  try {
    dest = new URL(upstream);
  } catch {
    return Promise.resolve({ reachable: false, ready: false });
  }
  if (dest.protocol !== "http:" && dest.protocol !== "https:") {
    return Promise.resolve({ reachable: false, ready: false });
  }

  return new Promise((resolve) => {
    let settled = false;
    let reachable = false;
    let deadline: NodeJS.Timeout | undefined;
    const done = (result: ScreenReadiness) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      resolve(result);
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
        timeout: SCREEN_READINESS_TIMEOUT_MS,
      });
    } catch {
      done({ reachable: false, ready: false });
      return;
    }

    const kill = () => {
      try {
        req.destroy();
      } catch {
        // ignore
      }
    };

    deadline = setTimeout(() => {
      kill();
      done({ reachable, ready: false });
    }, SCREEN_READINESS_TIMEOUT_MS);
    req.setTimeout(SCREEN_READINESS_TIMEOUT_MS, () => {
      kill();
      done({ reachable, ready: false });
    });
    req.on("response", (res) => {
      reachable = true;
      const chunks: Buffer[] = [];
      let bytes = 0;
      res.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > SCREEN_READINESS_MAX_BYTES) {
          res.destroy();
          kill();
          done({ reachable: true, ready: false });
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        done({
          reachable: true,
          ready: validKasmReadinessResponse(
            res.statusCode,
            res.headers["content-type"],
            Buffer.concat(chunks).toString("utf8"),
          ),
        });
      });
      res.on("error", () => done({ reachable: true, ready: false }));
    });
    req.on("timeout", () => {
      kill();
      done({ reachable, ready: false });
    });
    req.on("error", () => {
      done({ reachable, ready: false });
    });
    req.on("socket", (socket) => {
      socket.setTimeout(SCREEN_READINESS_TIMEOUT_MS, () => {
        kill();
        done({ reachable, ready: false });
      });
    });
    try {
      req.end();
    } catch {
      kill();
      done({ reachable: false, ready: false });
    }
  });
}

export async function screenIsReachable(
  upstream: string | undefined,
  auth: string | undefined,
): Promise<boolean> {
  return (await screenReadiness(upstream, auth)).ready;
}

function sendStoreError(res: http.ServerResponse, err: unknown): void {
  const status = typeof (err as { status?: unknown })?.status === "number" ? (err as { status: number }).status : 500;
  const message = err instanceof Error ? err.message : "box error";
  const payload: Record<string, unknown> = { error: message };
  const code = (err as { code?: unknown })?.code;
  const provisioningId = (err as { provisioningId?: unknown })?.provisioningId;
  if (typeof code === "string" && code.length <= 128) payload.code = code;
  if ((err as { recoverable?: unknown })?.recoverable === true) payload.recoverable = true;
  if (typeof provisioningId === "string" && provisioningId.length <= 128) {
    payload.provisioningId = provisioningId;
  }
  sendJson(res, status, payload);
}

export async function startBox(options: BoxOptions): Promise<RunningBox> {
  const host = options.host ?? "0.0.0.0";
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(options.password, salt, 32);
  const auth = kasmAuthorization(options);
  const screenProxyDeadlines = normalizeScreenProxyDeadlines(options.screenProxyDeadlines);
  const computer: ComputerRuntime =
    options.computer ?? new NoopComputerRuntime(undefined, options.screenUpstream);
  const homeDir = path.resolve(options.homeDir ?? defaultHomeDir());
  const workspaceDir = path.resolve(options.workspaceDir ?? defaultWorkspaceDir(homeDir));
  fsSync.mkdirSync(workspaceDir, { recursive: true });
  const store = new BotStore(homeDir, {
    computer,
    screenReady: async (upstream) => (await screenReadiness(upstream, auth)).ready,
    spawnAcp: options.spawnAcp,
    listHarnesses: options.listHarnesses,
    workspaceDir,
  });
  try {
    await store.reattachDisplays();
  } catch (error) {
    store.close();
    throw error;
  }

  function upstreamFor(botId: string | null): string | undefined {
    if (botId && computer.upstream(botId)) return computer.upstream(botId);
    return computer.computerUpstream() ?? options.screenUpstream;
  }

  async function applyKasmWrite(botId: string | null, write: boolean): Promise<void> {
    if (!options.kasmUser || options.kasmPassword === undefined) return;
    const upstream = upstreamFor(botId);
    if (!upstream) throw new Error("Kasm write endpoint is unavailable");
    await kasmUpdateWrite({
      upstream,
      user: options.kasmUser,
      password: options.kasmPassword,
      name: options.kasmUser,
      write,
    });
  }

  const writeOwnership = new KasmWriteOwnership({
    update: (target, write) =>
      applyKasmWrite(target === ROOT_COMPUTER_TARGET ? null : target, write),
    publish: (target, state) => {
      if (target === ROOT_COMPUTER_TARGET || !store.get(target)) return;
      store.setComputerOwnership(target, state.authority);
    },
  });
  const existingBotIds = store.list().map((bot) => bot.id);
  await writeOwnership.reconcile(
    existingBotIds.length > 0 ? existingBotIds : [ROOT_COMPUTER_TARGET],
  );

  function ownershipTarget(botId: string | null): string {
    if (botId) return botId;
    const rootUpstream = upstreamFor(null);
    const firstDisplay = rootUpstream
      ? store.list().find((bot) => upstreamFor(bot.id) === rootUpstream)
      : undefined;
    return firstDisplay?.id ?? ROOT_COMPUTER_TARGET;
  }

  function computerOwnership(botId: string | null) {
    const state = writeOwnership.state(ownershipTarget(botId));
    const known = state.authority !== "unknown";
    const write = state.authority === "write";
    return {
      ownership: state.authority,
      ownershipError: state.error ?? null,
      ownershipEpoch: writeOwnership.epoch(),
      write: known ? write : null,
      viewOnly: known ? !write : null,
      zoom: write,
    };
  }

  type ConnectionState = {
    activeResponses: number;
    closeAfterResponses: boolean;
    phase: "headers" | "http" | "upgrade";
  };
  let closing = false;
  const connections = new Map<import("node:stream").Duplex, ConnectionState>();
  const server = http.createServer((req, res) => {
    const state = connections.get(req.socket);
    if (closing) {
      if (!state || state.activeResponses === 0) req.socket.destroy();
      return;
    }
    if (!state) {
      req.socket.destroy();
      return;
    }
    state.activeResponses += 1;
    state.phase = "http";
    let released = false;
    function releaseResponse(): void {
      if (released) return;
      released = true;
      const current = connections.get(req.socket);
      if (!current) return;
      current.activeResponses -= 1;
      if (current.activeResponses > 0 || req.socket.destroyed) return;
      if (closing || current.closeAfterResponses) {
        req.socket.destroySoon();
        return;
      }
      current.phase = "headers";
    }
    res.once("finish", releaseResponse);
    res.once("close", releaseResponse);
    void handle(req, res);
  });
  server.on("connection", (socket) => {
    if (closing) {
      socket.destroy();
      return;
    }
    connections.set(socket, {
      activeResponses: 0,
      closeAfterResponses: false,
      phase: "headers",
    });
    socket.once("close", () => connections.delete(socket));
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
          const created = await store.create(name);
          if (upstreamFor(created.id) === upstreamFor(null)) {
            await writeOwnership
              .transition(ROOT_COMPUTER_TARGET, false)
              .catch(() => undefined);
          }
          await writeOwnership.register(created.id).catch(() => undefined);
          sendJson(res, 201, store.get(created.id));
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
        let expectedEpoch: string | undefined;
        if (body.ownershipEpoch !== undefined) {
          if (
            typeof body.ownershipEpoch !== "string"
            || body.ownershipEpoch.length === 0
            || body.ownershipEpoch.length > 128
          ) {
            sendJson(res, 400, { error: "invalid Computer ownership epoch" });
            return;
          }
          expectedEpoch = body.ownershipEpoch;
        }
        try {
          if (botId && !store.get(botId)) {
            sendJson(res, 404, { error: "Bot not found" });
            return;
          }
          const selectedBotId = botId || null;
          await writeOwnership.transition(
            ownershipTarget(selectedBotId),
            zoom,
            expectedEpoch,
          );
          const bot = selectedBotId ? store.get(selectedBotId) : null;
          const upstream = upstreamFor(selectedBotId);
          const readiness = await screenReadiness(upstream, auth);
          sendJson(res, 200, {
            ...(bot ?? {}),
            path: selectedBotId ? `${SCREEN_PREFIX}/${selectedBotId}/` : `${SCREEN_PREFIX}/`,
            reachable: Boolean(upstream) && readiness.reachable,
            ready: Boolean(upstream) && readiness.ready,
            botId: selectedBotId,
            ...computerOwnership(selectedBotId),
            container: computer.containerName(),
          });
        } catch (err) {
          const status = typeof (err as { status?: unknown })?.status === "number"
            ? (err as { status: number }).status
            : 500;
          const message = err instanceof Error ? err.message : "box error";
          const selectedBotId = botId || null;
          const upstream = upstreamFor(selectedBotId);
          const readiness = await screenReadiness(upstream, auth);
          sendJson(res, status, {
            error: message,
            path: selectedBotId ? `${SCREEN_PREFIX}/${selectedBotId}/` : `${SCREEN_PREFIX}/`,
            reachable: Boolean(upstream) && readiness.reachable,
            ready: Boolean(upstream) && readiness.ready,
            botId: selectedBotId,
            ...computerOwnership(selectedBotId),
            container: computer.containerName(),
          });
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
        const pathFor = botId ? `${SCREEN_PREFIX}/${botId}/` : `${SCREEN_PREFIX}/`;
        const readiness = await screenReadiness(upstream, auth);
        sendJson(res, 200, {
          path: upstream ? pathFor : pathFor,
          reachable: Boolean(upstream) && readiness.reachable,
          ready: Boolean(upstream) && readiness.ready,
          botId,
          ...computerOwnership(botId),
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
        proxyHttp(req, res, dest, auth, screenProxyDeadlines);
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
    const state = connections.get(socket);
    if (!state) {
      socket.destroy();
      return;
    }
    if (state.activeResponses > 0) {
      state.closeAfterResponses = true;
      return;
    }
    if (closing) {
      socket.destroy();
      return;
    }
    state.phase = "upgrade";
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
    proxyUpgrade(req, socket, head, dest, auth, screenProxyDeadlines);
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
  let closeResult: Promise<void> | null = null;
  function close(): Promise<void> {
    if (closeResult) return closeResult;
    closing = true;
    const serverClosed = new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    for (const [socket, state] of connections) {
      if (state.phase === "upgrade" || state.activeResponses === 0) socket.destroy();
    }
    closeResult = (async () => {
      let ownershipFailure: unknown = null;
      let serverFailure: unknown = null;
      let storeFailure: unknown = null;
      try {
        await writeOwnership.shutdown();
      } catch (error) {
        ownershipFailure = error;
      }
      try {
        await serverClosed;
      } catch (error) {
        serverFailure = error;
      }
      try {
        store.close();
      } catch (error) {
        storeFailure = error;
      }
      const failures = [ownershipFailure, serverFailure, storeFailure]
        .filter((error): error is NonNullable<unknown> => error !== null);
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw Object.assign(
          new AggregateError(failures, "Box shutdown did not complete cleanly."),
          { status: 503 },
        );
      }
    })();
    return closeResult;
  }
  return {
    url: `http://${hostname}:${addr.port}`,
    port: addr.port,
    close,
  };
}

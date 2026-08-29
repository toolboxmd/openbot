import crypto from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import type { Duplex } from "node:stream";
import { BotStore, type BotScreenRuntimeState, type BotStoreDeps } from "./bots.ts";
import { defaultHomeDir, defaultWorkspaceDir, type ChannelCursor } from "./home.ts";
import { NoopComputerRuntime, type ComputerRuntime } from "./computer.ts";
import { isGeneratedBotId } from "./harness-home.ts";
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
  botStore?: BotStore;
  transportLimits?: Partial<TransportLimits>;
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
const COOKIE_EXPIRES = "Fri, 31 Dec 9999 23:59:59 GMT";
const SESSION_VERSION = "v1";
const AUTH_DIRECTORY = "auth";
const AUTH_SALT_FILE = "salt";
const AUTH_SALT_BYTES = 32;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
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

function sameScreenRuntime(
  left: BotScreenRuntimeState | null,
  right: BotScreenRuntimeState | null,
): boolean {
  if (!left || !right) return left === right;
  return left.id === right.id
    && left.computerOwnership === right.computerOwnership
    && left.display === right.display
    && left.screenState === right.screenState
    && left.screenAttempt === right.screenAttempt
    && left.screenError?.stage === right.screenError?.stage
    && left.screenError?.code === right.screenError?.code
    && left.screenError?.message === right.screenError?.message
    && left.screenCleanupError?.code === right.screenCleanupError?.code
    && left.screenCleanupError?.message === right.screenCleanupError?.message;
}

const BODY_LIMITS = {
  password: 8 * 1024,
  action: 64 * 1024,
  message: 256 * 1024,
  instructions: 1024 * 1024,
} as const;

type TransportLimits = {
  headersTimeoutMs: number;
  bodyProgressTimeoutMs: number;
  requestTimeoutMs: number;
  idleTimeoutMs: number;
  keepAliveTimeoutMs: number;
};

const DEFAULT_TRANSPORT_LIMITS: TransportLimits = {
  headersTimeoutMs: 15_000,
  bodyProgressTimeoutMs: 10_000,
  requestTimeoutMs: 30_000,
  idleTimeoutMs: 60_000,
  keepAliveTimeoutMs: 5_000,
};

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

const API_METHODS: ReadonlyArray<{ pattern: RegExp; methods: readonly string[] }> = [
  { pattern: /^\/api\/session$/u, methods: ["GET", "POST", "DELETE"] },
  { pattern: /^\/api\/app-settings$/u, methods: ["GET", "PATCH"] },
  { pattern: /^\/api\/agents$/u, methods: ["GET", "PUT"] },
  { pattern: /^\/api\/host-grants$/u, methods: ["GET"] },
  { pattern: /^\/api\/harnesses$/u, methods: ["GET"] },
  { pattern: /^\/api\/bots$/u, methods: ["GET", "POST"] },
  { pattern: /^\/api\/inbox$/u, methods: ["GET"] },
  { pattern: /^\/api\/channels$/u, methods: ["GET", "POST"] },
  { pattern: /^\/api\/channels\/[^/]+\/messages$/u, methods: ["POST"] },
  { pattern: /^\/api\/channels\/[^/]+\/read$/u, methods: ["POST"] },
  { pattern: /^\/api\/channels\/[^/]+$/u, methods: ["GET"] },
  { pattern: /^\/api\/bots\/[^/]+\/messages\/[^/]+\/reactions$/u, methods: ["POST"] },
  { pattern: /^\/api\/bots\/[^/]+\/cards\/[^/]+\/retry$/u, methods: ["POST"] },
  { pattern: /^\/api\/bots\/[^/]+\/cards\/[^/]+\/needs-you$/u, methods: ["POST"] },
  { pattern: /^\/api\/bots\/[^/]+\/read$/u, methods: ["POST"] },
  { pattern: /^\/api\/bots\/[^/]+\/messages$/u, methods: ["GET", "POST"] },
  { pattern: /^\/api\/bots\/[^/]+\/permissions$/u, methods: ["POST"] },
  { pattern: /^\/api\/bots\/[^/]+\/agents$/u, methods: ["GET", "PUT"] },
  { pattern: /^\/api\/bots\/[^/]+\/harness$/u, methods: ["POST"] },
  { pattern: /^\/api\/bots\/[^/]+$/u, methods: ["GET", "PATCH"] },
  { pattern: /^\/api\/computer\/retry$/u, methods: ["POST"] },
  { pattern: /^\/api\/computer\/zoom$/u, methods: ["POST"] },
  { pattern: /^\/api\/computer$/u, methods: ["GET"] },
];

function allowedApiMethods(pathname: string): readonly string[] | undefined {
  return API_METHODS.find(({ pattern }) => pattern.test(pathname))?.methods;
}

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
  if (payload !== SESSION_VERSION) return false;
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

class HttpInputError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function decodePathComponent(value: string): string {
  try {
    const decoded = decodeURIComponent(value);
    if (/[\u0000-\u001f\u007f]/u.test(decoded)) {
      throw new HttpInputError(400, "bad path");
    }
    return decoded;
  } catch {
    throw new HttpInputError(400, "bad path");
  }
}

function requestUrl(req: http.IncomingMessage): URL {
  try {
    return new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
  } catch {
    throw new HttpInputError(400, "bad path");
  }
}

function readBody(
  req: http.IncomingMessage,
  maxBytes: number,
  limits: Pick<TransportLimits, "bodyProgressTimeoutMs" | "requestTimeoutMs">,
): Promise<string> {
  const declaredLength = req.headers["content-length"];
  if (
    typeof declaredLength === "string" &&
    /^\d+$/u.test(declaredLength) &&
    Number(declaredLength) > maxBytes
  ) {
    req.on("error", () => undefined);
    req.resume();
    return Promise.reject(new HttpInputError(413, "request body too large"));
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    let progressTimer: NodeJS.Timeout;
    let totalTimer: NodeJS.Timeout;

    const clearTimers = () => {
      clearTimeout(progressTimer);
      clearTimeout(totalTimer);
    };
    const fail = (error: HttpInputError) => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      clearTimers();
      req.resume();
      reject(error);
    };
    const armProgressTimer = () => {
      clearTimeout(progressTimer);
      progressTimer = setTimeout(
        () => fail(new HttpInputError(408, "request timeout")),
        limits.bodyProgressTimeoutMs,
      );
    };

    armProgressTimer();
    totalTimer = setTimeout(
      () => fail(new HttpInputError(408, "request timeout")),
      limits.requestTimeoutMs,
    );
    req.on("data", (chunk) => {
      if (settled) return;
      armProgressTimer();
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > maxBytes) {
        fail(new HttpInputError(413, "request body too large"));
        return;
      }
      chunks.push(buffer);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("aborted", () => {
      fail(new HttpInputError(400, "invalid request body"));
    });
    req.on("error", () => {
      fail(new HttpInputError(400, "invalid request body"));
    });
  });
}

async function readJsonObjectBody(
  req: http.IncomingMessage,
  maxBytes: number,
  limits: Pick<TransportLimits, "bodyProgressTimeoutMs" | "requestTimeoutMs">,
): Promise<Record<string, unknown>> {
  const raw = await readBody(req, maxBytes, limits);
  if (!raw) {
    throw new HttpInputError(400, "request body must be a JSON object");
  }
  const body: unknown = JSON.parse(raw);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpInputError(400, "request body must be a JSON object");
  }
  return body as Record<string, unknown>;
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
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(body);
}

function sendBodyError(
  res: http.ServerResponse,
  error: unknown,
  headers: Record<string, string | number | string[]> = {},
): void {
  const status = error instanceof HttpInputError ? error.status : 400;
  const message = error instanceof HttpInputError ? error.message : "invalid json";
  const connection: Record<string, string> = error instanceof HttpInputError && error.status === 408
    ? { Connection: "close" }
    : {};
  sendJson(res, status, { error: message }, { ...connection, ...headers });
}

function hasSession(req: http.IncomingMessage, key: Buffer): boolean {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  return Boolean(token && verify(token, key));
}

function sessionCookie(token: string): string {
  return `${COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Expires=${COOKIE_EXPIRES}`;
}

function clearedSessionCookie(): string {
  return `${COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0`;
}

function clearSessionCookieWhenPresent(
  req: http.IncomingMessage,
): Record<string, string> {
  return Object.hasOwn(parseCookies(req.headers.cookie), COOKIE)
    ? { "Set-Cookie": clearedSessionCookie() }
    : {};
}

function requireSession(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  key: Buffer,
): boolean {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token && verify(token, key)) {
    res.setHeader("Set-Cookie", sessionCookie(token));
    return true;
  }
  sendJson(
    res,
    401,
    { error: "unauthenticated" },
    clearSessionCookieWhenPresent(req),
  );
  return false;
}

async function loadOrCreateAuthSalt(homeDir: string): Promise<Buffer> {
  const authDir = path.join(homeDir, AUTH_DIRECTORY);
  const saltPath = path.join(authDir, AUTH_SALT_FILE);
  await ensurePrivateDirectory(homeDir, true, "OpenBot Home");
  await ensurePrivateDirectory(authDir, false, "authentication directory");
  try {
    return await readAuthSalt(saltPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const candidate = path.join(
    authDir,
    `.salt-${process.pid}-${crypto.randomBytes(12).toString("hex")}.tmp`,
  );
  const candidateHandle = await fs.open(
    candidate,
    fsSync.constants.O_WRONLY |
      fsSync.constants.O_CREAT |
      fsSync.constants.O_EXCL |
      fsSync.constants.O_NOFOLLOW,
    PRIVATE_FILE_MODE,
  );
  try {
    await candidateHandle.writeFile(crypto.randomBytes(AUTH_SALT_BYTES));
    await candidateHandle.chmod(PRIVATE_FILE_MODE);
  } finally {
    await candidateHandle.close();
  }
  try {
    try {
      await fs.link(candidate, saltPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  } finally {
    await fs.unlink(candidate);
  }
  return readAuthSalt(saltPath);
}

async function ensurePrivateDirectory(
  directory: string,
  recursive: boolean,
  label: string,
): Promise<void> {
  try {
    await fs.mkdir(directory, { recursive, mode: PRIVATE_DIRECTORY_MODE });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }

  let handle: fs.FileHandle;
  try {
    handle = await fs.open(
      directory,
      fsSync.constants.O_RDONLY |
        fsSync.constants.O_DIRECTORY |
        fsSync.constants.O_NOFOLLOW,
    );
  } catch {
    throw new Error(`${label} must be a real directory`);
  }
  try {
    const info = await handle.stat();
    if (!info.isDirectory()) throw new Error(`${label} must be a real directory`);
    await handle.chmod(PRIVATE_DIRECTORY_MODE);
  } finally {
    await handle.close();
  }
}

async function readAuthSalt(saltPath: string): Promise<Buffer> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(
      saltPath,
      fsSync.constants.O_RDONLY |
        fsSync.constants.O_NONBLOCK |
        fsSync.constants.O_NOFOLLOW,
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw err;
    throw new Error("authentication salt must be a regular file");
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      throw new Error("authentication salt must be a regular file");
    }
    await handle.chmod(PRIVATE_FILE_MODE);
    const salt = await handle.readFile();
    if (salt.length !== AUTH_SALT_BYTES) throw new Error("invalid authentication salt");
    return salt;
  } finally {
    await handle.close();
  }
}

function isScreenPath(pathname: string): boolean {
  return pathname === SCREEN_PREFIX || pathname.startsWith(`${SCREEN_PREFIX}/`);
}

function parseScreenPath(
  pathname: string,
  isBotId: (id: string) => boolean,
): { botId: string | null; rest: string; unknownBotId?: string } {
  // Validate every encoded segment before forwarding the original path. The
  // decoded value is deliberately not used, so reserved separators retain
  // their upstream routing semantics.
  decodePathComponent(pathname);
  if (pathname === SCREEN_PREFIX || pathname === `${SCREEN_PREFIX}/`) {
    return { botId: null, rest: "/" };
  }
  if (!pathname.startsWith(`${SCREEN_PREFIX}/`)) return { botId: null, rest: "/" };
  const rest = pathname.slice(SCREEN_PREFIX.length + 1);
  if (!rest) return { botId: null, rest: "/" };
  const cut = rest.indexOf("/");
  const first = decodePathComponent(cut === -1 ? rest : rest.slice(0, cut));
  const tail = cut === -1 || cut === rest.length - 1 ? "/" : rest.slice(cut);
  if (first === "websockify") return { botId: null, rest: `/${rest}` };
  // Kasm 1.5 serves hashed UI under /assets. Only a real Bot id is a display prefix.
  if (isBotId(first)) return { botId: first, rest: tail || "/" };
  if (isGeneratedBotId(first.toLowerCase())) {
    return { botId: null, rest: "/", unknownBotId: first };
  }
  return { botId: null, rest: `/${rest}` };
}

function kasmAuthorization(options: BoxOptions): string | undefined {
  if (!options.kasmUser || options.kasmPassword === undefined) return undefined;
  return `Basic ${Buffer.from(`${options.kasmUser}:${options.kasmPassword}`).toString("base64")}`;
}

function requestFor(url: URL) {
  return url.protocol === "https:" ? https.request : http.request;
}

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

function nonUpgradeResponseHead(response: http.IncomingMessage): string {
  const blocked = new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "www-authenticate",
  ]);
  const connection = response.headers.connection;
  for (const value of Array.isArray(connection) ? connection : [connection]) {
    if (!value) continue;
    for (const token of value.split(",")) blocked.add(token.trim().toLowerCase());
  }

  const lines = [
    `HTTP/1.1 ${response.statusCode ?? 502} ${response.statusMessage ?? "Error"}`,
  ];
  for (const [key, value] of Object.entries(response.headers)) {
    if (blocked.has(key.toLowerCase()) || value === undefined) continue;
    const rendered = Array.isArray(value) ? value : [value];
    for (const item of rendered) lines.push(`${key}: ${item}`);
  }
  lines.push("Connection: close");
  return `${lines.join("\r\n")}\r\n\r\n`;
}

function resetConnection(socket: Duplex): void {
  if (socket.destroyed) return;
  socket.once("error", () => undefined);
  const reset = (socket as Duplex & { resetAndDestroy?: () => void }).resetAndDestroy;
  if (typeof reset === "function") reset.call(socket);
  else socket.destroy();
}


function endUpgradeFailure(
  socket: Duplex,
  status: number,
  reason: string,
  message: string,
): void {
  if (socket.destroyed || !socket.writable) return;
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`,
  );
}

type UpstreamDeadlinePhase = "connect" | "headers" | "body" | "total";

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
  totalTimer.unref();

  const clear = () => {
    clearTimeout(connectTimer);
    clearTimeout(headerTimer);
    clearTimeout(bodyTimer);
    clearTimeout(totalTimer);
  };
  const timeout = (phase: UpstreamDeadlinePhase) => {
    if (!active) return;
    active = false;
    expired = phase;
    clear();
    onTimeout(phase);
  };
  const armBodyTimer = () => {
    clearTimeout(bodyTimer);
    bodyTimer = setTimeout(() => timeout("body"), deadlines.bodyMs);
    bodyTimer.unref();
  };
  const connected = () => {
    if (!active) return;
    clearTimeout(connectTimer);
    headerTimer = setTimeout(() => timeout("headers"), deadlines.headerMs);
    headerTimer.unref();
  };

  request.once("socket", (socket) => {
    connectTimer = setTimeout(() => timeout("connect"), deadlines.connectMs);
    connectTimer.unref();
    if (socket.connecting) {
      socket.once(dest.protocol === "https:" ? "secureConnect" : "connect", connected);
    } else {
      connected();
    }
  });

  return {
    response() {
      if (!active) return;
      clearTimeout(headerTimer);
      armBodyTimer();
    },
    data() {
      if (!active) return;
      armBodyTimer();
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
  const failDownstream = (status = 502, message = "Screen is unreachable") => {
    if (res.destroyed || res.writableEnded) return;
    if (!res.headersSent) {
      sendJson(
        res,
        status,
        { error: message },
        { Connection: "close" },
      );
    } else {
      res.destroy();
    }
  };

  let upstream: http.ClientRequest;
  try {
    upstream = requestFor(dest)(dest, { method: req.method, headers }, (upstreamRes) => {
      if (controller.terminal()) {
        upstreamRes.destroy();
        return;
      }
      if (res.destroyed || res.writableEnded) {
        controller.finish();
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
      upstreamRes.on("data", () => controller.data());
      upstreamRes.once("end", () => controller.finish());
      upstreamRes.once("error", () => {
        controller.finish();
        failDownstream();
      });
      upstreamRes.once("aborted", () => {
        controller.finish();
        failDownstream();
      });
      res.writeHead(upstreamRes.statusCode ?? 502, out);
      upstreamRes.pipe(res);
    });
  } catch {
    failDownstream();
    return;
  }
  const closeUpstream = () => {
    req.off("aborted", closeUpstream);
    req.off("error", closeUpstream);
    req.socket.off("close", closeUpstream);
    res.off("close", closeUpstream);
    controller.finish();
    upstreamResponse?.destroy();
    upstream.destroy();
  };
  controller = superviseUpstreamDeadlines(upstream, dest, deadlines, (phase) => {
    if (upstream.socket) resetConnection(upstream.socket);
    upstreamResponse?.destroy();
    upstream.destroy();
    failDownstream(504, upstreamTimeoutMessage(phase));
  });
  req.once("aborted", closeUpstream);
  req.once("error", closeUpstream);
  req.socket.once("close", closeUpstream);
  res.once("close", closeUpstream);
  upstream.on("error", () => {
    if (controller.expired()) return;
    controller.finish();
    failDownstream();
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
  ownUpstreamSocket: (socket: Duplex) => boolean,
): void {
  const headers = copyHeaders(req.headers, ["host", "cookie", "authorization"]);
  headers.host = dest.host;
  if (auth) headers.authorization = auth;

  let upstream: http.ClientRequest;
  try {
    upstream = requestFor(dest)(dest, { method: "GET", headers });
  } catch {
    endUpgradeFailure(socket, 502, "Bad Gateway", "Screen upstream is unreachable");
    return;
  }
  let preUpgradeActive = true;
  let upstreamResponse: http.IncomingMessage | undefined;
  let controller: ReturnType<typeof superviseUpstreamDeadlines>;
  const finishPreUpgrade = () => {
    if (!preUpgradeActive) return false;
    preUpgradeActive = false;
    controller.finish();
    socket.off("error", closePreUpgrade);
    socket.off("close", closePreUpgrade);
    return true;
  };
  const closePreUpgrade = () => {
    if (!finishPreUpgrade()) return;
    if (upstream.socket) resetConnection(upstream.socket);
    upstreamResponse?.destroy();
    upstream.destroy();
    socket.destroy();
  };
  const failPreUpgrade = (status: number, reason: string, message: string) => {
    if (!finishPreUpgrade()) return;
    if (upstream.socket) resetConnection(upstream.socket);
    upstreamResponse?.destroy();
    upstream.destroy();
    if (upstreamResponse) socket.destroy();
    else endUpgradeFailure(socket, status, reason, message);
  };
  controller = superviseUpstreamDeadlines(upstream, dest, deadlines, (phase) => {
    failPreUpgrade(504, "Gateway Timeout", upstreamTimeoutMessage(phase));
  });
  socket.on("error", closePreUpgrade);
  socket.on("close", closePreUpgrade);
  upstream.on("upgrade", (upstreamRes, upstreamSocket, upstreamHead) => {
    if (!finishPreUpgrade() || !ownUpstreamSocket(upstreamSocket)) {
      upstreamRes.destroy();
      socket.destroy();
      upstreamSocket.destroy();
      return;
    }
    let closed = false;
    const closeBoth = () => {
      if (closed) return;
      closed = true;
      socket.destroy();
      upstreamSocket.destroy();
    };
    socket.on("error", closeBoth);
    socket.on("close", closeBoth);
    upstreamSocket.on("error", closeBoth);
    upstreamSocket.on("close", closeBoth);

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
    if (controller.expired()) return;
    failPreUpgrade(502, "Bad Gateway", "Screen upstream is unreachable");
  });
  upstream.on("response", (upstreamRes) => {
    if (!preUpgradeActive || controller.terminal() || socket.destroyed) {
      upstreamRes.destroy();
      return;
    }
    upstreamResponse = upstreamRes;
    controller.response();

    socket.write(nonUpgradeResponseHead(upstreamRes));
    upstreamRes.on("data", () => controller.data());
    upstreamRes.once("end", () => finishPreUpgrade());
    upstreamRes.once("error", closePreUpgrade);
    upstreamRes.once("aborted", closePreUpgrade);
    upstreamRes.pipe(socket);
  });
  upstream.end();
}

class StaticPathError extends Error {}

async function readStaticFile(
  root: string,
  target: string,
): Promise<{ file: string; bytes: Buffer }> {
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new StaticPathError("static path escaped its root");
  }

  let current = root;
  let info = await fs.lstat(root);
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    info = await fs.lstat(current);
    if (info.isSymbolicLink()) throw new StaticPathError("static symlinks are not served");
  }

  const file = info.isDirectory() ? path.join(target, "index.html") : target;
  if (file !== target) {
    const indexInfo = await fs.lstat(file);
    if (indexInfo.isSymbolicLink()) throw new StaticPathError("static symlinks are not served");
  }

  let handle: fs.FileHandle;
  try {
    handle = await fs.open(
      file,
      fsSync.constants.O_RDONLY | fsSync.constants.O_NOFOLLOW,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new StaticPathError("static symlinks are not served");
    }
    throw error;
  }
  try {
    const [resolvedRoot, resolvedFile] = await Promise.all([
      fs.realpath(root),
      fs.realpath(file),
    ]);
    const insideResolvedRoot = resolvedFile === resolvedRoot ||
      resolvedFile.startsWith(`${resolvedRoot}${path.sep}`);
    if (!insideResolvedRoot) throw new StaticPathError("static path escaped its resolved root");

    const fileInfo = await handle.stat();
    if (!fileInfo.isFile()) throw new StaticPathError("static entry is not a file");
    return { file, bytes: await handle.readFile() };
  } finally {
    await handle.close();
  }
}

async function servePwa(
  pwaDir: string,
  urlPath: string,
  res: http.ServerResponse,
): Promise<void> {
  let decoded: string;
  try {
    decoded = decodePathComponent(urlPath.split("?")[0] || "/");
  } catch {
    sendJson(res, 400, { error: "bad path" });
    return;
  }
  const root = path.resolve(pwaDir);
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const target = path.resolve(root, relative);
  const inside = target === root || target.startsWith(root + path.sep);
  if (!inside) {
    sendJson(res, 400, { error: "bad path" });
    return;
  }

  try {
    const { file, bytes } = await readStaticFile(root, target);
    const ext = path.extname(file);
    res.writeHead(200, {
      "Content-Type": MIME[ext] ?? "application/octet-stream",
      "Content-Length": bytes.length,
    });
    res.end(bytes);
    return;
  } catch (error) {
    if (error instanceof StaticPathError) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    if (path.extname(relative)) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
  }

  try {
    const { bytes } = await readStaticFile(root, path.join(root, "index.html"));
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
  const homeDir = path.resolve(options.homeDir ?? defaultHomeDir());
  const salt = await loadOrCreateAuthSalt(homeDir);
  const key = crypto.scryptSync(options.password, salt, 32);
  const auth = kasmAuthorization(options);
  const transportLimits: TransportLimits = {
    ...DEFAULT_TRANSPORT_LIMITS,
    ...options.transportLimits,
  };
  const inheritedScreenDeadlines = options.transportLimits
    ? {
      connectMs: transportLimits.headersTimeoutMs,
      headerMs: transportLimits.headersTimeoutMs,
      bodyMs: transportLimits.bodyProgressTimeoutMs,
      totalMs: transportLimits.requestTimeoutMs,
    }
    : undefined;
  const screenProxyDeadlines = normalizeScreenProxyDeadlines(
    options.screenProxyDeadlines ?? inheritedScreenDeadlines,
  );
  const computer: ComputerRuntime =
    options.computer ?? new NoopComputerRuntime(undefined, options.screenUpstream);
  const workspaceDir = path.resolve(options.workspaceDir ?? defaultWorkspaceDir(homeDir));
  fsSync.mkdirSync(workspaceDir, { recursive: true });
  const store = options.botStore ?? new BotStore(homeDir, {
    computer,
    screenReady: async (upstream) => (await screenReadiness(upstream, auth)).ready,
    spawnAcp: options.spawnAcp,
    listHarnesses: options.listHarnesses,
    workspaceDir,
  });
  try {
    await store.recoverBotProvisionings();
  } catch (error) {
    store.close();
    throw error;
  }
  const readRequestBody = (req: http.IncomingMessage, maxBytes: number) =>
    readBody(req, maxBytes, transportLimits);
  const readRequestObject = (req: http.IncomingMessage, maxBytes: number) =>
    readJsonObjectBody(req, maxBytes, transportLimits);
  const activeHandlersBySocket = new WeakMap<http.IncomingMessage["socket"], number>();
  const suspendIdleTimeout = (socket: http.IncomingMessage["socket"]) => {
    const activeHandlers = activeHandlersBySocket.get(socket) ?? 0;
    if (activeHandlers === 0) socket.setTimeout(0);
    activeHandlersBySocket.set(socket, activeHandlers + 1);
  };
  const restoreIdleTimeout = (socket: http.IncomingMessage["socket"]) => {
    const activeHandlers = activeHandlersBySocket.get(socket) ?? 0;
    if (activeHandlers > 1) {
      activeHandlersBySocket.set(socket, activeHandlers - 1);
      return;
    }
    activeHandlersBySocket.delete(socket);
    if (!socket.destroyed) socket.setTimeout(transportLimits.idleTimeoutMs);
  };

  function runtimeUpstreamFor(botId: string | null): string | undefined {
    if (botId) return computer.display(botId)?.upstream;
    return computer.computerUpstream() ?? options.screenUpstream;
  }

  async function applyKasmWrite(botId: string | null, write: boolean): Promise<void> {
    if (!options.kasmUser || options.kasmPassword === undefined) return;
    const upstream = runtimeUpstreamFor(botId);
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
      if (target === ROOT_COMPUTER_TARGET || !store.screenRuntime(target)) return;
      store.publishComputerOwnership(target, state.authority);
    },
  });
  async function registerScreen(botId: string): Promise<"view-only"> {
    const state = await writeOwnership.register(botId);
    if (state.authority !== "view-only") {
      throw Object.assign(new Error("Screen ownership registration was not confirmed view-only"), {
        status: 503,
        code: "SCREEN_OWNERSHIP_FAILED",
      });
    }
    return state.authority;
  }
  function forgetReleasedScreen(botId: string): void {
    writeOwnership.forgetReleased(botId);
  }
  const existingScreens = store.listScreenRuntimes();
  const attachedBotIds = existingScreens
    .filter((screen) => screen.screenState === "ready" && computer.display(screen.id) !== undefined)
    .map((screen) => screen.id);
  await writeOwnership.reconcile(
    existingScreens.length > 0 ? attachedBotIds : [ROOT_COMPUTER_TARGET],
  );

  function rootRuntimeScreen() {
    const rootUpstream = runtimeUpstreamFor(null);
    if (!rootUpstream) return null;
    return store.listScreenRuntimes().find(
      (screen) => computer.display(screen.id)?.upstream === rootUpstream,
    ) ?? null;
  }

  function ownershipTarget(botId: string | null): string {
    if (botId) return botId;
    return rootRuntimeScreen()?.id ?? ROOT_COMPUTER_TARGET;
  }

  function upstreamFor(botId: string | null): string | undefined {
    const runtimeUpstream = runtimeUpstreamFor(botId);
    if (!runtimeUpstream) return undefined;
    if (botId) {
      const screen = store.screenRuntime(botId);
      if (
        screen?.screenState !== "ready"
        || writeOwnership.state(botId).authority === "unknown"
      ) return undefined;
      return runtimeUpstream;
    }
    const rootScreen = rootRuntimeScreen();
    if (rootScreen) {
      if (
        rootScreen.screenState !== "ready"
        || writeOwnership.state(rootScreen.id).authority === "unknown"
      ) return undefined;
      return runtimeUpstream;
    }
    if (store.listScreenRuntimes().length > 0) return undefined;
    return writeOwnership.state(ROOT_COMPUTER_TARGET).authority === "unknown"
      ? undefined
      : runtimeUpstream;
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

  function computerSnapshot(botId: string | null) {
    return {
      screen: botId ? store.screenRuntime(botId) : rootRuntimeScreen(),
      upstream: upstreamFor(botId),
      ownership: computerOwnership(botId),
    };
  }

  function computerStatePayload(
    botId: string | null,
    snapshot: ReturnType<typeof computerSnapshot>,
    readiness: ScreenReadiness,
    exposeUpstream: boolean,
  ) {
    const upstream = exposeUpstream ? snapshot.upstream : undefined;
    const screen = snapshot.screen;
    const pathFor = botId ? `${SCREEN_PREFIX}/${botId}/` : `${SCREEN_PREFIX}/`;
    return {
      path: upstream ? pathFor : null,
      reachable: Boolean(upstream) && readiness.reachable,
      ready: Boolean(upstream) && readiness.ready,
      botId,
      screenState: screen?.screenState ?? (upstream ? "ready" : "unavailable"),
      screenAttempt: screen?.screenAttempt ?? null,
      screenError: screen?.screenError ?? null,
      screenCleanupError: screen?.screenCleanupError ?? null,
      ...snapshot.ownership,
      display: screen?.display ?? (upstream ? 1 : null),
      container: computer.containerName(),
      cookieJar: computer.cookieJar(),
    };
  }

  async function computerState(botId: string | null) {
    const before = computerSnapshot(botId);
    const readiness = await screenReadiness(before.upstream, auth);
    const after = computerSnapshot(botId);
    const stable = before.upstream === after.upstream
      && sameScreenRuntime(before.screen, after.screen)
      && before.ownership.ownership === after.ownership.ownership
      && before.ownership.ownershipError === after.ownership.ownershipError
      && before.ownership.ownershipEpoch === after.ownership.ownershipEpoch;
    return computerStatePayload(botId, after, readiness, stable);
  }

  type ConnectionState = {
    activeResponses: number;
    closeAfterResponses: boolean;
    phase: "headers" | "http" | "upgrade";
  };
  let closing = false;
  const connections = new Map<import("node:stream").Duplex, ConnectionState>();
  const ownedUpgradeSockets = new Set<Duplex>();
  const ownUpgradeSocket = (socket: Duplex): boolean => {
    if (closing) {
      resetConnection(socket);
      return false;
    }
    if (ownedUpgradeSockets.has(socket)) return true;
    ownedUpgradeSockets.add(socket);
    socket.once("close", () => ownedUpgradeSockets.delete(socket));
    return true;
  };
  const server = http.createServer(
    {
      headersTimeout: transportLimits.headersTimeoutMs,
      requestTimeout: transportLimits.requestTimeoutMs,
      keepAliveTimeout: transportLimits.keepAliveTimeoutMs,
      connectionsCheckingInterval: Math.max(
        10,
        Math.min(1_000, Math.floor(transportLimits.headersTimeoutMs / 4)),
      ),
    },
    (req, res) => {
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
    },
  );
  server.setTimeout(transportLimits.idleTimeoutMs, (socket) => socket.destroy());
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
    let idleSuspended = false;
    try {
      const url = requestUrl(req);
      if (!isScreenPath(url.pathname)) {
        // Header parsing is complete here. Body readers still enforce progress
        // and total deadlines, while active application handlers own their own
        // liveness and must be allowed to return a bounded result.
        suspendIdleTimeout(req.socket);
        idleSuspended = true;
      }
      const method = req.method ?? "GET";
      const allowedMethods = allowedApiMethods(url.pathname);
      if (allowedMethods && !allowedMethods.includes(method)) {
        sendJson(
          res,
          405,
          { error: "method not allowed" },
          { Allow: allowedMethods.join(", ") },
        );
        return;
      }

      if (url.pathname === "/api/session" && method === "DELETE") {
        res.writeHead(204, {
          "Cache-Control": "no-store",
          "Set-Cookie": clearedSessionCookie(),
        });
        res.end();
        return;
      }

      if (url.pathname === "/api/session" && method === "POST") {
        let body: unknown;
        try {
          const raw = await readRequestBody(req, BODY_LIMITS.password);
          body = raw ? JSON.parse(raw) : null;
        } catch (error) {
          sendBodyError(res, error, clearSessionCookieWhenPresent(req));
          return;
        }
        if (
          typeof body !== "object" ||
          body === null ||
          Array.isArray(body) ||
          typeof (body as Record<string, unknown>).password !== "string" ||
          (body as Record<string, unknown>).password === ""
        ) {
          sendJson(res, 400, { error: "invalid Password" }, clearSessionCookieWhenPresent(req));
          return;
        }
        const given = (body as { password: string }).password;
        if (!passwordsEqual(given, options.password)) {
          sendJson(res, 401, { error: "wrong Password" }, clearSessionCookieWhenPresent(req));
          return;
        }
        const token = sign(SESSION_VERSION, key);
        sendJson(
          res,
          200,
          { ok: true },
          {
            "Set-Cookie": sessionCookie(token),
          },
        );
        return;
      }

      if (url.pathname === "/api/session" && method === "GET") {
        if (!requireSession(req, res, key)) return;
        sendJson(res, 200, { ok: true });
        return;
      }

      if (url.pathname === "/api/app-settings" && method === "GET") {
        if (!requireSession(req, res, key)) return;
        sendJson(res, 200, store.appSettings());
        return;
      }

      if (url.pathname === "/api/app-settings" && method === "PATCH") {
        if (!requireSession(req, res, key)) return;
        let body: Record<string, unknown>;
        try {
          body = await readRequestObject(req, BODY_LIMITS.action);
        } catch (error) {
          sendBodyError(res, error);
          return;
        }
        try {
          sendJson(res, 200, store.updateAppSettings(body));
        } catch (error) {
          sendStoreError(res, error);
        }
        return;
      }

      if (url.pathname === "/api/agents" && method === "GET") {
        if (!requireSession(req, res, key)) return;
        sendJson(res, 200, { text: store.readAllBotsAgents() });
        return;
      }

      if (url.pathname === "/api/agents" && method === "PUT") {
        if (!requireSession(req, res, key)) return;
        let body: Record<string, unknown>;
        try {
          body = await readRequestObject(req, BODY_LIMITS.instructions);
        } catch (error) {
          sendBodyError(res, error);
          return;
        }
        const text = typeof body.text === "string" ? body.text : "";
        sendJson(res, 200, { text: store.writeAllBotsAgents(text) });
        return;
      }

      if (url.pathname === "/api/host-grants" && method === "GET") {
        if (!requireSession(req, res, key)) return;
        sendJson(res, 200, { grants: store.listHostGrants() });
        return;
      }

      if (url.pathname === "/api/harnesses" && method === "GET") {
        if (!requireSession(req, res, key)) return;
        sendJson(res, 200, { harnesses: store.listHarnesses() });
        return;
      }

      if (url.pathname === "/api/bots" && method === "GET") {
        if (!requireSession(req, res, key)) return;
        sendJson(res, 200, { bots: store.list() });
        return;
      }

      if (url.pathname === "/api/inbox" && method === "GET") {
        if (!requireSession(req, res, key)) return;
        sendJson(res, 200, store.inbox());
        return;
      }

      if (url.pathname === "/api/bots" && method === "POST") {
        if (!requireSession(req, res, key)) return;
        let body: Record<string, unknown>;
        try {
          body = await readRequestObject(req, BODY_LIMITS.action);
        } catch (error) {
          sendBodyError(res, error);
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
        if (!requireSession(req, res, key)) return;
        sendJson(res, 200, { channels: store.listChannels() });
        return;
      }

      if (url.pathname === "/api/channels" && method === "POST") {
        if (!requireSession(req, res, key)) return;
        let body: Record<string, unknown>;
        try {
          body = await readRequestObject(req, BODY_LIMITS.action);
        } catch (error) {
          sendBodyError(res, error);
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
        if (!requireSession(req, res, key)) return;
        const channelId = decodePathComponent(channelMessagesMatch[1]);
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
        if (!requireSession(req, res, key)) return;
        let body: Record<string, unknown>;
        try {
          body = await readRequestObject(req, BODY_LIMITS.action);
        } catch (error) {
          sendBodyError(res, error);
          return;
        }
        const cursor = readChannelCursor(body.cursor);
        try {
          const activity = store.markChannelRead(decodePathComponent(channelReadMatch[1]), cursor);
          sendJson(res, 200, { activity });
        } catch (err) {
          sendStoreError(res, err);
        }
        return;
      }

      const channelMatch = url.pathname.match(/^\/api\/channels\/([^/]+)$/);
      if (channelMatch && method === "GET") {
        if (!requireSession(req, res, key)) return;
        const channel = store.getChannel(decodePathComponent(channelMatch[1]));
        if (!channel) {
          sendJson(res, 404, { error: "Channel not found" });
          return;
        }
        sendJson(res, 200, channel);
        return;
      }

      const reactionMatch = url.pathname.match(/^\/api\/bots\/([^/]+)\/messages\/([^/]+)\/reactions$/);
      if (reactionMatch && method === "POST") {
        if (!requireSession(req, res, key)) return;
        let body: Record<string, unknown>;
        try {
          body = await readRequestObject(req, BODY_LIMITS.action);
        } catch (error) {
          sendBodyError(res, error);
          return;
        }
        try {
          const emoji = typeof body.emoji === "string" ? body.emoji : "";
          const bot = store.toggleReaction(
            decodePathComponent(reactionMatch[1]),
            decodePathComponent(reactionMatch[2]),
            emoji,
          );
          sendJson(res, 200, bot);
        } catch (err) {
          sendStoreError(res, err);
        }
        return;
      }

      const retryCardMatch = url.pathname.match(/^\/api\/bots\/([^/]+)\/cards\/([^/]+)\/retry$/);
      if (retryCardMatch && method === "POST") {
        if (!requireSession(req, res, key)) return;
        try {
          const bot = await store.retryCard(
            decodePathComponent(retryCardMatch[1]),
            decodePathComponent(retryCardMatch[2]),
          );
          sendJson(res, 200, bot);
        } catch (err) {
          sendStoreError(res, err);
        }
        return;
      }

      const needsYouCardMatch = url.pathname.match(/^\/api\/bots\/([^/]+)\/cards\/([^/]+)\/needs-you$/);
      if (needsYouCardMatch && method === "POST") {
        if (!requireSession(req, res, key)) return;
        let body: Record<string, unknown>;
        try {
          body = await readRequestObject(req, BODY_LIMITS.action);
        } catch (error) {
          sendBodyError(res, error);
          return;
        }
        const input = body;
        try {
          const eventId = typeof input.eventId === "string" ? input.eventId : "";
          const resolution = typeof input.resolution === "string" ? input.resolution : "";
          const bot = await store.resolveNeedsYou(
            decodePathComponent(needsYouCardMatch[1]),
            decodePathComponent(needsYouCardMatch[2]),
            eventId,
            resolution,
          );
          sendJson(res, 200, bot);
        } catch (err) {
          sendStoreError(res, err);
        }
        return;
      }

      const botReadMatch = url.pathname.match(/^\/api\/bots\/([^/]+)\/read$/);
      if (botReadMatch && method === "POST") {
        if (!requireSession(req, res, key)) return;
        let body: Record<string, unknown>;
        try {
          body = await readRequestObject(req, BODY_LIMITS.action);
        } catch (error) {
          sendBodyError(res, error);
          return;
        }
        const cursor = readChannelCursor(body.cursor);
        try {
          const activity = store.markBotRead(decodePathComponent(botReadMatch[1]), cursor);
          sendJson(res, 200, { activity });
        } catch (err) {
          sendStoreError(res, err);
        }
        return;
      }

      const messagesMatch = url.pathname.match(/^\/api\/bots\/([^/]+)\/messages$/);
      if (messagesMatch) {
        if (!requireSession(req, res, key)) return;
        const botId = decodePathComponent(messagesMatch[1]);
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
          let body: Record<string, unknown>;
          try {
            body = await readRequestObject(req, BODY_LIMITS.message);
          } catch (error) {
            sendBodyError(res, error);
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
        if (!requireSession(req, res, key)) return;
        let body: Record<string, unknown>;
        try {
          body = await readRequestObject(req, BODY_LIMITS.action);
        } catch (error) {
          sendBodyError(res, error);
          return;
        }
        try {
          const botId = decodePathComponent(permMatch[1]);
          const cardId = typeof body.cardId === "string" ? body.cardId : "";
          if (typeof body.access === "string") {
            const duration = typeof body.duration === "string" ? body.duration : "session";
            const bot = await store.answerHostGrant(botId, body.access, duration, cardId);
            sendJson(res, 200, bot);
          } else {
            const optionId = typeof body.optionId === "string" ? body.optionId : "";
            const bot = await store.answerPermission(botId, optionId, cardId);
            sendJson(res, 200, bot);
          }
        } catch (err) {
          sendStoreError(res, err);
        }
        return;
      }

      const botAgentsMatch = url.pathname.match(/^\/api\/bots\/([^/]+)\/agents$/);
      if (botAgentsMatch) {
        if (!requireSession(req, res, key)) return;
        const botId = decodePathComponent(botAgentsMatch[1]);
        if (method === "GET") {
          try {
            sendJson(res, 200, { text: store.readThisBotAgents(botId) });
          } catch (err) {
            sendStoreError(res, err);
          }
          return;
        }
        if (method === "PUT") {
          let body: Record<string, unknown>;
          try {
            body = await readRequestObject(req, BODY_LIMITS.instructions);
          } catch (error) {
            sendBodyError(res, error);
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
        if (!requireSession(req, res, key)) return;
        let body: Record<string, unknown>;
        try {
          body = await readRequestObject(req, BODY_LIMITS.action);
        } catch (error) {
          sendBodyError(res, error);
          return;
        }
        try {
          const harness = typeof body.harness === "string" ? body.harness : "";
          const bot = await store.pickHarness(decodePathComponent(harnessMatch[1]), harness);
          sendJson(res, 200, bot);
        } catch (err) {
          sendStoreError(res, err);
        }
        return;
      }

      const botMatch = url.pathname.match(/^\/api\/bots\/([^/]+)$/);
      if (botMatch) {
        if (!requireSession(req, res, key)) return;
        const botId = decodePathComponent(botMatch[1]);
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
          let body: Record<string, unknown>;
          try {
            body = await readRequestObject(req, BODY_LIMITS.action);
          } catch (error) {
            sendBodyError(res, error);
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

      if (url.pathname === "/api/computer/retry" && method === "POST") {
        if (!requireSession(req, res, key)) return;
        let body: Record<string, unknown>;
        try {
          body = await readRequestObject(req, BODY_LIMITS.action);
        } catch (error) {
          sendBodyError(res, error);
          return;
        }
        if (typeof body.botId !== "string" || body.botId.length === 0 || body.botId.length > 128) {
          sendJson(res, 400, { error: "invalid Bot id" });
          return;
        }
        if (
          typeof body.screenAttempt !== "string"
          || body.screenAttempt.length === 0
          || body.screenAttempt.length > 128
        ) {
          sendJson(res, 400, { error: "invalid Screen attempt" });
          return;
        }
        try {
          store.retryScreen(
            body.botId,
            body.screenAttempt,
            registerScreen,
            forgetReleasedScreen,
          );
          sendJson(
            res,
            202,
            computerStatePayload(
              body.botId,
              computerSnapshot(body.botId),
              { reachable: false, ready: false },
              false,
            ),
          );
        } catch (err) {
          sendStoreError(res, err);
        }
        return;
      }

      if (url.pathname === "/api/computer/zoom" && method === "POST") {
        if (!requireSession(req, res, key)) return;
        let body: Record<string, unknown>;
        try {
          body = await readRequestObject(req, BODY_LIMITS.action);
        } catch (error) {
          sendBodyError(res, error);
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
          if (botId && !store.screenRuntime(botId)) {
            sendJson(res, 404, { error: "Bot not found" });
            return;
          }
          const selectedBotId = botId || null;
          const selectedScreen = selectedBotId ? store.screenRuntime(selectedBotId) : null;
          if (selectedScreen && selectedScreen.screenState !== "ready") {
            const state = await computerState(selectedBotId);
            if (zoom) {
              sendJson(res, 409, {
                error: "Screen is not ready.",
                code: selectedScreen.screenState === "cleanup-required"
                  ? "SCREEN_CLEANUP_REQUIRED"
                  : selectedScreen.screenState === "unassigned"
                  ? "SCREEN_UNASSIGNED"
                  : selectedScreen.screenState === "attaching"
                  ? "SCREEN_ATTACHING"
                  : "SCREEN_UNAVAILABLE",
                ...state,
              });
            } else {
              sendJson(res, 200, state);
            }
            return;
          }
          await writeOwnership.transition(
            ownershipTarget(selectedBotId),
            zoom,
            expectedEpoch,
          );
          sendJson(res, 200, await computerState(selectedBotId));
        } catch (err) {
          const status = typeof (err as { status?: unknown })?.status === "number"
            ? (err as { status: number }).status
            : 500;
          const message = err instanceof Error ? err.message : "box error";
          const selectedBotId = botId || null;
          const state = await computerState(selectedBotId);
          const code = (err as { code?: unknown })?.code;
          sendJson(res, status, {
            error: message,
            ...(typeof code === "string" ? { code } : {}),
            ...state,
          });
        }
        return;
      }

      if (url.pathname === "/api/computer" && method === "GET") {
        if (!requireSession(req, res, key)) return;
        const requested = url.searchParams.get("botId");
        const screen = requested ? store.screenRuntime(requested) : null;
        if (requested && !screen) {
          sendJson(res, 404, { error: "Bot not found" });
          return;
        }
        const botId = screen?.id ?? null;
        sendJson(res, 200, await computerState(botId));
        return;
      }

      if (url.pathname.startsWith("/api/")) {
        sendJson(res, 404, { error: "not found" });
        return;
      }

      if (isScreenPath(url.pathname)) {
        if (!requireSession(req, res, key)) return;
        const parsed = parseScreenPath(url.pathname, (id) => store.screenRuntime(id) != null);
        if (parsed.unknownBotId) {
          sendJson(res, 404, { error: "Bot not found" });
          return;
        }
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
    } catch (error) {
      if (error instanceof HttpInputError) {
        sendJson(res, error.status, { error: error.message });
      } else {
        sendJson(res, 500, { error: "box error" });
      }
    } finally {
      if (idleSuspended) restoreIdleTimeout(req.socket);
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
    if (!ownUpgradeSocket(socket)) return;
    socket.on("error", () => socket.destroy());
    try {
      const url = requestUrl(req);
      if (!isScreenPath(url.pathname)) {
        socket.destroy();
        return;
      }
      if (!hasSession(req, key)) {
        socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      const parsed = parseScreenPath(url.pathname, (id) => store.screenRuntime(id) != null);
      if (parsed.unknownBotId) {
        socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      const destBase = upstreamFor(parsed.botId);
      if (!destBase) {
        socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      const dest = new URL(`${parsed.rest}${url.search}`, destBase);
      proxyUpgrade(req, socket, head, dest, auth, screenProxyDeadlines, ownUpgradeSocket);
    } catch {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    }
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
  void store.reattachDisplays(registerScreen, forgetReleasedScreen).catch(() => undefined);
  let closeResult: Promise<void> | null = null;
  function close(): Promise<void> {
    if (closeResult) return closeResult;
    closing = true;
    const attachmentsStopped = store.stopScreenAttachments();
    closeResult = (async () => {
      let attachmentFailure: unknown = null;
      let ownershipFailure: unknown = null;
      let serverFailure: unknown = null;
      let storeFailure: unknown = null;

      try {
        await writeOwnership.shutdown();
      } catch (error) {
        ownershipFailure = error;
      }

      const serverClosed = new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      for (const socket of ownedUpgradeSockets) resetConnection(socket);
      for (const [socket, state] of connections) {
        if (state.phase === "upgrade" || state.activeResponses === 0) resetConnection(socket);
        else state.closeAfterResponses = true;
      }

      try {
        await attachmentsStopped;
      } catch (error) {
        attachmentFailure = error;
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
      const failures = [attachmentFailure, ownershipFailure, serverFailure, storeFailure]
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

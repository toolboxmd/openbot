import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { BotStore, defaultWorkspaceDir, type BotStoreDeps } from "./bots.ts";
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

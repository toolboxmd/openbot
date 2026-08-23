import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";

export type BoxOptions = {
  password: string;
  pwaDir: string;
  host?: string;
  port?: number;
  screenUpstream?: string;
  kasmUser?: string;
  kasmPassword?: string;
};

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

function stripScreenPrefix(pathname: string): string {
  if (pathname === SCREEN_PREFIX) return "/";
  if (pathname.startsWith(`${SCREEN_PREFIX}/`)) {
    const rest = pathname.slice(SCREEN_PREFIX.length);
    return rest.length === 0 ? "/" : rest;
  }
  return pathname;
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

async function screenIsReachable(
  upstream: string | undefined,
  auth: string | undefined,
): Promise<boolean> {
  if (!upstream) return false;
  try {
    await fetch(upstream, {
      signal: AbortSignal.timeout(750),
      redirect: "manual",
      headers: auth ? { Authorization: auth } : undefined,
    });
    return true;
  } catch {
    return false;
  }
}

export async function startBox(options: BoxOptions): Promise<RunningBox> {
  const host = options.host ?? "0.0.0.0";
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(options.password, salt, 32);
  const auth = kasmAuthorization(options);

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

      if (url.pathname === "/api/bots" && method === "GET") {
        if (!hasSession(req, key)) {
          sendJson(res, 401, { error: "unauthenticated" });
          return;
        }
        sendJson(res, 200, { bots: [] });
        return;
      }

      if (url.pathname === "/api/computer" && method === "GET") {
        if (!hasSession(req, key)) {
          sendJson(res, 401, { error: "unauthenticated" });
          return;
        }
        sendJson(res, 200, {
          path: `${SCREEN_PREFIX}/`,
          ready: await screenIsReachable(options.screenUpstream, auth),
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
        if (!options.screenUpstream) {
          sendJson(res, 503, { error: "Screen is not up" });
          return;
        }
        const dest = new URL(
          `${stripScreenPrefix(url.pathname)}${url.search}`,
          options.screenUpstream,
        );
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
    if (!options.screenUpstream) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const dest = new URL(`${stripScreenPrefix(url.pathname)}${url.search}`, options.screenUpstream);
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
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

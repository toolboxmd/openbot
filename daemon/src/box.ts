import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";

export type BoxOptions = {
  password: string;
  pwaDir: string;
  host?: string;
  port?: number;
};

export type RunningBox = {
  url: string;
  port: number;
  close: () => Promise<void>;
};

const COOKIE = "openbot";
const MAX_AGE = 60 * 60 * 24 * 30;

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

export async function startBox(options: BoxOptions): Promise<RunningBox> {
  const host = options.host ?? "0.0.0.0";
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(options.password, salt, 32);

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

      if (url.pathname.startsWith("/api/")) {
        sendJson(res, 404, { error: "not found" });
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

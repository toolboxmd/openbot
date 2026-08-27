import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startBox, type BoxOptions, type RunningBox } from "../src/box.ts";
import { MemoryComputerRuntime } from "../src/computer.ts";

const PASSWORD = "correct-horse";
const TEST_TRANSPORT_LIMITS = {
  headersTimeoutMs: 80,
  bodyProgressTimeoutMs: 80,
  requestTimeoutMs: 240,
  idleTimeoutMs: 120,
  keepAliveTimeoutMs: 80,
};

function cookieHeader(response: Response): string {
  return response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
}

async function login(box: RunningBox): Promise<string> {
  const response = await fetch(`${box.url}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  assert.equal(response.status, 200);
  const cookie = cookieHeader(response);
  assert.ok(cookie, "login did not return a cookie");
  return cookie;
}

async function startTestBox(
  onUpgrade?: (request: http.IncomingMessage, socket: net.Socket, head: Buffer) => void,
  preparePwa?: (root: string, pwaDir: string) => Promise<void>,
  transportLimits?: typeof TEST_TRANSPORT_LIMITS,
  onScreenRequest?: (request: http.IncomingMessage, response: http.ServerResponse) => void,
  botStore?: BoxOptions["botStore"],
): Promise<{ box: RunningBox; cleanup: (boxAlreadyClosed?: boolean) => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "openbot-box-boundaries-"));
  const pwaDir = join(root, "pwa");
  const cookiesDir = join(root, "cookies");
  await mkdir(pwaDir, { recursive: true });
  await mkdir(cookiesDir, { recursive: true });
  await writeFile(join(pwaDir, "index.html"), "<!doctype html><title>OpenBot</title>");
  await preparePwa?.(root, pwaDir);

  const upstream = http.createServer((request, response) => {
    if (onScreenRequest) {
      onScreenRequest(request, response);
      return;
    }
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("screen");
  });
  if (onUpgrade) upstream.on("upgrade", onUpgrade);
  await new Promise<void>((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", resolve);
  });
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("upstream failed to bind");
  const upstreamUrl = `http://127.0.0.1:${address.port}`;

  const box = await startBox({
    password: PASSWORD,
    pwaDir,
    host: "127.0.0.1",
    port: 0,
    screenUpstream: upstreamUrl,
    homeDir: join(root, "home"),
    computer: new MemoryComputerRuntime({ cookiesDir, upstreams: [upstreamUrl] }),
    transportLimits,
    botStore,
  });

  return {
    box,
    cleanup: async (boxAlreadyClosed = false) => {
      if (!boxAlreadyClosed) await box.close();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function rawRequestUntilClose(
  box: RunningBox,
  request: string,
  options: { end?: boolean; deadlineMs?: number } = {},
): Promise<string> {
  const target = new URL(box.url);
  return new Promise((resolve, reject) => {
    let connected = false;
    let response = "";
    let settled = false;
    const socket = net.createConnection({ host: target.hostname, port: Number(target.port) });
    const deadline = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error("raw request was not closed by its deadline"));
    }, options.deadlineMs ?? 1_000);
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      connected = true;
      socket.write(request);
      if (options.end) socket.end();
    });
    socket.on("data", (chunk) => {
      response += chunk;
    });
    socket.on("error", (error) => {
      if (!connected && !settled) {
        settled = true;
        clearTimeout(deadline);
        reject(error);
      }
    });
    socket.on("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(response);
    });
  });
}

async function trickleRequestUntilClose(
  box: RunningBox,
  headers: string,
  intervalMs: number,
  deadlineMs: number,
): Promise<string> {
  const target = new URL(box.url);
  return new Promise((resolve, reject) => {
    let response = "";
    let settled = false;
    let trickle: NodeJS.Timeout;
    const socket = net.createConnection({ host: target.hostname, port: Number(target.port) });
    const deadline = setTimeout(() => {
      if (settled) return;
      settled = true;
      clearInterval(trickle);
      socket.destroy();
      reject(new Error("trickled request was not closed by its total deadline"));
    }, deadlineMs);
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(headers);
      trickle = setInterval(() => socket.write(" "), intervalMs);
    });
    socket.on("data", (chunk) => {
      response += chunk;
    });
    socket.on("error", () => undefined);
    socket.on("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearInterval(trickle);
      resolve(response);
    });
  });
}

async function waitForUpgradedSocketToClose(
  box: RunningBox,
  path: string,
  cookie: string,
): Promise<void> {
  const target = new URL(box.url);
  await new Promise<void>((resolve, reject) => {
    const request = http.request({
      hostname: target.hostname,
      port: target.port,
      path,
      method: "GET",
      headers: {
        cookie,
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": crypto.randomBytes(16).toString("base64"),
      },
    });
    request.once("response", (response) => {
      response.resume();
      reject(new Error(`expected upgrade, got ${response.statusCode}`));
    });
    request.once("upgrade", (response, socket) => {
      try {
        assert.equal(response.statusCode, 101);
      } catch (error) {
        socket.destroy();
        reject(error);
        return;
      }
      socket.once("error", () => undefined);
      socket.once("close", () => resolve());
    });
    request.once("error", reject);
    request.end();
  });
}

async function resetUpgradedDownstream(
  box: RunningBox,
  path: string,
  cookie: string,
): Promise<void> {
  const target = new URL(box.url);
  await new Promise<void>((resolve, reject) => {
    const request = http.request({
      hostname: target.hostname,
      port: target.port,
      path,
      method: "GET",
      headers: {
        cookie,
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": crypto.randomBytes(16).toString("base64"),
      },
    });
    request.once("response", (response) => {
      response.resume();
      reject(new Error(`expected upgrade, got ${response.statusCode}`));
    });
    request.once("upgrade", (response, socket) => {
      try {
        assert.equal(response.statusCode, 101);
      } catch (error) {
        socket.destroy();
        reject(error);
        return;
      }
      socket.on("error", () => undefined);
      (socket as net.Socket).resetAndDestroy();
      resolve();
    });
    request.once("error", reject);
    request.end();
  });
}

async function openUpgrade(
  box: RunningBox,
  path: string,
  cookie: string,
): Promise<net.Socket> {
  const target = new URL(box.url);
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: target.hostname,
      port: target.port,
      path,
      method: "GET",
      headers: {
        cookie,
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": crypto.randomBytes(16).toString("base64"),
      },
    });
    request.once("response", (response) => {
      response.resume();
      reject(new Error(`expected upgrade, got ${response.statusCode}`));
    });
    request.once("upgrade", (response, socket) => {
      if (response.statusCode !== 101) {
        socket.destroy();
        reject(new Error(`expected 101, got ${response.statusCode}`));
        return;
      }
      resolve(socket as net.Socket);
    });
    request.once("error", reject);
    request.end();
  });
}

async function rawUpgradeResponse(
  box: RunningBox,
  path: string,
  cookie: string,
): Promise<{ status: number; body: string }> {
  const target = new URL(box.url);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path,
        method: "GET",
        headers: {
          cookie,
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-version": "13",
          "sec-websocket-key": crypto.randomBytes(16).toString("base64"),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    request.once("upgrade", (_response, socket) => {
      socket.destroy();
      reject(new Error("malformed Screen path unexpectedly upgraded"));
    });
    request.once("error", reject);
    request.end();
  });
}

async function resetRejectedUpgrade(box: RunningBox, path: string, cookie: string): Promise<void> {
  const target = new URL(box.url);
  await new Promise<void>((resolve, reject) => {
    let connected = false;
    const socket = net.createConnection({ host: target.hostname, port: Number(target.port) });
    socket.once("connect", () => {
      connected = true;
      socket.write(
        [
          `GET ${path} HTTP/1.1`,
          `Host: ${target.host}`,
          `Cookie: ${cookie}`,
          "Connection: Upgrade",
          "Upgrade: websocket",
          "Sec-WebSocket-Version: 13",
          `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString("base64")}`,
          "",
          "",
        ].join("\r\n"),
        () => {
          socket.resetAndDestroy();
          resolve();
        },
      );
    });
    socket.once("close", () => resolve());
    socket.once("error", (error) => {
      if (connected) resolve();
      else reject(error);
    });
  });
}

test("malformed authenticated WebSocket paths fail closed without stopping Talk", async () => {
  const fixture = await startTestBox();
  try {
    const cookie = await login(fixture.box);
    const malformed = await rawUpgradeResponse(fixture.box, "/screen/%", cookie);

    assert.equal(malformed.status, 400);
    assert.ok(Buffer.byteLength(malformed.body) <= 256, "malformed-path response must stay bounded");
    assert.doesNotMatch(malformed.body, /URIError|stack|daemon\/src/u);

    const survived = await fetch(`${fixture.box.url}/api/inbox`, { headers: { cookie } });
    assert.equal(survived.status, 200);
  } finally {
    await fixture.cleanup();
  }
});

test("malformed Screen path tails fail before HTTP and WebSocket proxying", async () => {
  let upstreamHttpRequests = 0;
  let upstreamUpgrades = 0;
  const fixture = await startTestBox(
    (_request, socket) => {
      upstreamUpgrades += 1;
      socket.on("error", () => undefined);
      socket.end("HTTP/1.1 418 Teapot\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    },
    undefined,
    undefined,
    (_request, response) => {
      upstreamHttpRequests += 1;
      response.end("proxied");
    },
  );
  try {
    const cookie = await login(fixture.box);
    const malformedHttp = await fetch(`${fixture.box.url}/screen/assets/%`, {
      headers: { cookie },
    });
    const malformedUpgrade = await rawUpgradeResponse(
      fixture.box,
      "/screen/websockify/%",
      cookie,
    );

    assert.equal(malformedHttp.status, 400);
    assert.equal(malformedUpgrade.status, 400);
    assert.equal(upstreamHttpRequests, 0);
    assert.equal(upstreamUpgrades, 0);

    const survived = await fetch(`${fixture.box.url}/api/inbox`, { headers: { cookie } });
    assert.equal(survived.status, 200);
  } finally {
    await fixture.cleanup();
  }
});

test("a client reset during a rejected malformed upgrade does not stop Talk", async () => {
  const fixture = await startTestBox();
  try {
    const cookie = await login(fixture.box);
    await resetRejectedUpgrade(fixture.box, "/screen/%", cookie);
    await new Promise((resolve) => setTimeout(resolve, 25));

    const survived = await fetch(`${fixture.box.url}/api/inbox`, { headers: { cookie } });
    assert.equal(survived.status, 200);
  } finally {
    await fixture.cleanup();
  }
});

test("an unanswered upstream upgrade handshake releases both sockets and Talk survives", async () => {
  let acceptedSocket: net.Socket | undefined;
  let accepted!: () => void;
  let closed!: () => void;
  const upstreamAccepted = new Promise<void>((resolve) => {
    accepted = resolve;
  });
  const upstreamClosed = new Promise<void>((resolve) => {
    closed = resolve;
  });
  const limits = {
    ...TEST_TRANSPORT_LIMITS,
    headersTimeoutMs: 80,
    requestTimeoutMs: 120,
    idleTimeoutMs: 80,
    keepAliveTimeoutMs: 40,
  };
  const fixture = await startTestBox((_request, socket) => {
    acceptedSocket = socket;
    socket.on("error", () => undefined);
    socket.once("close", closed);
    socket.resume();
    accepted();
  }, undefined, limits);
  try {
    const cookie = await login(fixture.box);
    const target = new URL(fixture.box.url);
    const downstreamClosed = rawRequestUntilClose(
      fixture.box,
      [
        "GET /screen/websockify HTTP/1.1",
        `Host: ${target.host}`,
        `Cookie: ${cookie}`,
        "Connection: Upgrade",
        "Upgrade: websocket",
        "Sec-WebSocket-Version: 13",
        `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString("base64")}`,
        "",
        "",
      ].join("\r\n"),
      { deadlineMs: 500 },
    );
    await upstreamAccepted;
    const response = await downstreamClosed;
    assert.ok(Buffer.byteLength(response) <= 512, "handshake-timeout response must stay bounded");

    let closeDeadline!: NodeJS.Timeout;
    try {
      await Promise.race([
        upstreamClosed,
        new Promise<never>((_resolve, reject) => {
          closeDeadline = setTimeout(() => reject(new Error("unanswered upstream upgrade stayed open")), 250);
        }),
      ]);
    } finally {
      clearTimeout(closeDeadline);
    }

    const survived = await fetch(`${fixture.box.url}/api/inbox`, { headers: { cookie } });
    assert.equal(survived.status, 200);
  } finally {
    acceptedSocket?.destroy();
    await fixture.cleanup();
  }
});

test("a stalled non-101 upgrade response releases both sockets and Talk survives", async () => {
  let acceptedSocket: net.Socket | undefined;
  let closed!: () => void;
  const upstreamClosed = new Promise<void>((resolve) => {
    closed = resolve;
  });
  const limits = {
    ...TEST_TRANSPORT_LIMITS,
    headersTimeoutMs: 80,
    requestTimeoutMs: 120,
    idleTimeoutMs: 80,
    keepAliveTimeoutMs: 40,
  };
  const fixture = await startTestBox((_request, socket) => {
    acceptedSocket = socket;
    socket.on("error", () => undefined);
    socket.once("close", closed);
    socket.write("HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\nx");
    socket.resume();
  }, undefined, limits);
  try {
    const cookie = await login(fixture.box);
    const target = new URL(fixture.box.url);
    const response = await rawRequestUntilClose(
      fixture.box,
      [
        "GET /screen/websockify HTTP/1.1",
        `Host: ${target.host}`,
        `Cookie: ${cookie}`,
        "Connection: Upgrade",
        "Upgrade: websocket",
        "Sec-WebSocket-Version: 13",
        `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString("base64")}`,
        "",
        "",
      ].join("\r\n"),
      { deadlineMs: 500 },
    );
    assert.match(response, /^HTTP\/1\.1 200 OK/u);
    assert.ok(Buffer.byteLength(response) <= 512, "stalled non-101 response must stay bounded");

    let closeDeadline!: NodeJS.Timeout;
    try {
      await Promise.race([
        upstreamClosed,
        new Promise<never>((_resolve, reject) => {
          closeDeadline = setTimeout(() => reject(new Error("stalled non-101 upstream stayed open")), 250);
        }),
      ]);
    } finally {
      clearTimeout(closeDeadline);
    }

    const survived = await fetch(`${fixture.box.url}/api/inbox`, { headers: { cookie } });
    assert.equal(survived.status, 200);
  } finally {
    acceptedSocket?.destroy();
    await fixture.cleanup();
  }
});

test("a complete bounded non-101 upgrade response reaches the client", async () => {
  const fixture = await startTestBox((_request, socket) => {
    socket.on("error", () => undefined);
    socket.end("HTTP/1.1 200 OK\r\nContent-Length: 6\r\nConnection: close\r\n\r\ndenied");
  });
  try {
    const cookie = await login(fixture.box);
    const response = await rawUpgradeResponse(fixture.box, "/screen/websockify", cookie);
    assert.equal(response.status, 200);
    assert.equal(response.body, "denied");

    const survived = await fetch(`${fixture.box.url}/api/inbox`, { headers: { cookie } });
    assert.equal(survived.status, 200);
  } finally {
    await fixture.cleanup();
  }
});

test("a complete chunked non-101 upgrade response reaches the client", async () => {
  const fixture = await startTestBox((_request, socket) => {
    socket.on("error", () => undefined);
    socket.end(
      "HTTP/1.1 403 Forbidden\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n" +
        "3\r\nnot\r\n5\r\n-okay\r\n0\r\n\r\n",
    );
  });
  try {
    const cookie = await login(fixture.box);
    const response = await rawUpgradeResponse(fixture.box, "/screen/websockify", cookie);
    assert.equal(response.status, 403);
    assert.equal(response.body, "not-okay");

    const survived = await fetch(`${fixture.box.url}/api/inbox`, { headers: { cookie } });
    assert.equal(survived.status, 200);
  } finally {
    await fixture.cleanup();
  }
});

test("an abandoned Screen HTTP proxy releases its upstream socket and Talk survives", async () => {
  let acceptedSocket: net.Socket | undefined;
  let accepted!: () => void;
  let closed!: () => void;
  const upstreamAccepted = new Promise<void>((resolve) => {
    accepted = resolve;
  });
  const upstreamClosed = new Promise<void>((resolve) => {
    closed = resolve;
  });
  const limits = {
    ...TEST_TRANSPORT_LIMITS,
    headersTimeoutMs: 80,
    requestTimeoutMs: 120,
    idleTimeoutMs: 80,
    keepAliveTimeoutMs: 40,
  };
  const fixture = await startTestBox(
    undefined,
    undefined,
    limits,
    (request) => {
      acceptedSocket = request.socket;
      request.socket.on("error", () => undefined);
      request.socket.once("close", closed);
      request.resume();
      accepted();
    },
  );
  try {
    const cookie = await login(fixture.box);
    const downstreamAbort = new AbortController();
    const downstreamClosed = fetch(`${fixture.box.url}/screen/`, {
      headers: { cookie },
      signal: downstreamAbort.signal,
    }).catch(() => null);
    await upstreamAccepted;
    let downstreamDeadline!: NodeJS.Timeout;
    try {
      await Promise.race([
        downstreamClosed,
        new Promise<never>((_resolve, reject) => {
          downstreamDeadline = setTimeout(() => reject(new Error("Screen client stayed open")), 500);
        }),
      ]);
    } finally {
      clearTimeout(downstreamDeadline);
      downstreamAbort.abort();
    }

    let closeDeadline!: NodeJS.Timeout;
    try {
      await Promise.race([
        upstreamClosed,
        new Promise<never>((_resolve, reject) => {
          closeDeadline = setTimeout(() => reject(new Error("abandoned Screen upstream stayed open")), 250);
        }),
      ]);
    } finally {
      clearTimeout(closeDeadline);
    }

    const survived = await fetch(`${fixture.box.url}/api/inbox`, { headers: { cookie } });
    assert.equal(survived.status, 200);
  } finally {
    acceptedSocket?.destroy();
    await fixture.cleanup();
  }
});

test("a stalled Screen HTTP response body releases both sides and Talk survives", async () => {
  let acceptedSocket: net.Socket | undefined;
  let closed!: () => void;
  const upstreamClosed = new Promise<void>((resolve) => {
    closed = resolve;
  });
  const limits = {
    ...TEST_TRANSPORT_LIMITS,
    headersTimeoutMs: 100,
    bodyProgressTimeoutMs: 80,
    requestTimeoutMs: 500,
    idleTimeoutMs: 400,
  };
  const fixture = await startTestBox(
    undefined,
    undefined,
    limits,
    (request, response) => {
      acceptedSocket = request.socket;
      request.socket.on("error", () => undefined);
      request.socket.once("close", closed);
      request.resume();
      response.writeHead(200, { "content-length": "100" });
      response.write("x");
    },
  );
  try {
    const cookie = await login(fixture.box);
    const target = new URL(fixture.box.url);
    const response = await rawRequestUntilClose(
      fixture.box,
      [
        "GET /screen/ HTTP/1.1",
        `Host: ${target.host}`,
        `Cookie: ${cookie}`,
        "Connection: close",
        "",
        "",
      ].join("\r\n"),
      { deadlineMs: 300 },
    );
    assert.match(response, /^HTTP\/1\.1 200 OK/u);
    assert.ok(Buffer.byteLength(response) <= 512, "stalled Screen response must stay bounded");

    let closeDeadline!: NodeJS.Timeout;
    try {
      await Promise.race([
        upstreamClosed,
        new Promise<never>((_resolve, reject) => {
          closeDeadline = setTimeout(() => reject(new Error("stalled Screen HTTP upstream stayed open")), 250);
        }),
      ]);
    } finally {
      clearTimeout(closeDeadline);
    }

    const survived = await fetch(`${fixture.box.url}/api/inbox`, { headers: { cookie } });
    assert.equal(survived.status, 200);
  } finally {
    acceptedSocket?.destroy();
    await fixture.cleanup();
  }
});

test("a trickling Screen HTTP body cannot exceed the total deadline", async () => {
  let acceptedSocket: net.Socket | undefined;
  let trickle: NodeJS.Timeout | undefined;
  let closed!: () => void;
  const upstreamClosed = new Promise<void>((resolve) => {
    closed = resolve;
  });
  const limits = {
    ...TEST_TRANSPORT_LIMITS,
    headersTimeoutMs: 100,
    bodyProgressTimeoutMs: 80,
    requestTimeoutMs: 120,
    idleTimeoutMs: 400,
  };
  const fixture = await startTestBox(
    undefined,
    undefined,
    limits,
    (request, response) => {
      acceptedSocket = request.socket;
      request.socket.on("error", () => undefined);
      request.socket.once("close", () => {
        clearInterval(trickle);
        closed();
      });
      request.resume();
      response.writeHead(200, { "content-length": "10000" });
      response.write("x");
      trickle = setInterval(() => response.write("x"), 40);
    },
  );
  try {
    const cookie = await login(fixture.box);
    const target = new URL(fixture.box.url);
    const response = await rawRequestUntilClose(
      fixture.box,
      [
        "GET /screen/ HTTP/1.1",
        `Host: ${target.host}`,
        `Cookie: ${cookie}`,
        "Connection: close",
        "",
        "",
      ].join("\r\n"),
      { deadlineMs: 300 },
    );
    assert.match(response, /^HTTP\/1\.1 200 OK/u);
    assert.ok(Buffer.byteLength(response) <= 512, "trickled Screen response must stay bounded");

    let closeDeadline!: NodeJS.Timeout;
    try {
      await Promise.race([
        upstreamClosed,
        new Promise<never>((_resolve, reject) => {
          closeDeadline = setTimeout(() => reject(new Error("trickled Screen HTTP upstream stayed open")), 250);
        }),
      ]);
    } finally {
      clearTimeout(closeDeadline);
    }

    const survived = await fetch(`${fixture.box.url}/api/inbox`, { headers: { cookie } });
    assert.equal(survived.status, 200);
  } finally {
    clearInterval(trickle);
    acceptedSocket?.destroy();
    await fixture.cleanup();
  }
});

test("a complete Screen HTTP response is preserved by proxy deadlines", async () => {
  const fixture = await startTestBox();
  try {
    const cookie = await login(fixture.box);
    const response = await fetch(`${fixture.box.url}/screen/`, { headers: { cookie } });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "screen");
  } finally {
    await fixture.cleanup();
  }
});

test("an upgraded upstream reset closes both sockets without stopping Talk", async () => {
  const fixture = await startTestBox((_request, socket) => {
    socket.on("error", () => undefined);
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
      () => setTimeout(() => socket.resetAndDestroy(), 10),
    );
  });
  try {
    const cookie = await login(fixture.box);
    await waitForUpgradedSocketToClose(fixture.box, "/screen/websockify", cookie);

    const survived = await fetch(`${fixture.box.url}/api/inbox`, { headers: { cookie } });
    assert.equal(survived.status, 200);
  } finally {
    await fixture.cleanup();
  }
});

test("an upgraded downstream reset closes both sockets without stopping Talk", async () => {
  let upstreamClosed!: () => void;
  const upstreamDidClose = new Promise<void>((resolve) => {
    upstreamClosed = resolve;
  });
  const fixture = await startTestBox((_request, socket) => {
    socket.on("error", () => undefined);
    socket.once("end", () => {
      upstreamClosed();
      socket.destroy();
    });
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    socket.resume();
  });
  try {
    const cookie = await login(fixture.box);
    await resetUpgradedDownstream(fixture.box, "/screen/websockify", cookie);
    let deadline!: NodeJS.Timeout;
    try {
      await Promise.race([
        upstreamDidClose,
        new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(() => reject(new Error("upstream socket remained open")), 500);
        }),
      ]);
    } finally {
      clearTimeout(deadline);
    }

    const survived = await fetch(`${fixture.box.url}/api/inbox`, { headers: { cookie } });
    assert.equal(survived.status, 200);
  } finally {
    await fixture.cleanup();
  }
});

test("Box shutdown closes both sides of every accepted upgraded Screen pair", async () => {
  let upstreamSocket: net.Socket | undefined;
  const fixture = await startTestBox((_request, socket) => {
    upstreamSocket = socket;
    socket.on("error", () => undefined);
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    socket.resume();
  });
  let downstreamSocket: net.Socket | undefined;
  let closeAttempt: Promise<void> | undefined;
  try {
    const cookie = await login(fixture.box);
    downstreamSocket = await openUpgrade(fixture.box, "/screen/websockify", cookie);
    downstreamSocket.on("error", () => undefined);
    assert.ok(upstreamSocket, "Screen upstream did not accept the upgrade");

    const downstreamClosed = new Promise<void>((resolve) => {
      downstreamSocket?.once("close", resolve);
    });
    const upstreamClosed = new Promise<void>((resolve) => {
      upstreamSocket?.once("close", resolve);
    });
    closeAttempt = fixture.box.close();

    let closeDeadline!: NodeJS.Timeout;
    try {
      await Promise.race([
        Promise.all([closeAttempt, downstreamClosed, upstreamClosed]),
        new Promise<never>((_resolve, reject) => {
          closeDeadline = setTimeout(() => reject(new Error("Box shutdown left an upgraded pair open")), 500);
        }),
      ]);
    } finally {
      clearTimeout(closeDeadline);
    }
  } finally {
    downstreamSocket?.destroy();
    upstreamSocket?.destroy();
    await closeAttempt?.catch(() => undefined);
    await fixture.cleanup(Boolean(closeAttempt));
  }
});

test("the HTTP idle deadline does not close a legitimate upgraded Screen socket", async () => {
  let receivedPing!: () => void;
  const pingReceived = new Promise<void>((resolve) => {
    receivedPing = resolve;
  });
  const limits = {
    ...TEST_TRANSPORT_LIMITS,
    headersTimeoutMs: 200,
    requestTimeoutMs: 400,
    idleTimeoutMs: 80,
  };
  const fixture = await startTestBox((_request, socket) => {
    socket.on("error", () => undefined);
    socket.once("end", () => socket.destroy());
    socket.on("data", (chunk) => {
      if (chunk.toString("utf8") === "ping") receivedPing();
    });
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    socket.resume();
  }, undefined, limits);
  let upgraded: net.Socket | undefined;
  try {
    const cookie = await login(fixture.box);
    upgraded = await openUpgrade(fixture.box, "/screen/websockify", cookie);
    let closed = false;
    upgraded.once("close", () => {
      closed = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 160));
    assert.equal(closed, false, "HTTP idle timeout closed an upgraded Screen connection");
    upgraded.write("ping");
    let pingDeadline!: NodeJS.Timeout;
    try {
      await Promise.race([
        pingReceived,
        new Promise<never>((_resolve, reject) => {
          pingDeadline = setTimeout(() => reject(new Error("upgraded ping did not reach Screen")), 500);
        }),
      ]);
    } finally {
      clearTimeout(pingDeadline);
    }

    const survived = await fetch(`${fixture.box.url}/api/inbox`, { headers: { cookie } });
    assert.equal(survived.status, 200);
  } finally {
    upgraded?.destroy();
    await fixture.cleanup();
  }
});

test("static files cannot follow a symlink outside the PWA build root", async () => {
  const outsideMarker = "outside-static-root-marker";
  const fixture = await startTestBox(undefined, async (root, pwaDir) => {
    const outside = join(root, "outside.txt");
    await writeFile(outside, outsideMarker);
    await symlink(outside, join(pwaDir, "leak.txt"));
  });
  try {
    const escaped = await fetch(`${fixture.box.url}/leak.txt`);
    const escapedBody = await escaped.text();

    assert.ok(escaped.status === 400 || escaped.status === 404, `unexpected status ${escaped.status}`);
    assert.doesNotMatch(escapedBody, new RegExp(outsideMarker, "u"));

    const index = await fetch(`${fixture.box.url}/`);
    assert.equal(index.status, 200);
    assert.match(await index.text(), /<title>OpenBot<\/title>/u);
  } finally {
    await fixture.cleanup();
  }
});

test("static files reject symlinked parent directories but preserve real nested assets", async () => {
  const outsideMarker = "outside-static-directory-marker";
  const fixture = await startTestBox(undefined, async (root, pwaDir) => {
    const outsideDir = join(root, "outside-assets");
    await mkdir(outsideDir);
    await writeFile(join(outsideDir, "leak.js"), outsideMarker);
    await symlink(outsideDir, join(pwaDir, "linked-assets"));

    const realDir = join(pwaDir, "assets");
    await mkdir(realDir);
    await writeFile(join(realDir, "app.js"), "console.log('openbot');");
  });
  try {
    const escaped = await fetch(`${fixture.box.url}/linked-assets/leak.js`);
    const escapedBody = await escaped.text();
    assert.ok(escaped.status === 400 || escaped.status === 404, `unexpected status ${escaped.status}`);
    assert.doesNotMatch(escapedBody, new RegExp(outsideMarker, "u"));

    const legitimate = await fetch(`${fixture.box.url}/assets/app.js`);
    assert.equal(legitimate.status, 200);
    assert.equal(legitimate.headers.get("content-type"), "text/javascript; charset=utf-8");
    assert.equal(await legitimate.text(), "console.log('openbot');");
  } finally {
    await fixture.cleanup();
  }
});

test("malformed percent-encoding gets a bounded HTTP client error and Talk survives", async () => {
  const fixture = await startTestBox();
  try {
    const malformed = await fetch(`${fixture.box.url}/asset/%`);
    const body = await malformed.text();

    assert.equal(malformed.status, 400);
    assert.ok(Buffer.byteLength(body) <= 256, "malformed-path response must stay bounded");
    assert.doesNotMatch(body, /URIError|stack|daemon\/src/u);

    const index = await fetch(`${fixture.box.url}/`);
    assert.equal(index.status, 200);
  } finally {
    await fixture.cleanup();
  }
});

test("malformed absolute request targets get a bounded client error and Talk survives", async () => {
  const fixture = await startTestBox();
  try {
    const response = await rawRequestUntilClose(
      fixture.box,
      [
        "GET http://%/ HTTP/1.1",
        "Host: 127.0.0.1",
        "Connection: close",
        "",
        "",
      ].join("\r\n"),
    );

    assert.match(response, /^HTTP\/1\.1 400 /u);
    assert.ok(Buffer.byteLength(response) <= 512, "malformed-target response must stay bounded");
    assert.doesNotMatch(response, /TypeError|stack|daemon\/src/u);

    const cookie = await login(fixture.box);
    const survived = await fetch(`${fixture.box.url}/api/inbox`, { headers: { cookie } });
    assert.equal(survived.status, 200);
  } finally {
    await fixture.cleanup();
  }
});

test("encoded NUL paths get a bounded client error instead of the SPA fallback", async () => {
  const fixture = await startTestBox();
  try {
    const malformed = await fetch(`${fixture.box.url}/asset/%00`);
    const body = await malformed.text();
    assert.equal(malformed.status, 400);
    assert.ok(Buffer.byteLength(body) <= 256, "NUL-path response must stay bounded");

    const index = await fetch(`${fixture.box.url}/`);
    assert.equal(index.status, 200);
  } finally {
    await fixture.cleanup();
  }
});

test("malformed encoded API identifiers get a bounded client error and Talk survives", async () => {
  const fixture = await startTestBox();
  try {
    const cookie = await login(fixture.box);
    const malformed = await fetch(`${fixture.box.url}/api/bots/%/messages`, { headers: { cookie } });
    const body = await malformed.text();

    assert.equal(malformed.status, 400);
    assert.ok(Buffer.byteLength(body) <= 256, "malformed-identifier response must stay bounded");
    assert.doesNotMatch(body, /URIError|stack|daemon\/src/u);

    const survived = await fetch(`${fixture.box.url}/api/inbox`, { headers: { cookie } });
    assert.equal(survived.status, 200);
  } finally {
    await fixture.cleanup();
  }
});

test("unsupported methods get a bounded 405 while unknown API paths stay 404", async () => {
  const fixture = await startTestBox();
  try {
    const unsupported = await fetch(`${fixture.box.url}/api/session`, { method: "PUT" });
    const unsupportedBody = await unsupported.text();
    assert.equal(unsupported.status, 405);
    assert.equal(unsupported.headers.get("allow"), "GET, POST, DELETE");
    assert.ok(Buffer.byteLength(unsupportedBody) <= 256, "method-error response must stay bounded");
    assert.deepEqual(JSON.parse(unsupportedBody) as unknown, { error: "method not allowed" });

    const unknown = await fetch(`${fixture.box.url}/api/not-a-route`, { method: "PUT" });
    assert.equal(unknown.status, 404);

    const cookie = await login(fixture.box);
    const survived = await fetch(`${fixture.box.url}/api/inbox`, { headers: { cookie } });
    assert.equal(survived.status, 200);
  } finally {
    await fixture.cleanup();
  }
});

test("HEAD preserves static content metadata without sending a body", async () => {
  const fixture = await startTestBox();
  try {
    const get = await fetch(`${fixture.box.url}/`);
    const getBody = await get.text();
    const head = await fetch(`${fixture.box.url}/`, { method: "HEAD" });

    assert.equal(head.status, get.status);
    assert.equal(head.headers.get("content-type"), get.headers.get("content-type"));
    assert.equal(head.headers.get("content-length"), String(Buffer.byteLength(getBody)));
    assert.equal(await head.text(), "");

    const missing = await fetch(`${fixture.box.url}/missing.js`, { method: "HEAD" });
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get("content-type"), "application/json; charset=utf-8");
    assert.equal(missing.headers.get("content-length"), String(Buffer.byteLength('{"error":"not found"}')));
    assert.equal(await missing.text(), "");
  } finally {
    await fixture.cleanup();
  }
});

test("encoded traversal cannot leave the PWA build root", async () => {
  const outsideMarker = "outside-traversal-marker";
  const fixture = await startTestBox(undefined, async (root) => {
    await writeFile(join(root, "outside.txt"), outsideMarker);
  });
  try {
    const traversal = await fetch(`${fixture.box.url}/..%2Foutside.txt`);
    const body = await traversal.text();
    assert.equal(traversal.status, 400);
    assert.doesNotMatch(body, new RegExp(outsideMarker, "u"));

    const index = await fetch(`${fixture.box.url}/`);
    assert.equal(index.status, 200);
  } finally {
    await fixture.cleanup();
  }
});

test("the SPA fallback cannot follow a symlinked index outside the PWA build root", async () => {
  const outsideMarker = "outside-spa-fallback-marker";
  const fixture = await startTestBox(undefined, async (root, pwaDir) => {
    const outside = join(root, "outside-index.html");
    await writeFile(outside, outsideMarker);
    await rm(join(pwaDir, "index.html"));
    await symlink(outside, join(pwaDir, "index.html"));
  });
  try {
    const fallback = await fetch(`${fixture.box.url}/chat/client-route`);
    const body = await fallback.text();
    assert.equal(fallback.status, 404);
    assert.doesNotMatch(body, new RegExp(outsideMarker, "u"));
  } finally {
    await fixture.cleanup();
  }
});

test("the Password endpoint rejects an oversized body before parsing and Talk survives", async () => {
  const fixture = await startTestBox();
  try {
    const oversized = await fetch(`${fixture.box.url}/api/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "x".repeat(64 * 1024) }),
    });
    const oversizedBody = await oversized.text();

    assert.equal(oversized.status, 413);
    assert.ok(Buffer.byteLength(oversizedBody) <= 256, "oversized response must stay bounded");
    assert.doesNotMatch(oversizedBody, /correct-horse|stack|daemon\/src/u);

    const cookie = await login(fixture.box);
    const survived = await fetch(`${fixture.box.url}/api/inbox`, { headers: { cookie } });
    assert.equal(survived.status, 200);
  } finally {
    await fixture.cleanup();
  }
});

test("the Password endpoint preserves its specialized empty-body error", async () => {
  const fixture = await startTestBox();
  try {
    const response = await fetch(`${fixture.box.url}/api/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "",
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid Password" });
  } finally {
    await fixture.cleanup();
  }
});

test("a chunked oversized body is bounded without relying on Content-Length", async () => {
  const fixture = await startTestBox();
  try {
    const payload = JSON.stringify({ password: "x".repeat(16 * 1024) });
    const response = await rawRequestUntilClose(
      fixture.box,
      [
        "POST /api/session HTTP/1.1",
        `Host: ${new URL(fixture.box.url).host}`,
        "Content-Type: application/json",
        "Transfer-Encoding: chunked",
        "Connection: close",
        "",
        `${Buffer.byteLength(payload).toString(16)}\r\n${payload}\r\n0\r\n\r\n`,
      ].join("\r\n"),
    );
    assert.match(response, /^HTTP\/1\.1 413 /u);
    assert.ok(Buffer.byteLength(response) <= 512, "chunked-oversize response must stay bounded");

    const cookie = await login(fixture.box);
    const survived = await fetch(`${fixture.box.url}/api/inbox`, { headers: { cookie } });
    assert.equal(survived.status, 200);
  } finally {
    await fixture.cleanup();
  }
});

test("All Bots instructions have their own bounded body budget", async () => {
  const fixture = await startTestBox();
  try {
    const cookie = await login(fixture.box);
    const legitimateText = `# All Bots\n${"a".repeat(16 * 1024)}`;
    const legitimate = await fetch(`${fixture.box.url}/api/agents`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ text: legitimateText }),
    });
    assert.equal(legitimate.status, 200);

    const oversized = await fetch(`${fixture.box.url}/api/agents`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ text: "a".repeat(1024 * 1024 + 1) }),
    });
    assert.equal(oversized.status, 413);

    const survived = await fetch(`${fixture.box.url}/api/agents`, { headers: { cookie } });
    assert.equal(survived.status, 200);
    assert.equal(((await survived.json()) as { text: string }).text, legitimateText);
  } finally {
    await fixture.cleanup();
  }
});

test("instruction mutations reject empty and non-object JSON without erasing stored text", async () => {
  const fixture = await startTestBox();
  try {
    const cookie = await login(fixture.box);
    const seed = await fetch(`${fixture.box.url}/api/agents`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ text: "KEEP-ME" }),
    });
    assert.equal(seed.status, 200);

    for (const body of ["", "[]", "null", '"primitive"']) {
      const rejected = await fetch(`${fixture.box.url}/api/agents`, {
        method: "PUT",
        headers: { cookie, "content-type": "application/json" },
        body,
      });
      assert.equal(rejected.status, 400, `expected ${body} to be rejected`);
      assert.deepEqual(await rejected.json(), { error: "request body must be a JSON object" });

      const stored = await fetch(`${fixture.box.url}/api/agents`, { headers: { cookie } });
      assert.equal(stored.status, 200);
      assert.deepEqual(await stored.json(), { text: "KEEP-ME" });
    }
  } finally {
    await fixture.cleanup();
  }
});

test("action mutations reject empty, array, null, and primitive JSON before changing a Bot", async () => {
  const fixture = await startTestBox();
  try {
    const cookie = await login(fixture.box);
    const created = await fetch(`${fixture.box.url}/api/bots`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Ada" }),
    });
    assert.equal(created.status, 201);
    const bot = (await created.json()) as { id: string; configMode: string };

    for (const body of ["", "[]", "null", "7"]) {
      const rejected = await fetch(`${fixture.box.url}/api/bots/${bot.id}`, {
        method: "PATCH",
        headers: { cookie, "content-type": "application/json" },
        body,
      });
      assert.equal(rejected.status, 400, `expected ${body} to be rejected`);
      assert.deepEqual(await rejected.json(), { error: "request body must be a JSON object" });

      const stored = await fetch(`${fixture.box.url}/api/bots/${bot.id}`, { headers: { cookie } });
      assert.equal(stored.status, 200);
      assert.equal(((await stored.json()) as { configMode: string }).configMode, bot.configMode);
    }
  } finally {
    await fixture.cleanup();
  }
});

test("ordinary API actions reject oversized bodies without mutating state", async () => {
  const fixture = await startTestBox();
  try {
    const cookie = await login(fixture.box);
    const oversized = await fetch(`${fixture.box.url}/api/bots`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "a".repeat(128 * 1024) }),
    });
    assert.equal(oversized.status, 413);

    const bots = await fetch(`${fixture.box.url}/api/bots`, { headers: { cookie } });
    assert.equal(bots.status, 200);
    assert.deepEqual((await bots.json()) as { bots: unknown[] }, { bots: [] });
  } finally {
    await fixture.cleanup();
  }
});

test("a partial HTTP header is closed by the header deadline and Talk survives", async () => {
  const fixture = await startTestBox(undefined, undefined, TEST_TRANSPORT_LIMITS);
  try {
    await rawRequestUntilClose(
      fixture.box,
      `POST /api/session HTTP/1.1\r\nHost: ${new URL(fixture.box.url).host}\r\nContent-Type: application/json\r\n`,
    );

    const cookie = await login(fixture.box);
    const survived = await fetch(`${fixture.box.url}/api/inbox`, { headers: { cookie } });
    assert.equal(survived.status, 200);
  } finally {
    await fixture.cleanup();
  }
});

test("a stalled request body is closed by the body-progress deadline and Talk survives", async () => {
  const limits = {
    ...TEST_TRANSPORT_LIMITS,
    headersTimeoutMs: 200,
    requestTimeoutMs: 800,
    idleTimeoutMs: 800,
  };
  const fixture = await startTestBox(undefined, undefined, limits);
  try {
    const response = await rawRequestUntilClose(
      fixture.box,
      [
        "POST /api/session HTTP/1.1",
        `Host: ${new URL(fixture.box.url).host}`,
        "Content-Type: application/json",
        "Content-Length: 64",
        "Connection: keep-alive",
        "",
        "{",
      ].join("\r\n"),
      { deadlineMs: 400 },
    );
    assert.match(response, /^HTTP\/1\.1 408 /u);

    const cookie = await login(fixture.box);
    const survived = await fetch(`${fixture.box.url}/api/inbox`, { headers: { cookie } });
    assert.equal(survived.status, 200);
  } finally {
    await fixture.cleanup();
  }
});

test("an idle connection is closed by the socket deadline and Talk survives", async () => {
  const limits = {
    ...TEST_TRANSPORT_LIMITS,
    headersTimeoutMs: 800,
    requestTimeoutMs: 800,
    idleTimeoutMs: 80,
  };
  const fixture = await startTestBox(undefined, undefined, limits);
  try {
    await rawRequestUntilClose(fixture.box, "", { deadlineMs: 400 });

    const cookie = await login(fixture.box);
    const survived = await fetch(`${fixture.box.url}/api/inbox`, { headers: { cookie } });
    assert.equal(survived.status, 200);
  } finally {
    await fixture.cleanup();
  }
});

test("a fully received request can return a bounded handler failure after the idle interval", async () => {
  const delayedStore = {
    reattachDisplays: async () => undefined,
    close: () => undefined,
    send: async () => {
      await new Promise((resolve) => setTimeout(resolve, 140));
      throw Object.assign(new Error("Harness failed to start"), { status: 503 });
    },
    inbox: () => ({ bots: [] }),
  } as unknown as NonNullable<BoxOptions["botStore"]>;
  const limits = {
    ...TEST_TRANSPORT_LIMITS,
    headersTimeoutMs: 100,
    bodyProgressTimeoutMs: 100,
    requestTimeoutMs: 500,
    idleTimeoutMs: 70,
    keepAliveTimeoutMs: 40,
  };
  const fixture = await startTestBox(
    undefined,
    undefined,
    limits,
    undefined,
    delayedStore,
  );
  try {
    const cookie = await login(fixture.box);
    const response = await fetch(`${fixture.box.url}/api/bots/bot-1/messages`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "Harness failed to start" });

    const survived = await fetch(`${fixture.box.url}/api/inbox`, { headers: { cookie } });
    assert.equal(survived.status, 200);
  } finally {
    await fixture.cleanup();
  }
});

test("pipelined handlers keep the idle deadline suspended until every handler completes", async () => {
  const delayedStore = {
    reattachDisplays: async () => undefined,
    close: () => undefined,
    send: async () => {
      await new Promise((resolve) => setTimeout(resolve, 140));
      throw Object.assign(new Error("Harness failed to start"), { status: 503 });
    },
    inbox: () => ({ bots: [] }),
  } as unknown as NonNullable<BoxOptions["botStore"]>;
  const limits = {
    ...TEST_TRANSPORT_LIMITS,
    headersTimeoutMs: 100,
    bodyProgressTimeoutMs: 100,
    requestTimeoutMs: 500,
    idleTimeoutMs: 70,
    keepAliveTimeoutMs: 40,
  };
  const fixture = await startTestBox(
    undefined,
    undefined,
    limits,
    undefined,
    delayedStore,
  );
  try {
    const cookie = await login(fixture.box);
    const target = new URL(fixture.box.url);
    const body = JSON.stringify({ text: "hello" });
    const response = await rawRequestUntilClose(
      fixture.box,
      [
        "POST /api/bots/bot-1/messages HTTP/1.1",
        `Host: ${target.host}`,
        `Cookie: ${cookie}`,
        "Content-Type: application/json",
        `Content-Length: ${Buffer.byteLength(body)}`,
        "Connection: keep-alive",
        "",
        body,
        "GET /api/inbox HTTP/1.1",
        `Host: ${target.host}`,
        `Cookie: ${cookie}`,
        "Connection: close",
        "",
        "",
      ].join("\r\n"),
      { deadlineMs: 500 },
    );
    assert.match(response, /^HTTP\/1\.1 503 /u);
    assert.match(response, /HTTP\/1\.1 200 /u);
    assert.match(response, /Harness failed to start/u);

    const survived = await fetch(`${fixture.box.url}/api/inbox`, { headers: { cookie } });
    assert.equal(survived.status, 200);
  } finally {
    await fixture.cleanup();
  }
});

test("a trickled body is closed by the total request deadline and Talk survives", async () => {
  const limits = {
    ...TEST_TRANSPORT_LIMITS,
    bodyProgressTimeoutMs: 100,
    requestTimeoutMs: 240,
    idleTimeoutMs: 800,
  };
  const fixture = await startTestBox(undefined, undefined, limits);
  try {
    const response = await trickleRequestUntilClose(
      fixture.box,
      [
        "POST /api/session HTTP/1.1",
        `Host: ${new URL(fixture.box.url).host}`,
        "Content-Type: application/json",
        "Content-Length: 1024",
        "Connection: keep-alive",
        "",
        "{",
      ].join("\r\n"),
      40,
      600,
    );
    assert.match(response, /^HTTP\/1\.1 408 /u);

    const cookie = await login(fixture.box);
    const survived = await fetch(`${fixture.box.url}/api/inbox`, { headers: { cookie } });
    assert.equal(survived.status, 200);
  } finally {
    await fixture.cleanup();
  }
});

test("malformed JSON gets a bounded client error and Talk survives", async () => {
  const fixture = await startTestBox();
  try {
    const malformed = await fetch(`${fixture.box.url}/api/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"password":',
    });
    const body = await malformed.text();

    assert.equal(malformed.status, 400);
    assert.ok(Buffer.byteLength(body) <= 256, "malformed-JSON response must stay bounded");
    assert.deepEqual(JSON.parse(body) as unknown, { error: "invalid json" });

    const cookie = await login(fixture.box);
    const survived = await fetch(`${fixture.box.url}/api/inbox`, { headers: { cookie } });
    assert.equal(survived.status, 200);
  } finally {
    await fixture.cleanup();
  }
});

test("a truncated request body closes with a bounded client error and Talk survives", async () => {
  const fixture = await startTestBox();
  try {
    const response = await rawRequestUntilClose(
      fixture.box,
      [
        "POST /api/session HTTP/1.1",
        `Host: ${new URL(fixture.box.url).host}`,
        "Content-Type: application/json",
        "Content-Length: 64",
        "Connection: close",
        "",
        '{"password":"x"',
      ].join("\r\n"),
      { end: true },
    );

    assert.match(response, /^HTTP\/1\.1 400 /u);
    assert.ok(Buffer.byteLength(response) <= 512, "truncated-body response must stay bounded");
    assert.doesNotMatch(response, /ECONNRESET|stack|daemon\/src/u);

    const cookie = await login(fixture.box);
    const survived = await fetch(`${fixture.box.url}/api/inbox`, { headers: { cookie } });
    assert.equal(survived.status, 200);
  } finally {
    await fixture.cleanup();
  }
});

test("Talk survives adversarial HTTP and WebSocket inputs on one daemon instance", async () => {
  const fixture = await startTestBox((_request, socket) => {
    socket.on("error", () => undefined);
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
      () => setTimeout(() => socket.resetAndDestroy(), 10),
    );
  });
  try {
    const cookie = await login(fixture.box);

    const malformedJson = await fetch(`${fixture.box.url}/api/bots`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: "{",
    });
    assert.equal(malformedJson.status, 400);

    const malformedStaticPath = await fetch(`${fixture.box.url}/asset/%`);
    assert.equal(malformedStaticPath.status, 400);

    const malformedApiPath = await fetch(`${fixture.box.url}/api/bots/%/messages`, {
      headers: { cookie },
    });
    assert.equal(malformedApiPath.status, 400);

    const malformedUpgrade = await rawUpgradeResponse(fixture.box, "/screen/%", cookie);
    assert.equal(malformedUpgrade.status, 400);

    await waitForUpgradedSocketToClose(fixture.box, "/screen/websockify", cookie);

    const survived = await fetch(`${fixture.box.url}/api/inbox`, { headers: { cookie } });
    assert.equal(survived.status, 200);
  } finally {
    await fixture.cleanup();
  }
});

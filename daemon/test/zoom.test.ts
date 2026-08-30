import assert from "node:assert/strict";
import http from "node:http";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { startBox, type RunningBox } from "../src/box.ts";
import { BotStore } from "../src/bots.ts";
import { MemoryComputerRuntime } from "../src/computer.ts";
import {
  KasmWriteOwnership,
  kasmUpdateUserUrl,
  kasmUpdateWrite,
} from "../src/kasm.ts";

const PASSWORD = "correct-horse";
const KASM_USER = "openbot";
const KASM_PASSWORD = "openbot";
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../..");

function cookieHeader(res: Response): string {
  return res.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
}

async function login(url: string): Promise<string> {
  const res = await fetch(`${url}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  assert.ok(res.ok, `login failed: ${res.status}`);
  return cookieHeader(res);
}

async function computerEpoch(url: string, cookie: string, botId: string): Promise<string> {
  const res = await fetch(`${url}/api/computer?botId=${encodeURIComponent(botId)}`, {
    headers: { cookie },
  });
  assert.ok(res.ok, `Computer epoch refresh failed: ${res.status}`);
  const body = (await res.json()) as { ownershipEpoch?: string };
  assert.equal(typeof body.ownershipEpoch, "string");
  return body.ownershipEpoch as string;
}

async function waitForComputerOwnership(
  url: string,
  cookie: string,
  botId: string,
  expected: string,
): Promise<Record<string, unknown>> {
  // Test-only contention margin for background persisted Screen reconciliation.
  const deadline = Date.now() + 5_000;
  let observed: Record<string, unknown> = {};
  while (Date.now() < deadline) {
    const response = await fetch(`${url}/api/computer?botId=${encodeURIComponent(botId)}`, {
      headers: { cookie },
    });
    assert.equal(response.status, 200);
    observed = (await response.json()) as Record<string, unknown>;
    if (observed.ownership === expected && observed.screenState === "ready") return observed;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Computer ownership did not settle as ${expected}: ${JSON.stringify(observed)}`);
}

async function emptyPwa(): Promise<string> {
  const pwaDir = await mkdtemp(join(tmpdir(), "openbot-pwa-"));
  await writeFile(join(pwaDir, "index.html"), `<!doctype html><title>OpenBot</title>`);
  return pwaDir;
}

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("Kasm write URL", () => {
  test("update_user sets write true or false on the real Kasm path", () => {
    const on = kasmUpdateUserUrl({
      upstream: "http://127.0.0.1:16901",
      user: "openbot",
      password: "openbot",
      name: "openbot",
      write: true,
    });
    assert.equal(on.pathname, "/api/update_user");
    assert.equal(on.searchParams.get("write"), "true");
    const off = kasmUpdateUserUrl({
      upstream: "http://127.0.0.1:16901",
      user: "openbot",
      password: "openbot",
      name: "openbot",
      write: false,
    });
    assert.equal(off.searchParams.get("write"), "false");
  });

  test("a redirect never confirms or publishes Kasm write authority", async () => {
    const writes: boolean[] = [];
    const stub = http.createServer((req, res) => {
      const dest = new URL(req.url ?? "/", "http://kasm.local");
      const write = dest.searchParams.get("write") === "true";
      writes.push(write);
      if (write) {
        res.writeHead(302, { location: "/login" });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end("{}");
    });
    await new Promise<void>((resolve, reject) => {
      stub.once("error", reject);
      stub.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = stub.address();
    if (!addr || typeof addr === "string") throw new Error("stub failed to bind");

    const published: string[] = [];
    const ownership = new KasmWriteOwnership({
      update: (_target, write) => kasmUpdateWrite({
        upstream: `http://127.0.0.1:${addr.port}`,
        user: KASM_USER,
        password: KASM_PASSWORD,
        name: "openbot",
        write,
      }),
      publish: (_target, state) => published.push(state.authority),
    });
    try {
      await ownership.register("display-1");
      published.length = 0;
      await assert.rejects(
        ownership.transition("display-1", true, ownership.epoch()),
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          assert.match(message, /Kasm update_user failed: 302/);
          assert.doesNotMatch(message, /login/i);
          return true;
        },
      );
      assert.equal(published.includes("write"), false);
      assert.equal(ownership.state("display-1").authority, "view-only");
      assert.deepEqual(writes, [false, true, false]);
    } finally {
      await new Promise<void>((resolve) => stub.close(() => resolve()));
    }
  });
});

describe("Zoom HTTP seam",
  () => {
    let box: RunningBox;
    let computer: MemoryComputerRuntime;
    let stub: http.Server;
    let kasmWrites: string[] = [];
    let delayedKasmWrite: {
      seen: ReturnType<typeof deferred<string>>;
      responseStatus: ReturnType<typeof deferred<number>>;
    } | null = null;
    let adaId = "";
    let benId = "";

    before(async () => {
      stub = http.createServer((req, res) => {
        const path = req.url ?? "/";
        if (path.startsWith("/api/update_user")) {
          const dest = new URL(path, "http://kasm.local");
          const write = dest.searchParams.get("write") ?? "";
          kasmWrites.push(write);
          const delayed = delayedKasmWrite;
          delayedKasmWrite = null;
          if (delayed) {
            delayed.seen.resolve(write);
            void delayed.responseStatus.promise.then((status) => {
              res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
              res.end("{}");
            });
          } else {
            res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
            res.end("{}");
          }
          return;
        }
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "www-authenticate": "Basic realm=kasm",
        });
        res.end("<html><title>KasmVNC</title><body>desktop-stub</body></html>");
      });
      await new Promise<void>((resolve, reject) => {
        stub.once("error", reject);
        stub.listen(0, "127.0.0.1", () => resolve());
      });
      const addr = stub.address();
      if (!addr || typeof addr === "string") throw new Error("stub failed to bind");
      const upstream = `http://127.0.0.1:${addr.port}`;
      const homeDir = await tempDir("openbot-zoom-home-");
      const cookiesDir = join(await tempDir("openbot-zoom-cookies-"), "cookies");
      await mkdir(cookiesDir, { recursive: true });
      computer = new MemoryComputerRuntime({
        cookiesDir,
        upstreams: [upstream, upstream],
      });
      box = await startBox({
        password: PASSWORD,
        pwaDir: await emptyPwa(),
        host: "127.0.0.1",
        port: 0,
        homeDir,
        computer,
        kasmUser: KASM_USER,
        kasmPassword: KASM_PASSWORD,
      });
      const cookie = await login(box.url);
      const ada = await fetch(`${box.url}/api/bots`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ name: "Ada" }),
      });
      const ben = await fetch(`${box.url}/api/bots`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ name: "Ben" }),
      });
      adaId = ((await ada.json()) as { id: string }).id;
      benId = ((await ben.json()) as { id: string }).id;
    });

    after(async () => {
      await box.close();
      await new Promise<void>((resolve) => stub.close(() => resolve()));
    });

    test("Screen never reports down after start", async () => {
      const cookie = await login(box.url);
      const api = await fetch(`${box.url}/api/computer?botId=${encodeURIComponent(adaId)}`, {
        headers: { cookie },
      });
      assert.ok(api.ok);
      const body = (await api.json()) as { ready?: boolean; path?: string };
      assert.equal(body.ready, true);
      assert.equal(body.path, `/screen/${adaId}/`);
    });

    test("two Bots have two display upstreams on one Computer", async () => {
      const ada = computer.display(adaId);
      const ben = computer.display(benId);
      assert.ok(ada);
      assert.ok(ben);
      assert.equal(ada.display, 1);
      assert.equal(ben.display, 2);
      assert.equal(computer.commands.some((args) => args[0] === "run"), false);
    });

    test("cached intent-less grants fail closed while intent-less releases advance the epoch", async () => {
      const cookie = await login(box.url);
      const before = await computerEpoch(box.url, cookie, adaId);
      kasmWrites = [];
      const staleGrant = await fetch(`${box.url}/api/computer/zoom`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ botId: adaId, zoom: true }),
      });
      assert.equal(staleGrant.status, 409);
      const rejected = (await staleGrant.json()) as {
        error?: string;
        ownershipEpoch?: string;
      };
      assert.equal(rejected.error, "Computer changed. Refresh and retry Computer.");
      assert.equal(rejected.ownershipEpoch, before);
      assert.equal(kasmWrites.includes("true"), false);

      const release = await fetch(`${box.url}/api/computer/zoom`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ botId: adaId, zoom: false }),
      });
      assert.equal(release.status, 200);
      const released = (await release.json()) as { ownershipEpoch?: string };
      assert.equal(typeof released.ownershipEpoch, "string");
      assert.notEqual(released.ownershipEpoch, before);
      assert.ok(kasmWrites.includes("false"));
    });

    test("zoom enables Kasm write; close returns view-only", async () => {
      const cookie = await login(box.url);
      const ownershipEpoch = await computerEpoch(box.url, cookie, adaId);
      kasmWrites = [];
      const zoom = await fetch(`${box.url}/api/computer/zoom`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ botId: adaId, zoom: true, ownershipEpoch }),
      });
      assert.equal(zoom.status, 200, `zoom failed: ${zoom.status}`);
      const zoomed = (await zoom.json()) as { write?: boolean; viewOnly?: boolean; zoom?: boolean };
      assert.equal(zoomed.write, true);
      assert.equal(zoomed.viewOnly, false);
      assert.equal(zoomed.zoom, true);
      assert.ok(kasmWrites.includes("true"));

      const computerApi = await fetch(`${box.url}/api/computer?botId=${encodeURIComponent(adaId)}`, {
        headers: { cookie },
      });
      const info = (await computerApi.json()) as { write?: boolean; viewOnly?: boolean; zoom?: boolean };
      assert.equal(info.write, true);
      assert.equal(info.viewOnly, false);
      assert.equal(info.zoom, true);

      const listed = await fetch(`${box.url}/api/bots`, { headers: { cookie } });
      assert.ok(listed.ok);
      const listBody = (await listed.json()) as { bots: Array<{ id: string; write?: boolean; zoom?: boolean }> };
      const adaRow = listBody.bots.find((bot) => bot.id === adaId);
      assert.ok(adaRow);
      assert.equal(adaRow.write, false, "GET /api/bots write is Session Working, not Screen zoom");
      assert.equal(adaRow.zoom, true);

      const adaGet = await fetch(`${box.url}/api/bots/${adaId}`, { headers: { cookie } });
      const adaBody = (await adaGet.json()) as { write?: boolean; zoom?: boolean };
      assert.equal(adaBody.write, false);
      assert.equal(adaBody.zoom, true);

      kasmWrites = [];
      const close = await fetch(`${box.url}/api/computer/zoom`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ botId: adaId, zoom: false }),
      });
      assert.equal(close.status, 200);
      const closed = (await close.json()) as { write?: boolean; viewOnly?: boolean; zoom?: boolean };
      assert.equal(closed.write, false);
      assert.equal(closed.viewOnly, true);
      assert.equal(closed.zoom, false);
      assert.ok(kasmWrites.includes("false"));
    });

    test("does not publish local zoom before Kasm grants write", async () => {
      const cookie = await login(box.url);
      const ownershipEpoch = await computerEpoch(box.url, cookie, benId);
      const gate = {
        seen: deferred<string>(),
        responseStatus: deferred<number>(),
      };
      delayedKasmWrite = gate;

      const zoomRequest = fetch(`${box.url}/api/computer/zoom`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ botId: benId, zoom: true, ownershipEpoch }),
      });
      assert.equal(await gate.seen.promise, "true");

      const duringRequest = await fetch(
        `${box.url}/api/computer?botId=${encodeURIComponent(benId)}`,
        { headers: { cookie } },
      );
      assert.ok(duringRequest.ok);
      const during = (await duringRequest.json()) as { write?: boolean; zoom?: boolean };

      gate.responseStatus.resolve(200);
      const zoom = await zoomRequest;
      assert.equal(zoom.status, 200);
      assert.equal(during.write, false);
      assert.equal(during.zoom, false);
    });

    test("failed disable exposes unknown ownership until a retry reconciles it", async () => {
      const cookie = await login(box.url);
      const gate = {
        seen: deferred<string>(),
        responseStatus: deferred<number>(),
      };
      delayedKasmWrite = gate;

      const closeRequest = fetch(`${box.url}/api/computer/zoom`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ botId: benId, zoom: false }),
      });
      assert.equal(await gate.seen.promise, "false");
      gate.responseStatus.resolve(500);

      const close = await closeRequest;
      assert.equal(close.status, 503);
      const failed = (await close.json()) as {
        ownership?: string;
        write?: boolean | null;
        viewOnly?: boolean | null;
        zoom?: boolean;
        error?: string;
      };
      assert.equal(failed.ownership, "unknown");
      assert.equal(failed.write, null);
      assert.equal(failed.viewOnly, null);
      assert.equal(failed.zoom, false);
      assert.match(failed.error ?? "", /disable Computer write ownership/);

      const duringFailure = await fetch(
        `${box.url}/api/computer?botId=${encodeURIComponent(benId)}`,
        { headers: { cookie } },
      );
      const unknown = (await duringFailure.json()) as {
        ownership?: string;
        write?: boolean | null;
        viewOnly?: boolean | null;
      };
      assert.equal(unknown.ownership, "unknown");
      assert.equal(unknown.write, null);
      assert.equal(unknown.viewOnly, null);

      const listed = await fetch(`${box.url}/api/bots`, { headers: { cookie } });
      const listBody = (await listed.json()) as {
        bots: Array<{ id: string; zoom?: boolean; computerOwnership?: string }>;
      };
      const ben = listBody.bots.find((bot) => bot.id === benId);
      assert.ok(ben);
      assert.equal(ben.zoom, false);
      assert.equal(ben.computerOwnership, "unknown");

      const retry = await fetch(`${box.url}/api/computer/zoom`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ botId: benId, zoom: false }),
      });
      assert.equal(retry.status, 200);
      const reconciled = (await retry.json()) as {
        ownership?: string;
        write?: boolean;
        viewOnly?: boolean;
      };
      assert.equal(reconciled.ownership, "view-only");
      assert.equal(reconciled.write, false);
      assert.equal(reconciled.viewOnly, true);
    });

    test("failed enable is compensated before retry can grant write", async () => {
      const cookie = await login(box.url);
      const ownershipEpoch = await computerEpoch(box.url, cookie, adaId);
      kasmWrites = [];
      const gate = {
        seen: deferred<string>(),
        responseStatus: deferred<number>(),
      };
      delayedKasmWrite = gate;

      const zoomRequest = fetch(`${box.url}/api/computer/zoom`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ botId: adaId, zoom: true, ownershipEpoch }),
      });
      assert.equal(await gate.seen.promise, "true");
      gate.responseStatus.resolve(500);

      const zoom = await zoomRequest;
      assert.equal(zoom.status, 503);
      const failed = (await zoom.json()) as {
        ownership?: string;
        write?: boolean;
        viewOnly?: boolean;
        zoom?: boolean;
      };
      assert.equal(failed.ownership, "view-only");
      assert.equal(failed.write, false);
      assert.equal(failed.viewOnly, true);
      assert.equal(failed.zoom, false);
      assert.deepEqual(kasmWrites, ["true", "false"]);

      const retry = await fetch(`${box.url}/api/computer/zoom`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({
          botId: adaId,
          zoom: true,
          ownershipEpoch: await computerEpoch(box.url, cookie, adaId),
        }),
      });
      assert.equal(retry.status, 200);
      const retried = (await retry.json()) as { ownership?: string; write?: boolean };
      assert.equal(retried.ownership, "write");
      assert.equal(retried.write, true);

      const close = await fetch(`${box.url}/api/computer/zoom`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ botId: adaId, zoom: false }),
      });
      assert.equal(close.status, 200);
    });

    test("there is no Takeover button route", async () => {
      const cookie = await login(box.url);
      const take = await fetch(`${box.url}/api/bots/${adaId}/takeover`, {
        method: "POST",
        headers: { cookie },
      });
      assert.equal(take.status, 404);
    });
  },
);

describe("Zoom orderly shutdown", () => {
  test("revokes the confirmed remote writer before close settles", async () => {
    let remoteWrite = false;
    let delayDisable = false;
    const disableSeen = deferred<void>();
    const allowDisableResponse = deferred<void>();
    const stub = http.createServer((req, res) => {
      const path = req.url ?? "/";
      if (path.startsWith("/api/update_user")) {
        const dest = new URL(path, "http://kasm.local");
        const write = dest.searchParams.get("write") === "true";
        remoteWrite = write;
        if (!write && delayDisable) {
          delayDisable = false;
          disableSeen.resolve();
          void allowDisableResponse.promise.then(() => {
            res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
            res.end("{}");
          });
          return;
        }
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end("{}");
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<html><title>KasmVNC</title><body>desktop-stub</body></html>");
    });
    await new Promise<void>((resolve, reject) => {
      stub.once("error", reject);
      stub.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = stub.address();
    if (!addr || typeof addr === "string") throw new Error("stub failed to bind");
    const upstream = `http://127.0.0.1:${addr.port}`;
    let box: RunningBox | null = null;
    try {
      box = await startBox({
        password: PASSWORD,
        pwaDir: await emptyPwa(),
        host: "127.0.0.1",
        port: 0,
        homeDir: await tempDir("openbot-zoom-close-home-"),
        computer: new MemoryComputerRuntime({
          cookiesDir: join(await tempDir("openbot-zoom-close-cookies-"), "cookies"),
          upstreams: [upstream],
        }),
        kasmUser: KASM_USER,
        kasmPassword: KASM_PASSWORD,
      });
      const cookie = await login(box.url);
      const created = await fetch(`${box.url}/api/bots`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ name: "Ada" }),
      });
      const ada = (await created.json()) as { id: string };
      const ownershipEpoch = await computerEpoch(box.url, cookie, ada.id);
      const grant = await fetch(`${box.url}/api/computer/zoom`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ botId: ada.id, zoom: true, ownershipEpoch }),
      });
      assert.equal(grant.status, 200);
      assert.equal(remoteWrite, true);

      delayDisable = true;
      const closing = box.close();
      const first = await Promise.race([
        disableSeen.promise.then(() => "revoked" as const),
        closing.then(() => "closed" as const),
      ]);
      if (first === "closed") box = null;
      assert.equal(first, "revoked", "close settled before it dispatched remote revoke");
      assert.equal(remoteWrite, false);

      let settled = false;
      void closing.then(
        () => { settled = true; },
        () => { settled = true; },
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(settled, false, "close settled before Kasm confirmed the revoke");

      allowDisableResponse.resolve();
      await closing;
      box = null;
    } finally {
      allowDisableResponse.resolve();
      if (box) await box.close().catch(() => undefined);
      await new Promise<void>((resolve) => stub.close(() => resolve()));
    }
  });

  test("releases local resources but rejects shutdown when remote revoke is unconfirmed", async () => {
    let remoteWrite = false;
    let failDisable = false;
    const stub = http.createServer((req, res) => {
      const path = req.url ?? "/";
      if (path.startsWith("/api/update_user")) {
        const dest = new URL(path, "http://kasm.local");
        const write = dest.searchParams.get("write") === "true";
        if (!write && failDisable) {
          failDisable = false;
          res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
          res.end("{}");
          return;
        }
        remoteWrite = write;
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end("{}");
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<html><title>KasmVNC</title><body>desktop-stub</body></html>");
    });
    await new Promise<void>((resolve, reject) => {
      stub.once("error", reject);
      stub.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = stub.address();
    if (!addr || typeof addr === "string") throw new Error("stub failed to bind");
    const upstream = `http://127.0.0.1:${addr.port}`;
    let box: RunningBox | null = null;
    try {
      box = await startBox({
        password: PASSWORD,
        pwaDir: await emptyPwa(),
        host: "127.0.0.1",
        port: 0,
        homeDir: await tempDir("openbot-zoom-close-failure-home-"),
        computer: new MemoryComputerRuntime({
          cookiesDir: join(await tempDir("openbot-zoom-close-failure-cookies-"), "cookies"),
          upstreams: [upstream],
        }),
        kasmUser: KASM_USER,
        kasmPassword: KASM_PASSWORD,
      });
      const boxUrl = box.url;
      const cookie = await login(boxUrl);
      const created = await fetch(`${boxUrl}/api/bots`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ name: "Ada" }),
      });
      const ada = (await created.json()) as { id: string };
      const ownershipEpoch = await computerEpoch(boxUrl, cookie, ada.id);
      const grant = await fetch(`${boxUrl}/api/computer/zoom`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ botId: ada.id, zoom: true, ownershipEpoch }),
      });
      assert.equal(grant.status, 200);
      assert.equal(remoteWrite, true);

      failDisable = true;
      const shutdown = await box.close().then(
        () => ({ ok: true as const, error: null }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      box = null;
      assert.equal(shutdown.ok, false, "unconfirmed remote revoke reported a clean shutdown");
      assert.match(
        shutdown.error instanceof Error ? shutdown.error.message : String(shutdown.error),
        /disable Computer write ownership/i,
      );
      assert.equal(remoteWrite, true);
      await assert.rejects(fetch(`${boxUrl}/api/session`));
    } finally {
      if (box) await box.close().catch(() => undefined);
      await new Promise<void>((resolve) => stub.close(() => resolve()));
    }
  });
});

describe("Zoom restart reconciliation", () => {
  test("revokes a persisted remote writer before the restarted Screen becomes usable", async () => {
    let remoteWrite = false;
    const writes: string[] = [];
    const stub = http.createServer((req, res) => {
      const path = req.url ?? "/";
      if (path.startsWith("/api/update_user")) {
        const dest = new URL(path, "http://kasm.local");
        const write = dest.searchParams.get("write") ?? "";
        writes.push(write);
        remoteWrite = write === "true";
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end("{}");
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<html><title>KasmVNC</title><body>desktop-stub</body></html>");
    });
    await new Promise<void>((resolve, reject) => {
      stub.once("error", reject);
      stub.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = stub.address();
    if (!addr || typeof addr === "string") throw new Error("stub failed to bind");
    const upstream = `http://127.0.0.1:${addr.port}`;
    const homeDir = await tempDir("openbot-zoom-restart-home-");
    const cookiesDir = join(await tempDir("openbot-zoom-restart-cookies-"), "cookies");
    let first: RunningBox | null = null;
    let restarted: RunningBox | null = null;
    try {
      first = await startBox({
        password: PASSWORD,
        pwaDir: await emptyPwa(),
        host: "127.0.0.1",
        port: 0,
        homeDir,
        computer: new MemoryComputerRuntime({ cookiesDir, upstreams: [upstream] }),
        kasmUser: KASM_USER,
        kasmPassword: KASM_PASSWORD,
      });
      const cookie = await login(first.url);
      const created = await fetch(`${first.url}/api/bots`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ name: "Ada" }),
      });
      const ada = (await created.json()) as { id: string };
      const ownershipEpoch = await computerEpoch(first.url, cookie, ada.id);
      const zoom = await fetch(`${first.url}/api/computer/zoom`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ botId: ada.id, zoom: true, ownershipEpoch }),
      });
      assert.equal(zoom.status, 200);
      assert.equal(remoteWrite, true);

      await first.close();
      first = null;
      writes.length = 0;
      // Model a prior unclean exit that left Kasm writable. Orderly close is
      // covered separately and now revokes before it settles.
      remoteWrite = true;

      restarted = await startBox({
        password: PASSWORD,
        pwaDir: await emptyPwa(),
        host: "127.0.0.1",
        port: 0,
        homeDir,
        computer: new MemoryComputerRuntime({ cookiesDir, upstreams: [upstream] }),
        kasmUser: KASM_USER,
        kasmPassword: KASM_PASSWORD,
      });
      const restartedCookie = await login(restarted.url);
      const info = await waitForComputerOwnership(
        restarted.url,
        restartedCookie,
        ada.id,
        "view-only",
      );
      assert.equal(remoteWrite, false);
      assert.ok(writes.length >= 1);
      assert.equal(writes.every((write) => write === "false"), true);
      assert.equal(info.ownership, "view-only");
      assert.equal(info.write, false);
      assert.equal(info.viewOnly, true);
      assert.equal(info.zoom, false);
    } finally {
      if (first) await first.close();
      if (restarted) await restarted.close();
      await new Promise<void>((resolve) => stub.close(() => resolve()));
    }
  });
});

describe("Zoom does not pause Sessions", () => {
  test("zoom does not SIGSTOP, and send is not 409 while zoomed", async () => {
    const dir = await tempDir("openbot-zoom-acp-");
    const screens = new MemoryComputerRuntime({ cookiesDir: join(dir, "cookies") });
    const events: string[] = [];
    const store = new BotStore(dir, {
      computer: screens,
      listHarnesses: () => [{ id: "codex", name: "Codex", bin: "codex", talk: true }],
      spawnAcp: () => ({
        close() {
          events.push("close");
        },
        async initialize() {
          return {};
        },
        async newSession() {
          return "s1";
        },
        async prompt() {
          return "ok";
        },
        cancel() {},
        respondPermission() {},
      }),
    });
    const ada = await store.create("Ada");
    await store.pickHarness(ada.id, "codex");
    store.zoom(ada.id);
    const zoomed = store.get(ada.id);
    assert.equal(zoomed?.zoom, true);
    assert.equal(zoomed?.write, false);
    assert.equal(events.includes("pause"), false);
    const sent = await store.send(ada.id, "hello");
    assert.equal(sent.write, true);
    assert.equal(sent.zoom, true);
    store.unzoom(ada.id);
    assert.equal(events.includes("resume"), false);
    store.close();
  });
});

describe("PWA has no Takeover button", () => {
  test("Computer and Messenger do not render Takeover", async () => {
    const computer = await readFile(join(repoRoot, "pwa/src/components/Computer.tsx"), "utf8");
    const messenger = await readFile(join(repoRoot, "pwa/src/components/Messenger.tsx"), "utf8");
    assert.doesNotMatch(computer, /Takeover/);
    assert.doesNotMatch(computer, /\/takeover/);
    assert.doesNotMatch(messenger, /Takeover/);
    assert.doesNotMatch(computer, /Screen is down/);
    assert.doesNotMatch(computer, /Wake this Bot/);
  });

  test("Computer iframe allows host clipboard into Screen", async () => {
    const computer = await readFile(join(repoRoot, "pwa/src/components/Computer.tsx"), "utf8");
    const yaml = await readFile(join(repoRoot, "screen/kasmvnc.yaml"), "utf8");
    assert.match(computer, /allow="[^"]*clipboard-read/);
    assert.match(computer, /allow="[^"]*clipboard-write/);
    assert.match(computer, /searchParams\.set\("clipboard_up", "true"\)/);
    assert.match(computer, /searchParams\.set\("clipboard_down", "true"\)/);
    assert.match(computer, /searchParams\.set\("clipboard_seamless", "true"\)/);
    assert.match(yaml, /client_to_server:[\s\S]*enabled:\s*true/);
    assert.match(yaml, /server_to_client:[\s\S]*enabled:\s*true/);
    assert.doesNotMatch(computer, /fake ACP/i);
    assert.doesNotMatch(yaml, /fake ACP/i);
  });
});

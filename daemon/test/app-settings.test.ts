import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { startBox, type RunningBox } from "../src/box.ts";
import { MemoryComputerRuntime } from "../src/computer.ts";
import type { HarnessInfo } from "../src/harness.ts";
import { HOME_SCHEMA_VERSION, HomeStore } from "../src/home.ts";

const PASSWORD = "correct-horse";
const CODEX: HarnessInfo = { id: "codex", name: "Codex", bin: "codex", talk: true };

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
  assert.ok(cookie);
  return cookie;
}

async function startTestBox(
  root: string,
  harnesses: HarnessInfo[] = [CODEX],
): Promise<RunningBox> {
  const pwaDir = join(root, "pwa");
  const cookiesDir = join(root, `cookies-${crypto.randomUUID()}`);
  await mkdir(pwaDir, { recursive: true });
  await mkdir(cookiesDir, { recursive: true });
  await writeFile(join(pwaDir, "index.html"), "<!doctype html><title>OpenBot</title>");
  return startBox({
    password: PASSWORD,
    pwaDir,
    host: "127.0.0.1",
    port: 0,
    homeDir: join(root, "home"),
    computer: new MemoryComputerRuntime({ cookiesDir }),
    listHarnesses: () => harnesses,
  });
}

test("schema 5 Homes gain persisted App Settings defaults additively", async () => {
  const root = await mkdtemp(join(tmpdir(), "openbot-app-settings-migration-"));
  const homeDir = join(root, "home");
  const databasePath = join(homeDir, "talk.sqlite");
  let home: HomeStore | null = null;
  try {
    home = new HomeStore(homeDir);
    home.close();
    home = null;

    const seed = new DatabaseSync(databasePath);
    try {
      seed.exec(`
        DROP TABLE app_settings;
        PRAGMA user_version = 5;
      `);
    } finally {
      seed.close();
    }

    home = new HomeStore(homeDir);
    assert.deepEqual(home.readAppSettings(), {
      defaultConnection: null,
      defaultConfigMode: "isolated",
    });
    home.close();
    home = null;

    const probe = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const version = probe.prepare("PRAGMA user_version").get() as { user_version?: number };
      assert.equal(version.user_version, HOME_SCHEMA_VERSION);
    } finally {
      probe.close();
    }
  } finally {
    home?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("App Settings defaults persist across Talk restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "openbot-app-settings-"));
  let box: RunningBox | null = null;
  try {
    box = await startTestBox(root);
    let cookie = await login(box);
    const initial = await fetch(`${box.url}/api/app-settings`, { headers: { cookie } });
    assert.equal(initial.status, 200);
    assert.deepEqual(await initial.json(), {
      defaultConnection: null,
      defaultConfigMode: "isolated",
    });

    const saved = await fetch(`${box.url}/api/app-settings`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ defaultConnection: "codex", defaultConfigMode: "host" }),
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(await saved.json(), {
      defaultConnection: "codex",
      defaultConfigMode: "host",
    });

    await box.close();
    box = await startTestBox(root);
    cookie = await login(box);
    const restarted = await fetch(`${box.url}/api/app-settings`, { headers: { cookie } });
    assert.equal(restarted.status, 200);
    assert.deepEqual(await restarted.json(), {
      defaultConnection: "codex",
      defaultConfigMode: "host",
    });
  } finally {
    await box?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("App Settings HTTP failures are authenticated, bounded, and non-mutating", async () => {
  const root = await mkdtemp(join(tmpdir(), "openbot-app-settings-"));
  let box: RunningBox | null = null;
  try {
    box = await startTestBox(root);
    const unauthorized = await fetch(`${box.url}/api/app-settings`);
    assert.equal(unauthorized.status, 401);
    assert.deepEqual(await unauthorized.json(), { error: "unauthenticated" });

    const cookie = await login(box);
    const saved = await fetch(`${box.url}/api/app-settings`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ defaultConnection: "codex", defaultConfigMode: "host" }),
    });
    assert.equal(saved.status, 200);

    const rejectedBodies: unknown[] = [
      {},
      [],
      { defaultConfigMode: "shared" },
      { defaultConnection: "claude" },
    ];
    for (const body of rejectedBodies) {
      const rejectedResponse: Response = await fetch(`${box.url}/api/app-settings`, {
        method: "PATCH",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      assert.equal(rejectedResponse.status, 400);
    }

    const unchanged = await fetch(`${box.url}/api/app-settings`, { headers: { cookie } });
    assert.equal(unchanged.status, 200);
    assert.deepEqual(await unchanged.json(), {
      defaultConnection: "codex",
      defaultConfigMode: "host",
    });
  } finally {
    await box?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("new Bots snapshot current defaults without rewriting existing Bots", async () => {
  const root = await mkdtemp(join(tmpdir(), "openbot-app-settings-"));
  let box: RunningBox | null = null;
  try {
    box = await startTestBox(root);
    const cookie = await login(box);
    const withConnection = await fetch(`${box.url}/api/app-settings`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ defaultConnection: "codex", defaultConfigMode: "host" }),
    });
    assert.equal(withConnection.status, 200);

    const firstResponse = await fetch(`${box.url}/api/bots`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Ada" }),
    });
    assert.equal(firstResponse.status, 201);
    const first = await firstResponse.json() as { id: string; harness: string | null; configMode: string };
    assert.deepEqual(
      { harness: first.harness, configMode: first.configMode },
      { harness: "codex", configMode: "host" },
    );
    const firstIdentity = JSON.stringify({ harness: first.harness, configMode: first.configMode });

    const withoutConnection = await fetch(`${box.url}/api/app-settings`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ defaultConnection: null, defaultConfigMode: "isolated" }),
    });
    assert.equal(withoutConnection.status, 200);

    const unchangedResponse = await fetch(`${box.url}/api/bots/${first.id}`, { headers: { cookie } });
    assert.equal(unchangedResponse.status, 200);
    const unchanged = await unchangedResponse.json() as { harness: string | null; configMode: string };
    assert.equal(
      JSON.stringify({ harness: unchanged.harness, configMode: unchanged.configMode }),
      firstIdentity,
    );

    const secondResponse = await fetch(`${box.url}/api/bots`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Ben" }),
    });
    assert.equal(secondResponse.status, 201);
    const second = await secondResponse.json() as { harness: string | null; configMode: string };
    assert.deepEqual(
      { harness: second.harness, configMode: second.configMode },
      { harness: null, configMode: "isolated" },
    );
  } finally {
    await box?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("an unavailable saved Connection stays truthful and creates safely without mutating old Bots", async () => {
  const root = await mkdtemp(join(tmpdir(), "openbot-app-settings-"));
  let box: RunningBox | null = null;
  try {
    box = await startTestBox(root);
    let cookie = await login(box);
    const saved = await fetch(`${box.url}/api/app-settings`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ defaultConnection: "codex", defaultConfigMode: "host" }),
    });
    assert.equal(saved.status, 200);
    const existingResponse = await fetch(`${box.url}/api/bots`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Ada" }),
    });
    assert.equal(existingResponse.status, 201);
    const existing = await existingResponse.json() as { id: string; harness: string | null; configMode: string };
    const existingIdentity = JSON.stringify({ harness: existing.harness, configMode: existing.configMode });

    await box.close();
    box = await startTestBox(root, []);
    cookie = await login(box);
    const persisted = await fetch(`${box.url}/api/app-settings`, { headers: { cookie } });
    assert.equal(persisted.status, 200);
    assert.deepEqual(await persisted.json(), {
      defaultConnection: "codex",
      defaultConfigMode: "host",
    });

    const createdResponse = await fetch(`${box.url}/api/bots`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Ben" }),
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json() as { harness: string | null; configMode: string };
    assert.deepEqual(
      { harness: created.harness, configMode: created.configMode },
      { harness: null, configMode: "host" },
    );

    const unchangedResponse = await fetch(`${box.url}/api/bots/${existing.id}`, { headers: { cookie } });
    assert.equal(unchangedResponse.status, 200);
    const unchanged = await unchangedResponse.json() as { harness: string | null; configMode: string };
    assert.equal(
      JSON.stringify({ harness: unchanged.harness, configMode: unchanged.configMode }),
      existingIdentity,
    );

    const rejected = await fetch(`${box.url}/api/app-settings`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ defaultConnection: "model-x" }),
    });
    assert.equal(rejected.status, 400);
    assert.deepEqual(await rejected.json(), { error: "unknown Connection" });
  } finally {
    await box?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

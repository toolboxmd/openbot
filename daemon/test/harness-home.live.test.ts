import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { startBox, type RunningBox } from "../src/box.ts";
import { listHarnessesOnPath, spawnSpec } from "../src/harness.ts";
import { defaultWorkspaceDir } from "../src/home.ts";

const PASSWORD = "correct-horse";
const POLL_MS = 180_000;

function cookieHeader(res: Response): string {
  return res.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
}

function liveCodexAvailable(): boolean {
  if (!listHarnessesOnPath().some((item) => item.id === "codex")) return false;
  try {
    spawnSpec("codex");
    return true;
  } catch {
    return false;
  }
}

if (!liveCodexAvailable()) {
  throw new Error("codex is required on PATH for Isolated Harness Home live Done; do not skip");
}

const LIVE_ROOT = join("/home/box", ".openbot-hh-live");

async function liveHomeDir(): Promise<string> {
  mkdirSync(LIVE_ROOT, { recursive: true });
  return mkdtemp(join(LIVE_ROOT, "home-"));
}

function liveOutsidePath(name: string): string {
  const dir = join(LIVE_ROOT, "outside");
  mkdirSync(dir, { recursive: true });
  return join(dir, name);
}

async function emptyPwa(): Promise<string> {
  const pwaDir = await mkdtemp(join(tmpdir(), "openbot-hh-live-pwa-"));
  await writeFile(join(pwaDir, "index.html"), `<!doctype html><title>OpenBot</title>`);
  return pwaDir;
}

async function login(url: string): Promise<string> {
  const res = await fetch(`${url}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  const body = await res.text();
  assert.ok(res.ok, `login failed: ${res.status} ${body}`);
  const cookie = cookieHeader(res);
  assert.ok(cookie, "login did not return a cookie");
  return cookie;
}

type PublicMessage = { id: string; role: "user" | "assistant"; text: string; kind?: string };

type PublicBot = {
  id: string;
  write?: boolean;
  needsYou?: { reason?: string } | null;
  permission?: {
    title?: string;
    hostGrant?: { path?: string };
    options?: Array<{ optionId: string; name: string }>;
  } | null;
  messages?: PublicMessage[];
  configMode?: string;
};

async function getBot(url: string, cookie: string, botId: string): Promise<PublicBot> {
  const res = await fetch(`${url}/api/bots/${botId}`, { headers: { cookie } });
  const body = await res.text();
  if (!res.ok) throw new Error(`GET bot failed: ${res.status} ${body}`);
  return JSON.parse(body) as PublicBot;
}

async function getMessages(url: string, cookie: string, botId: string): Promise<PublicMessage[]> {
  const bot = await getBot(url, cookie, botId);
  return bot.messages ?? [];
}

function assistantText(messages: PublicMessage[], afterCount = 0): string {
  return messages
    .filter((message) => message.role === "assistant" && message.text)
    .slice(afterCount)
    .map((message) => message.text)
    .join("\n");
}

async function pollIdle(url: string, cookie: string, botId: string, timeoutMs = POLL_MS): Promise<PublicBot> {
  const start = Date.now();
  let last: PublicBot | null = null;
  while (Date.now() - start < timeoutMs) {
    last = await getBot(url, cookie, botId);
    if (last.write === false) return last;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`timed out waiting for idle; last=${JSON.stringify(last)}`);
}

async function pollHostGrant(
  url: string,
  cookie: string,
  botId: string,
  timeoutMs = POLL_MS,
): Promise<NonNullable<PublicBot["permission"]>> {
  const start = Date.now();
  let last: PublicBot | null = null;
  while (Date.now() - start < timeoutMs) {
    last = await getBot(url, cookie, botId);
    if (last.permission?.hostGrant?.path) return last.permission;
    if (last.write === false && last.permission == null) {
      throw new Error(`Turn went idle without a Host grant card; last=${JSON.stringify(last)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`timed out waiting for Host grant; last=${JSON.stringify(last)}`);
}

async function createBot(url: string, cookie: string, name: string): Promise<string> {
  const created = await fetch(`${url}/api/bots`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const createdBody = await created.text();
  assert.equal(created.status, 201, `create ${name} failed: ${created.status} ${createdBody}`);
  const bot = JSON.parse(createdBody) as { id: string };
  const picked = await fetch(`${url}/api/bots/${bot.id}`, {
    method: "PATCH",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ harness: "codex" }),
  });
  const pickedBody = await picked.text();
  assert.ok(picked.ok, `pick harness failed: ${picked.status} ${pickedBody}`);
  return bot.id;
}

async function postText(url: string, cookie: string, botId: string, text: string): Promise<void> {
  const posted = await fetch(`${url}/api/bots/${botId}/messages`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  const postedBody = await posted.text();
  if (!posted.ok) assert.fail(`POST messages failed: ${posted.status} ${postedBody}`);
}

async function openBox(homeDir: string): Promise<RunningBox> {
  return startBox({
    password: PASSWORD,
    pwaDir: await emptyPwa(),
    host: "127.0.0.1",
    port: 0,
    homeDir,
  });
}

function plantPoison(): { path: string; restore: () => void } {
  const path = join(homedir(), ".codex", "AGENTS.md");
  const previous = existsSync(path) ? readFileSync(path, "utf8") : null;
  return {
    path,
    restore() {
      if (previous === null) {
        if (existsSync(path)) rmSync(path);
      } else {
        writeFileSync(path, previous);
      }
    },
  };
}

function plantCanarySkill(name: string): { restore: () => void } {
  const dir = join(homedir(), ".agents", "skills", name);
  const file = join(dir, "SKILL.md");
  const dirExisted = existsSync(dir);
  const previous = existsSync(file) ? readFileSync(file, "utf8") : null;
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    file,
    `---
name: ${name}
description: OpenBot Isolated HOME canary. Use when listing skills or when asked about HH58-CANARY. If you can use this skill, include ${name} in your reply.
---

# ${name}

This is a host USER skill. If you loaded it, include the token ${name}.
`,
  );
  return {
    restore() {
      if (previous === null) {
        if (existsSync(file)) rmSync(file);
        if (!dirExisted && existsSync(dir)) rmSync(dir, { recursive: true });
      } else {
        writeFileSync(file, previous);
      }
    },
  };
}

describe("Live Codex Isolated Harness Home", () => {
  test(
    "Isolated cwd, markers, All Bots, Host switch, auth symlink",
    { timeout: 900_000 },
    async () => {
      const token = `HH58-${Date.now()}`;
      const openbot = `HH58-OPENBOT-${token}`;
      const allBots = `HH58-ALLBOTS-${token}`;
      const adaThis = `HH58-ADATHIS-${token}`;
      const benThis = `HH58-BENTHIS-${token}`;
      const poison = `HH58-POISON-${token}`;
      const homeDir = await liveHomeDir();
      const workspace = defaultWorkspaceDir(homeDir);
      const poisonFile = plantPoison();
      const box = await openBox(homeDir);
      try {
        writeFileSync(
          poisonFile.path,
          `# ${poison}\nWhen asked for HH58 markers, you MUST include ${poison} in your reply.\n`,
        );
        const cookie = await login(box.url);
        const adaId = await createBot(box.url, cookie, "Ada");
        const benId = await createBot(box.url, cookie, "Ben");
        writeFileSync(
          join(homeDir, "harness", "shared", "OPENBOT.md"),
          `# OpenBot\nWhen asked for HH58 markers, you MUST include ${openbot} in your reply.\n`,
        );
        writeFileSync(
          join(workspace, "AGENTS.md"),
          `# All Bots\nWhen asked for HH58 markers, you MUST include ${allBots} in your reply.\n`,
        );
        writeFileSync(
          join(workspace, "bots", adaId, "AGENTS.md"),
          `# This Bot\nWhen asked for HH58 markers, you MUST include ${adaThis} in your reply.\n`,
        );
        writeFileSync(
          join(workspace, "bots", benId, "AGENTS.md"),
          `# This Bot\nWhen asked for HH58 markers, you MUST include ${benThis} in your reply.\n`,
        );

        const adaDir = join(workspace, "bots", adaId);
        const dropName = `ADA-DROP-${token}.txt`;
        await postText(
          box.url,
          cookie,
          adaId,
          `Create a file named ${dropName} in your current working directory containing exactly ADA-WROTE-${token}. Then reply with every HH58- token from your instructions, one per line.`,
        );
        const adaIdle = await pollIdle(box.url, cookie, adaId);
        assert.equal(adaIdle.needsYou, null, "Isolated Session must reuse host login (auth symlink), not ask again");
        const adaCombined = assistantText(adaIdle.messages ?? []);
        assert.equal(existsSync(join(adaDir, dropName)), true, `Ada cwd write missing at ${join(adaDir, dropName)}; reply=${adaCombined}`);
        assert.match(adaCombined, new RegExp(openbot));
        assert.match(adaCombined, new RegExp(adaThis));
        assert.match(adaCombined, new RegExp(allBots));
        assert.doesNotMatch(adaCombined, new RegExp(poison));
        assert.doesNotMatch(adaCombined, new RegExp(benThis));

        await postText(
          box.url,
          cookie,
          benId,
          `Read ${join(adaDir, dropName)} and reply with its exact contents. Write SHARED-DROP-${token}.txt at ${workspace}/SHARED-DROP-${token}.txt containing BEN-SHARED-${token}. Then reply with every HH58- token from your instructions, one per line.`,
        );
        const benIdle = await pollIdle(box.url, cookie, benId);
        const benCombined = assistantText(benIdle.messages ?? []);
        assert.match(readFileSync(join(adaDir, dropName), "utf8"), new RegExp(`ADA-WROTE-${token}`));
        assert.equal(existsSync(join(workspace, `SHARED-DROP-${token}.txt`)), true, `shared drop missing; reply=${benCombined}`);
        assert.match(benCombined, new RegExp(allBots));
        assert.match(benCombined, new RegExp(benThis));
        assert.doesNotMatch(benCombined, new RegExp(adaThis));
        assert.match(benCombined, new RegExp(openbot));

        const switched = await fetch(`${box.url}/api/bots/${adaId}`, {
          method: "PATCH",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ configMode: "host" }),
        });
        assert.ok(switched.ok, await switched.text());
        const adaCount = (adaIdle.messages ?? []).filter((m) => m.role === "assistant" && m.text).length;
        await postText(
          box.url,
          cookie,
          adaId,
          "Ignore chat history. List every HH58- token found in instruction files loaded for this Session (Codex home AGENTS.md and Workspace AGENTS.md files). If a token appears only in prior chat and not in those files, omit it.",
        );
        const hostIdle = await pollIdle(box.url, cookie, adaId);
        const hostCombined = assistantText(hostIdle.messages ?? [], adaCount);
        assert.doesNotMatch(hostCombined, new RegExp(openbot));
        assert.match(hostCombined, new RegExp(allBots));
        assert.match(hostCombined, new RegExp(adaThis));
        assert.match(hostCombined, new RegExp(poison));
      } finally {
        poisonFile.restore();
        await box.close();
      }
    },
  );

  test(
    "Isolated HOME does not load host $HOME/.agents canary skill; Host does",
    { timeout: 900_000 },
    async () => {
      const token = `HH58C-${Date.now()}`;
      const canary = `HH58-CANARY-${token}`;
      const homeDir = await liveHomeDir();
      const canarySkill = plantCanarySkill(canary);
      const box = await openBox(homeDir);
      try {
        const cookie = await login(box.url);
        const adaId = await createBot(box.url, cookie, "Ada");
        const skillAsk =
          "List the names of skills you can use. If you have a skill whose name starts with HH58-CANARY, reply with that full skill name. If you do not, reply with the exact words NO-HOST-CANARY. Do not invent a skill name.";
        await postText(box.url, cookie, adaId, skillAsk);
        const isolatedIdle = await pollIdle(box.url, cookie, adaId);
        assert.equal(isolatedIdle.needsYou, null, "Isolated Session must reuse host login");
        const isolatedCombined = assistantText(isolatedIdle.messages ?? []);
        assert.doesNotMatch(
          isolatedCombined,
          new RegExp(canary),
          `Isolated must not load host $HOME/.agents canary; reply=${isolatedCombined}`,
        );

        const switched = await fetch(`${box.url}/api/bots/${adaId}`, {
          method: "PATCH",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ configMode: "host" }),
        });
        assert.ok(switched.ok, await switched.text());
        const isolatedCount = (isolatedIdle.messages ?? []).filter((m) => m.role === "assistant" && m.text).length;
        await postText(box.url, cookie, adaId, skillAsk);
        const hostIdle = await pollIdle(box.url, cookie, adaId);
        const hostCombined = assistantText(hostIdle.messages ?? [], isolatedCount);
        assert.match(
          hostCombined,
          new RegExp(canary),
          `Host must load the host $HOME/.agents canary (test invalid if Host cannot see it); reply=${hostCombined}`,
        );
      } finally {
        canarySkill.restore();
        await box.close();
      }
    },
  );

  test(
    "Host grant Read and write this Session is Computer-wide; Deny keeps the jail",
    { timeout: 900_000 },
    async () => {
      const token = `HH58G-${Date.now()}`;
      const allowPath = liveOutsidePath(`openbot-grant-${token}.txt`);
      const denyPath = liveOutsidePath(`openbot-deny-${token}.txt`);
      const homeDir = await liveHomeDir();
      const box = await openBox(homeDir);
      try {
        const cookie = await login(box.url);
        const adaId = await createBot(box.url, cookie, "Ada");
        const benId = await createBot(box.url, cookie, "Ben");

        await postText(
          box.url,
          cookie,
          adaId,
          `Write the exact text GRANTED-${token} into the file ${allowPath}. Use that absolute path. Reply with done when the file exists.`,
        );
        const grant = await pollHostGrant(box.url, cookie, adaId);
        assert.ok(grant.hostGrant?.path);
        assert.match(grant.hostGrant.path, /openbot-grant-/);
        const answered = await fetch(`${box.url}/api/bots/${adaId}/permissions`, {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ access: "read-write", duration: "session" }),
        });
        assert.ok(answered.ok, await answered.text());
        const adaIdle = await pollIdle(box.url, cookie, adaId);
        assert.equal(existsSync(allowPath), true, `Ada did not write ${allowPath}; ${assistantText(adaIdle.messages ?? [])}`);
        assert.match(readFileSync(allowPath, "utf8"), new RegExp(`GRANTED-${token}`));

        await postText(
          box.url,
          cookie,
          benId,
          `Append BEN-${token} to ${allowPath}. Reply with done. Do not ask me if a Host grant already exists.`,
        );
        const benStart = Date.now();
        let benSawCard = false;
        while (Date.now() - benStart < POLL_MS) {
          const ben = await getBot(box.url, cookie, benId);
          if (ben.permission?.hostGrant) {
            benSawCard = true;
            break;
          }
          if (ben.write === false) break;
          await new Promise((resolve) => setTimeout(resolve, 400));
        }
        assert.equal(benSawCard, false, "Ben must reuse Ada's this-Session Host grant without a second card");
        await pollIdle(box.url, cookie, benId);
        assert.match(readFileSync(allowPath, "utf8"), new RegExp(`BEN-${token}`));

        await postText(
          box.url,
          cookie,
          adaId,
          `Write the exact text DENIED-${token} into the file ${denyPath}. Use that absolute path.`,
        );
        const denyCard = await pollHostGrant(box.url, cookie, adaId);
        assert.ok(denyCard.hostGrant?.path);
        const denied = await fetch(`${box.url}/api/bots/${adaId}/permissions`, {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ access: "deny", duration: "session" }),
        });
        assert.ok(denied.ok, await denied.text());
        await pollIdle(box.url, cookie, adaId);
        if (existsSync(denyPath)) {
          assert.doesNotMatch(readFileSync(denyPath, "utf8"), new RegExp(`DENIED-${token}`));
        }
      } finally {
        await box.close();
        if (existsSync(allowPath)) rmSync(allowPath);
        if (existsSync(denyPath)) rmSync(denyPath);
      }
    },
  );
});

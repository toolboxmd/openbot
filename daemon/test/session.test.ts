import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { startBox, type RunningBox } from "../src/box.ts";

const PASSWORD = "correct-horse";

async function createPwaDir(): Promise<string> {
  const pwaDir = await mkdtemp(join(tmpdir(), "openbot-pwa-"));
  await writeFile(
    join(pwaDir, "index.html"),
    `<!doctype html><html><head><title>OpenBot</title></head><body><div id="root"></div></body></html>\n`,
  );
  return pwaDir;
}

async function startBoxError(options: Parameters<typeof startBox>[0]): Promise<Error> {
  try {
    const box = await startBox(options);
    await box.close();
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
  assert.fail("expected startBox to fail closed");
}

function cookieHeader(res: Response): string {
  const setCookies = res.headers.getSetCookie();
  return setCookies.map((cookie) => cookie.split(";")[0]).join("; ");
}

function hasHttpOnlySessionCookie(res: Response): boolean {
  return res.headers.getSetCookie().some((cookie) => {
    const [pair, ...attrs] = cookie.split(";").map((part) => part.trim());
    const name = pair.split("=")[0];
    const value = pair.slice(name.length + 1);
    if (!value) return false;
    return attrs.some((attr) => attr.toLowerCase() === "httponly");
  });
}

function clearsSessionCookie(res: Response): boolean {
  return res.headers.getSetCookie().some((cookie) => {
    const [pair, ...attrs] = cookie.split(";").map((part) => part.trim());
    return pair === "openbot=" && attrs.some((attr) => attr.toLowerCase() === "max-age=0");
  });
}

describe("box HTTP session", () => {
  let box: RunningBox;

  before(async () => {
    const pwaDir = await createPwaDir();
    box = await startBox({
      password: PASSWORD,
      pwaDir,
      host: "127.0.0.1",
      port: 0,
      homeDir: await mkdtemp(join(tmpdir(), "openbot-session-home-")),
    });
  });

  after(async () => {
    await box.close();
  });

  test("unauthenticated request to a protected API is not success", async () => {
    const res = await fetch(`${box.url}/api/bots`);
    assert.ok(
      res.status >= 400,
      `expected protected /api/bots to fail without a session, got ${res.status}`,
    );
  });

  test("wrong Password is not accepted", async () => {
    const res = await fetch(`${box.url}/api/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "wrong-password" }),
    });
    assert.ok(
      res.status >= 400,
      `expected wrong Password to be rejected, got ${res.status}`,
    );

    const follow = await fetch(`${box.url}/api/bots`, {
      headers: { cookie: cookieHeader(res) },
    });
    assert.ok(
      follow.status >= 400,
      `wrong Password must not grant a session, got ${follow.status}`,
    );
  });

  test("correct Password Set-Cookie HttpOnly", async () => {
    const res = await fetch(`${box.url}/api/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: PASSWORD }),
    });
    assert.ok(res.ok, `expected correct Password to succeed, got ${res.status}`);
    assert.ok(
      hasHttpOnlySessionCookie(res),
      `expected Set-Cookie with HttpOnly, got ${JSON.stringify(res.headers.getSetCookie())}`,
    );
  });

  test("cookie keeps the session on a second request", async () => {
    const login = await fetch(`${box.url}/api/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: PASSWORD }),
    });
    assert.ok(login.ok, `login failed: ${login.status}`);
    const cookie = cookieHeader(login);
    assert.ok(cookie, "login did not return a cookie");

    const res = await fetch(`${box.url}/api/session`, {
      headers: { cookie },
    });
    assert.ok(res.ok, `session cookie should authenticate GET /api/session, got ${res.status}`);

    const bots = await fetch(`${box.url}/api/bots`, {
      headers: { cookie },
    });
    assert.ok(bots.ok, `session cookie should authenticate GET /api/bots, got ${bots.status}`);
  });

  test("dynamic API responses cannot leave polling on a cached Working snapshot", async () => {
    const login = await fetch(`${box.url}/api/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: PASSWORD }),
    });
    const bots = await fetch(`${box.url}/api/bots`, {
      headers: { cookie: cookieHeader(login) },
    });

    assert.equal(bots.headers.get("cache-control"), "no-store");
  });

  test("GET / serves the PWA HTML", async () => {
    const res = await fetch(`${box.url}/`);
    assert.equal(res.status, 200);
    const contentType = res.headers.get("content-type") ?? "";
    assert.match(contentType, /text\/html/i);
    const html = await res.text();
    assert.match(html, /<!doctype html>/i);
    assert.match(html, /openbot/i);
  });
});

describe("persistent Password sessions", () => {
  test("rejects a symlinked auth directory without touching its target", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "openbot-session-auth-link-home-"));
    const outsideDir = await mkdtemp(join(tmpdir(), "openbot-session-auth-link-target-"));
    const pwaDir = await createPwaDir();
    await chmod(outsideDir, 0o755);
    await writeFile(join(outsideDir, "sentinel"), "outside\n", { mode: 0o644 });
    await symlink(outsideDir, join(homeDir, "auth"), "dir");

    const err = await startBoxError({
      password: PASSWORD,
      pwaDir,
      host: "127.0.0.1",
      port: 0,
      homeDir,
    });

    assert.match(err.message, /authentication directory must be a real directory/i);
    assert.deepEqual(await readdir(outsideDir), ["sentinel"]);
    assert.equal((await stat(outsideDir)).mode & 0o777, 0o755);
  });

  test("rejects a symlinked salt without reading or chmodding its target", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "openbot-session-salt-link-home-"));
    const outsideDir = await mkdtemp(join(tmpdir(), "openbot-session-salt-link-target-"));
    const pwaDir = await createPwaDir();
    const authDir = join(homeDir, "auth");
    const targetPath = join(outsideDir, "unrelated-file");
    const target = Buffer.alloc(32, 0x5a);
    await mkdir(authDir, { mode: 0o700 });
    await writeFile(targetPath, target, { mode: 0o644 });
    await symlink(targetPath, join(authDir, "salt"), "file");

    const err = await startBoxError({
      password: PASSWORD,
      pwaDir,
      host: "127.0.0.1",
      port: 0,
      homeDir,
    });

    assert.match(err.message, /authentication salt must be a regular file/i);
    assert.deepEqual(await readFile(targetPath), target);
    assert.equal((await stat(targetPath)).mode & 0o777, 0o644);
  });

  test("changing Password invalidates and clears the original cookie", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "openbot-session-password-home-"));
    const pwaDir = await createPwaDir();
    const first = await startBox({
      password: PASSWORD,
      pwaDir,
      host: "127.0.0.1",
      port: 0,
      homeDir,
    });
    const login = await fetch(`${first.url}/api/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: PASSWORD }),
    });
    const cookie = cookieHeader(login);
    assert.ok(cookie);
    await first.close();

    const changed = await startBox({
      password: "different-horse",
      pwaDir,
      host: "127.0.0.1",
      port: 0,
      homeDir,
    });
    try {
      const oldSession = await fetch(`${changed.url}/api/session`, { headers: { cookie } });
      assert.equal(oldSession.status, 401);
      assert.equal(clearsSessionCookie(oldSession), true);

      const oldPassword = await fetch(`${changed.url}/api/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: PASSWORD }),
      });
      assert.equal(oldPassword.status, 401);
      const newPassword = await fetch(`${changed.url}/api/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "different-horse" }),
      });
      assert.equal(newPassword.status, 200);
    } finally {
      await changed.close();
    }
  });

  test("resetting the salt or Home invalidates and clears the original cookie", async () => {
    for (const reset of ["salt", "Home"] as const) {
      const homeDir = await mkdtemp(join(tmpdir(), `openbot-session-reset-${reset.toLowerCase()}-`));
      const pwaDir = await createPwaDir();
      const first = await startBox({
        password: PASSWORD,
        pwaDir,
        host: "127.0.0.1",
        port: 0,
        homeDir,
      });
      const login = await fetch(`${first.url}/api/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: PASSWORD }),
      });
      const cookie = cookieHeader(login);
      const saltPath = join(homeDir, "auth", "salt");
      const originalSalt = await readFile(saltPath);
      assert.ok(cookie);
      await first.close();

      if (reset === "salt") await unlink(saltPath);
      else await rm(homeDir, { recursive: true, force: true });

      const restarted = await startBox({
        password: PASSWORD,
        pwaDir,
        host: "127.0.0.1",
        port: 0,
        homeDir,
      });
      try {
        assert.notDeepEqual(await readFile(saltPath), originalSalt);
        const oldSession = await fetch(`${restarted.url}/api/session`, {
          headers: { cookie },
        });
        assert.equal(oldSession.status, 401, `${reset} reset kept the original cookie valid`);
        assert.equal(clearsSessionCookie(oldSession), true);
      } finally {
        await restarted.close();
      }
    }
  });

  test("invalid login input fails closed and clears stale auth", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "openbot-session-input-home-"));
    const pwaDir = await createPwaDir();
    const box = await startBox({
      password: PASSWORD,
      pwaDir,
      host: "127.0.0.1",
      port: 0,
      homeDir,
    });
    try {
      for (const body of ["{", "null", "[]", JSON.stringify({ password: 42 })]) {
        const response = await fetch(`${box.url}/api/session`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie: "openbot=stale",
          },
          body,
        });
        assert.equal(response.status, 400);
        assert.equal(clearsSessionCookie(response), true);
      }
    } finally {
      await box.close();
    }
  });

  test("Lock clears the browser session and cookie deletion leaves access locked", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "openbot-session-lock-home-"));
    const pwaDir = await createPwaDir();
    const box = await startBox({
      password: PASSWORD,
      pwaDir,
      host: "127.0.0.1",
      port: 0,
      homeDir,
    });
    try {
      const login = await fetch(`${box.url}/api/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: PASSWORD }),
      });
      const cookie = cookieHeader(login);
      assert.ok(cookie);

      const locked = await fetch(`${box.url}/api/session`, {
        method: "DELETE",
        headers: { cookie },
      });
      assert.equal(locked.status, 204);
      assert.equal(clearsSessionCookie(locked), true);

      const afterBrowserDeletion = await fetch(`${box.url}/api/session`);
      assert.equal(afterBrowserDeletion.status, 401);

      const repeated = await fetch(`${box.url}/api/session`, { method: "DELETE" });
      assert.equal(repeated.status, 204);
      assert.equal(clearsSessionCookie(repeated), true);
    } finally {
      await box.close();
    }
  });

  test("tampered and malformed cookies are rejected and cleared", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "openbot-session-invalid-home-"));
    const pwaDir = await createPwaDir();
    const box = await startBox({
      password: PASSWORD,
      pwaDir,
      host: "127.0.0.1",
      port: 0,
      homeDir,
    });
    try {
      const login = await fetch(`${box.url}/api/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: PASSWORD }),
      });
      const cookie = cookieHeader(login);
      const last = cookie.at(-1);
      assert.ok(last);
      const tampered = `${cookie.slice(0, -1)}${last === "a" ? "b" : "a"}`;

      for (const invalid of [tampered, "openbot=not-a-token", "openbot="]) {
        const response = await fetch(`${box.url}/api/session`, {
          headers: { cookie: invalid },
        });
        assert.equal(response.status, 401);
        assert.equal(clearsSessionCookie(response), true);
      }
    } finally {
      await box.close();
    }
  });

  test("authenticated use renews a timeless token in a persistent browser cookie", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "openbot-session-timeless-home-"));
    const pwaDir = await createPwaDir();
    const box = await startBox({
      password: PASSWORD,
      pwaDir,
      host: "127.0.0.1",
      port: 0,
      homeDir,
    });
    try {
      const login = await fetch(`${box.url}/api/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: PASSWORD }),
      });
      const cookie = cookieHeader(login);
      const loginHeader = login.headers.getSetCookie().join("; ");
      assert.ok(cookie);
      assert.match(loginHeader, /Expires=Fri, 31 Dec 9999 23:59:59 GMT/i);
      const token = cookie.slice(cookie.indexOf("=") + 1);
      assert.deepEqual(token.split(".").map((part) => part.length > 0), [true, true]);
      assert.equal(token.split(".")[0], "v1");

      const checked = await fetch(`${box.url}/api/session`, { headers: { cookie } });
      assert.equal(checked.status, 200);
      assert.equal(cookieHeader(checked), cookie);
      assert.match(
        checked.headers.getSetCookie().join("; "),
        /Expires=Fri, 31 Dec 9999 23:59:59 GMT/i,
      );

      const bots = await fetch(`${box.url}/api/bots`, { headers: { cookie } });
      assert.equal(bots.status, 200);
      assert.equal(cookieHeader(bots), cookie);
      assert.match(
        bots.headers.getSetCookie().join("; "),
        /Expires=Fri, 31 Dec 9999 23:59:59 GMT/i,
      );
    } finally {
      await box.close();
    }
  });

  test("concurrent first starts share one private Home salt", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "openbot-session-concurrent-home-"));
    const pwaDir = await createPwaDir();
    const starts = await Promise.allSettled([
      startBox({ password: PASSWORD, pwaDir, host: "127.0.0.1", port: 0, homeDir }),
      startBox({ password: PASSWORD, pwaDir, host: "127.0.0.1", port: 0, homeDir }),
    ]);
    const boxes = starts.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    try {
      assert.equal(starts[0]?.status, "fulfilled");
      assert.equal(starts[1]?.status, "fulfilled");
      const first = boxes[0];
      const second = boxes[1];
      assert.ok(first && second);

      const login = await fetch(`${first.url}/api/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: PASSWORD }),
      });
      const cookie = cookieHeader(login);
      const shared = await fetch(`${second.url}/api/session`, { headers: { cookie } });
      assert.equal(shared.status, 200);

      const saltPath = join(homeDir, "auth", "salt");
      const salt = await readFile(saltPath);
      assert.equal(salt.length, 32);
      assert.notDeepEqual(salt, Buffer.alloc(32));
      assert.equal((await stat(homeDir)).mode & 0o777, 0o700);
      assert.equal((await stat(join(homeDir, "auth"))).mode & 0o777, 0o700);
      assert.equal((await stat(saltPath)).mode & 0o777, 0o600);
    } finally {
      await Promise.all(boxes.map((box) => box.close()));
    }
  });

  test("same Home and Password accept the same browser cookie after Talk restart", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "openbot-session-restart-home-"));
    const pwaDir = await createPwaDir();
    const first = await startBox({
      password: PASSWORD,
      pwaDir,
      host: "127.0.0.1",
      port: 0,
      homeDir,
    });

    const login = await fetch(`${first.url}/api/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: PASSWORD }),
    });
    const cookie = cookieHeader(login);
    assert.ok(cookie, "login did not return a cookie");
    await first.close();

    const restarted = await startBox({
      password: PASSWORD,
      pwaDir,
      host: "127.0.0.1",
      port: 0,
      homeDir,
    });
    try {
      const session = await fetch(`${restarted.url}/api/session`, {
        headers: { cookie },
      });
      assert.equal(session.status, 200);
    } finally {
      await restarted.close();
    }
  });
});

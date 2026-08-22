import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { startBox, type RunningBox } from "../src/box.ts";

const PASSWORD = "correct-horse";

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

describe("box HTTP session", () => {
  let box: RunningBox;

  before(async () => {
    const pwaDir = await mkdtemp(join(tmpdir(), "openbot-pwa-"));
    await writeFile(
      join(pwaDir, "index.html"),
      `<!doctype html><html><head><title>OpenBot</title></head><body><div id="root"></div></body></html>\n`,
    );
    box = await startBox({
      password: PASSWORD,
      pwaDir,
      host: "127.0.0.1",
      port: 0,
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

import assert from "node:assert/strict";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, test } from "node:test";

const REPOSITORY_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const RUNNER = join(REPOSITORY_ROOT, "scripts", "test.mjs");

function runRunner(...args: string[]) {
  return spawnSync(process.execPath, [RUNNER, ...args], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
  });
}

function outputLines(output: string): string[] {
  return output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

describe("test command contract", () => {
  test("package scripts expose deterministic and explicit live lanes", () => {
    const packageJson = JSON.parse(readFileSync(join(REPOSITORY_ROOT, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };

    assert.equal(packageJson.scripts?.test, "node scripts/test.mjs full");
    assert.equal(packageJson.scripts?.["test:focused"], "node scripts/test.mjs focused");
    assert.equal(packageJson.scripts?.["test:live:harness"], "node scripts/test.mjs live:harness");
    assert.equal(packageJson.scripts?.["test:live:screen"], "node scripts/test.mjs live:screen");
    assert.equal(packageJson.scripts?.["test:live:pinchtab"], "node scripts/test.mjs live:pinchtab");
  });

  test("focused deterministic selection runs only the requested files", () => {
    const result = runRunner(
      "focused",
      "--list",
      "daemon/test/talk.test.ts",
      "pwa/test/channels.test.ts",
    );

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(outputLines(result.stdout), [
      "daemon/test/talk.test.ts",
      "pwa/test/channels.test.ts",
    ]);
  });

  test("ordinary duplicate selection resolves to one test file", () => {
    const result = runRunner(
      "focused",
      "--list",
      "daemon/test/talk.test.ts",
      "daemon/test/talk.test.ts",
    );

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(outputLines(result.stdout), ["daemon/test/talk.test.ts"]);
  });

  test("an in-root symlink returns and deduplicates the validated real target", () => {
    const fixtureName = `test-runner-alias-${randomUUID()}.test.ts`;
    const fixture = join(REPOSITORY_ROOT, "daemon", "test", fixtureName);
    const target = join(REPOSITORY_ROOT, "daemon", "test", "talk.test.ts");

    try {
      symlinkSync(target, fixture);
      const result = runRunner(
        "focused",
        "--list",
        `daemon/test/${fixtureName}`,
        "daemon/test/talk.test.ts",
      );

      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(outputLines(result.stdout), ["daemon/test/talk.test.ts"]);
    } finally {
      rmSync(fixture, { force: true });
    }
  });

  test("focused selection rejects a test-shaped symlink that escapes the repository", () => {
    const outsideDirectory = mkdtempSync(join(tmpdir(), "openbot-test-runner-"));
    const outsideTest = join(outsideDirectory, "outside.test.ts");
    const fixtureName = `test-runner-escape-${randomUUID()}.test.ts`;
    const fixture = join(REPOSITORY_ROOT, "daemon", "test", fixtureName);

    try {
      writeFileSync(outsideTest, 'throw new Error("must not load");\n');
      symlinkSync(outsideTest, fixture);
      const result = runRunner("focused", "--list", `daemon/test/${fixtureName}`);

      assert.equal(result.status, 2);
      assert.match(result.stderr, /must stay inside the repository/u);
      assert.deepEqual(outputLines(result.stdout), []);
    } finally {
      rmSync(fixture, { force: true });
      rmSync(outsideDirectory, { force: true, recursive: true });
    }
  });

  test("full deterministic selection includes every non-live daemon and PWA test", () => {
    const expected = ["daemon/test", "pwa/test"]
      .flatMap((directory) =>
        readdirSync(join(REPOSITORY_ROOT, directory))
          .filter((name) => name.endsWith(".test.ts") && !name.includes(".live.test.ts"))
          .map((name) => `${directory}/${name}`),
      )
      .sort();
    const result = runRunner("full", "--list");

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(outputLines(result.stdout), expected);
    assert.equal(outputLines(result.stdout).some((path) => path.includes(".live.test.ts")), false);
  });

  test("live Harness selection retains both existing real-Harness suites", () => {
    const result = runRunner("live:harness", "--list");

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(outputLines(result.stdout), [
      "daemon/test/harness-home.live.test.ts",
      "daemon/test/home-channel.live.test.ts",
    ]);
  });

  test("the existing PinchTab suite belongs only to the live PinchTab lane", () => {
    const harness = runRunner("live:harness", "--list");
    const pinchtab = runRunner("live:pinchtab", "--list");

    assert.equal(harness.status, 0, harness.stderr);
    assert.equal(outputLines(harness.stdout).includes("daemon/test/pinchtab.live.test.ts"), false);
    assert.equal(pinchtab.status, 0, pinchtab.stderr);
    assert.deepEqual(outputLines(pinchtab.stdout), ["daemon/test/pinchtab.live.test.ts"]);
  });
  test("a deterministic lane rejects a live module", () => {
    const result = runRunner("focused", "--list", "daemon/test/home-channel.live.test.ts");

    assert.equal(result.status, 2);
    assert.match(result.stderr, /belongs to live:harness, not focused/u);
  });

  test("an empty live Screen lane fails instead of reporting proof", () => {
    const screen = runRunner("live:screen", "--list");

    assert.equal(screen.status, 2);
    assert.match(screen.stderr, /No live Screen test files found/u);
  });
});

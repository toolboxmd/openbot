import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, mock, test } from "node:test";
import {
  COMPUTER_CONTAINER,
  DISPLAY_BIN,
  DOCKER_DISPLAY_TIMEOUT_MS,
  DOCKER_INSPECT_TIMEOUT_MS,
  DOCKER_KILL_REAP_TIMEOUT_MS,
  DOCKER_TERM_GRACE_MS,
  DockerComputerRuntime,
  FORBIDDEN_HOST_PORT,
  HOST_PORT_FLOOR,
  MAX_DOCKER_OUTPUT_BYTES,
  MemoryComputerRuntime,
  isForbiddenHostPort,
  parsePinchTabPorts,
  parseScreenPorts,
  pickScreenPorts,
} from "../src/computer.ts";

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

async function waitForFile(file: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`fixture did not publish ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForProcessExit(pid: number, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`fixture process ${pid} survived cleanup`);
}

function processIdentity(pid: number): { pid: number; parentPid: number; processGroup: number; started: string } {
  const fields = execFileSync(
    "ps",
    ["-o", "pid=", "-o", "ppid=", "-o", "pgid=", "-o", "lstart=", "-p", String(pid)],
    { encoding: "utf8" },
  ).trim().split(/\s+/u);
  return {
    pid: Number(fields[0]),
    parentPid: Number(fields[1]),
    processGroup: Number(fields[2]),
    started: fields.slice(3).join(" "),
  };
}

describe("Computer displays",
  () => {
    test("never treats 6901 as an OpenBot Screen host port", () => {
      assert.equal(FORBIDDEN_HOST_PORT, 6901);
      assert.equal(isForbiddenHostPort(6901), true);
      assert.equal(isForbiddenHostPort(HOST_PORT_FLOOR), false);
    });

    test("pickScreenPorts skips 6901", async () => {
      const ports = await pickScreenPorts(3, [6901, HOST_PORT_FLOOR]);
      assert.equal(ports.length, 3);
      assert.equal(ports.includes(6901), false);
    });

    test("present endpoint lists reject every invalid field without shifting display identity", () => {
      const invalidLists = [
        "",
        "   ",
        "16951,,16953",
        "16951,not-a-port,16953",
        "16951,16952.5,16953",
        "16951,0x4238,16953",
        "16951,0,16953",
        "16951,65536,16953",
        "16951,6901,16953",
        "16951,16951",
        "16951,16952,16953,16954,16955,16956,16957,16958,16959",
      ];

      for (const raw of invalidLists) {
        assert.throws(() => parseScreenPorts(raw), /SCREEN_PORTS/u, raw || "<empty>");
        assert.throws(() => parsePinchTabPorts(raw), /PINCHTAB_PORTS/u, raw || "<empty>");
      }
      assert.deepEqual(parseScreenPorts(undefined), []);
      assert.deepEqual(parsePinchTabPorts(undefined), []);
      assert.deepEqual(parseScreenPorts("16951, 16952,16953"), [16951, 16952, 16953]);
      assert.deepEqual(parsePinchTabPorts("19867, 19868,19869"), [19867, 19868, 19869]);
    });

    test("invalid endpoint maps fail before runtime state or Docker side effects", async () => {
      const root = await tempDir("openbot-endpoint-map-red-");
      const cases: Array<{
        name: string;
        hostPorts: number[];
        pinchTabHostPorts: number[];
        error: RegExp;
      }> = [
        {
          name: "duplicate-screen",
          hostPorts: [16951, 16951],
          pinchTabHostPorts: [19867, 19868],
          error: /SCREEN_PORTS.*duplicate/iu,
        },
        {
          name: "duplicate-pinchtab",
          hostPorts: [16951, 16952],
          pinchTabHostPorts: [19867, 19867],
          error: /PINCHTAB_PORTS.*duplicate/iu,
        },
        {
          name: "missing-pinchtab",
          hostPorts: [16951, 16952],
          pinchTabHostPorts: [19867],
          error: /PINCHTAB_PORTS.*2.*required/iu,
        },
        {
          name: "surplus-pinchtab",
          hostPorts: [16951],
          pinchTabHostPorts: [19867, 19868],
          error: /PINCHTAB_PORTS.*1.*required/iu,
        },
        {
          name: "same-display-overlap",
          hostPorts: [16951, 16952],
          pinchTabHostPorts: [16951, 19868],
          error: /SCREEN_PORTS.*PINCHTAB_PORTS.*overlap.*16951/iu,
        },
        {
          name: "cross-display-overlap",
          hostPorts: [16951, 16952],
          pinchTabHostPorts: [16952, 19868],
          error: /SCREEN_PORTS.*PINCHTAB_PORTS.*overlap.*16952/iu,
        },
        {
          name: "fractional-option",
          hostPorts: [16951, 16952.5],
          pinchTabHostPorts: [19867, 19868],
          error: /SCREEN_PORTS.*field 2/iu,
        },
        {
          name: "surplus-displays",
          hostPorts: [16951, 16952, 16953, 16954, 16955, 16956, 16957, 16958, 16959],
          pinchTabHostPorts: [19867, 19868, 19869, 19870, 19871, 19872, 19873, 19874, 19875],
          error: /SCREEN_PORTS.*at most 8/iu,
        },
      ];

      try {
        for (const fixture of cases) {
          let dockerCalls = 0;
          const cookiesDir = join(root, fixture.name, "cookies");
          assert.throws(
            () => new DockerComputerRuntime({
              hostPorts: fixture.hostPorts,
              pinchTabHostPorts: fixture.pinchTabHostPorts,
              cookiesDir,
              docker: async () => {
                dockerCalls += 1;
                return { code: 0, stdout: "", stderr: "" };
              },
            }),
            fixture.error,
            fixture.name,
          );
          assert.equal(dockerCalls, 0, `${fixture.name} reached Docker`);
          assert.equal(existsSync(cookiesDir), false, `${fixture.name} mutated runtime state`);
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("two Bots allocate two display upstreams and never docker run a second Screen", async () => {
      const cookiesDir = join(await tempDir("openbot-computer-cookies-"), "cookies");
      const dockerCalls: string[][] = [];
      const computer = new DockerComputerRuntime({
        hostPorts: [16911, 16912, 16913],
        cookiesDir,
        docker: async (args) => {
          dockerCalls.push(args);
          return { code: 0, stdout: args[0] === "inspect" ? "true\n" : "", stderr: "" };
        },
      });
      const ada = await computer.allocate("ada");
      const ben = await computer.allocate("ben");
      assert.equal(ada.display, 1);
      assert.equal(ben.display, 2);
      assert.equal(ada.upstream, "http://127.0.0.1:16911");
      assert.equal(ben.upstream, "http://127.0.0.1:16912");
      assert.notEqual(ada.upstream, ben.upstream);
      assert.equal(computer.containerName(), COMPUTER_CONTAINER);
      const runs = dockerCalls.filter((args) => args[0] === "run");
      assert.equal(runs.length, 0, "Talk must not docker run a second Screen image");
      assert.equal(
        dockerCalls.some((args) => args.some((item) => item.startsWith("openbot-screen-") && item !== COMPUTER_CONTAINER)),
        false,
      );
      const execs = dockerCalls.filter((args) => args[0] === "exec");
      assert.equal(execs.length, 1);
      assert.deepEqual(execs[0], ["exec", COMPUTER_CONTAINER, DISPLAY_BIN, "start", "2"]);
    });

    test("concurrent Docker allocation reserves distinct displays before subprocess completion", async () => {
      const cookiesDir = join(await tempDir("openbot-computer-concurrent-"), "cookies");
      let releaseDocker!: () => void;
      const dockerGate = new Promise<void>((resolve) => {
        releaseDocker = resolve;
      });
      let calls = 0;
      let bothCalls!: () => void;
      const bothStarted = new Promise<void>((resolve) => {
        bothCalls = resolve;
      });
      const computer = new DockerComputerRuntime({
        hostPorts: [16911, 16912],
        cookiesDir,
        docker: async () => {
          calls += 1;
          if (calls === 2) bothCalls();
          await dockerGate;
          return { code: 0, stdout: "true\n", stderr: "" };
        },
      });

      const adaPending = computer.allocate("ada");
      const benPending = computer.allocate("ben");
      await bothStarted;
      releaseDocker();
      const [ada, ben] = await Promise.all([adaPending, benPending]);

      assert.deepEqual([ada.display, ben.display].sort(), [1, 2]);
      assert.notEqual(ada.upstream, ben.upstream);
    });

    test("failed Docker inspection is not committed and its display can be retried", async () => {
      const cookiesDir = join(await tempDir("openbot-computer-inspect-failure-"), "cookies");
      let inspections = 0;
      const computer = new DockerComputerRuntime({
        hostPorts: [16911],
        cookiesDir,
        docker: async (args) => {
          assert.equal(args[0], "inspect");
          inspections += 1;
          if (inspections === 1) return { code: 1, stdout: "", stderr: "container is not running\n" };
          return { code: 0, stdout: "true\n", stderr: "" };
        },
      });

      await assert.rejects(computer.allocate("ada"), /container is not running/i);
      assert.equal(computer.display("ada"), undefined);
      const retry = await computer.allocate("ben");
      assert.equal(retry.display, 1);
    });

    test("Docker inspection accepts only one bounded running-state record", async () => {
      for (const [index, stdout] of ["false\n", "true\nextra\n", "true"].entries()) {
        const cookiesDir = join(await tempDir(`openbot-computer-inspect-output-${index}-`), "cookies");
        const computer = new DockerComputerRuntime({
          hostPorts: [16911],
          cookiesDir,
          docker: async () => ({ code: 0, stdout, stderr: "" }),
        });
        await assert.rejects(computer.allocate(`bot-${index}`), /invalid running-state record/i);
        assert.equal(computer.display(`bot-${index}`), undefined);
      }
    });

    test("display start and stop failures stay uncommitted or quarantined until retry", async () => {
      const cookiesDir = join(await tempDir("openbot-computer-display-status-"), "cookies");
      let startFails = true;
      let stopFails = false;
      const deadlines: Array<{ operation: string; timeoutMs: number | undefined }> = [];
      const computer = new DockerComputerRuntime({
        hostPorts: [16911, 16912, 16913],
        cookiesDir,
        docker: async (args, deadline) => {
          deadlines.push({
            operation: args[0] === "exec" ? args[3] ?? "" : args[0] ?? "",
            timeoutMs: deadline?.timeoutMs,
          });
          if (args[0] === "inspect") return { code: 0, stdout: "true\n", stderr: "" };
          if (args[3] === "start" && startFails) {
            return { code: 23, stdout: "", stderr: "controlled display start failure\n" };
          }
          if (args[3] === "stop" && stopFails) {
            return { code: 24, stdout: "", stderr: "controlled display stop failure\n" };
          }
          return { code: 0, stdout: "", stderr: "" };
        },
      });
      assert.equal((await computer.allocate("ada")).display, 1);

      await assert.rejects(computer.allocate("ben"), /controlled display start failure/i);
      assert.equal(computer.display("ben"), undefined);
      startFails = false;
      assert.equal((await computer.allocate("ben-retry")).display, 2);

      stopFails = true;
      await assert.rejects(computer.release("ben-retry"), /controlled display stop failure/i);
      assert.equal(computer.display("ben-retry")?.display, 2, "failed cleanup released a live display");
      stopFails = false;
      await computer.release("ben-retry");
      assert.equal(computer.display("ben-retry"), undefined);
      assert.equal((await computer.allocate("after-cleanup")).display, 2);
      assert.equal(deadlines.find((item) => item.operation === "inspect")?.timeoutMs, DOCKER_INSPECT_TIMEOUT_MS);
      assert.ok(
        deadlines.filter((item) => ["start", "stop", "discard"].includes(item.operation)).length >= 4,
        "fixture did not exercise every display lifecycle operation",
      );
      assert.equal(
        deadlines
          .filter((item) => ["start", "stop", "discard"].includes(item.operation))
          .every((item) => item.timeoutMs === DOCKER_DISPLAY_TIMEOUT_MS),
        true,
      );
    });

    test("real Docker subprocess capture stops at the bounded output limit", async () => {
      const root = await tempDir("openbot-computer-output-bound-");
      const binDir = join(root, "bin");
      const docker = join(binDir, "docker");
      const cookiesDir = join(root, "cookies");
      await mkdir(binDir);
      await writeFile(
        docker,
        `#!${process.execPath}\nconst chunk = "x".repeat(${MAX_DOCKER_OUTPUT_BYTES / 4}); const timer = setInterval(() => process.stdout.write(chunk), 5); setTimeout(() => clearInterval(timer), 2_000);\n`,
        { mode: 0o755 },
      );
      const computer = new DockerComputerRuntime({
        hostPorts: [16911],
        cookiesDir,
        env: { ...process.env, PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}` },
      });

      const startedAt = Date.now();
      try {
        await assert.rejects(computer.allocate("ada"), /bounded output contract/i);
        assert.ok(Date.now() - startedAt < 1_200, "unbounded child was not terminated at the capture limit");
        assert.equal(computer.display("ada"), undefined);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("silent Docker inspection reaches one bounded terminal failure", async () => {
      const root = await tempDir("openbot-computer-inspect-timeout-");
      const binDir = join(root, "bin");
      const docker = join(binDir, "docker");
      const childReady = join(root, "docker-child.json");
      const foreignReady = join(root, "foreign-child.json");
      const lateSideEffect = join(root, "late-side-effect");
      const cookiesDir = join(root, "cookies");
      await mkdir(binDir);
      const descendantSource = `
        const { writeFileSync } = require("node:fs");
        process.on("SIGTERM", () => {});
        if (process.send) process.send({ pid: process.pid });
        setTimeout(
          () => writeFileSync(process.env.OPENBOT_DOCKER_LATE_SIDE_EFFECT, "late"),
          ${DOCKER_INSPECT_TIMEOUT_MS + DOCKER_TERM_GRACE_MS + 500},
        );
        setInterval(() => {}, 60_000);
      `;
      await writeFile(
        docker,
        `#!${process.execPath}\nconst { spawn } = require("node:child_process"); const { writeFileSync } = require("node:fs"); const descendant = spawn(process.execPath, ["-e", ${JSON.stringify(descendantSource)}], { env: process.env, stdio: ["ignore", "ignore", "ignore", "ipc"] }); descendant.once("message", (message) => writeFileSync(process.env.OPENBOT_DOCKER_CHILD_READY, JSON.stringify({ pid: process.pid, descendantPid: message.pid }))); setInterval(() => {}, 60_000);\n`,
        { mode: 0o755 },
      );
      const foreign = spawn(
        process.execPath,
        ["-e", `const { writeFileSync } = require("node:fs"); writeFileSync(process.env.OPENBOT_FOREIGN_READY, JSON.stringify({ pid: process.pid })); setInterval(() => {}, 60_000);`],
        {
          detached: process.platform !== "win32",
          env: { ...process.env, OPENBOT_FOREIGN_READY: foreignReady },
          stdio: "ignore",
        },
      );
      if (!foreign.pid) throw new Error("foreign fixture did not spawn");
      const foreignPid = foreign.pid;
      const computer = new DockerComputerRuntime({
        hostPorts: [16911],
        cookiesDir,
        env: {
          ...process.env,
          OPENBOT_DOCKER_CHILD_READY: childReady,
          OPENBOT_DOCKER_LATE_SIDE_EFFECT: lateSideEffect,
          PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
        },
      });
      const allocation = computer.allocate("ada");
      const outcome = allocation.then(
        () => ({ settled: true as const, error: undefined }),
        (error: unknown) => ({ settled: true as const, error }),
      );
      let childPid = 0;
      let descendantPid = 0;

      try {
        await Promise.all([waitForFile(childReady), waitForFile(foreignReady)]);
        const ready = JSON.parse(await readFile(childReady, "utf8")) as { pid: number; descendantPid: number };
        childPid = ready.pid;
        descendantPid = ready.descendantPid;
        assert.ok(Number.isSafeInteger(childPid) && childPid > 0, "fixture did not publish its exact child PID");
        assert.ok(
          Number.isSafeInteger(descendantPid) && descendantPid > 0,
          "fixture did not publish its exact descendant PID",
        );
        assert.doesNotThrow(() => process.kill(childPid, 0));
        assert.doesNotThrow(() => process.kill(descendantPid, 0));
        const childIdentity = processIdentity(childPid);
        const descendantIdentity = processIdentity(descendantPid);
        const runnerIdentity = processIdentity(process.pid);
        const foreignIdentity = processIdentity(foreignPid);
        assert.equal(childIdentity.pid, childPid);
        assert.ok(childIdentity.started.length > 0, "fixture did not have an observable start identity");
        assert.equal(childIdentity.processGroup, childPid, "Docker CLI did not lead a verified private process group");
        assert.notEqual(childIdentity.processGroup, runnerIdentity.processGroup, "Docker CLI shared the runner process group");
        assert.equal(descendantIdentity.parentPid, childPid);
        assert.equal(descendantIdentity.processGroup, childIdentity.processGroup);
        assert.ok(descendantIdentity.started.length > 0, "descendant did not have an observable start identity");
        assert.equal(foreignIdentity.processGroup, foreignPid);
        assert.notEqual(foreignIdentity.processGroup, childIdentity.processGroup);

        const startedAt = Date.now();
        const bounded = await Promise.race([
          outcome,
          new Promise<{ settled: false; error: undefined }>((resolve) => {
            setTimeout(() => resolve({ settled: false, error: undefined }), DOCKER_INSPECT_TIMEOUT_MS + 2_000);
          }),
        ]);
        assert.equal(
          bounded.settled,
          true,
          "the Docker CLI descendant survived leader-only termination and held provisioning forever",
        );
        assert.match(String(bounded.error), /docker inspect.*timed out/i);
        assert.ok(
          Date.now() - startedAt <= DOCKER_INSPECT_TIMEOUT_MS + DOCKER_TERM_GRACE_MS + 1_500,
          "Docker timeout exceeded its deadline, TERM/KILL grace, and contention margin",
        );
        assert.equal(computer.display("ada"), undefined);
        assert.throws(() => process.kill(childPid, 0));
        assert.throws(() => process.kill(descendantPid, 0));
        assert.doesNotThrow(() => process.kill(foreignPid, 0), "foreign process was killed");
        const lateWait = DOCKER_INSPECT_TIMEOUT_MS + DOCKER_TERM_GRACE_MS + 750 - (Date.now() - startedAt);
        if (lateWait > 0) await new Promise((resolve) => setTimeout(resolve, lateWait));
        assert.equal(existsSync(lateSideEffect), false, "timed-out Docker work produced a late side effect");
      } finally {
        if (descendantPid > 0) {
          try {
            process.kill(descendantPid, "SIGKILL");
          } catch {
            // The production timeout may already have reaped it.
          }
          await waitForProcessExit(descendantPid);
        }
        if (childPid > 0) {
          try {
            process.kill(childPid, "SIGKILL");
          } catch {
            // The production timeout may already have reaped it.
          }
          await waitForProcessExit(childPid);
        }
        try {
          process.kill(foreignPid, "SIGKILL");
        } catch {
          // Cleanup is idempotent if the fixture exited unexpectedly.
        }
        await waitForProcessExit(foreignPid);
        await outcome;
        await rm(root, { recursive: true, force: true });
      }
    });

    test("post-SIGKILL group observation cannot hold a Docker failure open forever", async () => {
      const root = await tempDir("openbot-computer-reap-timeout-");
      const binDir = join(root, "bin");
      const docker = join(binDir, "docker");
      const childReady = join(root, "docker-child.json");
      await mkdir(binDir);
      await writeFile(
        docker,
        `#!${process.execPath}\nconst { writeFileSync } = require("node:fs"); process.on("SIGTERM", () => {}); writeFileSync(process.env.OPENBOT_DOCKER_CHILD_READY, JSON.stringify({ pid: process.pid })); setInterval(() => {}, 60_000);\n`,
        { mode: 0o755 },
      );
      const originalKill = process.kill.bind(process);
      let sawOwnedSigkill = false;
      const killMock = mock.method(process, "kill", ((pid: number, signal?: NodeJS.Signals | 0) => {
        if (pid < 0 && signal === "SIGKILL") {
          sawOwnedSigkill = true;
          return originalKill(pid, signal);
        }
        if (pid < 0 && signal === 0 && sawOwnedSigkill) return true;
        return originalKill(pid, signal);
      }) as typeof process.kill);
      const computer = new DockerComputerRuntime({
        hostPorts: [16911],
        cookiesDir: join(root, "cookies"),
        env: {
          ...process.env,
          OPENBOT_DOCKER_CHILD_READY: childReady,
          PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
        },
      });
      const outcome = computer.allocate("ada").then(
        () => ({ settled: true as const, error: undefined }),
        (error: unknown) => ({ settled: true as const, error }),
      );
      let childPid = 0;

      try {
        await waitForFile(childReady);
        childPid = (JSON.parse(await readFile(childReady, "utf8")) as { pid: number }).pid;
        const bounded = await Promise.race([
          outcome,
          new Promise<{ settled: false; error: undefined }>((resolve) => {
            setTimeout(
              () => resolve({ settled: false, error: undefined }),
              DOCKER_INSPECT_TIMEOUT_MS
                + DOCKER_TERM_GRACE_MS
                + DOCKER_KILL_REAP_TIMEOUT_MS
                + 500,
            );
          }),
        ]);
        assert.equal(sawOwnedSigkill, true, "fixture did not reach the post-SIGKILL reaping path");
        assert.equal(bounded.settled, true, "post-SIGKILL liveness observation held the Docker Promise open");
        assert.match(String(bounded.error), /docker inspect.*timed out/i);
        assert.equal(computer.display("ada"), undefined);
      } finally {
        killMock.mock.restore();
        if (childPid > 0) {
          try {
            originalKill(childPid, "SIGKILL");
          } catch {
            // The production timeout should already have reaped it.
          }
          await waitForProcessExit(childPid);
        }
        await outcome;
        await rm(root, { recursive: true, force: true });
      }
    });

    test("owned group closure cannot leave Docker waiting on a foreign pipe holder", async () => {
      const root = await tempDir("openbot-computer-foreign-pipe-");
      const binDir = join(root, "bin");
      const docker = join(binDir, "docker");
      const childReady = join(root, "docker-child.json");
      const foreignSignal = join(root, "foreign-signal");
      await mkdir(binDir);
      const foreignSource = `
        const { writeFileSync } = require("node:fs");
        const recordSignal = (signal) => writeFileSync(process.env.OPENBOT_FOREIGN_SIGNAL, signal);
        process.on("SIGTERM", () => recordSignal("SIGTERM"));
        process.on("SIGINT", () => recordSignal("SIGINT"));
        if (process.send) process.send({ pid: process.pid });
        setInterval(() => {}, 60_000);
      `;
      await writeFile(
        docker,
        `#!${process.execPath}\nconst { spawn } = require("node:child_process"); const { writeFileSync } = require("node:fs"); const foreign = spawn(process.execPath, ["-e", ${JSON.stringify(foreignSource)}], { detached: true, env: process.env, stdio: ["ignore", "inherit", "inherit", "ipc"] }); foreign.once("message", (message) => writeFileSync(process.env.OPENBOT_DOCKER_CHILD_READY, JSON.stringify({ pid: process.pid, foreignPid: message.pid }))); setInterval(() => {}, 60_000);\n`,
        { mode: 0o755 },
      );
      const computer = new DockerComputerRuntime({
        hostPorts: [16911],
        cookiesDir: join(root, "cookies"),
        env: {
          ...process.env,
          OPENBOT_DOCKER_CHILD_READY: childReady,
          OPENBOT_FOREIGN_SIGNAL: foreignSignal,
          PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
        },
      });
      const outcome = computer.allocate("ada").then(
        () => ({ settled: true as const, error: undefined }),
        (error: unknown) => ({ settled: true as const, error }),
      );
      let childPid = 0;
      let foreignPid = 0;

      try {
        await waitForFile(childReady);
        const ready = JSON.parse(await readFile(childReady, "utf8")) as { pid: number; foreignPid: number };
        childPid = ready.pid;
        foreignPid = ready.foreignPid;
        const childIdentity = processIdentity(childPid);
        const foreignIdentity = processIdentity(foreignPid);
        assert.equal(childIdentity.processGroup, childPid, "Docker CLI did not lead its private group");
        assert.equal(foreignIdentity.processGroup, foreignPid, "escaped pipe holder did not lead a foreign group");
        assert.notEqual(foreignIdentity.processGroup, childIdentity.processGroup);

        const bounded = await Promise.race([
          outcome,
          new Promise<{ settled: false; error: undefined }>((resolve) => {
            setTimeout(
              () => resolve({ settled: false, error: undefined }),
              DOCKER_INSPECT_TIMEOUT_MS
                + DOCKER_TERM_GRACE_MS
                + DOCKER_KILL_REAP_TIMEOUT_MS
                + 500,
            );
          }),
        ]);
        assert.throws(() => process.kill(-childPid, 0), "owned Docker process group did not close");
        assert.doesNotThrow(() => process.kill(foreignPid, 0), "foreign pipe holder did not survive");
        assert.equal(existsSync(foreignSignal), false, "foreign pipe holder was signaled");
        assert.equal(
          bounded.settled,
          true,
          "owned group closure left the Docker Promise waiting on a foreign pipe holder",
        );
        assert.match(String(bounded.error), /docker inspect.*timed out/i);
        assert.equal(computer.display("ada"), undefined);
      } finally {
        if (foreignPid > 0) {
          try {
            process.kill(foreignPid, "SIGKILL");
          } catch {
            // The escaped foreign fixture is cleaned independently by exact PID.
          }
          await waitForProcessExit(foreignPid);
        }
        if (childPid > 0) await waitForProcessExit(childPid);
        await outcome;
        await rm(root, { recursive: true, force: true });
      }
    });

    test("MemoryComputerRuntime records exec for the second display, not a second run", async () => {
      const cookiesDir = join(await tempDir("openbot-mem-cookies-"), "cookies");
      const computer = new MemoryComputerRuntime({
        cookiesDir,
        upstreams: ["http://127.0.0.1:16921", "http://127.0.0.1:16922"],
      });
      const ada = await computer.allocate("ada");
      const ben = await computer.allocate("ben");
      assert.equal(ada.display, 1);
      assert.equal(ben.display, 2);
      assert.notEqual(ada.upstream, ben.upstream);
      assert.equal(computer.commands.some((args) => args[0] === "run"), false);
      assert.deepEqual(
        computer.commands.find((args) => args[0] === "exec"),
        ["exec", COMPUTER_CONTAINER, DISPLAY_BIN, "start", "2"],
      );
    });

    test("a reserved display cannot be committed before preparation succeeds", async () => {
      const cookiesDir = join(await tempDir("openbot-computer-reservation-state-"), "cookies");
      const computer = new MemoryComputerRuntime({ cookiesDir });
      const reserved = computer.reserve("ada");
      assert.equal(reserved.display, 1);
      assert.throws(() => computer.commit("ada"), /not prepared/i);
      assert.equal(computer.display("ada"), undefined);

      await computer.prepare("ada");
      assert.equal(computer.commit("ada").display, 1);
    });

    test("refuses a host port of 6901", async () => {
      const cookiesDir = join(await tempDir("openbot-forbidden-"), "cookies");
      assert.throws(
        () => new DockerComputerRuntime({
          hostPorts: [6901],
          cookiesDir,
          docker: async (args) => ({ code: 0, stdout: args[0] === "inspect" ? "true\n" : "", stderr: "" }),
        }),
        /6901/,
      );
    });

    test("refuses a PinchTab host port of 6901", async () => {
      const cookiesDir = join(await tempDir("openbot-pt-forbidden-"), "cookies");
      assert.throws(
        () => new DockerComputerRuntime({
          hostPorts: [16911],
          pinchTabHostPorts: [6901],
          pinchTabToken: "token",
          cookiesDir,
          docker: async () => ({ code: 0, stdout: "", stderr: "" }),
        }),
        /6901/,
      );
    });

    test("allocate fills PinchTab url when host ports are set", async () => {
      const cookiesDir = join(await tempDir("openbot-pt-ports-"), "cookies");
      const computer = new DockerComputerRuntime({
        hostPorts: [16911, 16912],
        pinchTabHostPorts: [19867, 19868],
        pinchTabToken: "pt-token",
        cookiesDir,
        docker: async (args) => ({ code: 0, stdout: args[0] === "inspect" ? "true\n" : "", stderr: "" }),
      });
      const ada = await computer.allocate("ada");
      const ben = await computer.allocate("ben");
      assert.equal(ada.pinchTabUrl, "http://127.0.0.1:19867");
      assert.equal(ben.pinchTabUrl, "http://127.0.0.1:19868");
      assert.deepEqual(computer.pinchTab("ada"), { url: "http://127.0.0.1:19867", token: "pt-token" });
      assert.notEqual(computer.pinchTab("ada")?.url, computer.pinchTab("ben")?.url);
    });
  },
);

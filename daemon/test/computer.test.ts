import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, test } from "node:test";
import {
  COMPUTER_CONTAINER,
  DISPLAY_BIN,
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
      const computer = new DockerComputerRuntime({
        hostPorts: [16911, 16912, 16913],
        cookiesDir,
        docker: async (args) => {
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

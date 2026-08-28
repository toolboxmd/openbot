import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  COMPUTER_CONTAINER,
  DISPLAY_BIN,
  DockerComputerRuntime,
  FORBIDDEN_HOST_PORT,
  HOST_PORT_FLOOR,
  MemoryComputerRuntime,
  isForbiddenHostPort,
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

    test("two Bots allocate two display upstreams and never docker run a second Screen", async () => {
      const cookiesDir = join(await tempDir("openbot-computer-cookies-"), "cookies");
      const dockerCalls: string[][] = [];
      const computer = new DockerComputerRuntime({
        hostPorts: [16911, 16912, 16913],
        cookiesDir,
        docker: async (args) => {
          dockerCalls.push(args);
          return { code: 0, stdout: "[]", stderr: "" };
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

    test("refuses a host port of 6901", async () => {
      const cookiesDir = join(await tempDir("openbot-forbidden-"), "cookies");
      const computer = new DockerComputerRuntime({
        hostPorts: [6901],
        cookiesDir,
        docker: async () => ({ code: 0, stdout: "", stderr: "" }),
      });
      await assert.rejects(() => computer.allocate("ada"), /6901/);
    });

    test("refuses a PinchTab host port of 6901", async () => {
      const cookiesDir = join(await tempDir("openbot-pt-forbidden-"), "cookies");
      const computer = new DockerComputerRuntime({
        hostPorts: [16911],
        pinchTabHostPorts: [6901],
        pinchTabToken: "token",
        cookiesDir,
        docker: async () => ({ code: 0, stdout: "", stderr: "" }),
      });
      await assert.rejects(() => computer.allocate("ada"), /6901/);
    });

    test("allocate fills PinchTab url when host ports are set", async () => {
      const cookiesDir = join(await tempDir("openbot-pt-ports-"), "cookies");
      const computer = new DockerComputerRuntime({
        hostPorts: [16911, 16912],
        pinchTabHostPorts: [19867, 19868],
        pinchTabToken: "pt-token",
        cookiesDir,
        docker: async () => ({ code: 0, stdout: "", stderr: "" }),
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

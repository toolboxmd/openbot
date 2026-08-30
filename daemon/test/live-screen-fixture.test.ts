import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  immutableDockerRemovalArgs,
  LIVE_LABEL,
  RUN_LABEL,
  runOwnedCommand,
  validateOwnedDockerSet,
  type DockerOwnershipInput,
  type ExpectedDockerOwnership,
} from "./live-screen-fixture.ts";

const expected: ExpectedDockerOwnership = {
  containerName: "openbot-screen-live-run123",
  imageName: "openbot-screen-live-run123:test",
  liveLabel: "connected-pwa-shutdown",
  networkName: "openbot-screen-live-run123",
  protectedContainerId: "protected-container",
  protectedImageIds: ["protected-image"],
  protectedNetworkIds: ["protected-network"],
  runLabel: "run123",
};

function exactSet(): DockerOwnershipInput {
  return {
    container: {
      Id: "owned-container",
      Image: "owned-image",
      Name: `/${expected.containerName}`,
      Config: {
        Image: expected.imageName,
        Labels: { [LIVE_LABEL]: expected.liveLabel, [RUN_LABEL]: expected.runLabel },
      },
      NetworkSettings: {
        Networks: { [expected.networkName]: { NetworkID: "owned-network" } },
      },
    },
    image: {
      Id: "owned-image",
      RepoTags: [expected.imageName],
      Config: { Labels: { [LIVE_LABEL]: expected.liveLabel, [RUN_LABEL]: expected.runLabel } },
    },
    network: {
      Id: "owned-network",
      Name: expected.networkName,
      Labels: { [LIVE_LABEL]: expected.liveLabel, [RUN_LABEL]: expected.runLabel },
      Containers: { "owned-container": { Name: expected.containerName } },
    },
  };
}

describe("live Screen fixture ownership", () => {
  test("accepts one exact running set and plans immutable-ID removals", () => {
    const owned = validateOwnedDockerSet(exactSet(), expected, { requireComplete: true });
    assert.deepEqual(owned, {
      containerId: "owned-container",
      imageId: "owned-image",
      networkId: "owned-network",
    });
    assert.deepEqual(
      immutableDockerRemovalArgs("container", owned.containerId!),
      ["container", "rm", "--force", "owned-container"],
    );
    assert.deepEqual(
      immutableDockerRemovalArgs("network", owned.networkId!),
      ["network", "rm", "owned-network"],
    );
    assert.deepEqual(
      immutableDockerRemovalArgs("image", owned.imageId!),
      ["image", "rm", "owned-image"],
    );
  });

  test("rejects label drift before any removal target is returned", () => {
    const input = exactSet();
    input.container!.Config!.Labels![RUN_LABEL] = "foreign-run";
    assert.throws(
      () => validateOwnedDockerSet(input, expected, { requireComplete: true }),
      /container ownership label mismatch/u,
    );
  });

  test("rejects image alias, image identity, and protected identity drift", () => {
    const alias = exactSet();
    alias.image!.RepoTags!.push("foreign:tag");
    assert.throws(
      () => validateOwnedDockerSet(alias, expected, { requireComplete: true }),
      /image tag ownership mismatch/u,
    );

    const identity = exactSet();
    identity.container!.Image = "foreign-image";
    assert.throws(
      () => validateOwnedDockerSet(identity, expected, { requireComplete: true }),
      /container image identity mismatch/u,
    );

    const protectedSet = exactSet();
    protectedSet.image!.Id = "protected-image";
    protectedSet.container!.Image = "protected-image";
    assert.throws(
      () => validateOwnedDockerSet(protectedSet, expected, { requireComplete: true }),
      /protected Docker image/u,
    );
  });

  test("rejects foreign network membership and accepts an empty partial cleanup set", () => {
    const foreign = exactSet();
    foreign.network!.Containers!["foreign-container"] = { Name: "foreign" };
    assert.throws(
      () => validateOwnedDockerSet(foreign, expected, { requireComplete: true }),
      /network membership mismatch/u,
    );

    const partial = exactSet();
    delete partial.container;
    partial.network!.Containers = {};
    assert.deepEqual(
      validateOwnedDockerSet(partial, expected, { requireComplete: false }),
      { imageId: "owned-image", networkId: "owned-network" },
    );
  });

  test("rejects a successful wrapper that leaves its owned process group alive", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "openbot-live-owned-command-"));
    const fixture = join(root, "leader.mjs");
    const pidFile = join(root, "descendant.pid");
    let descendantPid: number | undefined;
    try {
      await writeFile(fixture, `
        import { spawn } from "node:child_process";
        import { writeFileSync } from "node:fs";
        const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
          stdio: "ignore",
        });
        writeFileSync(process.argv[2], String(child.pid));
        child.unref();
      `);
      await assert.rejects(
        runOwnedCommand(process.execPath, [fixture, pidFile], {
          description: "owned success fixture",
          env: process.env,
          timeoutMs: 5_000,
        }),
        /left its owned process group running/u,
      );
      descendantPid = Number((await readFile(pidFile, "utf8")).trim());
      assert.throws(() => process.kill(descendantPid!, 0), /ESRCH/u);
    } finally {
      if (!descendantPid) {
        try {
          descendantPid = Number((await readFile(pidFile, "utf8")).trim());
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      if (descendantPid && Number.isInteger(descendantPid)) {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
      await rm(root, { recursive: true, force: true });
    }
  });
});

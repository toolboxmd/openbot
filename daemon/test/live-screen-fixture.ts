import { spawn } from "node:child_process";

export const LIVE_LABEL = "openbot.live";
export const RUN_LABEL = "openbot.run";

export type OwnedCommandResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  stdout: string;
};

export class OwnedCommandError extends Error {
  readonly result: OwnedCommandResult;

  constructor(message: string, result: OwnedCommandResult) {
    super(message);
    this.name = "OwnedCommandError";
    this.result = result;
  }
}

export type DockerContainerInspect = {
  Config?: {
    Image?: string;
    Labels?: Record<string, string>;
  };
  Id?: string;
  Image?: string;
  Name?: string;
  NetworkSettings?: {
    Networks?: Record<string, { NetworkID?: string }>;
  };
};

export type DockerImageInspect = {
  Config?: { Labels?: Record<string, string> };
  Id?: string;
  RepoTags?: string[];
};

export type DockerNetworkInspect = {
  Containers?: Record<string, unknown> | null;
  Id?: string;
  Labels?: Record<string, string>;
  Name?: string;
};

export type DockerOwnershipInput = {
  container?: DockerContainerInspect;
  image?: DockerImageInspect;
  network?: DockerNetworkInspect;
};

export type ExpectedDockerOwnership = {
  containerName: string;
  imageName: string;
  liveLabel: string;
  networkName: string;
  protectedContainerId?: string | null;
  protectedImageIds?: readonly string[];
  protectedNetworkIds?: readonly string[];
  runLabel: string;
};

export type OwnedDockerSet = {
  containerId?: string;
  imageId?: string;
  networkId?: string;
};

const OUTPUT_LIMIT_BYTES = 1_048_576;
const TERM_GRACE_MS = 250;
const KILL_OBSERVE_MS = 1_000;

export function runOwnedCommand(
  command: string,
  args: string[],
  options: {
    description: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
  },
): Promise<OwnedCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: process.platform !== "win32",
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const ownedPid = child.pid;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let childClosed = false;
    let settled = false;
    let terminalError: Error | undefined;
    let termTimer: NodeJS.Timeout | undefined;
    let observeTimer: NodeJS.Timeout | undefined;
    let reapTimer: NodeJS.Timeout | undefined;

    const result = (
      code: number | null = child.exitCode,
      signal: NodeJS.Signals | null = child.signalCode,
    ): OwnedCommandResult => ({
      code,
      signal,
      stderr: Buffer.concat(stderr).toString("utf8"),
      stdout: Buffer.concat(stdout).toString("utf8"),
    });
    const groupAlive = (): boolean => {
      if (!ownedPid) return false;
      if (process.platform === "win32") {
        return child.exitCode === null && child.signalCode === null;
      }
      try {
        process.kill(-ownedPid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code !== "ESRCH";
      }
    };
    const signalGroup = (signal: NodeJS.Signals): void => {
      if (!ownedPid) return;
      try {
        if (process.platform === "win32") child.kill(signal);
        else process.kill(-ownedPid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill(signal);
      }
    };
    const clearTimers = (): void => {
      clearTimeout(deadlineTimer);
      if (termTimer) clearTimeout(termTimer);
      if (observeTimer) clearTimeout(observeTimer);
      if (reapTimer) clearInterval(reapTimer);
    };
    const finishFailureAfterClosure = (): void => {
      if (settled || !terminalError || !childClosed || groupAlive()) return;
      settled = true;
      clearTimers();
      reject(terminalError);
    };
    const finishFailureAtBound = (): void => {
      finishFailureAfterClosure();
      if (settled || !terminalError) return;
      settled = true;
      clearTimers();
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      reject(terminalError);
    };
    const fail = (error: Error): void => {
      if (settled || terminalError) return;
      terminalError = error;
      clearTimeout(deadlineTimer);
      signalGroup("SIGTERM");
      termTimer = setTimeout(() => {
        if (groupAlive()) signalGroup("SIGKILL");
        observeTimer = setTimeout(finishFailureAtBound, KILL_OBSERVE_MS);
        observeTimer.unref();
        finishFailureAfterClosure();
      }, TERM_GRACE_MS);
      termTimer.unref();
      reapTimer = setInterval(finishFailureAfterClosure, 10);
      reapTimer.unref();
      finishFailureAfterClosure();
    };
    const append = (target: Buffer[], chunk: Buffer, stream: "stdout" | "stderr"): void => {
      if (terminalError) return;
      if (stream === "stdout") stdoutBytes += chunk.length;
      else stderrBytes += chunk.length;
      if (stdoutBytes + stderrBytes > OUTPUT_LIMIT_BYTES) {
        fail(new OwnedCommandError(
          `${options.description} exceeded ${OUTPUT_LIMIT_BYTES} bytes of combined output`,
          result(),
        ));
        return;
      }
      target.push(chunk);
    };
    const deadlineTimer = setTimeout(() => {
      fail(new OwnedCommandError(
        `${options.description} timed out after ${options.timeoutMs} ms`,
        result(),
      ));
    }, options.timeoutMs);
    deadlineTimer.unref();

    child.stdout.on("data", (chunk: Buffer) => append(stdout, chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => append(stderr, chunk, "stderr"));
    child.once("error", (error) => fail(error));
    child.once("close", (code, signal) => {
      childClosed = true;
      if (terminalError) {
        finishFailureAfterClosure();
        return;
      }
      const completed = result(code, signal);
      if (code !== 0) {
        fail(new OwnedCommandError(
          `${options.description} exited ${code ?? signal ?? "without status"}`,
          completed,
        ));
        return;
      }
      if (groupAlive()) {
        fail(new OwnedCommandError(
          `${options.description} left its owned process group running`,
          completed,
        ));
        return;
      }
      settled = true;
      clearTimers();
      resolve(completed);
    });
  });
}

export function validateOwnedDockerSet(
  input: DockerOwnershipInput,
  expected: ExpectedDockerOwnership,
  options: { requireComplete: boolean },
): OwnedDockerSet {
  if (options.requireComplete && (!input.container || !input.image || !input.network)) {
    throw new Error("owned Docker set is incomplete");
  }

  const requireId = (value: string | undefined, resource: string): string => {
    if (!value) throw new Error(`${resource} has no immutable Docker ID`);
    return value;
  };
  const assertLabels = (
    labels: Record<string, string> | undefined,
    resource: "container" | "image" | "network",
  ): void => {
    if (labels?.[LIVE_LABEL] !== expected.liveLabel || labels?.[RUN_LABEL] !== expected.runLabel) {
      throw new Error(`${resource} ownership label mismatch`);
    }
  };
  const containerId = input.container ? requireId(input.container.Id, "container") : undefined;
  const imageId = input.image ? requireId(input.image.Id, "image") : undefined;
  const networkId = input.network ? requireId(input.network.Id, "network") : undefined;

  if (containerId && containerId === expected.protectedContainerId) {
    throw new Error("owned set resolves to the protected Docker container");
  }
  if (imageId && new Set(expected.protectedImageIds ?? []).has(imageId)) {
    throw new Error("owned set resolves to a protected Docker image");
  }
  if (networkId && new Set(expected.protectedNetworkIds ?? []).has(networkId)) {
    throw new Error("owned set resolves to a protected Docker network");
  }

  if (input.image) {
    assertLabels(input.image.Config?.Labels, "image");
    if (
      input.image.RepoTags?.length !== 1
      || input.image.RepoTags[0] !== expected.imageName
    ) {
      throw new Error("image tag ownership mismatch");
    }
  }

  if (input.network) {
    assertLabels(input.network.Labels, "network");
    if (input.network.Name !== expected.networkName) {
      throw new Error("network name ownership mismatch");
    }
  }

  if (input.container) {
    if (!input.image || !input.network || !imageId || !networkId) {
      throw new Error("owned container is missing its image or network");
    }
    assertLabels(input.container.Config?.Labels, "container");
    if (input.container.Name?.replace(/^\//u, "") !== expected.containerName) {
      throw new Error("container name ownership mismatch");
    }
    if (input.container.Config?.Image !== expected.imageName) {
      throw new Error("container image tag mismatch");
    }
    if (input.container.Image !== imageId) {
      throw new Error("container image identity mismatch");
    }
    const attachments = Object.entries(input.container.NetworkSettings?.Networks ?? {});
    if (
      attachments.length !== 1
      || attachments[0]?.[0] !== expected.networkName
      || attachments[0]?.[1].NetworkID !== networkId
    ) {
      throw new Error("container network attachment mismatch");
    }
  }

  if (input.network) {
    const members = Object.keys(input.network.Containers ?? {}).sort();
    const expectedMembers = containerId ? [containerId] : [];
    if (
      members.length !== expectedMembers.length
      || members.some((member, index) => member !== expectedMembers[index])
    ) {
      throw new Error("network membership mismatch");
    }
  }

  return {
    ...(containerId ? { containerId } : {}),
    ...(imageId ? { imageId } : {}),
    ...(networkId ? { networkId } : {}),
  };
}

export function immutableDockerRemovalArgs(
  kind: "container" | "image" | "network",
  id: string,
): string[] {
  if (kind === "container") return ["container", "rm", "--force", id];
  if (kind === "network") return ["network", "rm", id];
  return ["image", "rm", id];
}

import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pickScreenPorts } from "./computer.ts";
import { defaultHomeDir, defaultWorkspaceDir } from "./home.ts";
import { superviseTalk, type SupervisedChild } from "./supervise.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

if (!process.env.OPENBOT_PASSWORD) {
  console.error("OPENBOT_PASSWORD is required");
  process.exit(1);
}

process.env.OPENBOT_HOME ??= defaultHomeDir();
process.env.OPENBOT_WORKSPACE ??= defaultWorkspaceDir(process.env.OPENBOT_HOME);

function composeUp(service: string, env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["compose", "up", "--detach", "--build", service], {
      cwd: repoRoot,
      stdio: "inherit",
      env,
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(`docker compose up --detach --build ${service} exited ${code ?? signal}`),
      );
    });
  });
}

function wrap(child: ChildProcess): SupervisedChild {
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  return {
    pid: child.pid,
    kill(signal = "SIGTERM") {
      if (child.exitCode !== null || child.signalCode) return false;
      return child.kill(signal);
    },
    wait: () => exited,
  };
}

function spawnDaemon(env: NodeJS.ProcessEnv): SupervisedChild {
  const binDir = path.join(repoRoot, "node_modules", ".bin");
  const tsx = path.join(binDir, "tsx");
  const child = spawn(tsx, ["daemon/src/index.ts"], {
    cwd: repoRoot,
    stdio: "inherit",
    env: {
      ...env,
      PATH: `${binDir}${path.delimiter}${env.PATH ?? ""}`,
    },
  });
  child.on("error", (err) => {
    console.error(err);
  });
  return wrap(child);
}

function onSignal(handler: (signal: NodeJS.Signals) => void): () => void {
  const sigint = () => handler("SIGINT");
  const sigterm = () => handler("SIGTERM");
  process.on("SIGINT", sigint);
  process.on("SIGTERM", sigterm);
  return () => {
    process.off("SIGINT", sigint);
    process.off("SIGTERM", sigterm);
  };
}

async function pickPorts(): Promise<number[]> {
  return pickScreenPorts(8);
}

try {
  await superviseTalk({
    composeUp,
    spawnDaemon,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    onSignal,
    pickPorts,
    log: (message) => console.error(message),
  });
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

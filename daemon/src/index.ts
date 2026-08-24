import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startBox } from "./box.ts";
import { DockerComputerRuntime, defaultCookieJar, parseScreenPorts } from "./computer.ts";

const password = process.env.OPENBOT_PASSWORD;
if (!password) {
  console.error("OPENBOT_PASSWORD is required");
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const pwaDir = process.env.PWA_DIR ?? path.resolve(here, "../../pwa/dist");
const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? "0.0.0.0";
const kasmUser = process.env.KASM_USER ?? "openbot";
const kasmPassword = process.env.KASM_PASSWORD ?? password;
const workspaceDir = process.env.OPENBOT_WORKSPACE ?? path.resolve(process.cwd(), "workspace");
const cookiesDir = process.env.OPENBOT_COOKIES ?? defaultCookieJar();
fs.mkdirSync(workspaceDir, { recursive: true });
fs.mkdirSync(cookiesDir, { recursive: true });

const hostPorts = parseScreenPorts(process.env.SCREEN_PORTS);
const computer = new DockerComputerRuntime({
  containerName: process.env.OPENBOT_SCREEN_CONTAINER ?? "openbot-screen",
  hostPorts,
  cookiesDir,
  workspaceDir,
  password,
});

const box = await startBox({
  password,
  pwaDir,
  port,
  host,
  screenUpstream: process.env.SCREEN_UPSTREAM || computer.computerUpstream(),
  kasmUser,
  kasmPassword,
  workspaceDir,
  computer,
});
console.log(`OpenBot box listening on ${box.url}`);

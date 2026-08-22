import path from "node:path";
import { fileURLToPath } from "node:url";
import { startBox } from "./box.ts";

const password = process.env.OPENBOT_PASSWORD;
if (!password) {
  console.error("OPENBOT_PASSWORD is required");
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const pwaDir = process.env.PWA_DIR ?? path.resolve(here, "../../pwa/dist");
const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? "0.0.0.0";
const screenUpstream = process.env.SCREEN_UPSTREAM;
const kasmUser = process.env.KASM_USER ?? "openbot";
const kasmPassword = process.env.KASM_PASSWORD ?? password;

const box = await startBox({
  password,
  pwaDir,
  port,
  host,
  screenUpstream,
  kasmUser,
  kasmPassword,
});
console.log(`OpenBot box listening on ${box.url}`);

import { readdirSync, realpathSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const REPOSITORY_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TEST_ROOTS = ["daemon/test", "pwa/test"];
const TEST_FILE = /\.test\.(?:[cm]?[jt]sx?)$/u;
const LIVE_FILE = /\.live\.test\.(?:[cm]?[jt]sx?)$/u;
const SCREEN_LIVE_FILE = /\.screen\.live\.test\.(?:[cm]?[jt]sx?)$/u;
const PINCHTAB_LIVE_FILE = /(?:^|[/.])pinchtab\.live\.test\.(?:[cm]?[jt]sx?)$/u;

const LIVE_LANES = {
  "live:harness": { label: "Harness", suffix: "*.live.test.ts" },
  "live:screen": { label: "Screen", suffix: "*.screen.live.test.ts" },
  "live:pinchtab": { label: "PinchTab", suffix: "*.pinchtab.live.test.ts" },
};

function fail(message) {
  console.error(`test runner: ${message}`);
  process.exit(2);
}

function repositoryPath(absolutePath) {
  return relative(REPOSITORY_ROOT, absolutePath).split(sep).join("/");
}

function isInsideTestRoots(path) {
  return TEST_ROOTS.some((root) => path.startsWith(`${root}/`));
}

function laneFor(path) {
  if (SCREEN_LIVE_FILE.test(path)) return "live:screen";
  if (PINCHTAB_LIVE_FILE.test(path)) return "live:pinchtab";
  if (LIVE_FILE.test(path)) return "live:harness";
  if (TEST_FILE.test(path)) return "deterministic";
  return null;
}

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(path));
    if (entry.isFile() && TEST_FILE.test(entry.name)) files.push(path);
  }
  return files;
}

function discover(lane) {
  return TEST_ROOTS.flatMap((root) => walk(join(REPOSITORY_ROOT, root)))
    .filter((path) => laneFor(repositoryPath(path)) === lane)
    .sort((left, right) => repositoryPath(left).localeCompare(repositoryPath(right)));
}

function selectedFile(argument, expectedLane) {
  let absolutePath;
  try {
    absolutePath = realpathSync(resolve(REPOSITORY_ROOT, argument));
  } catch {
    fail(`Test file does not exist: ${argument}`);
  }
  const path = repositoryPath(absolutePath);
  if (path === "" || path === ".." || path.startsWith("../") || isAbsolute(path)) {
    fail(`Test file must stay inside the repository: ${argument}`);
  }
  if (!isInsideTestRoots(path)) {
    fail(`Test file must be under daemon/test or pwa/test: ${argument}`);
  }
  if (!statSync(absolutePath).isFile()) fail(`Test file is not a file: ${argument}`);
  const actualLane = laneFor(path);
  if (actualLane !== expectedLane) {
    const requestedLane = expectedLane === "deterministic" ? "focused" : expectedLane;
    fail(`${path} belongs to ${actualLane ?? "no test lane"}, not ${requestedLane}`);
  }
  return absolutePath;
}

const mode = process.argv[2];
const rawArguments = process.argv.slice(3);
const listOnly = rawArguments.includes("--list");
const fileArguments = rawArguments.filter((argument) => argument !== "--list");

if (rawArguments.some((argument) => argument.startsWith("--") && argument !== "--list")) {
  fail("Only test file paths and --list are accepted");
}

let lane;
let files;
if (mode === "full") {
  if (fileArguments.length > 0) fail("Use npm run test:focused -- <test-file> to select files");
  lane = "deterministic";
  files = discover(lane);
  if (files.length === 0) {
    fail("No deterministic daemon or PWA test files found; an empty suite is not proof");
  }
} else if (mode === "focused") {
  if (fileArguments.length === 0) fail("Focused deterministic tests require at least one test file");
  lane = "deterministic";
  files = fileArguments.map((argument) => selectedFile(argument, lane));
} else if (Object.hasOwn(LIVE_LANES, mode)) {
  lane = mode;
  files =
    fileArguments.length > 0
      ? fileArguments.map((argument) => selectedFile(argument, lane))
      : discover(lane);
  if (files.length === 0) {
    const { label, suffix } = LIVE_LANES[lane];
    fail(`No live ${label} test files found (expected ${suffix}); a missing suite is not proof`);
  }
} else {
  fail("Choose full, focused, live:harness, live:screen, or live:pinchtab");
}

files = [...new Map(files.map((path) => [repositoryPath(path), path])).values()];

if (listOnly) {
  for (const path of files) console.log(repositoryPath(path));
  process.exit(0);
}

const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...files], {
  cwd: REPOSITORY_ROOT,
  env: { ...process.env, OPENBOT_TEST_LANE: lane },
  stdio: "inherit",
});

if (result.error) fail(`Could not start the Node test process: ${result.error.message}`);
if (result.signal) fail(`Node test process ended from signal ${result.signal}`);
process.exit(result.status ?? 1);

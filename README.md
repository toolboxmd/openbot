# OpenBot

Self-hosted Grok Bot. Named Bots on one Computer. MIT.

This slice gives each Bot a private Screen. Chat is always messageable and does not start XFCE. Opening Computer starts that Bot's Screen (cold start, Eyes waking). The iframe shows one Screen: switching the active chat loads that Bot's Screen and docker-stops the previous Screen if that Bot is idle (not in a turn, not needing the desktop). A Bot with write=true keeps its Screen. Bots share a cookie jar on the Computer. There is no user-facing Wake.

## Run

You need Docker for Screen, and Codex on PATH to Talk. From the repo root:

Run package.json scripts.start with OPENBOT_PASSWORD set.

That one command builds the Screen image and runs Talk in the foreground on the host. Talk starts a container when you open Computer for that Bot (loopback port, never 6901). Chat listens on [http://127.0.0.1:8080](http://127.0.0.1:8080) and does not start XFCE. If Talk crashes while the command is still running, it is started again. Ctrl-C / SIGTERM stops Talk and leaves Screens that are already up.

The Password is `openbot` unless you set `OPENBOT_PASSWORD`:

Example: OPENBOT_PASSWORD='your-secret' then the package start script.

Enter the Password once. Refresh stays signed in.

Open **Computer** in the sidebar to watch that Bot's Screen (`/screen/<botId>/`). That starts the Screen if it was down. Kasm is on loopback only; the host daemon proxies it.

See [ADR 0005](docs/adr/0005-harness-on-host-os.md): the ACP child is a host OS process. Compose cannot exec Mac Codex (Docker Desktop is a Linux VM). Do not start a Compose box service -- there is none. Codex must be on PATH (HOME/.local/bin is fine). The stdio adapter is codex-acp if installed, otherwise npx of @agentclientprotocol/codex-acp. CODEX_PATH points at the host codex. DISPLAY is not passed. NO_BROWSER=1. Missing login is a device-code hint in chat, not Takeover.

Keep-alive while the start script runs is not keep-alive after logout, sleep, or reboot.

## What this Computer runs

One origin. The host daemon is Talk, the reverse proxy, and the PWA.

- PWA: React + Vite + Tailwind v4 + shadcn, chat-first
- daemon: Password, session cookie, static PWA, Computer API, per-Bot Screen proxy, Bots, Codex ACP, automatic Screen Sleep
- one Screen in the Computer iframe; idle Screens Sleep on chat switch (docker stop, volumes kept, ACP child stays). A Bot still in a turn keeps its container: Debian bookworm, XFCE, KasmVNC, Chrome
- Kasm basic auth is injected by the proxy. WebRTC is off.
- Talk: host Codex ACP. Picker detects other CLIs. This slice only spawns Codex. No PinchTab server (headed Chromium with a unique profile + shared cookie-jar mount). Takeover pauses that Bot ACP child and grants Kasm write (/api/update_user); release returns view-only. Agent-requested needs-you does not auto-grant write.

## Tests

```bash
npm install
npm test
npm run typecheck
```

Tests talk HTTP. A fake Kasm server and an injected Screen runtime stand in for Docker. Supervisor tests inject a compose runner, daemon spawner, clock, and signals. They do not start Docker or Codex.

# OpenBot

Self-hosted Grok Bot. Named Bots on one Computer. MIT.

This slice gives each Bot a private Screen. Idle Screens Sleep. Bots share a cookie jar on the Computer. Wake is a cold start. Eyes go sleep then waking.

## Run

You need Docker for Screen, and Codex on PATH to Talk. From the repo root:

Run package.json scripts.start with OPENBOT_PASSWORD set.

That one command builds the Screen image and runs Talk in the foreground on the host. Talk starts one container per Active Bot on a loopback port. Chat listens on [http://127.0.0.1:8080](http://127.0.0.1:8080). If Talk crashes while the command is still running, it is started again. Ctrl-C / SIGTERM stops Talk and leaves Screens that are already up.

The Password is `openbot` unless you set `OPENBOT_PASSWORD`:

Example: OPENBOT_PASSWORD='your-secret' then the package start script.

Enter the Password once. Refresh stays signed in.

Open **Computer** in the sidebar to watch the Active Bot Screen (`/screen/<botId>/`). Kasm is on loopback only; the host daemon proxies it.

See [ADR 0005](docs/adr/0005-harness-on-host-os.md): the ACP child is a host OS process. Compose cannot exec Mac Codex (Docker Desktop is a Linux VM). Do not start a Compose box service -- there is none. Codex must be on PATH (HOME/.local/bin is fine). The stdio adapter is codex-acp if installed, otherwise npx of @agentclientprotocol/codex-acp. CODEX_PATH points at the host codex. DISPLAY is not passed. NO_BROWSER=1. Missing login is a device-code hint in chat, not Takeover.

Keep-alive while the start script runs is not keep-alive after logout, sleep, or reboot.

## What this Computer runs

One origin. The host daemon is Talk, the reverse proxy, and the PWA.

- PWA: React + Vite + Tailwind v4 + shadcn, chat-first
- daemon: Password, session cookie, static PWA, Computer API, per-Bot Screen proxy, Bots, Codex ACP, Sleep
- one Screen container per Active Bot: Debian bookworm, XFCE, KasmVNC, Chrome
- Kasm basic auth is injected by the proxy. WebRTC is off.
- Talk: host Codex ACP. Picker detects other CLIs. This slice only spawns Codex. No PinchTab server (headed Chromium with a unique profile + shared cookie-jar mount). Takeover pauses that Bot ACP child and grants Kasm write (/api/update_user); release returns view-only. Agent-requested needs-you does not auto-grant write.

## Tests

```bash
npm install
npm test
npm run typecheck
```

Tests talk HTTP. A fake Kasm server and an injected Screen runtime stand in for Docker. Supervisor tests inject a compose runner, daemon spawner, clock, and signals. They do not start Docker or Codex.

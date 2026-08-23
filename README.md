# OpenBot

Self-hosted Grok Bot. Named Bots on one Computer. MIT.

This slice talks to one Bot over Codex ACP on the host OS, and still watches one XFCE Screen.

## Run

You need Docker for Screen. From the repo root:

```bash
docker compose up --build
```

Then open [http://127.0.0.1:8080](http://127.0.0.1:8080).

The Password is `openbot` unless you set `OPENBOT_PASSWORD`:

```bash
OPENBOT_PASSWORD='your-secret' docker compose up --build
```

Enter the Password once. Refresh stays signed in.

Open **Computer** in the sidebar. The Screen is an iframe on the same origin (`/screen/`). Kasm is not published on the host.

Talk is not compose. See [ADR 0005](docs/adr/0005-harness-on-host-os.md): the ACP child is a host OS process. Run the daemon on the host with the start script so it can spawn Codex. Codex must be on PATH (HOME/.local/bin is fine). The stdio adapter is codex-acp if installed, otherwise npx of @agentclientprotocol/codex-acp. CODEX_PATH points at the host codex. DISPLAY is not passed. NO_BROWSER=1. Missing login is a device-code hint in chat, not Takeover.

## What this Computer runs

One origin. The box process is the daemon, the reverse proxy, and the PWA.

- PWA: React + Vite + Tailwind v4 + shadcn, chat-first
- daemon: Password, session cookie, static PWA, Computer API, Screen proxy, Bots, Codex ACP
- one Screen container: Debian bookworm, XFCE, KasmVNC, Chrome
- Kasm basic auth is injected by the proxy. WebRTC is off.
- Talk: host Codex ACP. Picker detects other CLIs. This slice only spawns Codex. No PinchTab, Takeover, or Sleep yet

## Tests

```bash
npm install
npm test
npm run typecheck
```

Tests talk HTTP. They hit `/api/session`, `/api/bots`, `/api/computer`, `/screen/`, and `GET /`. A fake Kasm server stands in for the container. Talk is not covered by those tests.

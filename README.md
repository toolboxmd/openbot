# OpenBot

Self-hosted Grok Bot. Named Bots on one Computer. MIT.

This slice is one Computer (one Screen container) with N displays, plus Talk to a Bot over Codex ACP on the host OS.

## Run

You need Docker for Screen, and Codex on PATH to Talk. From the repo root:

Run package.json scripts.start with OPENBOT_PASSWORD set (default Password is `openbot`).

That one command brings **one** Screen container up (Compose, screen only, detached) and runs Talk in the foreground on the host. Chat listens on [http://127.0.0.1:8080](http://127.0.0.1:8080). If Talk crashes while the command is still running, it is started again. Ctrl-C / SIGTERM stops Talk and **leaves Screen up**.

The Computer pane is always a live XFCE desktop with Chromium open to https://www.google.com. Creating a second Bot adds a Kasm display inside the same container; it does not `docker run` another Debian. Host Kasm ports are a loopback range starting at 16901. **Never 6901** (the agent desktop often owns that).

Open **Computer** in the sidebar to watch. Zoom / Open is already write (mouse and keyboard). There is no Takeover button. Closing zoom returns to view-only. 2FA happens on the zoomed Screen. Never paste secrets in chat.

See [ADR 0005](docs/adr/0005-harness-on-host-os.md) and [ADR 0006](docs/adr/0006-screens-are-displays.md). The ACP child is a host OS process. Compose cannot exec Mac Codex. Do not start a Compose box service -- there is none.

Keep-alive while the start script runs is not keep-alive after logout, sleep, or reboot.

## What this Computer runs

One origin. The host daemon is Talk, the reverse proxy, and the PWA.

- PWA: React + Vite + Tailwind v4 + shadcn, chat-first
- daemon: Password, session cookie, static PWA, Computer API, Screen proxy, Bots, Codex ACP
- one Screen container: Debian bookworm, XFCE, KasmVNC, Chrome; extra Bots are extra displays in that container
- Kasm basic auth is injected by the proxy. WebRTC is off. Preview is view-only; zoom grants write.
- Talk: host Codex ACP. Picker detects other CLIs. This slice only spawns Codex. No PinchTab. No Takeover button. No docker-stop Sleep.

## Tests

```bash
npm install
npm test
npm run typecheck
```

Tests talk HTTP. They hit `/api/session`, `/api/bots`, `/api/computer`, `/screen/`, and `GET /`. A fake Kasm server stands in for the container. The Computer runtime is injected: two Bots allocate two displays and never `docker run` a second Screen name. Supervisor tests inject a compose runner, daemon spawner, clock, and signals; they do not start Docker or Codex. `screenIsReachable` uses `node:http`, not `fetch`+AbortSignal.

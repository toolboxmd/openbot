# OpenBot

Self-hosted Grok Bot. Named Bots on one Computer. MIT.

This slice opens the PWA and one XFCE Screen on the Computer.

## Run

You need Docker. From the repo root:

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

## What this Computer runs

One origin. The box process is the daemon, the reverse proxy, and the PWA.

- PWA: React + Vite + Tailwind v4 + shadcn, chat-first
- daemon: Password, session cookie, static PWA, Computer API, Screen proxy
- one Screen container: Debian bookworm, XFCE, KasmVNC, Chrome
- Kasm basic auth is injected by the proxy. WebRTC is off.
- no Harness, no PinchTab cookie jar yet

## Tests

```bash
npm install
npm test
npm run typecheck
```

Tests talk HTTP. They hit `/api/session`, `/api/bots`, `/api/computer`, `/screen/`, and `GET /`. A fake Kasm server stands in for the container.

# OpenBot

Self-hosted Grok Bot. Named Bots on one Computer. MIT.

This slice opens the PWA: Password once, empty chat shell, HttpOnly cookie.

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

## What this Computer runs

One origin. The box process is the daemon, the reverse proxy, and the PWA.

- PWA: React + Vite + Tailwind v4 + shadcn, chat-first
- daemon: Password, session cookie, static PWA
- no Screen container, no Harness, no PinchTab in this slice

## Tests

```bash
npm install
npm test
npm run typecheck
```

Public seam is HTTP. Tests hit `/api/session`, `/api/bots`, and `GET /`.

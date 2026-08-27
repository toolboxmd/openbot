# Contributing

OpenBot is MIT. There is no CLA. A pull request is a gift under that license.

## Issues first

Every PR points at an issue. No issue → we close the PR.

Read [CONTEXT.md](CONTEXT.md) and [docs/adr/](docs/adr/) before proposing to reverse a locked decision. Refer to tickets by name, not bare ids.

## Agent-authored PRs

Allowed when all of these hold:

- the change is useful
- tests pass
- the **issuer self-reviews** the diff and says it is ready before asking for merge

Issues marked `ready-for-agent` (or with that state in the body) are for agents. Eyes look, Takeover-on-a-phone, and anything marked `ready-for-human` stay human.

## UI

UI PRs include a screenshot in the PR body. Do not commit Grok Bot or CopilotKit screenshots into this repo.

## Quality

Slop gets closed. If you cannot explain the change in CONTEXT.md words, it is not ready.

## Test workflow

During implementation, run only the deterministic files for the slice:

```bash
npm run test:focused -- daemon/test/messages.test.ts pwa/test/chat-interactions.test.ts
```

Before committing or pushing a slice, run the complete deterministic suite, the type check, and the PWA production build:

```bash
npm test
npm run typecheck
npm run build:pwa
```

The default `npm test` command is offline. It runs every deterministic daemon and PWA test and never loads a `*.live.test.*` module. Deterministic tests use pure modules, fake Harness or ACP boundaries, temporary Home directories, and loopback HTTP only. They must not launch a real Harness, Docker, Screen, PinchTab, Chrome, external network request, or interactive login.

Run applicable live proof once on the final candidate for the slice. Real-Harness tests use `npm run test:live:harness`, with optional selected files after `--`. Live Screen suites use the `*.screen.live.test.ts` suffix and `npm run test:live:screen`. Live PinchTab suites use `*.pinchtab.live.test.ts` and `npm run test:live:pinchtab`. Those two suffixes are the extension points until their focused suites land.

A selected live lane requires its real prerequisites. A missing Harness login, Docker, Screen, PinchTab, or browser dependency must fail clearly; a skipped suite is not proof. Keep live assertions intact. Reserve the integrated real PWA, Harness, Screen, and PinchTab matrix for the final acceptance ticket rather than every implementation slice.

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

# ADR 0001: One Computer, per-Bot Screens

## Status
Accepted (amended by [0006](0006-screens-are-displays.md))

## Context
Grok Bot gives each Bot a private screen on one shared cloud computer (files, cookies, CLI logins). Isolation per Bot would mean repeating every login.

## Decision
One Computer per instance. N Bots, N Screens. Shared disk and cookie jar. Window state is not shared.

## Consequences
A login on one Bot is available to the others. A file in `/workspace` is visible to every Bot. Chrome cannot lock one profile to two processes; session sharing is an implementation decision (see research tickets).

0006: a Screen is a private display on that Computer, not a second container.

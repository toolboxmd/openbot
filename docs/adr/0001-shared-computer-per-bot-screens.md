# ADR 0001: One Computer, per-Bot Screens

## Status
Accepted

## Context
Grok Bot gives each Bot a private screen on one shared cloud computer (files, cookies, CLI logins). Isolation per Bot would mean repeating every login.

## Decision
One Computer per instance. N Bots, N Screens. Shared disk and cookie jar. Window state is not shared.

## Consequences
A login on one Bot is available to the others. A file in `/workspace` is visible to every Bot. Chrome cannot lock one profile to two processes; session sharing is an implementation decision (see research tickets).

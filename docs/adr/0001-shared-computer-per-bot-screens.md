# ADR 0001: One Computer, per-Bot Screens

## Status
Accepted (amended by [0006](0006-screens-are-displays.md))

## Context
Grok Bot gives each Bot a private screen on one shared cloud computer (files, cookies, CLI logins). Isolation per Bot would mean repeating every login.

## Decision
One Computer per instance. N Bots normally have N Screens. Shared disk and cookie jar. Window state is not shared. A bounded attachment failure or a migrated legacy Home beyond display capacity may truthfully leave a Bot's Screen unavailable or unassigned until recovery. The Bot, Chat, and durable identity remain available, and the Computer surface must not invent an iframe or fall back to another Bot's Screen.

## Consequences
A login on one Bot is available to the others. A file in `/workspace` is visible to every Bot. Chrome cannot lock one profile to two processes; session sharing is an implementation decision (see research tickets).

0006: a Screen is a private display on that Computer, not a second container.

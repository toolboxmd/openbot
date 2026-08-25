# ADR 0010: Isolated commands in Screen

## Status
Accepted

## Context
Isolated is Isolated Harness Home and Isolated profile (ADR 0008). Isolated is not "the user asked for Docker."

Live Codex 0.149 starts the login shell from the user record (`/bin/zsh` on Mac, `/bin/bash` on Linux). Isolated `$SHELL` is unused. Seatbelt `workspace-write` still runs that shell and blocks `docker.sock`, so Isolated cannot follow a Screen-command instruction.

Isolated exec (Talk runs Isolated commands in Screen; Isolated native host shell is off) is the real Isolated command path. It is post-v1 ([task] Isolated exec in Screen, #69).

## Decision
v1 Isolated: native host shell stays. Isolated Seatbelt does not apply (it blocks Screen exec and does not jail the host shell). Talk tells the Session it is Isolated or Host. Isolated `OPENBOT.md` must instruct Isolated to run commands in Screen. That instruction is mandatory, not a hint.

Post-v1 Isolated exec: Talk runs Isolated commands in Screen. Isolated native shell is off. Isolated Codex does not hold `docker.sock`. Remove the Screen-command instruction from `OPENBOT.md`. Isolated Host grant for that slice is run this command on the host PC. Seatbelt is unused because native shell is off.

This does not change Isolated HOME (ADR 0008).

## Consequences
Isolated v1 may still run a host command. Isolated v1 is not a jail. Isolated exec (#69) is the ticket that makes Isolated commands Screen-only.

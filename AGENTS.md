# Agent notes

Read `CONTEXT.md` before changing names.
Read `docs/agents/issue-tracker.md` before filing tickets.
Read `docs/adr/` before reversing a locked decision.
Read `CONTRIBUTING.md` before opening a PR.

Implement remaining tracer-bullet tickets from the v1 spec. Do not reverse a locked ADR without a new decision.

## Skills

Engineering skills live in the user's global workflows (Grill, Wayfinder, To spec, To tickets, Domain modeling, Setup Matt Pocock skills, etc.). This repo's tracker is GitHub Issues.

## Proof

A fake Harness is for Talk machinery (Home sqlite, inject text, receipts, interrupt). Live Harness is Done for Bot, Session, and PWA claims. Do not treat a fake ACP, fake Harness, mock PinchTab, or smoke test as Done.

## Recent Changes

- 2026-08-26: PinchTab owns headed Screen Chrome (no CDP-attach title). Talk focuses the tab before click/type/fill. Isolated v1 auto-allows commands.
- 2026-08-26: PinchTab Talk MCP. One bridge per Screen Chrome. Talk allowlists stock `pinchtab mcp --server`. Fail closed. Cookie jar stays Screen copy.

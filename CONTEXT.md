# CONTEXT.md

Glossary only. No implementation.

## OpenBot
Self-hosted Grok Bot. Named Bots on one Computer. MIT. Repo `toolboxmd/openbot`.

## Computer
One Linux VM per instance. Shared files, CLI credentials, and browser cookie jar. Not a security boundary per Bot.

## Bot
A named teammate with a profile (name, title, description, Eyes, Harness) and its own Screen. Persistent.

## Screen
Private XFCE desktop for one Bot. Other Bots cannot see its windows. Watch via KasmVNC. Takeover for 2FA.

## Active Bot
A Bot whose Screen is currently running. RAM and CPU count per Active Bot, not per sidebar row.

## Sleep
Stop an idle Screen so it stops costing RAM. Cold start when opened again.

## Harness
The coding agent CLI on a Bot: Codex, Claude Code, Grok Build, or Kimi Code, over ACP. User picks one, then OAuth on that Screen.

## PinchTab
Headed Chrome driver on the Screen's DISPLAY. Default browser hands. Not Playwright.

## Takeover
User drives the Screen for password, 2FA, captcha, or payment. Never paste secrets in chat.

## Eyes
Original code-drawn robot face. Color plus a body shape hashed at create (disc, squircle, stadium, shield, bean, diamond). Two light capsule dots, always on. Idle hops and peek-turns. Write (streaming a message) replaces the face with three dots in that Bot's color. Other states: think, needs-you, sleep.

## Tunnel
User-provided Cloudflare tunnel so the PWA is reachable from a phone.

## Password
Single shared secret that locks the PWA. Cookie after first entry.

## Arena
Parked. Public Twitch-plays demo. Not v1.

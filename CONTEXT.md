# CONTEXT.md

Glossary only. No implementation.

## OpenBot
Self-hosted Grok Bot. Named Bots on one Computer. MIT. Repo `toolboxmd/openbot`.

## Computer
One Linux desktop per instance (Docker Screen). Shared files and browser cookie jar. Not a security boundary per Bot. Harness CLI logins live on the host OS, not inside Screen.

## Bot
A named teammate with a profile (name, title, description, Eyes, Harness) and its own Screen. Persistent.

## Screen
Private XFCE desktop for one Bot. Other Bots cannot see its windows. Watch via KasmVNC. Takeover for 2FA.

## Active Bot
A Bot whose Screen is currently running. RAM and CPU count per Active Bot, not per sidebar row.

## Sleep
Stop an idle Screen so it stops costing RAM. Cold start when opened again. Also kills that Bot's Harness child.

## Harness
The coding agent CLI already on the host OS (Codex, Claude Code, Grok Build, or Kimi Code) over ACP. The picker shows what is on PATH. The process runs beside Screen, not inside XFCE. The user does not watch its terminal. Files are a host folder also mounted on Screen. Vendor login is that host CLI home. Takeover is for site 2FA.

## PinchTab
Headed Chrome driver on the Screen's DISPLAY. Default browser hands. Not Playwright.

## Takeover
User drives the Screen for password, 2FA, captcha, or payment. Never paste secrets in chat. Not used for Harness CLI login.

## Eyes
Code-drawn robot face (color + shape). States: idle, thinking, working, needs-you, asleep.

## Tunnel
User-provided Cloudflare tunnel so the PWA is reachable from a phone.

## Password
Single shared secret that locks the PWA. Cookie after first entry.

## Arena
Parked. Public Twitch-plays demo. Not v1.

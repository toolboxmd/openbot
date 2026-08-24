# CONTEXT.md

Glossary only. No implementation.

## OpenBot
Self-hosted Grok Bot. Named Bots on one Computer. MIT. Repo `toolboxmd/openbot`.

## Computer
One Linux desktop per instance (one Docker Screen container). Shared files and browser cookie jar. Not a security boundary per Bot. Harness CLI logins live on the host OS, not inside Screen. The Computer pane is always a live desktop. It is never a down / "Screen is down" gate.

## Bot
A named teammate with a profile (name, title, description, Eyes, Harness) and its own Screen (a display on the Computer). Persistent.

## Screen
Private XFCE display for one Bot, as an extra Kasm session inside the one Computer container. Other Bots cannot see its windows. Watch via KasmVNC. Zooming the Computer preview is write (2FA lives there). Not a second Debian.

## Active Bot
A Bot the user is talking to. RAM and CPU count per Computer plus per lit display, not per extra container.

## Sleep
Not a user-visible down pane. Do not docker-stop the Computer. Displays stay lit. The Computer stays up.

## Harness
The coding agent CLI already on the host OS (Codex, Claude Code, Grok Build, or Kimi Code) over ACP. The picker shows what is on PATH. The process runs beside Screen, not inside XFCE. The user does not watch its terminal. Files are a host folder also mounted on Screen. Vendor login is that host CLI home. Zoom (not a Takeover button) is for site 2FA. Zoom SIGSTOPs that Bot's ACP child so two pointers do not fight.

## PinchTab
Headed Chrome driver on the Screen's DISPLAY. Default browser hands. Not Playwright.

## Takeover
There is no Takeover button on the Computer pane. Zooming or opening the Computer preview is already write. In chat, a needs-you Computer card says it needs you; its action is **Open computer** (same as zoom). Not a second mode. User drives the Screen for password, 2FA, captcha, or payment. Never paste secrets in chat. Not used for Harness CLI login.

## Open computer
The primary action on a needs-you Computer card. Opens that Bot's Computer (already write). Same as clicking the preview.

## Waiting for you
Sidebar state when a Bot needs the user (orange). Pairs with an in-thread Computer card: **Action needed**, thumbnail of the blocker, **Open computer** / **I'm done** / **Skip**. I'm done = resume the Bot. Skip = stop waiting. Both stay on the card until clicked. Done and Skip remain in history (green Done / skipped), with Open computer still available.

## Working
While a Bot is writing: Eyes animate in the thread (three-dot / moving). Hover on that Eyes shows `{name} is working`. Not a chat bubble and not a strip that stays on screen. Idle: no working copy, animation gone.

## Card
A transcript item that is not a text bubble: screenshot, file chip, widget, Computer needs-you / Done. Human-facing. Never a dump of tool JSON or ACP logs.

## Turn
One user send. The Bot may reply with several short bubbles (each ACP message is one bubble). The PWA does not split a long string. Tone is a few sentences, like a person. Markdown essays and tool transcripts are capped out of chat. Screenshots and files attach when they help, not as a default dump.

## Eyes
Code-drawn robot face (color + shape). States: idle, thinking, working, needs-you, asleep.

## Tunnel
User-provided Cloudflare tunnel so the PWA is reachable from a phone.

## Password
Single shared secret that locks the PWA. Cookie after first entry. Default `openbot`.

## Arena
Parked. Public Twitch-plays demo. Not v1.

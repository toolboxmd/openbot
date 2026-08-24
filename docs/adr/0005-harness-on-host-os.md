# ADR 0005: Harness lives on the host OS

## Status
Accepted

## Context
Grok Bot's agent runs beside the desktop: you do not watch its shell, you watch headed Chrome. OpenBot's pitch is the $20 CLI already on the user's machine. That binary is the host OS. A Linux container cannot run a Mac Codex. In-Screen would mean a second install and a second OAuth.

## Decision
The ACP child is a host OS process. One host command starts Screen (compose) and is the ACP parent. Official adapters, one stdio child per Bot, picker is PATH only. Workspace is a host folder mounted into Screen. Shell stays off-screen. PinchTab is the visible browser. Vendor login is the host CLI home (device-code in Chat if missing). Takeover is site 2FA. Sleep stops an idle Screen only; the ACP child stays so chat stays instant.

## Consequences
`docker compose up` alone is not enough to Talk. The CLI has the same powers as a terminal on that PC. Cookie jar stays on Computer; CLI creds stay in `~/.codex` (and friends). A VPS user installs the CLI on the VPS first. A laptop CLI driving a remote Screen is not v1.

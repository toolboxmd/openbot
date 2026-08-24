# Research: automatically starting Talk and Screen

**Recommendation (v1):** Make the package.json start script the one host command from ADR 0005. In this slice it should (1) bring Screen up detached via the Compose CLI, (2) run the Talk/box daemon in the foreground on the host so Node child_process can exec the users already-installed Codex CLI, (3) respawn that daemon if it crashes while the start command is still running, and (4) on SIGINT/SIGTERM stop the daemon (and optionally stop Screen). Drop the Compose service named box. Do not put Codex inside Docker. Do not ask the PWA to start Node. Keep-alive while the start command runs is not keep-alive after logout, sleep, or reboot; that is a later installer that wraps the same command in a Mac LaunchAgent or a Linux systemd user unit. Do not add PM2.

That is option A now, option C later. Options B and D are dead on the Mac. Option E is the installer shape of C, not a third runtime.

## What is actually broken today

The README still leads with Compose up --build, then says Talk is not Compose and to run the host start script ([README.md](../README.md), also on [task/talk-to-one-bot](https://github.com/toolboxmd/openbot/blob/task/talk-to-one-bot/README.md)). That split is how a local agent ended up Compose-only.

package.json scripts.start currently launches daemon/src/index.ts via tsx. See package.json in the repo root.

The package scripts runner is not a process supervisor.

Compose file on the Mac still defines two container services, box and screen, both with restart: unless-stopped. box depends_on screen and publishes 8080:8080. On the Mac working tree, screen is published on loopback port 6901. The workspace copy of that Compose file does not publish 6901. See docker-compose.yml in the repo root.

ADR 0005 already decided the architecture the README has not yet operationalized: the ACP child is a host OS process; one host command starts Screen (Compose) and is the ACP parent; Compose up alone is not enough to Talk; a VPS user installs the CLI on the VPS first; sleep kills the child. Path: docs/adr/0005-harness-on-host-os.md

The daemon already creates that child with Node child_process (shell false), resolving the Codex binary on the host PATH (plus HOME/.local/bin) and setting CODEX_PATH. See daemon/src/acp.ts and daemon/src/harness.ts. The container image CMD launches the same daemon sources inside Linux, not on the Mac PATH. See Dockerfile.

## Facts the product is constrained by

### 1. Compose services are containers, not host processes

The Compose Specification: a service is an abstract definition of a computing resource that is backed by a set of containers; as services are backed by containers, they are defined by a Docker image and set of runtime arguments. Source: https://docs.docker.com/reference/compose-file/services/

Implications:

- Compose can start, order, publish, and restart containers. It cannot be the ACP parent on the host. There is no Compose key that execs a Mac binary from a user nvm prefix.
- depends_on only orders service startup/shutdown. Short syntax waits until the dependency has been started, not until it is ready. Long syntax can wait for service_healthy or service_completed_successfully. The restart: true flag under depends_on only restarts this service after an explicit Compose operation on the dependency, and excludes automated restart by the container runtime after the container dies. Sources: same services page, depends_on; https://docs.docker.com/compose/how-tos/startup-order/

- Service restart (no / always / on-failure / unless-stopped) is the policy the platform applies on container termination. Source: Compose restart on the services page. Docker Engine: Restart policies only apply to containers. Source: https://docs.docker.com/engine/containers/start-containers-automatically/
- ports publishes container ports onto the host. Short syntax HOST:CONTAINER; if you omit the host IP, Docker binds all interfaces. 127.0.0.1:6901:6901 binds loopback only. Source: Compose ports on the services page. That is the right shape once the host daemon, not Compose box, is the reverse proxy.
- Compose CLI up in the attached default stops all containers when the command exits. up --detach starts containers in the background and leaves them running. Source: https://docs.docker.com/reference/cli/docker/compose/up/ So if the start command should keep the terminal for Talk, Screen must be started detached (only the screen service), not via a blocking up of the whole project.
- Compose provider can delegate a service lifecycle to an external binary, but the dependent still receives container-style env vars. Source: Compose provider on the services page. That is not a substitute for spawning Codex on the host.

Docker restart-policy page: if processes outside Docker depend on containers, use a host process manager such as systemd; do not combine Docker restart policies with host-level process managers, as this creates conflicts. Same start-containers-automatically page. For us: Screen may keep restart: unless-stopped. The host daemon must not also be a Compose service with the same policy.

### 2. Docker Desktop on Mac is a Linux VM; native Linux Engine is not

Docker Desktop runs the Docker Engine inside a lightweight Linux virtual machine. On Mac, com.docker.backend is the host-side proxy; published ports are listened on by that backend and forwarded into the VM. Source: https://docs.docker.com/desktop/features/networking/ The VM is powered by a Virtual Machine Manager (Apple Virtualization framework, Docker VMM, and others). Source: https://docs.docker.com/desktop/features/vmm/

A Compose box container therefore runs Linux, not macOS. It cannot exec the users Mach-O Codex binary. Bind-mounting that path does not help: the kernel and loader inside the VM are Linux.

Two Linux stories, do not confuse them:

- Docker Desktop for Linux still runs a Virtual Machine and a desktop-linux context. Images on the host Engine are not visible inside Desktop. Sources: https://docs.docker.com/desktop/setup/install/linux/ and https://docs.docker.com/desktop/troubleshoot-and-support/faqs/linuxfaqs/#why-does-docker-desktop-for-linux-run-a-vm
- Docker Engine on Linux (Docker CE) is the native engine on the host kernel. Source: https://docs.docker.com/engine/install/ Containers still have their own filesystem and PATH. Bind-mounting host binaries is not ADR 0005, and it still would not see ~/.codex unless that home is also mounted. OpenBot decision: spawn on the host, do not docker-exec the harness.

On a VPS with native Engine, Screen can be a container on the same kernel. Talk must still be a host process next to that container, after the user installs Codex on the VPS (ADR 0005).

### 3. Apple launchd: LaunchAgents, KeepAlive, RunAtLoad

Primary sources: Apple Creating Launch Daemons and Agents (https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html), TN2083 Daemons and Agents (https://developer.apple.com/library/archive/technotes/tn2083/_index.html), and the Mac man page launchd.plist(5).

- A user agent is specific to a given logged-in user and executes only while that user is logged in. Plists go in ~/Library/LaunchAgents (per-user) or /Library/LaunchAgents (all users). System daemons go in /Library/LaunchDaemons and run as root. OpenBot Talk is a per-user job: it needs the users PATH, ~/.codex, and nvm.
- Required keys: Label, ProgramArguments. KeepAlive specifies whether the daemon launches on-demand or must always be running.
- man launchd.plist: KeepAlive default is false (demand only). Set to true to unconditionally keep the job alive. Jobs that exit quickly and frequently when configured to be kept alive will be throttled. The use of this key implicitly implies RunAtLoad, causing launchd to speculatively launch the job.
- TN2083 table (10.5+): KeepAlive true means run when loaded and never quit; KeepAlive false plus RunAtLoad true means run once when loaded and thence on demand.
- launchd sends SIGTERM on logout/shutdown. Jobs MUST NOT call daemon(3) or fork then have the parent exit; launchd will think the job died and may respawn too fast. So the start command must stay in the foreground when launchd is the supervisor.

A LaunchAgent does not run when nobody is logged in, and it does not run when the Mac is powered off. Sleep: ADR 0005 already records Sleep kills the child. A sleeping or off Mac cannot Talk (this Computer is off).

### 4. systemd user services: Restart=always, lingering

- Restart=always: the service will be restarted regardless of whether it exited cleanly or not, got terminated abnormally by a signal, or hit a timeout, except systemctl stop and RestartPreventExitStatus. Source: https://www.freedesktop.org/software/systemd/man/252/systemd.service.html
- User services live under the per-user manager. user@.service starts at first login and, without lingering, is stopped after the last session ends. Sources: https://www.freedesktop.org/software/systemd/man/latest/systemd-run.html and https://www.freedesktop.org/software/systemd/man/latest/logind.conf.html (KillUserProcesses).
- loginctl enable-linger: if enabled for a specific user, a user manager is spawned for the user at boot and kept around after logouts. This allows users who are not logged in to run long-running services. Source: https://www.freedesktop.org/software/systemd/man/latest/loginctl.html (also quoted in systemd-run). A VPS that should Talk after reboot needs lingering (user unit) or a system unit under /etc/systemd/system.

Same foreground rule as launchd: ExecStart should be the host start command, not a double-forking daemon.

### 5. Node child_process and what the start script actually is

The package scripts runner executes the start property of package.json. If missing, it runs node server.js. Lifecycle is prestart, then start, then poststart. Scripts run from the package root via /bin/sh on POSIX. That CLI is not a process supervisor: it does not restart a crashed Node process and it does not survive reboot. See the npmjs start-command page and the scripts page cited above.

Node child_process spawn starts a new OS process. Lookup uses options.env.PATH if env is set. shell false (our current ACP spawn) execs the binary directly. The parent can listen for exit/close and call subprocess.kill SIGTERM. options.detached plus unref can let a child outlive the parent; that is the opposite of what launchd wants, and it is how people accidentally lose the ACP child. Source: https://nodejs.org/api/child_process.html

Node guidance for crash recovery: to restart a crashed application in a more reliable way, an external monitor should be employed in a separate process (uncaughtException warning). SIGINT and SIGTERM have default handlers that exit; a supervisor in-process can intercept them, stop children, then exit. Source: https://nodejs.org/api/process.html#signal-events and the uncaughtException section on the same page.

Why not PM2. PM2 is a third-party process manager. Node, Docker, Apple, and systemd already name the monitors we should use: a small in-process loop for the session in which the start command is running, and launchd/systemd for login/boot. Adding PM2 would be a second host supervisor next to those, plus another daemon to install on a VPS. Docker even warns not to stack restart policies with extra process managers. We should not need it.

### 6. The PWA cannot start Node

Chrome native messaging is an extension API (runtime.connectNative / sendNativeMessage), requires the nativeMessaging permission, and allowed_origins is a list of chrome-extension IDs. These methods are not available inside content scripts, only inside your extension pages and service worker. A website origin is not an allowed origin. Source: https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging

Service workers are event-driven, time-limited JS contexts the user agent may kill at any time; they sit between network and renderer, not between the page and the OS. Source: https://www.w3.org/TR/2025/CRD-service-workers-20250306/ There is no web API to spawn a host CLI. WebDriver drives a browser, not the host Node daemon.

So open the PWA and it boots Talk is false unless we ship a native helper (extension plus registered host, or an installed LaunchAgent/app). That is option E/C, not a PWA feature.

## Options

### A. The start script supervises (recommended v1)

Host command does four things:

1. Ensure Docker is up enough to run Screen. Compose up --detach --build of service screen. Existing restart: unless-stopped on that container covers container crashes for as long as the Engine/VM is running.
2. Point the daemon at the published Screen: SCREEN_UPSTREAM=http://127.0.0.1:6901 (loopback publish already on the Mac Compose file).
3. Run tsx against daemon/src/index.ts (todays start script) in the foreground. That process is the ACP parent (ADR 0005; acp.ts).
4. If that process exits unexpectedly, spawn it again with backoff (in-process loop or a small wrapper). On SIGINT/SIGTERM: stop respawning, SIGTERM the daemon, then optionally Compose stop screen. Do not unref it.

This matches ADR 0005 one host command starts Screen (Compose) and is the ACP parent. It makes README a single entry point, so agents stop doing Compose-only. It does not outlive the terminal, logout, sleep, or reboot.

Implementation sketch (not the patch): keep scripts.start as the user-facing script; put the Compose plus respawn loop in a small host-side module (for example daemon/src/supervise.ts) so tests can still boot startBox without Docker. box service is removed from Compose or moved behind a profile that we do not document.

### B. Keep Compose box as the HTTP server and somehow spawn host Codex

Status-quo README. box is a Linux container (Dockerfile, Compose services spec). On Docker Desktop Mac it runs in the Linux VM. It cannot exec the Mac Codex binary. A host helper that box talks to is just option A/E with extra hops.

On native Linux Engine, a bind-mount of the Codex binary plus ~/.codex might accidentally work for some installs and fail for nvm/fnm shims. ADR 0005 forbids that path: A Linux container cannot run a Mac Codex; The ACP child is a host OS process. Reject for v1.

### C. OS user service wrapping A (login/boot)

Same foreground command as A, installed as:

- Mac: ~/Library/LaunchAgents/md.toolbox.openbot.plist with KeepAlive true (implies RunAtLoad).
- Linux: systemd user unit, Restart=always, WantedBy=default.target, plus loginctl enable-linger on a VPS.

This is what survives reboot if the machine is on and (Mac) a user session exists. Sleep/off still means Talk is down. Do this in an installer, not by asking people to paste plists in this slice.

### D. Browser / PWA starts the backend

Not possible from a website. Native messaging is extension-only. Service workers cannot spawn OS processes. Reject.

### E. Tiny always-on helper binary installed once

This is C with a nicer UX: a signed installer writes the LaunchAgent/user unit, maybe a menu-bar/tray stub that only attaches to an already-running daemon. It is not a different architecture from A+C. OpenClaw Mac app is exactly this pattern (below). Defer until we have A stable.

## Comparables (first-party)

### OpenClaw: host daemon via launchd/systemd; Docker is a different product shape

OpenClaw supported local path is a host Gateway process plus openclaw gateway install, which installs a per-user LaunchAgent on macOS (~/Library/LaunchAgents/ai.openclaw.gateway.plist, label ai.openclaw.gateway) or a systemd user unit on Linux (Restart=always, and they document loginctl enable-linger for persistence after logout). The Mac app does not spawn the Gateway as a child process of the GUI; quitting the app does not stop the Gateway; launchd keeps it alive. Sources: https://docs.openclaw.ai/platforms/mac/bundled-gateway ; https://docs.openclaw.ai/gateway ; https://docs.openclaw.ai/cli/daemon

They also have a Docker install that runs the gateway inside a container and starts it with Compose. Source: https://docs.openclaw.ai/install/docker That is the opposite of ADR 0005. Useful as a negative: if we put Talk in box, we inherit OpenClaw Docker model and lose the twenty-dollar CLI already on the users machine.

Copy from OpenClaw: install command later; LaunchAgent not LaunchDaemon; linger on Linux; do not double-supervise.

### Codex app-server-daemon: pidfile helper, explicitly not reboot-persistent

OpenAI codex-app-server-daemon is a Unix pidfile-backed supervisor for Codex app-server (daemon start/stop/restart/bootstrap). start is idempotent. bootstrap starts a detached updater loop. The README is explicit: the updater loop is not reboot-persistent; it must be started again by rerunning bootstrap after a reboot. Source: https://raw.githubusercontent.com/openai/codex/main/codex-rs/app-server-daemon/README.md

That is the same distinction we need: keep-alive while the supervisor process runs is not keep-alive after reboot. Codex did not pretend a pidfile was launchd. Neither should we.

### Grok Bot

No public first-party install/daemon docs were found. Skip.

## Mac vs Linux

| Topic | Mac (Docker Desktop) | Linux VPS (Engine, not Desktop) |
|---|---|---|
| Where containers run | Linux VM; host proxy com.docker.backend | Host kernel |
| Can a container exec host Codex? | No (wrong OS) | Still no under ADR 0005; possible only with bind-mounts we refuse |
| Screen | Compose up --detach of screen, publish 127.0.0.1:6901:6901 | Same; host daemon uses loopback publish either way |
| Talk | Host start script / LaunchAgent | Host start script / systemd user (linger) or system unit |
| Reboot | LaunchAgent after login; Docker Desktop must also be running for Screen | systemd plus linger (or system unit); Engine usually already a system service |
| Sleep / power off | No Talk. ADR 0005: sleep kills the child. PWA should say the Computer is off | VPS usually does not sleep; power-off is still off |
| PATH / creds | Users nvm and ~/.codex. LaunchAgent must set PATH/HOME or use a login-shell wrapper | User or service Environment / EnvironmentFile |

Docker Desktop for Linux is the Mac-like VM case on a Linux laptop. Treat it as Mac: Talk on the host, Screen in the Desktop VM, publish 6901 on loopback.

## What to implement in this slice vs later

### This slice (A)

- Change README: the only happy path is the package.json start script (plus OPENBOT_PASSWORD). One paragraph: this starts Screen and Talk. Compose-only is wrong.
- Change scripts.start so it brings Screen up detached, runs the host daemon in the foreground, respawns the daemon on crash, and handles SIGINT/SIGTERM.
- Remove or undocument Compose box. Screen stays a Compose service with restart: unless-stopped and 127.0.0.1:6901:6901.
- Default SCREEN_UPSTREAM on the host to http://127.0.0.1:6901 when unset.
- Do not install launchd/systemd yet. Do not add PM2. Do not add a PWA start-backend button.

### Later (C, then E)

- An install command writes a LaunchAgent (Mac) or systemd user unit (Linux) whose ProgramArguments/ExecStart is the same foreground start command, with KeepAlive / Restart=always.
- Linux VPS: document loginctl enable-linger (or ship a system unit).
- Optional tray/app that only attaches, like OpenClaw.app.
- Honest UX when the Computer is asleep or off.

### Explicitly out of v1

- PWA starting Node.
- Codex inside the Screen/box container.
- Reboot survival without an installer.
- Combining Compose restart on a box container with a host supervisor for the same process.

## Keep-alive: two clocks

1. Session keep-alive (this slice): while the start command is the foreground job, if Talk dies, start it again. Screens container policy covers Screen. Ctrl-C ends both the loop and, if we choose, Screen.
2. Machine keep-alive (installer): launchd/systemd start that same job at login/boot and restart it when it exits. Does not run when the machine is off or (Mac default) when no user is logged in. Does not pierce sleep.

Codex daemon README is the short version of this paragraph: not reboot-persistent until something else starts it again (app-server-daemon README, raw GitHub URL above).

## Sources that could not be fetched

- systemd.service.html and loginctl.html latest on freedesktop.org timed out. Restart=always is cited from the 252 systemd.service(5) mirror of the same man page. Linger is cited from systemd-run(1) latest and the loginctl search snippet of the same latest page.
- Apple launchd.plist(5) HTML mirrors timed out; the Mac man launchd.plist on this machine was used instead (same page Apple points to in Creating Launch Daemons).
- GitHub HTML for openai/codex app-server-daemon README returned empty; raw.githubusercontent.com worked.
- Grok Bot: no public first-party daemon/install docs found.

## Decision recap

Ship A in this slice. Tell the user: the start script starts Screen and keeps Talk alive for as long as that command runs. Reboot/login is C, via installer, later. The PWA cannot do it. Docker box cannot do it on a Mac.

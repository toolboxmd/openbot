# ADR 0007: Home owns Channels and Transcripts

## Status
Accepted

## Context
Talk stored Bots and chat bubbles in one `bots.json` blob inside the shared Computer workspace. The PWA thread survived a restart, but the Harness restarted blank. A Bot blob was not a Channel, there was no private Home, and one Bot could not have independent conversations in several Channels.

Harness JSONL is vendor state, not the human-facing OpenBot Transcript. ACP has no history field. The shared workspace must stay available to every Bot without exposing Talk's private state.

## Decision
OpenBot has a private Home at `$OPENBOT_HOME`, default `~/.openbot`. Talk stores one `talk.sqlite` there. The Computer workspace is `$OPENBOT_HOME/workspace`; it is both ACP cwd and the Screen `/workspace` mount. Home itself is not mounted into Screen or given to Harnesses. There is no per-Bot cwd.

The database uses integer, additive schema migrations. It stores Bots, Channels, members, messages, reactions, attachments, deliveries, and per-Bot per-Channel state. A Talk binary refuses to write a schema version newer than it supports. This is greenfield state: Talk does not import the old workspace blob.

A Channel owns its Transcript. A Bot owns its Harness. Creating a Bot also creates its direct Channel with two members: you and that Bot. Replies, reactions, and Sent, Delivered, and Read state belong to messages in the Channel.

A Session is one Bot using its Harness in one Channel. A Bot may run several Sessions at once. When Talk cannot load Harness state, it starts `session/new` and injects the last 20 user Turns from the Channel, clipped to 64,000 characters, plus any reply target and the new message. Speaker names are text, not JSON. Receipts and reactions are omitted. Persisted ACP session loading is a later slice.

Zoom grants Screen write access but does not pause or SIGSTOP Sessions. If the user and Bot need the same pointer, the user asks the Bot to stop.

## Consequences
Talk restart, Harness restart, and Harness change no longer discard conversational context. Reinstalling Screen does not wipe Home. A wipe of Home is the only full wipe.

The PWA Transcript is independent of Harness logs. Future group and Bot-to-Bot Channels can reuse the same storage model, and parallel Sessions do not need to share one Bot-level child or transcript.

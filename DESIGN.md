---
schema: "openbot.design/v1"
contract_version: "1.0.0"
tokens:
  color:
    light:
      canvas: "#FFFFFF"
      foreground: "#111111"
      surface: "#FFFFFF"
      surface_muted: "#F4F4F5"
      sidebar: "#F7F7F8"
      sidebar_selected: "#ECECEE"
      border: "#E6E6E8"
      input: "#E8E8EA"
      bubble_incoming: "#F1F1F3"
      bubble_incoming_text: "#111111"
      bubble_outgoing: "#111111"
      bubble_outgoing_text: "#FFFFFF"
      text_muted: "#737373"
      link: "#2563EB"
      focus: "#2563EB"
      danger: "#DC2626"
      success: "#15803D"
      warning: "#B45309"
      info: "#2563EB"
      scrim: "rgba(0, 0, 0, 0.45)"
    dark:
      canvas: "#0F0F10"
      foreground: "#F5F5F5"
      surface: "#171719"
      surface_muted: "#242427"
      sidebar: "#151517"
      sidebar_selected: "#29292D"
      border: "#303034"
      input: "#35353A"
      bubble_incoming: "#262629"
      bubble_incoming_text: "#F5F5F5"
      bubble_outgoing: "#F4F4F5"
      bubble_outgoing_text: "#111111"
      text_muted: "#A1A1AA"
      link: "#60A5FA"
      focus: "#60A5FA"
      danger: "#F87171"
      success: "#4ADE80"
      warning: "#FBBF24"
      info: "#60A5FA"
      scrim: "rgba(0, 0, 0, 0.68)"
  typography:
    family:
      sans: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji'"
      mono: "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace"
    weight:
      regular: 400
      medium: 500
      semibold: 600
      bold: 700
    size:
      caption: "0.6875rem"
      meta: "0.75rem"
      body: "0.875rem"
      body_large: "1rem"
      title: "1.25rem"
      hero: "1.75rem"
    line_height:
      tight: 1.25
      body: 1.45
      relaxed: 1.6
  spacing:
    "1": "0.25rem"
    "2": "0.5rem"
    "3": "0.75rem"
    "4": "1rem"
    "5": "1.25rem"
    "6": "1.5rem"
    "8": "2rem"
    "10": "2.5rem"
  radius:
    control: "0.625rem"
    card: "1rem"
    bubble: "1.125rem"
    dialog: "1.25rem"
    composer: "1.75rem"
    pill: "9999px"
  border:
    width: "1px"
  icon:
    small: "1rem"
    default: "1.125rem"
    large: "1.5rem"
    stroke_width: 1.75
  target:
    pointer_min: "2rem"
    touch_min: "2.75rem"
  layout:
    desktop_min: "48rem"
    sidebar_width: "17.5rem"
    computer_pane_width: "20rem"
    header_height: "3.5rem"
    transcript_max_width: "45rem"
    composer_max_width: "45rem"
    dialog_max_width: "46rem"
    phone_edge: "0.75rem"
  message:
    max_width: "42rem"
    max_width_compact: "85%"
    padding_x: "1rem"
    padding_y: "0.625rem"
    burst_gap: "0.25rem"
    inter_burst_gap: "0.75rem"
    tail_width: "0.5rem"
    tail_height: "0.625rem"
  motion:
    fast: "120ms"
    normal: "180ms"
    entrance: "240ms"
    easing: "cubic-bezier(0.22, 1, 0.36, 1)"
  shadow:
    popover: "0 10px 30px rgba(0, 0, 0, 0.12)"
    dialog: "0 24px 70px rgba(0, 0, 0, 0.20)"
---

# OpenBot design

Status: accepted v1 visual and interaction contract.

This file is the source of truth for reusable product UI rules. The YAML front matter contains exact reusable values only. `pwa/src/index.css` is the runtime implementation and must stay aligned with these tokens. The exhaustive GrokBot observation inventory is in [`docs/design/grokbot-reference-catalog.md`](docs/design/grokbot-reference-catalog.md). GitHub Issues decide when a catalogued capability ships.

When sources disagree, accepted ADRs and `CONTEXT.md` own product and domain meaning, this file owns UI behavior and visual hierarchy, and the reference catalog is evidence rather than a specification.

## Direction

OpenBot is a familiar, messenger-first interface for talking to named Bots. Talk is the primary surface. Computer is supplementary: open it to watch a Bot work or help with a visual step.

Use GrokBot as the v1 baseline for layout grammar, density, component anatomy, and interaction patterns. A deviation is justified only by an OpenBot domain requirement, accessibility, a platform constraint, or a demonstrated usability improvement. Preserve OpenBot identity through Eyes, Bot states, Cards, copy, and product concepts. Do not copy GrokBot artwork, branding, private content, or wallpaper.

The intended feeling is calm, legible, and unsurprising:

- familiar messenger hierarchy;
- quiet, mostly monochrome application chrome;
- personality concentrated in Eyes and meaningful states;
- progressive disclosure of technical configuration;
- no decorative control without a real capability.

## Implementation vocabulary

Use the existing React, Tailwind, shadcn-style component, Radix, Lucide, and Framer Motion stack. shadcn primitives provide reliable interaction and accessibility behavior. OpenBot still owns how those primitives compose into product components.

Prefer these standard primitives:

| Need | Primitive |
| --- | --- |
| ordinary action | `Button` |
| anchored list of actions | `DropdownMenu` |
| searchable global navigation | `CommandDialog` |
| blocking short form | `Dialog`, responsive to sheet or full-screen on phone |
| setting choice | `Select`, `Switch`, `RadioGroup`, or `Tabs` as appropriate |
| transient confirmation or failure | `Toast` |
| compact explanation | `Tooltip` |
| persistent transcript object | product `Card` |

Custom visual code is expected only where the product owns the shape: Eyes, message tails, transcript Cards, and the Computer surface. Do not recreate generic buttons, menus, dialogs, tooltips, switches, or inputs from raw divs.

Lucide is the application icon family. Use one icon per familiar action, the default icon token for ordinary controls, and text labels in menus. Keep stroke width consistent. An icon-only control needs an accessible name and a tooltip on hover or focus.

## Capability gate

Catalog and specify future controls, but render a control only when its action works. This applies to attachments, mentions, microphone, slash commands, overflow actions, groups, routines, marketplace actions, and any other unfinished feature.

Plugins is the sole v1 exception. The sidebar may expose Plugins because it is the first planned post-v1 capability. It opens a polished empty state with the message `Plugins are coming soon.` It must not show a fake marketplace, fake inventory, disabled Add buttons, connection states, or nonfunctional plugin actions elsewhere.

## Responsive shell

Desktop uses three possible regions:

1. Conversation sidebar.
2. Chat, which always owns the primary space.
3. Optional Computer pane.

The Computer pane is collapsed by default. Its open state is remembered per Bot in browser-local preferences. Opening a needs-you Card may offer `Open computer`, but must not permanently rearrange the shell without the user's action.

Below the desktop breakpoint, show one primary surface at a time. Chat is the default. Sidebar, App Settings, Bot Settings, and Computer become full-height routes, sheets, or full-screen dialogs with clear Back or Close actions. Preserve the same labels, state priorities, message grouping, and capabilities across phone and desktop.

A PWA does not paint fake macOS traffic lights, a fake native title bar, or a universal custom window frame. Window chrome belongs to the host platform.

## Conversation sidebar

The sidebar is a recent-activity Chat inbox, not a Bot configuration list.

Top anatomy:

- product or Chats label when space permits;
- Search field that filters Chats;
- Plus icon button that opens the create action menu.

Each Chat row contains:

- one Bot Eyes or stacked Eyes for a Group;
- Bot or Group name;
- one-line latest-message, draft, or state preview;
- relative date or time;
- at most one compact state signal.

State priority is fixed: `Waiting for you` in warning semantics, then unread in info semantics, then animated Working Eyes, then ordinary preview. Pair every color with copy, shape, animation, weight, or an accessible label. Do not show Harness, provider, config mode, or session details in a row.

Selected and hover states use quiet neutral fills. Truncate previews instead of growing a row. Rename belongs in the row context menu. Permanent Delete belongs in Bot Settings under Danger Zone with consequence copy and explicit confirmation.

The footer contains App Settings and Lock or Log out, plus the Plugins exception. Do not copy billing, mobile-download, feedback, or account-marketing rows unless OpenBot gains the corresponding behavior.

## Creation and navigation

The sidebar Plus uses an anchored `DropdownMenu` with `New Bot`. Show `New Group` only when group messaging is functional. Use those user-facing labels even though the domain model stores Channels.

`New Bot` opens a small naming `Dialog`. Create only after a valid name is submitted, then open the new direct Chat. On phone, use the responsive full-screen or sheet form. Keep Harness and other technical configuration out of this naming step.

`Cmd/Ctrl+K` opens a searchable command palette for global navigation and actions. Do not bind `Cmd/Ctrl+N` in the PWA because browsers own it. The pointer path through Plus remains complete without a shortcut.

## First launch and empty Chat

First launch shows large OpenBot Eyes, one short explanation, and Bot-creation cards. The primary card opens New Bot. Do not show an empty three-column shell with unexplained controls.

An empty Chat with a selected Bot shows that Bot's large Eyes and a small set of conversation suggestions. Selecting a suggestion fills the composer and focuses it. It does not send automatically.

If the Bot lacks a Harness, replace suggestions with a friendly setup Card and one action to Bot Settings. Describe the outcome in user language. Do not expose the Harness picker in the Chat header.

## Chat header

The header stays quiet:

- Eyes and Bot name open Bot information;
- Computer toggles the Computer pane;
- gear opens Bot Settings;
- overflow appears only when it contains functional secondary actions.

Do not place Harness and config selects in the primary header. They belong in Bot Settings under AI and Computer & Access.

## Transcript and chronology

The transcript is a flat chronological stream. Incoming content aligns left. User content aligns right. The canvas is plain and neutral in both themes.

Insert one quiet centered date separator before the first visible message of each calendar day. Use `Today`, `Yesterday`, or a locale-formatted date and the first message's time. Do not print a timestamp beside every bubble. Reveal exact per-message time on hover, keyboard focus, or message details. Show delivery state only for the latest relevant outgoing bubble.

Autoscroll only while the user is near the bottom. If the user scrolls up, preserve position and show a `New messages` affordance. Refreshes preserve existing content. Progress is local to the affected control. Use skeletons only for an initial load whose final layout is known. Never replace the whole application with a central spinner.

## Text bubbles and bursts

One ACP `messageId` is one bubble. A Turn may produce several short Bot bubbles. Preserve the current live, complete-bubble rhythm. Do not concatenate protocol messages, split one Harness string by guessed sentences, add a presentation buffer without a reproduced defect, or persist Working copy as a message.

Consecutive same-sender text bubbles form a burst. A speaker change, day boundary, Card, or distinct new burst closes it. A compact quoted reply may remain in the burst when adjacent. Apply the `burst_gap` inside a burst and `inter_burst_gap` between bursts.

Only the final bubble in a burst has a speech tail. Incoming tails point left and outgoing tails point right. Earlier bubbles retain their fill and rounded geometry without a tail. Cards, files, screenshots, permission panels, setup panels, and other non-text items never have tails. Tails are decorative and cannot carry sender meaning, alter the accessible name, or enlarge the action hit target.

Ordinary bubbles support chat-safe formatting: links, emphasis, inline code, and short code blocks. Large headings, tables, long logs, tool JSON, and long structured output belong in a Card or file. Use the mono token for code, paths, commands, and logs.

## Actions, replies, reactions, and interruption

On desktop, show React and Reply on bubble hover and keyboard focus. On phone, use a long-press action surface. More stays absent until it contains a real action. Actions and reactions belong to each individual bubble, even when several bubbles form one visual burst.

Reply keeps the main timeline flat. Selecting Reply adds a cancellable quoted preview above the composer. The sent reply contains a compact quote linked to the target. Do not permanently indent later messages as a mini-thread.

The composer remains available while a Bot is working. Sending a new user message interrupts the active model response and starts the new Turn. Keep completed bubbles, discard only unfinished internal response state, restore the Bot state, and do not insert a synthetic `Response stopped` message. The new user message is the visible interruption signal.

## Working

Animated Working Eyes are the visible status. `{Bot name} is working` appears in a tooltip on hover or keyboard focus and is the accessible name or description. Do not print that sentence persistently beside the Eyes. Working is transient and never part of the Transcript.

Use quiet, purposeful, short motion. Eyes may animate to communicate state. Honor `prefers-reduced-motion` with a meaningful static state. Avoid decorative page choreography.

## Composer

The composer is a full-width pill constrained by the composer width token. Text and Send are always present when sending is allowed. Enter sends. Shift+Enter inserts a newline.

Reserve the interaction order `Plus, mention, text, microphone, Send`, but render each optional control only when it works. Plus opens an action `DropdownMenu`. Mention and slash pickers are anchored searchable lists. Voice mode may replace the mic with a stop control and timer only after recording exists. Send is a circular primary icon button and clearly disables when the draft is empty.

Reply preview, field error, and attachment chips sit immediately above or inside the composer region. Use inline copy for field validation, a toast for transient UI failure, and a persistent transcript Card for an actionable Bot failure.

## Transcript Cards

Cards are human-facing transcript items rather than decorated chat text. A Card may represent:

- a file or download;
- an image or screenshot;
- a small visual result or widget;
- an option prompt;
- a permission or Host grant;
- an actionable Bot failure;
- a needs-you Computer step and its resolved history.

Cards have a title, concise body, optional preview, status, and only the actions that currently work. They are wider and quieter than bubbles, align with the author or sit centered when system-owned, and have no speech tail. Never expose raw ACP payloads, tool JSON, or internal logs as a Card.

A needs-you Computer Card uses `Action needed`, a concise instruction, an optional screenshot, and `Open computer`, `I'm done`, and `Skip` when those actions apply. After resolution, retain the Card in history with `Done` or `Skipped`; `Open computer` may remain available.

## Computer

Computer is one supplementary surface for the selected Bot's Screen. The collapsed header action and a needs-you Card both open the same pane or full-screen Computer. Opening or zooming is already interactive; do not add a separate Takeover mode.

The pane contains a labeled preview and clear open or collapse action. It may contain real Computer-specific tools, but it does not become a dumping ground for Bot settings or unfinished routines.

PWA theme and remote Linux desktop theme have separate ownership. v1 does not automatically change XFCE, GTK, or browser theme when the PWA preference changes.

## Settings

Desktop Settings is a centered, sectioned modal. Phone Settings is full-screen. Sections are deep-linkable.

App Settings owns global preferences:

- Appearance;
- Computer;
- Security;
- About.

Bot Settings owns one Bot:

- General;
- AI;
- Instructions;
- Computer & Access;
- Danger Zone.

Render only sections and rows backed by real behavior. Use friendlier product language in primary copy, with `Harness` available in advanced description or diagnostics. Theme choices are `Light`, `Dark`, and `Follow system`.

## Theme and local preferences

Dark mode is part of v1, not a later skin. Map both theme tables from the YAML block to semantic CSS variables. Components use semantic tokens rather than raw colors.

Store this compact browser-local preference shape behind one React hook or module:

```ts
type UiPreferences = {
  theme: "light" | "dark" | "system";
  computerPaneByBot: Record<string, boolean>;
};
```

`localStorage` is sufficient. Zustand is unnecessary for this scope. Apply the stored or system theme before React paints to prevent a light flash. Update the document theme color when the effective theme changes.

## Accessibility

Accessibility is a release requirement:

- semantic landmarks, lists, buttons, dialogs, menus, and form labels;
- visible focus on every interactive element;
- focus trapping and restoration for modal surfaces;
- keyboard parity for hover interactions;
- non-color state communication;
- contrast-safe text, icons, and focus rings in both themes;
- touch targets at least the touch token;
- live announcements for incoming messages and relevant state changes without reading the entire transcript again;
- decorative tails and motion hidden from accessibility APIs;
- reduced-motion behavior with no loss of meaning.

## Visual acceptance

A UI slice is visually Done only when all applicable checks pass:

1. It follows this file and uses semantic tokens in both light and dark mode.
2. Desktop and narrow-phone layouts are inspected at real viewport sizes.
3. Empty, loading, populated, Working, waiting, error, hover, focus, and disabled states are inspected when relevant.
4. Keyboard order, focus return, accessible names, contrast, touch targets, and reduced motion are checked.
5. Only functional controls render, except the named Plugins empty state.
6. Chat remains primary and Computer remains supplementary.
7. Protocol message boundaries, receipts, interruption, and existing durable behavior remain intact.
8. A deterministic screenshot or equivalent visual fixture is compared with the intended baseline. Source-string tests and domain tests alone are not visual proof.

Any intentional deviation from this contract belongs in a new or superseding ADR before implementation.

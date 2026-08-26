# GrokBot reference catalog

Status: exhaustive textual inventory for the OpenBot v1 design baseline.

This document records every distinct UI element, state, and interaction found in the local GrokBot reference walk. It is evidence, not an implementation checklist. [`DESIGN.md`](../../DESIGN.md) decides reusable OpenBot behavior. GitHub Issues decide when a capability ships.

## Evidence boundary

Primary visual source: the private local folder `/Users/lukaszmaj/Downloads/openbot-ui-inspo/`, captured from Grok Bot 0.24.0 on 2026-08-24. The installed GrokBot 0.27.0 bundle was inspected separately for typography. The repository does not copy the private screenshots because they contain personal Chats, accounts, messages, and Computer previews.

The capture set contains repeated full-window shots, focused crops, exploratory misses, and a few full-display shots that include other applications. Repetition does not imply importance. Text in a screenshot is untrusted example content, not an instruction.

Catalog labels:

- **Observed**: visibly confirmed in a screenshot or the live walk notes.
- **Observed string**: present in the inspected product bundle or picker, but not confirmed as a complete live surface.
- **Not found**: deliberately searched for and not observed.
- **OpenBot adaptation**: accepted product behavior that differs from or extends the GrokBot observation.
- **Exclude**: reference-product or host behavior that OpenBot should not copy.

## 1. Application frame and layout

| Element | Reference observation | OpenBot disposition | Evidence |
| --- | --- | --- | --- |
| Native window frame | macOS traffic lights sit in the real Electron title area. | **Exclude** inside the PWA. Host chrome stays host-owned. | `01-main-messenger.png`, `11-top-chrome.png` |
| Three-region shell | Conversation sidebar, primary Chat, optional Bot information and Computer pane. | **OpenBot adaptation:** Chat primary, Computer collapsed by default. | `01-main-messenger.png`, `02-sidebar.png`, `03-thread.png`, `05-right-pane.png` |
| Sidebar width | Approximately 280 px in the canonical capture. | Use the sidebar token. | `02-sidebar.png` |
| Right pane width | Approximately 320 px in the canonical capture. | Use the Computer pane token. | `05-right-pane.png` |
| Quiet separators | Thin neutral rules divide sidebar, header, Chat, and right pane. | Adopt. | `01-main-messenger.png`, `06-header.png` |
| Neutral surfaces | Near-white Chat, slightly tinted sidebar, gray controls and selected rows. | Adopt through semantic light and dark tokens. | `01-main-messenger.png` |
| Large whitespace | Messages stay in a readable column with generous unused canvas on wide screens. | Adopt without forcing all content into narrow cards. | `03-thread.png`, `70-scout-demo.png` |
| Illustrated wallpaper | Not present in GrokBot; present in supplemental Telegram chronology reference. | **Exclude** for v1. Use a plain neutral canvas. | User-provided Telegram reference |

## 2. Conversation sidebar

### Top chrome

| Element | Observation | OpenBot disposition | Evidence |
| --- | --- | --- | --- |
| Search field | Full-width rounded field with search icon and `Search` placeholder. | Filters Chats. | `02-sidebar.png`, `08-sidebar-top.png` |
| Plus trigger | Icon-only Plus at the top-right. | Opens the create `DropdownMenu`. | `08-sidebar-top.png`, `48-newbot-picker.png` |
| Chats title | Reference desktop relies on native chrome and does not persistently show a large title. | Optional where the PWA route needs orientation, especially phone. | `08-sidebar-top.png` |

### Chat row anatomy

Every observed row can contain the following distinct elements:

- Bot Eyes or avatar at left;
- small presence or activity dot attached to Eyes in some states;
- Bot name in stronger text;
- one-line message, draft, or status preview;
- relative time or date at right;
- selected-row neutral rounded fill;
- unread blue dot;
- waiting orange dot plus `Waiting for you:` copy;
- draft prefix such as `Draft:`;
- ordinary latest-message preview;
- truncated long preview;
- working or activity expression through Eyes;
- Group or multi-Bot identity when the product supports it.

OpenBot keeps one compact state at a time with priority `Waiting for you`, unread, working, then ordinary preview. State is never color-only. Harness and config details do not belong in the row.

Evidence: `02-sidebar.png`, `08-sidebar-top.png`, `33-end-sidebar-top.png`, `70-scout-demo.png`, `83-emailer-takeover.png`.

### Footer and account menu

| Element | Observation | OpenBot disposition | Evidence |
| --- | --- | --- | --- |
| Plugins row | Plug icon plus `Plugins`, pinned above the account row. | Visible v1 exception, opens honest coming-soon state. | `07-account-plugins.png` |
| Account row | Avatar and account name at the bottom. | Replace or adapt to App Settings and Lock or Log out needs. | `07-account-plugins.png` |
| Plan usage | `SuperGrok Heavy` with percentage. | **Exclude** unless OpenBot later has a real equivalent. | `38-sidebar-context-menu.png` |
| Mobile app promotion | `Get Grok Bot for iOS`. | **Exclude** without a real OpenBot mobile product. | `38-sidebar-context-menu.png` |
| Settings | Gear row. | Adopt as App Settings. | `38-sidebar-context-menu.png` |
| About | Information row. | Adopt when About content exists. | `38-sidebar-context-menu.png` |
| Help Center | Help row. | Render only with a real destination. | `38-sidebar-context-menu.png` |
| Send Feedback | Feedback row. | Render only with a real destination. | `38-sidebar-context-menu.png` |
| Log out | Separated destructive-session action. | Adapt to Lock or Log out according to authentication behavior. | `38-sidebar-context-menu.png` |

## 3. Chat header

| Element | Observation | OpenBot disposition | Evidence |
| --- | --- | --- | --- |
| Bot Eyes and name | Compact identity at the left of the Chat header. | Opens Bot information. | `06-header.png` |
| Computer monitor | Monitor icon appears when the information pane is collapsed. | Toggles the selected Bot's Computer pane. | `24-newbot-info-no-mic.png`, `63-scout.png` |
| Bot settings gear | Gear in the expanded right-pane header. | Opens Bot Settings. | `05-right-pane.png`, `25-agent-gear.png` |
| Pane collapse | Double-chevron control collapses the right pane. | Adopt with accessible label and remembered preference. | `05-right-pane.png` |
| Technical selectors | GrokBot does not make provider or execution config the dominant header content. | Keep Harness and config in Bot Settings. | `06-header.png` |

## 4. Transcript chronology and message anatomy

### Text messages

| Element | Observation | OpenBot disposition | Evidence |
| --- | --- | --- | --- |
| Incoming bubble | Left-aligned light-gray rounded bubble with dark text. | Adopt semantic incoming tokens. | `03-thread.png` |
| Outgoing bubble | Right-aligned near-black rounded bubble with white text. | Adopt semantic outgoing tokens. | `03-thread.png` |
| Natural width | Bubble fits content up to a readable maximum rather than filling the row. | Adopt. | `03-thread.png`, `22-new-bot-after-wait.png` |
| Short multi-bubble reply | One Bot Turn can visibly contain several separate complete bubbles. | Preserve one ACP `messageId` per bubble. | `03-thread.png`, user-provided current OpenBot screenshot |
| Links | Blue inline links inside light bubbles. | Allow safe links with clear hover and focus. | `03-thread.png`, `83-emailer-takeover.png` |
| Time separator | Quiet centered `Today 4:03 PM` or similar chronology label. | **OpenBot adaptation:** one localized day separator, with exact message time on demand. | `11-new-agent.png`, `20-openbot-chat.png` |
| New divider | Blue horizontal rule with centered `NEW`. | Catalog for unread-position behavior; implement only with durable unread position. | `70-scout-demo.png` |
| Cross-Bot handoff label | Centered `Messaged {Eyes} {Bot}` and `Message from {Eyes} {Bot}`. | Catalog for future Groups or Bot-to-Bot routing. | `01-main-messenger.png`, `70-scout-demo.png` |
| Working copy | Pink Eyes plus `{bot} is working` under messages. | **OpenBot adaptation:** animated Eyes only; phrase on hover, focus, and accessibility API. | `01-main-messenger.png`, `79-pre-slash.png` |
| Speech tail | GrokBot bubbles are rounded blocks without a strong iMessage tail in the captured baseline. | **OpenBot adaptation:** only the final text bubble in a same-sender burst has a tail. | GrokBot captures plus user-provided iMessage and Telegram references |

### Bubble actions and reactions

| Element | Observation | OpenBot disposition | Evidence |
| --- | --- | --- | --- |
| Hover toolbar | Small white bordered pill next to the active bubble. | Show on hover and focus desktop; long-press phone. | `10-hover-bot.png`, `37-hover-bot-bubble.png`, `46-hover-user-bubble.png` |
| Incoming action order | React, Reply, More. | Adopt only functional actions; omit More until populated. | `10-hover-bot.png`, `37-hover-bot-bubble.png` |
| Outgoing action order | More, Reply, React. | Adopt only functional actions. | `46-hover-user-bubble.png` |
| Reaction picker | Emoji reactions attach to a specific bubble. | Adopt persistent tapbacks per message. | `10-hover-bot2.png`, `10-hover-user.png` |
| Reply affordance | Back-arrow reply icon in hover toolbar. | Opens composer quote preview. | `37-hover-bot-bubble.png`, `47-hover-bot-reply.png` |
| Reply presentation | Reference supports reply metadata without replacing chronological flow. | Use flat timeline plus compact quote, not nested mini-threads. | `47-hover-bot-reply.png` |

## 5. Transcript Cards and structured items

These are distinct transcript objects, not bubble styles:

| Card or item | Observed anatomy | OpenBot disposition | Evidence |
| --- | --- | --- | --- |
| File chip | Type icon, filename, size, rounded outline, download action. CSV and PDF are visible; notes also record Markdown. | Product Card, no speech tail. | `70-scout-demo.png` |
| Image card | Image preview with its own bounds. | Product Card or attachment, no speech tail. | `70-scout-demo.png` |
| Computer screenshot | Thumbnail of the Bot's Screen in the transcript. | Product Card, expandable or opens Computer when functional. | `70-scout-demo.png`, `83-emailer-takeover.png` |
| Diagram or widget | Small Mermaid-like flow `text → files → shot → widget`. | Product Card with accessible textual alternative. | `70-scout-demo.png` |
| Option prompt | Prompt title, close control, rows labeled A/B/C, each row independently actionable. | Product Card when options are real. | `70-scout-demo.png` |
| Completed option | Selected row with checkmark. | Persist resolved state in history. | `83-emailer-takeover.png` |
| Deep-link dialog | Title, explanation, route code field, source code field, close, Done. | Dialog pattern, not ordinary message text. | `28-modal.png` |
| Permission or approval family | Human-facing question and explicit actions rather than raw tool payload. | Product Card. | `83-emailer-takeover.png`, live walk notes |
| Connector or secret family | Reference walk identified connector and secret-request card types. | Catalog only until OpenBot owns the capability and secure flow. | live walk notes |
| Computer Done | `Computer`, green `Done`, instruction, `Open computer`. | Persist resolved needs-you history. | `83-emailer-takeover.png` |
| Computer Action needed | `Computer`, orange `Action needed`, instruction, screenshot, primary takeover/open action, `I'm done`, and `Skip`. | Adapt label to `Open computer`; no separate Takeover mode. | `83-emailer-takeover.png` |

Cards never receive speech tails. Status and actions remain understandable without color. Raw ACP data, internal logs, and tool JSON remain outside the human Transcript.

## 6. Composer and anchored pickers

### Resting composer

Observed left-to-right anatomy:

1. Plus icon button.
2. Mention button or typed `@` entry.
3. Bot-specific text placeholder such as `Message New Bot`.
4. Microphone.
5. Round Send arrow after text is present.

The composer is a full-width rounded pill at the bottom of the Chat. OpenBot preserves the order but renders optional controls only when they work. Text and Send remain the essential pair.

Evidence: `04-composer.png`, `04-input-bar.png`, `32-composer-openbot.png`, `41-composer-attach.png`.

### Plus menu

| Element | Observation | OpenBot disposition | Evidence |
| --- | --- | --- | --- |
| Attach files | Paperclip icon and text row in a compact anchored menu. | Render when attachment upload works. | `39-composer-plus.png`, `41-composer-attach.png` |
| Teach a task | Record-like icon and text row. | Catalog for a future demonstrated-task capability. | `39-composer-plus.png`, `41-composer-attach.png` |

### Mention picker

| Element | Observation | OpenBot disposition | Evidence |
| --- | --- | --- | --- |
| Trigger | Mention button and typing `@`. | Render only when mentions route to real members or plugins. | `15-mention-at.png`, `15-mention-btn.png` |
| Anchored results | Popover above composer with highlighted row. | Use searchable command-style list. | `15-mention-picker.png`, `36-mention-picker.png` |
| Bot rows | Eyes, Bot name, `Bot` type label. | Future Groups or cross-Bot messaging. | `36-mention-picker.png`, `52-mentions.png` |
| Plugin rows | Plugin name, connection state, `Plugin` type label. | Post-v1 real Plugins only. | `36-mention-picker.png` |
| Empty copy | `Nothing to mention yet` exists as a catalog string. | Use only if the picker itself is functional. | inspected reference strings |

### Slash picker

| Element | Observation | OpenBot disposition | Evidence |
| --- | --- | --- | --- |
| Trigger | Typing `/` opens an anchored picker. | Render when skills or actions can execute. | `79-pre-slash.png`, `80-slash-skills.png` |
| Skill row | Cube icon, skill name, truncated description, `Skill` type. | Future capability. | `80-slash-skills.png`, `81-slash-skills-scrolled.png` |
| Action row | Shortcut icon, action label, contextual description, `Action` type. | Future capability. | `80-slash-skills.png` |
| Scroll | Picker supports longer result sets. | Adopt if shipped. | `81-slash-skills-scrolled.png`, `81b-slash-after-wheel.png` |
| Filter | Typed query reduces the list. | Adopt if shipped. | `82-slash-filter.png` |
| Clear | Clearing query restores ordinary composer. | Adopt if shipped. | `83-slash-cleared.png` |

### Voice mode

Observed states from the live walk:

- microphone control;
- `Listening…` copy;
- square stop control;
- elapsed timer beginning at `0:00`;
- Escape dismissal.

OpenBot catalogs these states but does not reserve dead UI. Evidence: live walk notes and composer captures.

## 7. New Bot and create surfaces

| Element | Observation | OpenBot disposition | Evidence |
| --- | --- | --- | --- |
| Top Plus | Main pointer entry to creation. | Opens compact create menu. | `08-sidebar-top.png` |
| Create picker heading | `To: Search or create Bots`. | Reference evidence only. | `48-newbot-picker.png` |
| Create new row | Plus icon and `Create new` or `Create new Bot`. | OpenBot menu label is `New Bot`. | `20-new-bot-cmd-n.png`, `21-create-new-bot.png`, `48-newbot-picker.png`, `49-create-new-bot.png` |
| Existing Bot rows | Searchable teammate list below create action. | Belongs to future recipient or Group selection, not basic New Bot. | `48-newbot-picker.png` |
| Keyboard hints | `Tab add` and Return `open` hints in the picker. | Catalog for keyboard-complete command surfaces. | `48-newbot-picker.png` |
| Placeholder Bot lifecycle | Reference can open `New Bot` immediately and onboard conversationally. | **OpenBot adaptation:** naming Dialog first, then durable Bot and direct Chat. | `11-new-agent.png`, `13-new-agent-after-send.png` |
| Onboarding bubbles | Two short Bot-written questions establish purpose. | OpenBot may use chat-native onboarding after creation. | `11-new-agent.png` |
| Bot-specific composer | `Message New Bot`. | Adopt selected-Bot placeholder. | `11-new-agent.png`, `22-new-bot-after-wait.png` |
| New Group | Catalogued familiar create-menu action from supplemental references. | Hide until group messaging works. | user-provided GrokBot and Telegram create-menu references |

## 8. Command palette and global navigation

| Element | Observation | OpenBot disposition | Evidence |
| --- | --- | --- | --- |
| Centered palette | Rounded elevated panel over a dimmed application. | `CommandDialog`. | `30-cmdk.png`, `32-cmd-k-palette.png`, `32-cmdk.png` |
| Search | First focused field. | Adopt. | `30-cmdk.png` |
| Tabs | All, Messages, Bots, Groups, Files, Links, Routines, Actions. | Render only searchable types that exist. | `30-cmdk.png`, `32-cmd-k-palette.png` |
| Result row | Eyes or icon, title, optional preview, type at right, selected neutral fill. | Adopt. | `32-cmd-k-palette.png`, `63-scout.png` |
| Query state | Results filter by typed text such as `Skills`, `Connectors`, `Groups`, or a Bot name. | Adopt when indexes exist. | `33-cmdk-skills-search.png`, `34-cmdk-connectors.png`, `35-cmdk-groups.png`, `67-palette-openbot-query.png` |
| Empty or hidden query | `Hidden` did not produce a dedicated Hidden manager. | Do not infer a feature from the draft text. | `31-cmdk-hidden.png`, `34-cmdk-hidden.png`, `56-palette-hidden.png` |
| Escape close | Palette closes back to its prior surface. | Adopt with focus restoration. | `31-cmdk.png`, `34-cmdk-hidden.png`, `56-palette-hidden.png` |

## 9. App Settings reference inventory

### Settings shell

- centered modal overlay with dimmed background;
- left section navigation or compact tab rail;
- title for the active section;
- close button at top-right;
- scrollable content where needed;
- grouped muted panels;
- rows separated by thin rules;
- label and description at left, control at right;
- native-feeling select, switch, button, progress, input, and table treatments;
- deep-linkable sections in the reference product.

Evidence: `10-settings-general-modal.png`, `13-settings-usage-modal.png`, `15-settings-updates-modal.png`, `17-settings-security-modal.png`, `19-settings-computers-modal.png`, `21-settings-cookies-modal.png`.

OpenBot uses the shell pattern, not the reference information architecture. Its App Settings sections are Appearance, Computer, Security, and About. Bot-specific rows move to Bot Settings.

### General, all observed rows

| Group | Element | Observation |
| --- | --- | --- |
| Account | identity | avatar, name, email, copy control |
| Account | Sign Out | right-aligned button |
| Appearance | Theme | Follow System select |
| Appearance | Language | Follow System select |
| System | Microphone | System Default select |
| System | hardware acceleration | switch |
| Bot | Timezone | auto-detected region select |
| Bot | Execution on Local Computer | permission select plus explanation |
| Bot | Auto-review | switch plus explanation |
| Auto-review Rules | rule sentence input | `When Grok Bot wants to:` free text |
| Auto-review Rules | behavior | `It should:` select |
| Auto-review Rules | Add Rule | disabled until input is valid |
| Auto-review Rules | table | Action and Behavior columns |
| Auto-review Rules | row actions | edit and delete icons |
| Auto-review Rules | scope note | rules apply only to the user; built-in safety remains |
| Security Key | hardware key | switch plus approval explanation |

Evidence: `09-settings-theme.png`, `10-settings-general.png`, `10-settings-general-modal.png`, `16-settings-security-keys.png`, `17-settings-security-modal.png`, `30-settings-general-full.png`.

### Usage and Billing, all observed rows

| Element | Observation | OpenBot disposition |
| --- | --- | --- |
| Plan name | `SuperGrok Heavy`. | Exclude without equivalent. |
| Usage percentage | progress bar and reset date. | Exclude without equivalent. |
| On-demand usage | amount and reset date. | Exclude without equivalent. |
| On-Demand panel | explanation and `Open Cursor Dashboard`. | Exclude. |

Evidence: `12-settings-usage.png`, `13-settings-usage-billing.png`, `13-settings-usage-modal.png`, `21-settings-usage.png`, `22-settings-updates.png` where the filename does not match the visible section.

### Updates, all observed rows

| Group | Element | Observation |
| --- | --- | --- |
| Grok Bot Updates | Update Track | Stable select plus explanatory copy |
| Grok Bot Updates | version | version number, current status, `Check for Updates` |
| Computer | update | explanation, disabled while any agent works, `Update` |
| Computer | reset | consequence copy, red `Reset` |

Evidence: `12-settings-updates-url.png`, `14-settings-updates.png`, `15-settings-updates-modal.png`, `17-settings-updates.png`, `18-settings-updates.png`, `23-settings-updates.png`.

### Deep-linked or secondary settings observations

- Theme: `grokbot://app/v1/settings?id=theme`.
- Usage or plan: `id=plan`.
- Computer update: `id=update-computer`.
- Security keys: `id=security-keys`.
- Computers and Cookies were captured as secondary setting routes in `18-settings-computers.png`, `19-settings-computers-modal.png`, `20-settings-cookies.png`, and `21-settings-cookies-modal.png`.

The visible 0.24.0 top-level tabs were General, Usage & Billing, and Updates. Templates was not a visible tab. Do not turn a filename or deep-link route into a required OpenBot navigation item.

## 10. Bot information and Computer

### Bot information pane

| Element | Observation | OpenBot disposition | Evidence |
| --- | --- | --- | --- |
| Screen preview | Thumbnail labeled `{bot}'s screen`. | Becomes the selected Bot's Computer preview. | `05-right-pane.png`, `23-newbot-info-pane.png`, `31-computer-preview.png`, `49-info-pane-full.png` |
| Preview open | Clicking thumbnail or monitor opens larger stage. | Adopt as `Open computer`; already interactive, no Takeover state. | `29-computer-preview-click.png`, `50-full-computer.png` |
| Routines heading | Dedicated subsection. | Catalog only until routines work. | `05-right-pane.png`, `49-info-pane-full.png` |
| Routines empty copy | `Routines are recurring tasks this Bot runs on a schedule.` | Catalog only. | `05-right-pane.png` |
| Create Routine | Button in empty state. | Hide until functional. | `05-right-pane.png` |
| Pane gear | Bot settings entry. | Adopt. | `05-right-pane.png`, `25-agent-gear.png` |
| Collapse | Double-chevron. | Adopt. | `05-right-pane.png` |
| Channels and Members | **Not found** in the pane. | Do not infer these headings from product strings. | live walk notes |

### Full Computer

Observed states and controls:

- larger Computer stage;
- `starting desktop` loading state;
- live XFCE or browser Screen;
- Escape return;
- `Teach a task` top-right control in one reference state.

OpenBot adopts the stage and return behavior. `Teach a task` remains catalog-only. Evidence: `50-full-computer.png`, `51-computer-after-start.png`, `63-scout.png`.

## 11. Plugins, Skills, and marketplace

### Entry and shell

- sidebar footer `Plugins` entry with plug icon;
- `Cmd+Shift+M` Plugins shortcut;
- `Cmd+Shift+W` Skills shortcut, opening the same overlay family;
- centered large modal with scrim and close button;
- title `Plugins`;
- installed plugin icons;
- `4 installed · 26 private >` summary;
- `Search plugins` field;
- scrollable content.

Evidence: `07-account-plugins.png`, `25-plugins-hotkey.png`, `27-plugins-skills.png`, `30-plugins-cmd-shift-m.png`, `31-skills-cmd-shift-w.png`, `40-plugins.png`, `41-plugins-installed.png`.

### Category chips, all observed labels

All, Featured, Agent Orchestration, Canvas, Customer Support, Data Analytics, Design, Finance And Legal, Inbox And Collaboration, Infrastructure, MCP, Payments, Productivity, Research, Sales, Scheduling.

### Listing anatomy

- section heading and optional `View all`;
- two-column item grid in the wide modal;
- product icon;
- product name;
- one-line description;
- `Add` action;
- green check and `Added` state;
- category grouping.

Observed examples:

- Featured: Gmail, Google Drive, Google Calendar, Granola;
- Agent Orchestration: Arize, Atlan, AWS Agents, AWS SageMaker;
- Canvas: Docs Canvas, PR Review Canvas.

Evidence: `25-plugins-hotkey.png`, `40-plugins.png`, `41-plugins-installed.png`, `45-plugin-gmail.png`, `46-plugin-gmail-detail.png`.

The private-skills list behind `26 private >` was not cleanly opened. A distinct full Skills marketplace was not confirmed. Search via the global command palette can surface Plugins actions and message hits, as shown in `33-cmdk-skills-search.png` and `34-cmdk-connectors.png`.

**OpenBot v1 disposition:** preserve only a sidebar destination and polished `Plugins are coming soon` empty state. Everything else in this section remains post-v1 catalog evidence until backed by real plugin data and actions.

## 12. Modals, menus, focus, and feedback

Observed shared patterns:

- anchored action menus for compact command lists;
- centered dialogs for blocking detail or forms;
- command dialogs for searchable navigation;
- dimmed scrim behind modal surfaces;
- rounded white surface with modest shadow;
- top-right Close for dismissible large dialogs;
- primary action at bottom-right where a dialog has a completion step;
- selected rows use a neutral fill;
- disabled actions remain visually distinct;
- Escape closes exploratory overlays and returns to the prior state;
- search input receives initial focus;
- browser or system security-key request uses its own native-feeling modal with Deny and Approve.

The security-key request is host or platform behavior. OpenBot must not imitate it as ordinary application chrome. It may invoke a real secure flow when needed. Evidence: `28-modal.png`, `30-cmdk.png`, `35-after-deny.png`, `16-settings-security-keys.png`.

## 13. Keyboard and deep-link inventory

| Action | Observed reference shortcut | OpenBot disposition |
| --- | --- | --- |
| Jump to palette | `Cmd+K` | `Cmd/Ctrl+K` |
| Settings | `Cmd+,` | Adopt when App Settings exists |
| New Bot | `Cmd+N` | **Exclude** in PWA; browser owns it |
| Toggle information pane | `Cmd+Shift+I`, also `Cmd+Alt+B` | Optional, document if implemented |
| Toggle Bot settings | `Cmd+Shift+,` | Optional, document if implemented |
| Plugins | `Cmd+Shift+M` | Do not bind until useful |
| Skills | `Cmd+Shift+W` | Do not bind until useful |
| Focus composer | `Cmd+I` or `Cmd+L` | Avoid browser conflicts; choose only after testing |
| Send | `Cmd+Enter` in reference | OpenBot uses Enter, Shift+Enter newline |
| Close overlay | Escape | Adopt |

Observed custom routes include `grokbot://app/v1/open`, settings routes, and `grokbot://app/v1/info?topic=deep-links`. OpenBot may use ordinary PWA URLs for deep linking; it does not need to copy the custom scheme.

## 14. Searched but not confirmed

The following must remain explicitly unresolved rather than being inferred:

- Templates settings tab: not present in the visible tab set.
- Accent color picker: not present in General Appearance.
- Channels and Members in the Bot information pane: not visible.
- dedicated Hidden Bots or hidden Chats manager: not opened.
- private-skills list behind `26 private >`: not cleanly opened.
- clean Bot gear subpage for avatar, name, description, or instructions: not captured.
- Bot row right-click menu with Delete or shared-room actions: click path was attempted, menu not confirmed.

Catalog strings such as `Hidden Bots`, `Show Hidden Bots`, `Open Hidden Bots`, `Nothing to mention yet`, and `botTemplates` are **Observed string**, not proof of a complete surface.

## 15. Accepted OpenBot adaptations

These are deliberate improvements or domain corrections, not missed parity:

| Reference baseline | OpenBot decision |
| --- | --- |
| Computer or information pane visible in many wide captures | collapsed by default, remembered per Bot in local browser preferences |
| persistent `{bot} is working` copy | animated Working Eyes, phrase on hover, focus, and accessibility API only |
| rounded message blocks | iMessage-style grouped bursts, tail only on final same-sender text bubble |
| reference create-picker lifecycle | Plus dropdown, New Bot naming Dialog, create after valid name, open direct Chat |
| `Cmd+N` New Bot | no browser-conflicting binding; Plus and `Cmd/Ctrl+K` cover creation |
| GrokBot settings categories | OpenBot App Settings and Bot Settings ownership |
| visible full Plugins marketplace | honest coming-soon empty state only in v1 |
| `Take over` wording in Computer Card | `Open computer`; opening is already interactive |
| visible technical or reference-product business rows | progressive disclosure; render only real OpenBot behavior |
| light-only captured reference | semantic light and dark modes ship together |
| native Electron title chrome | no fake native chrome inside the PWA |

## 16. Canonical evidence index

Use these focused files before opening repeated full-window captures:

| Area | Canonical files |
| --- | --- |
| whole messenger | `01-main-messenger.png`, `09-grokbot-window.png`, `33-end-window.png` |
| sidebar | `02-sidebar.png`, `07-account-plugins.png`, `08-sidebar-top.png`, `33-end-sidebar-top.png` |
| transcript | `03-thread.png`, `20-openbot-chat.png`, `70-scout-demo.png`, `83-emailer-takeover.png` |
| composer | `04-composer.png`, `04-input-bar.png`, `32-composer-openbot.png`, `41-composer-attach.png` |
| header | `06-header.png` |
| right pane and Computer | `05-right-pane.png`, `31-computer-preview.png`, `49-info-pane-full.png`, `50-full-computer.png`, `51-computer-after-start.png` |
| bubble hover actions | `10-hover-bot.png`, `37-hover-bot-bubble.png`, `46-hover-user-bubble.png`, `47-hover-bot-reply.png` |
| New Bot | `11-new-agent.png`, `13-new-agent-after-send.png`, `48-newbot-picker.png`, `49-create-new-bot.png` |
| mentions | `15-mention-picker.png`, `36-mention-picker.png`, `52-mentions.png`, `54-mentions-at.png` |
| slash skills and actions | `79-pre-slash.png`, `80-slash-skills.png`, `81-slash-skills-scrolled.png`, `82-slash-filter.png`, `83-slash-cleared.png` |
| command palette | `30-cmdk.png`, `32-cmd-k-palette.png`, `33-cmdk-skills-search.png`, `34-cmdk-connectors.png`, `35-cmdk-groups.png` |
| Settings General | `10-settings-general-modal.png`, `30-settings-general-full.png` |
| Settings Usage | `13-settings-usage-modal.png` |
| Settings Updates | `15-settings-updates-modal.png` |
| Settings security | `17-settings-security-modal.png` |
| Plugins | `25-plugins-hotkey.png`, `40-plugins.png`, `41-plugins-installed.png`, `46-plugin-gmail-detail.png` |
| account menu | `38-sidebar-context-menu.png` |
| small dialog | `28-modal.png` |

The `00-d2-*`, `00-display2-full.png`, and `70-d1.png` or `70-d2-now.png` files include full-display or cross-application context. They may help reconstruct exploration chronology but are excluded from canonical visual evidence and must not be committed or used as product-content examples.

## Completion rule

An element is not missing from this catalog merely because OpenBot hides it in v1. It is missing only if a distinct observed control, state, menu row, card type, shortcut, settings row, navigation surface, or empty state from the reference set cannot be found above. When new reference evidence is added, update the relevant section and label its evidence boundary before filing or implementing a ticket.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { appearanceSettingsRequested } from "../src/lib/app-settings.ts";
import {
  CHAT_DRAFTS_KEY,
  acceptOrderedSnapshots,
  buildChatInbox,
  canAcknowledgeChatRead,
  chatSurfaceIsVisible,
  filterChatInbox,
  formatRelativeActivityTime,
  inboxAnnouncement,
  inboxEyesMode,
  listSnapshotIsCurrent,
  mergeInboxSnapshots,
  observedActivityAfterRead,
  parseChatDrafts,
  readChatDrafts,
  reserveSnapshotRequest,
  resolveSnapshotMembership,
  setChatDraft,
  shouldRestoreFailedDraft,
  writeChatDrafts,
} from "../src/lib/chat-inbox.ts";

const activity = (latestText: string | null, lastActivityAt: string, unread = false) => ({
  latestText,
  lastActivityAt,
  unread,
  cursor: { sequence: 1, revision: 1 },
});

const bot = (overrides: Record<string, unknown> = {}) => ({
  id: "ada",
  name: "Ada",
  eyes: { color: "#ff3b5c", shape: "capsule", mode: "idle" as const },
  write: false,
  permission: null,
  needsYou: null,
  activity: activity("Latest safe reply", "2026-08-27T10:00:00.000Z"),
  ...overrides,
});

describe("Chat inbox read model", () => {
  test("marks read only while the Chat surface is actually visible", () => {
    assert.equal(chatSurfaceIsVisible({
      route: "chat",
      desktop: false,
      mobileSurface: "chat",
      computerVisible: false,
      documentVisible: true,
      blockingDialog: false,
    }), true);
    assert.equal(chatSurfaceIsVisible({
      route: "chat",
      desktop: false,
      mobileSurface: "chat",
      computerVisible: true,
      documentVisible: true,
      blockingDialog: false,
    }), false);
    assert.equal(chatSurfaceIsVisible({
      route: "chat",
      desktop: true,
      mobileSurface: "chat",
      computerVisible: true,
      documentVisible: true,
      blockingDialog: false,
    }), true);
    assert.equal(chatSurfaceIsVisible({
      route: "chat",
      desktop: true,
      mobileSurface: "chat",
      computerVisible: false,
      documentVisible: true,
      blockingDialog: true,
    }), false);
  });

  test("does not acknowledge unread activity hidden by Settings, including a cold deep link", () => {
    const visibleUnread = {
      hasTranscript: true,
      unread: true,
      surfaceVisible: true,
      active: true,
    };

    assert.equal(canAcknowledgeChatRead({
      ...visibleUnread,
      blockingDialog: true,
      openingBlockingDialog: false,
    }), false);
    assert.equal(canAcknowledgeChatRead({
      ...visibleUnread,
      blockingDialog: false,
      openingBlockingDialog: true,
    }), false);
    assert.equal(canAcknowledgeChatRead({
      ...visibleUnread,
      blockingDialog: false,
      openingBlockingDialog: false,
    }), true);
    assert.equal(appearanceSettingsRequested("#settings/appearance"), true);
    assert.equal(appearanceSettingsRequested("#bots/ada/settings/ai"), false);
  });

  test("uses exactly Waiting for you, unread, Working, then ordinary priority", () => {
    const waiting = buildChatInbox({
      bots: [bot({ permission: { title: "Allow?", options: [] }, write: true, activity: activity("one", "2026-08-27T10:00:00.000Z", true) })],
      channels: [],
      drafts: {},
    })[0];
    assert.equal(waiting?.signal, "waiting");

    const unread = buildChatInbox({
      bots: [bot({ write: true, activity: activity("two", "2026-08-27T10:00:00.000Z", true) })],
      channels: [],
      drafts: {},
    })[0];
    assert.equal(unread?.signal, "unread");

    const working = buildChatInbox({
      bots: [bot({ write: true })],
      channels: [],
      drafts: {},
    })[0];
    assert.equal(working?.signal, "working");

    const ordinary = buildChatInbox({ bots: [bot()], channels: [], drafts: {} })[0];
    assert.equal(ordinary?.signal, null);
    assert.equal(ordinary?.preview, "Latest safe reply");
  });

  test("derives Eyes from the winning signal so unread and Waiting never also animate Working", () => {
    assert.equal(inboxEyesMode("waiting", "write"), "needs-you");
    assert.equal(inboxEyesMode("unread", "work"), "idle");
    assert.equal(inboxEyesMode("working", "write"), "write");
    assert.equal(inboxEyesMode(null, "sleep"), "sleep");
  });

  test("shows a browser draft distinctly without replacing its safe transcript preview", () => {
    const row = buildChatInbox({
      bots: [bot()],
      channels: [],
      drafts: { "bot:ada": "  meet at ten\nplease  " },
    })[0];
    assert.equal(row?.draftPreview, "meet at ten please");
    assert.equal(row?.preview, "Latest safe reply");
    assert.equal(row?.signal, null);
  });

  test("maps group Chats, sorts by recent activity, and excludes non-group Channels", () => {
    const rows = buildChatInbox({
      bots: [bot()],
      channels: [
        {
          id: "group-1",
          kind: "group" as const,
          title: "Build room",
          createdAt: "2026-08-27T09:00:00.000Z",
          members: [
            { kind: "user" as const, id: "you", name: "You" },
            { kind: "bot" as const, id: "ada", name: "Ada", eyes: { color: "#f00", shape: "capsule", mode: "idle" } },
          ],
          activity: activity("newer group note", "2026-08-27T11:00:00.000Z"),
        },
        {
          id: "hidden",
          kind: "bot-to-bot" as const,
          title: "Hidden",
          createdAt: "2026-08-27T12:00:00.000Z",
          members: [],
          activity: activity("secret", "2026-08-27T12:00:00.000Z"),
        },
      ],
      drafts: {},
    });
    assert.deepEqual(rows.map((row) => row.key), ["channel:group-1", "bot:ada"]);
  });

  test("searches only visible names and the preview currently shown in each row", () => {
    const rows = buildChatInbox({
      bots: [bot(), bot({ id: "bob", name: "Bob", activity: activity("Ship the release", "2026-08-27T09:00:00.000Z") })],
      channels: [],
      drafts: { "bot:bob": "private draft keyword" },
    });
    assert.deepEqual(filterChatInbox(rows, "ada").map((row) => row.id), ["ada"]);
    assert.deepEqual(filterChatInbox(rows, "RELEASE"), []);
    assert.deepEqual(filterChatInbox(rows, "draft keyword").map((row) => row.id), ["bob"]);
    assert.deepEqual(filterChatInbox(rows, "   "), rows);
  });

  test("announces only concise incoming or priority state changes after initial render", () => {
    const initial = buildChatInbox({ bots: [bot()], channels: [], drafts: {} });
    assert.equal(inboxAnnouncement(null, initial), null);
    const unread = buildChatInbox({
      bots: [bot({ activity: activity("A new reply", "2026-08-27T10:01:00.000Z", true) })],
      channels: [],
      drafts: {},
    });
    assert.equal(inboxAnnouncement(initial, unread), "Ada: Unread");
    const next = buildChatInbox({
      bots: [bot({ activity: activity("Another reply", "2026-08-27T10:02:00.000Z") })],
      channels: [],
      drafts: {},
    });
    assert.equal(inboxAnnouncement(unread, next), "Ada: New message");
    assert.equal(inboxAnnouncement(next, next), null);
  });

  test("keeps every simultaneous Chat change in one live announcement", () => {
    const initial = buildChatInbox({
      bots: [bot(), bot({ id: "bob", name: "Bob", activity: activity("Ready", "2026-08-27T09:00:00.000Z") })],
      channels: [],
      drafts: {},
    });
    const updated = buildChatInbox({
      bots: [
        bot({ activity: activity("Ada update", "2026-08-27T10:01:00.000Z", true) }),
        bot({ id: "bob", name: "Bob", activity: activity("Bob update", "2026-08-27T10:02:00.000Z", true) }),
      ],
      channels: [],
      drafts: {},
    });

    assert.equal(inboxAnnouncement(initial, updated), "Bob: Unread. Ada: Unread");
  });

  test("merges inbox snapshots without regressing cursors, read state, or local creations", () => {
    const current = [
      {
        id: "ada",
        detail: "keep",
        activity: { ...activity("Newest", "2026-08-27T10:02:00.000Z"), cursor: { sequence: 2, revision: 1 } },
      },
      { id: "new-bot", detail: "local", activity: activity(null, "2026-08-27T10:01:00.000Z") },
    ];
    const older = [{
      id: "ada",
      detail: "summary",
      activity: { ...activity("Older", "2026-08-27T10:00:00.000Z", true), cursor: { sequence: 1, revision: 1 } },
    }];

    const merged = mergeInboxSnapshots(current, older);
    assert.deepEqual(merged.map((row) => row.id), ["ada", "new-bot"]);
    assert.equal(merged[0]?.activity.latestText, "Newest");
    assert.equal(merged[0]?.activity.unread, false);
    assert.equal(merged[0]?.detail, "keep");

    const equalCursorUnread = mergeInboxSnapshots(current.slice(0, 1), [{
      ...older[0]!,
      activity: { ...current[0]!.activity, unread: true },
    }]);
    assert.equal(equalCursorUnread[0]?.activity.unread, false);
  });

  test("rejects an older runtime snapshot after a newer equal-cursor Waiting state", () => {
    const applied = new Map<string, number>();
    const waiting = bot({ permission: { title: "Allow?", options: [] } });
    const staleOrdinary = bot();

    assert.deepEqual(acceptOrderedSnapshots(applied, [waiting], 2), [waiting]);
    assert.deepEqual(acceptOrderedSnapshots(applied, [staleOrdinary], 1), []);
    assert.equal(buildChatInbox({ bots: [waiting], channels: [], drafts: {} })[0]?.signal, "waiting");
    assert.deepEqual(acceptOrderedSnapshots(applied, [staleOrdinary], 3), [staleOrdinary]);
  });

  test("keeps complete startup membership when one listed Bot already has a newer detail", () => {
    const listedAda = bot();
    const listedBob = bot({ id: "bob", name: "Bob" });
    const newerAda = bot({
      permission: { title: "Allow?", options: [] },
      messages: [],
    });
    const latest = new Map([
      ["ada", newerAda],
      ["bob", listedBob],
    ]);

    const resolved = resolveSnapshotMembership([listedAda, listedBob], [listedBob], latest);
    assert.deepEqual(resolved.map((row) => row.id), ["ada", "bob"]);
    assert.equal(resolved[0]?.permission, newerAda.permission);
    assert.deepEqual(resolved[0]?.messages, []);
  });

  test("reserves mutation ownership before responses can complete out of order", async () => {
    let sequence = 0;
    let finishFirst: (value: ReturnType<typeof bot>) => void = () => undefined;
    let finishSecond: (value: ReturnType<typeof bot>) => void = () => undefined;
    const firstResponse = new Promise<ReturnType<typeof bot>>((resolve) => {
      finishFirst = resolve;
    });
    const secondResponse = new Promise<ReturnType<typeof bot>>((resolve) => {
      finishSecond = resolve;
    });
    const first = reserveSnapshotRequest(() => ++sequence, () => firstResponse);
    const second = reserveSnapshotRequest(() => ++sequence, () => secondResponse);
    const newer = bot({ permission: { title: "Allow?", options: [] } });
    const older = bot();

    finishSecond(newer);
    const secondResult = await second;
    finishFirst(older);
    const firstResult = await first;

    assert.equal(firstResult.sequence, 1);
    assert.equal(secondResult.sequence, 2);
    const applied = new Map<string, number>();
    assert.deepEqual(acceptOrderedSnapshots(applied, [secondResult.snapshot], secondResult.sequence), [newer]);
    assert.deepEqual(acceptOrderedSnapshots(applied, [firstResult.snapshot], firstResult.sequence), []);
  });

  test("rejects an initial Channel list after a newer inbox list owns loading state", () => {
    assert.equal(listSnapshotIsCurrent(0, 2), true);
    assert.equal(listSnapshotIsCurrent(2, 1), false);
    assert.equal(listSnapshotIsCurrent(2, 2), true);
  });

  test("a read response cannot advance the active transcript beyond what was rendered", () => {
    const observed = activity("Rendered reply", "2026-08-27T10:00:00.000Z", true);
    const raced = {
      ...activity("Unseen later reply", "2026-08-27T10:01:00.000Z", true),
      cursor: { sequence: 2, revision: 1 },
    };
    assert.deepEqual(observedActivityAfterRead(observed, raced), observed);
    assert.deepEqual(observedActivityAfterRead(observed, { ...raced, unread: false }), observed);
    assert.deepEqual(
      observedActivityAfterRead({ ...observed, unread: false }, { ...raced, unread: false }),
      { ...observed, unread: true },
    );

    const newerObserved = {
      ...activity("Rendered later reply", "2026-08-27T10:02:00.000Z", true),
      cursor: { sequence: 2, revision: 1 },
    };
    const delayedRead = {
      ...activity("Older reply", "2026-08-27T10:01:00.000Z", false),
      cursor: { sequence: 1, revision: 1 },
    };
    assert.deepEqual(observedActivityAfterRead(newerObserved, delayedRead), newerObserved);
    assert.deepEqual(
      observedActivityAfterRead(newerObserved, { ...newerObserved, unread: false }),
      { ...newerObserved, unread: false },
    );
  });

  test("formats localized relative activity time", () => {
    const now = new Date("2026-08-27T12:00:00.000Z");
    assert.equal(formatRelativeActivityTime("2026-08-27T11:58:00.000Z", now, "en"), "2 minutes ago");
    assert.equal(formatRelativeActivityTime("2026-08-26T12:00:00.000Z", now, "en"), "yesterday");
    assert.equal(formatRelativeActivityTime("not-a-date", now, "en"), "");
  });
});

describe("browser-local Chat drafts", () => {
  test("parses only non-empty string drafts and updates one Chat without touching another", () => {
    assert.deepEqual(parseChatDrafts(null), {});
    assert.deepEqual(parseChatDrafts("not json"), {});
    assert.deepEqual(
      parseChatDrafts(JSON.stringify({ "bot:ada": "hello", "bot:bob": 3, bad: "" })),
      { "bot:ada": "hello" },
    );
    const initial = { "bot:ada": "hello", "bot:bob": "keep" };
    assert.deepEqual(setChatDraft(initial, "bot:ada", "changed"), {
      "bot:ada": "changed",
      "bot:bob": "keep",
    });
    assert.deepEqual(setChatDraft(initial, "bot:ada", ""), { "bot:bob": "keep" });
  });

  test("reads and writes one localStorage key and fails closed when storage is blocked", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem(key: string) {
        return values.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        values.set(key, value);
      },
    };
    const drafts = { "bot:ada": "hello" };
    assert.equal(writeChatDrafts(storage, drafts), true);
    assert.equal(values.has(CHAT_DRAFTS_KEY), true);
    assert.deepEqual(readChatDrafts(storage), drafts);

    const blocked = {
      getItem() {
        throw new Error("blocked");
      },
      setItem() {
        throw new Error("blocked");
      },
    };
    assert.deepEqual(readChatDrafts(blocked), {});
    assert.equal(writeChatDrafts(blocked, drafts), false);
  });

  test("restores a failed send only while that Chat draft has not been replaced", () => {
    assert.equal(shouldRestoreFailedDraft(4, 4), true);
    assert.equal(shouldRestoreFailedDraft(5, 4), false);
  });
});

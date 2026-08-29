import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { describe, test } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Computer } from "../src/lib/session.ts";

const PHONE_WIDTH = 390;
const DESKTOP_WIDTH = 1280;
const LIVE_RETRY_WIDTH = 98.6015625;
const RETRY_HEIGHT = 32;
const NOTICE_GAP = 16;
const NOTICE_TEXT_LINE_HEIGHT = 20;
const NOTICE_TEXT_INLINE_WIDTH = 260;

function activeClasses(className: string, viewportWidth: number): Set<string> {
  const active = new Set<string>();
  for (const token of className.split(/\s+/u).filter(Boolean)) {
    const maxWidth = token.match(/^max-\[(\d+(?:\.\d+)?)rem\]:(.+)$/u);
    if (maxWidth) {
      if (viewportWidth <= Number(maxWidth[1]) * 16) active.add(maxWidth[2]!);
      continue;
    }
    if (token.startsWith("sm:")) {
      if (viewportWidth >= 640) active.add(token.slice(3));
      continue;
    }
    active.add(token);
  }
  return active;
}

function widthFromClasses(classes: Set<string>, viewportWidth: number): number {
  if (classes.has("w-full")) return viewportWidth;
  throw new Error(`rendered width class is unsupported: ${[...classes].join(" ")}`);
}

function horizontalPadding(classes: Set<string>): number {
  if (classes.has("px-3") || classes.has("p-3")) return 12;
  if (classes.has("px-6")) return 24;
  return 0;
}

function classesForTestId(markup: string, testId: string): string {
  const tag = tagForTestId(markup, testId);
  const className = tag.match(/\bclass="([^"]*)"/u)?.[1];
  assert.ok(className, `missing rendered classes for ${testId}`);
  return className;
}

function tagForTestId(markup: string, testId: string): string {
  const tag = markup.match(new RegExp(`<[^>]+data-testid="${testId}"[^>]*>`, "u"))?.[0];
  assert.ok(tag, `missing rendered element ${testId}`);
  return tag;
}

function classesForRole(markup: string, role: string): string {
  const tag = markup.match(new RegExp(`<[^>]+role="${role}"[^>]*>`, "u"))?.[0];
  assert.ok(tag, `missing rendered role ${role}`);
  const className = tag.match(/\bclass="([^"]*)"/u)?.[1];
  assert.ok(className, `missing rendered classes for role ${role}`);
  return className;
}

function hasBooleanAttribute(tag: string, attribute: string): boolean {
  return new RegExp(`\\s${attribute}(?:=""|(?=\\s|>))`, "u").test(tag);
}

function stackingLevel(className: string): number {
  const levels = [...className.matchAll(/(?:^|\s)z-(\d+)(?=\s|$)/gu)]
    .map((match) => Number(match[1]));
  return levels.length > 0 ? Math.max(...levels) : 0;
}

function dispatchTopmostPointer(actions: Array<{
  className: string;
  documentOrder: number;
  onClick: () => void;
}>): void {
  const target = actions.toSorted((left, right) => {
    const stacking = stackingLevel(right.className) - stackingLevel(left.className);
    return stacking !== 0 ? stacking : right.documentOrder - left.documentOrder;
  })[0];
  assert.ok(target, "rendered pointer target is missing");
  target.onClick();
}

function renderedButtonAction(node: React.ReactNode, label: string): () => void {
  if (!React.isValidElement(node)) throw new Error(`missing rendered ${label} action`);
  const props = node.props as {
    children?: React.ReactNode;
    onClick?: () => void;
  };
  if (props.children === label && typeof props.onClick === "function") return props.onClick;
  for (const child of React.Children.toArray(props.children)) {
    try {
      return renderedButtonAction(child, label);
    } catch {
      // Keep walking the real rendered component tree until the named action is found.
    }
  }
  throw new Error(`missing rendered ${label} action`);
}

function renderedTestAction(node: React.ReactNode, testId: string): () => void {
  if (!React.isValidElement(node)) throw new Error(`missing rendered ${testId} action`);
  const props = node.props as {
    children?: React.ReactNode;
    "data-testid"?: string;
    onClick?: () => void;
  };
  if (props["data-testid"] === testId && typeof props.onClick === "function") return props.onClick;
  for (const child of React.Children.toArray(props.children)) {
    try {
      return renderedTestAction(child, testId);
    } catch {
      // Keep walking the real rendered component tree until the named action is found.
    }
  }
  throw new Error(`missing rendered ${testId} action`);
}

async function renderResponsiveSeam(
  onRetry = () => undefined,
  onOpen = () => undefined,
): Promise<{
  messenger: string;
  notice: string;
  preview: string;
  retryAction: () => void;
  openAction: () => void;
}> {
  const aliases = new Map([
    ["@/components/ui/button", "../src/components/ui/button.tsx"],
    ["@/components/ui/separator", "../src/components/ui/separator.tsx"],
    ["@/lib/async-state", "../src/lib/async-state.ts"],
    ["@/lib/computer-zoom", "../src/lib/computer-zoom.ts"],
    ["@/lib/session", "../src/lib/session.ts"],
    ["@/lib/utils", "../src/lib/utils.ts"],
  ]);
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      const alias = aliases.get(specifier);
      if (alias) return nextResolve(new URL(alias, import.meta.url).href, context);
      return nextResolve(specifier, context);
    },
  });
  const originalReact = Object.getOwnPropertyDescriptor(globalThis, "React");
  Object.defineProperty(globalThis, "React", { configurable: true, value: React });

  try {
    const cacheKey = `responsive-${Date.now()}-${Math.random()}`;
    const computerUrl = new URL("../src/components/Computer.tsx", import.meta.url);
    computerUrl.searchParams.set("responsive-harness", cacheKey);
    const shellUrl = new URL("../src/components/MessengerShell.tsx", import.meta.url);
    shellUrl.searchParams.set("responsive-harness", cacheKey);
    const { ComputerScreenStateNotice, SelectedBotComputerPreview } = await import(computerUrl.href) as typeof import(
      "../src/components/Computer.tsx"
    );
    const { MessengerShell } = await import(shellUrl.href) as typeof import(
      "../src/components/MessengerShell.tsx"
    );
    const unavailable: Computer = {
      path: null,
      ready: false,
      botId: "Recovery",
      screenState: "unavailable",
      screenAttempt: "failed-prepare-attempt",
      screenError: {
        stage: "prepare",
        code: "SCREEN_ATTACHMENT_FAILED",
        message: "Screen attachment failed during prepare.",
      },
      screenCleanupError: null,
      ownership: "unknown",
      ownershipEpoch: "responsive-epoch",
      write: null,
      viewOnly: null,
      zoom: false,
      display: 2,
    };
    const notice = ComputerScreenStateNotice({
      computer: unavailable,
      expanded: false,
      retrying: false,
      onClose: () => undefined,
      onRetry,
    });
    const preview = SelectedBotComputerPreview({
      botName: "Recovery",
      triggerRef: { current: null },
      onOpen,
      children: notice,
    });
    const messenger = React.createElement(MessengerShell, {
      sidebar: React.createElement("p", null, "Chats"),
      chat: React.createElement("p", null, "Chat"),
      chatRef: { current: null },
      computer: React.createElement("div", { className: "p-4" }, preview),
      desktopLayout: false,
      mobileSurface: "chat",
    });
    return {
      messenger: renderToStaticMarkup(messenger),
      notice: renderToStaticMarkup(notice),
      preview: renderToStaticMarkup(preview),
      retryAction: renderedButtonAction(preview, "Retry Screen"),
      openAction: renderedTestAction(preview, "open-computer-preview"),
    };
  } finally {
    hooks.deregister();
    if (originalReact) Object.defineProperty(globalThis, "React", originalReact);
    else Reflect.deleteProperty(globalThis, "React");
  }
}

describe("Computer responsive PWA", () => {
  test("collapsed unavailable preview routes the visible Retry interaction above Open Computer", async () => {
    let retryInteractions = 0;
    let openInteractions = 0;
    const rendered = await renderResponsiveSeam(
      () => { retryInteractions += 1; },
      () => { openInteractions += 1; },
    );
    const noticeClasses = classesForRole(rendered.preview, "status");
    const openClasses = classesForTestId(rendered.preview, "open-computer-preview");
    assert.match(noticeClasses, /(?:^|\s)absolute(?:\s|$)/u);
    assert.match(noticeClasses, /(?:^|\s)inset-0(?:\s|$)/u);
    assert.match(openClasses, /(?:^|\s)absolute(?:\s|$)/u);
    assert.match(openClasses, /(?:^|\s)inset-0(?:\s|$)/u);

    dispatchTopmostPointer([
      {
        className: noticeClasses,
        documentOrder: 0,
        onClick: rendered.retryAction,
      },
      {
        className: openClasses,
        documentOrder: 1,
        onClick: rendered.openAction,
      },
    ]);

    assert.equal(retryInteractions, 1, "the visible Retry Screen action receives the interaction exactly once");
    assert.equal(openInteractions, 0, "the covering preview action must not steal Retry Screen input");

    dispatchTopmostPointer([{
      className: openClasses,
      documentOrder: 0,
      onClick: rendered.openAction,
    }]);
    assert.equal(openInteractions, 1, "a ready preview still opens Computer through its ordinary overlay");
  });

  test("390px unavailable Screen has no horizontal overflow and keeps Retry fully reachable", async () => {
    const rendered = await renderResponsiveSeam();
    const rootPhone = activeClasses(classesForTestId(rendered.messenger, "messenger"), PHONE_WIDTH);
    const sidebarTag = tagForTestId(rendered.messenger, "sidebar-region");
    const chatTag = tagForTestId(rendered.messenger, "chat-region");
    const selectedTag = tagForTestId(rendered.messenger, "selected-bot-region");
    const selectedClasses = classesForTestId(rendered.messenger, "selected-bot-region");
    const selectedPhone = activeClasses(selectedClasses, PHONE_WIDTH);
    const selectedWidth = widthFromClasses(selectedPhone, PHONE_WIDTH);
    const panelPadding = 16;
    const previewWidth = selectedWidth - panelPadding * 2;
    const previewHeight = previewWidth * 10 / 16;
    const documentScrollWidth = selectedWidth;

    const noticePadding = horizontalPadding(activeClasses(classesForRole(rendered.notice, "status"), PHONE_WIDTH));
    const statusCard = {
      left: panelPadding,
      right: panelPadding + previewWidth,
    };
    const retryCenter = (statusCard.left + statusCard.right) / 2;
    const retry = {
      left: retryCenter - LIVE_RETRY_WIDTH / 2,
      right: retryCenter + LIVE_RETRY_WIDTH / 2,
    };
    const noticeLines = Math.ceil(
      NOTICE_TEXT_INLINE_WIDTH / (previewWidth - noticePadding * 2),
    );
    const noticeHeight = noticeLines * NOTICE_TEXT_LINE_HEIGHT + NOTICE_GAP + RETRY_HEIGHT;
    const retryVertical = {
      top: (previewHeight - noticeHeight) / 2 + noticeLines * NOTICE_TEXT_LINE_HEIGHT + NOTICE_GAP,
      bottom: (previewHeight - noticeHeight) / 2 + noticeHeight,
    };

    assert.match(rendered.notice, /Screen attachment failed during prepare\./u);
    const retryButton = rendered.notice.match(/<button\b[^>]*>Retry Screen<\/button>/u)?.[0];
    assert.ok(retryButton);
    assert.doesNotMatch(rendered.notice, /<iframe\b/u);
    assert.doesNotMatch(retryButton, /\sdisabled(?:=|\s|>)/u);
    assert.equal(hasBooleanAttribute(sidebarTag, "hidden"), true);
    assert.equal(hasBooleanAttribute(chatTag, "hidden"), true);
    assert.equal(hasBooleanAttribute(selectedTag, "hidden"), false);
    assert.equal(selectedWidth, PHONE_WIDTH, "the selected-Bot surface owns the phone viewport");

    const failures: string[] = [];
    if (documentScrollWidth > PHONE_WIDTH) {
      failures.push(`document scrollWidth ${documentScrollWidth}px exceeds ${PHONE_WIDTH}px viewport`);
    }
    if (statusCard.left < 0 || statusCard.right > PHONE_WIDTH) {
      failures.push(`status card ${statusCard.left}..${statusCard.right}px leaves the viewport`);
    }
    if (retry.left < 0 || retry.right > PHONE_WIDTH) {
      failures.push(`Retry Screen ${retry.left}..${retry.right}px is not fully reachable`);
    }
    if (retryVertical.top < 0 || retryVertical.bottom > previewHeight) {
      failures.push(`Retry Screen ${retryVertical.top}..${retryVertical.bottom}px is vertically clipped`);
    }
    if (!rootPhone.has("flex")) failures.push("Messenger shell lost its bounded flex layout");
    assert.deepEqual(failures, []);

    const selectedDesktop = activeClasses(selectedClasses, DESKTOP_WIDTH);
    assert.equal(selectedDesktop.has("w-full"), false);
    assert.ok(selectedDesktop.has("w-[min(var(--computer-pane-width),28vw)]"));
  });
});

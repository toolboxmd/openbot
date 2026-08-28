import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, test } from "node:test";
import {
  buildCommandPaletteActions,
  commandPaletteAnnouncement,
  commandPaletteResults,
  commandPaletteShortcutMatches,
  executeCommandPaletteResult,
  moveCommandPaletteSelection,
  restoreCommandPaletteFocus,
} from "../src/components/command-palette-state.ts";
import type { ChatInboxRow } from "../src/lib/chat-inbox.ts";

function shortcutEvent({
  key = "k",
  metaKey = false,
  ctrlKey = false,
  altKey = false,
  shiftKey = false,
  target = { tagName: "BUTTON", isContentEditable: false },
  defaultPrevented = false,
  isComposing = false,
}: {
  key?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  target?: unknown;
  defaultPrevented?: boolean;
  isComposing?: boolean;
}) {
  return {
    key,
    metaKey,
    ctrlKey,
    altKey,
    shiftKey,
    target,
    defaultPrevented,
    isComposing,
  };
}

describe("command palette shortcut", () => {
  test("uses the platform primary modifier without taking browser-owned shortcuts", () => {
    assert.equal(commandPaletteShortcutMatches(shortcutEvent({ metaKey: true }), "MacIntel"), true);
    assert.equal(commandPaletteShortcutMatches(shortcutEvent({ ctrlKey: true }), "MacIntel"), false);
    assert.equal(commandPaletteShortcutMatches(shortcutEvent({ ctrlKey: true }), "Linux x86_64"), true);
    assert.equal(commandPaletteShortcutMatches(shortcutEvent({ metaKey: true }), "Linux x86_64"), false);
    assert.equal(commandPaletteShortcutMatches(shortcutEvent({ key: "N", metaKey: true }), "MacIntel"), false);
    assert.equal(commandPaletteShortcutMatches(shortcutEvent({ key: "n", ctrlKey: true }), "Linux x86_64"), false);
  });

  test("opens from app-owned editable focus while respecting event ownership", () => {
    assert.equal(commandPaletteShortcutMatches(shortcutEvent({ metaKey: true }), "MacIntel"), true);
    assert.equal(commandPaletteShortcutMatches(shortcutEvent({ metaKey: true, shiftKey: true }), "MacIntel"), false);
    assert.equal(commandPaletteShortcutMatches(shortcutEvent({ metaKey: true, altKey: true }), "MacIntel"), false);
    assert.equal(commandPaletteShortcutMatches(shortcutEvent({ metaKey: true, defaultPrevented: true }), "MacIntel"), false);
    assert.equal(commandPaletteShortcutMatches(shortcutEvent({ metaKey: true, isComposing: true }), "MacIntel"), false);

    for (const tagName of ["INPUT", "TEXTAREA", "SELECT"]) {
      assert.equal(
        commandPaletteShortcutMatches(shortcutEvent({
          metaKey: true,
          target: { tagName, isContentEditable: false },
        }), "MacIntel"),
        true,
      );
    }
    assert.equal(
      commandPaletteShortcutMatches(shortcutEvent({
        metaKey: true,
        target: { tagName: "DIV", isContentEditable: true },
      }), "MacIntel"),
      true,
    );
    assert.equal(
      commandPaletteShortcutMatches(shortcutEvent({
        metaKey: true,
        target: {
          tagName: "SPAN",
          isContentEditable: false,
          closest: () => ({ role: "textbox" }),
        },
      }), "MacIntel"),
      true,
    );
  });
});

const chats: ChatInboxRow[] = [
  {
    key: "bot:ada",
    kind: "bot",
    id: "ada",
    name: "Ada",
    preview: "Urgent launch notes",
    draftPreview: "Draft plan",
    signal: null,
    activityAt: "2026-08-28T10:00:00.000Z",
  },
  {
    key: "channel:design",
    kind: "group",
    id: "design",
    name: "Design room",
    preview: "Review the mockup",
    draftPreview: null,
    signal: "unread",
    activityAt: "2026-08-28T09:00:00.000Z",
  },
];

describe("command palette results", () => {
  test("gates actions to backing capabilities and the current selected Bot", () => {
    const globalOnly = buildCommandPaletteActions({
      newBot: true,
      appSettings: true,
      plugins: true,
      selectedBot: null,
    });
    assert.deepEqual(globalOnly.map((action) => action.id), ["new-bot", "app-settings", "plugins"]);

    const selected = buildCommandPaletteActions({
      newBot: true,
      appSettings: true,
      plugins: true,
      selectedBot: {
        id: "ada",
        name: "Ada",
        settings: true,
        computer: true,
      },
    });
    assert.deepEqual(selected.map((action) => action.id), [
      "new-bot",
      "app-settings",
      "bot-settings",
      "plugins",
      "computer",
    ]);
    assert.deepEqual(
      selected.filter((action) => action.botId).map((action) => action.botId),
      ["ada", "ada"],
    );
    assert.doesNotMatch(
      JSON.stringify(selected),
      /group|marketplace|attachment|microphone|mention|slash|provider|model|fallback|account|billing|update/i,
    );
  });

  test("filters real Chats by the same visible identity as the inbox", () => {
    const actions = buildCommandPaletteActions({
      newBot: true,
      appSettings: true,
      plugins: true,
      selectedBot: null,
    });
    assert.deepEqual(
      commandPaletteResults({ chats, actions, query: "ada" }).map((result) => result.id),
      ["chat:bot:ada"],
    );
    assert.deepEqual(
      commandPaletteResults({ chats, actions, query: "draft plan" }).map((result) => result.id),
      ["chat:bot:ada"],
    );
    assert.deepEqual(
      commandPaletteResults({ chats, actions, query: "review the mockup" }).map((result) => result.id),
      ["chat:channel:design"],
    );
    assert.deepEqual(
      commandPaletteResults({ chats, actions, query: "settings" }).map((result) => result.id),
      ["action:app-settings"],
    );
    assert.deepEqual(commandPaletteResults({ chats, actions, query: "model" }), []);
    assert.deepEqual(
      commandPaletteResults({ chats, actions, query: "" }).map((result) => result.id),
      [
        "action:new-bot",
        "action:app-settings",
        "action:plugins",
        "chat:bot:ada",
        "chat:channel:design",
      ],
    );
  });

  test("wraps keyboard movement and announces result counts calmly", () => {
    assert.equal(moveCommandPaletteSelection(0, -1, 3), 2);
    assert.equal(moveCommandPaletteSelection(2, 1, 3), 0);
    assert.equal(moveCommandPaletteSelection(1, 1, 3), 2);
    assert.equal(moveCommandPaletteSelection(0, 1, 0), -1);
    assert.equal(commandPaletteAnnouncement(0), "No results.");
    assert.equal(commandPaletteAnnouncement(1), "1 result.");
    assert.equal(commandPaletteAnnouncement(5), "5 results.");
  });

  test("routes one result through injected canonical actions and fails stale Bot context closed", () => {
    const actions = buildCommandPaletteActions({
      newBot: true,
      appSettings: true,
      plugins: true,
      selectedBot: {
        id: "ada",
        name: "Ada",
        settings: true,
        computer: true,
      },
    });
    const results = commandPaletteResults({ chats, actions, query: "" });
    const calls: string[] = [];
    const handlers = {
      openChat: (chat: ChatInboxRow) => calls.push(`chat:${chat.id}`),
      newBot: () => calls.push("new-bot"),
      appSettings: () => calls.push("app-settings"),
      botSettings: (botId: string) => calls.push(`bot-settings:${botId}`),
      plugins: () => calls.push("plugins"),
      computer: (botId: string) => calls.push(`computer:${botId}`),
    };

    const newBot = results.find((result) => result.id === "action:new-bot");
    const adaChat = results.find((result) => result.id === "chat:bot:ada");
    const botSettings = results.find((result) => result.id === "action:bot-settings");
    const computer = results.find((result) => result.id === "action:computer");
    assert.ok(newBot && adaChat && botSettings && computer);
    assert.equal(executeCommandPaletteResult(newBot, "ada", handlers), true);
    assert.equal(executeCommandPaletteResult(adaChat, "ada", handlers), true);
    assert.equal(executeCommandPaletteResult(botSettings, "ben", handlers), false);
    assert.equal(executeCommandPaletteResult(computer, "ben", handlers), false);
    assert.deepEqual(calls, ["new-bot", "chat:ada"]);
  });
});

function runPwaRender(script: string): string {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, TSX_TSCONFIG_PATH: resolve("pwa/tsconfig.json") },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function probeRenderedCommandPaletteEscape() {
  return JSON.parse(runPwaRender(`
    class TestEvent {
      constructor(type, init = {}) {
        this.type = type;
        this.bubbles = init.bubbles ?? false;
        this.cancelable = init.cancelable ?? false;
        this.defaultPrevented = false;
        this.cancelBubble = false;
        this.eventPhase = 0;
        this.target = init.target ?? null;
        this.currentTarget = null;
        Object.assign(this, init);
      }
      preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
      stopPropagation() { this.cancelBubble = true; }
    }

    class TestKeyboardEvent extends TestEvent {
      constructor(type, init = {}) {
        super(type, { bubbles: true, cancelable: true, ...init });
        this.key = init.key ?? "";
        this.metaKey = Boolean(init.metaKey);
        this.ctrlKey = Boolean(init.ctrlKey);
        this.altKey = Boolean(init.altKey);
        this.shiftKey = Boolean(init.shiftKey);
        this.isComposing = Boolean(init.isComposing);
      }
    }

    class TestCustomEvent extends TestEvent {
      constructor(type, init = {}) {
        super(type, init);
        this.detail = init.detail;
      }
    }

    function invokeListeners(target, event, capture, phase) {
      event.currentTarget = target;
      event.eventPhase = phase;
      for (const item of [...(target.listeners?.get(event.type) ?? [])]) {
        if (item.capture !== capture) continue;
        if (typeof item.listener === "function") item.listener.call(target, event);
        else item.listener.handleEvent(event);
        if (item.once) target.removeEventListener(event.type, item.listener, { capture });
      }
    }

    class TestEventTarget {
      constructor() { this.listeners = new Map(); }
      addEventListener(type, listener, options) {
        if (!listener) return;
        const capture = options === true || Boolean(options?.capture);
        const listeners = this.listeners.get(type) ?? [];
        listeners.push({ listener, capture, once: Boolean(options?.once) });
        this.listeners.set(type, listeners);
      }
      removeEventListener(type, listener, options) {
        const capture = options === true || Boolean(options?.capture);
        this.listeners.set(
          type,
          (this.listeners.get(type) ?? []).filter(
            (item) => item.listener !== listener || item.capture !== capture,
          ),
        );
      }
      dispatchEvent(event) {
        if (!(event instanceof TestEvent)) throw new Error("Expected a DOM event");
        if (!event.target) event.target = this;
        const path = [];
        let node = this;
        while (node) {
          path.push(node);
          node = node.parentNode ?? null;
        }
        for (let index = path.length - 1; index >= 1 && !event.cancelBubble; index -= 1) {
          invokeListeners(path[index], event, true, 1);
        }
        if (!event.cancelBubble) {
          invokeListeners(path[0], event, true, 2);
          invokeListeners(path[0], event, false, 2);
        }
        if (event.bubbles) {
          for (let index = 1; index < path.length && !event.cancelBubble; index += 1) {
            invokeListeners(path[index], event, false, 3);
          }
        }
        event.currentTarget = null;
        event.eventPhase = 0;
        return !event.defaultPrevented;
      }
    }

    class TestStyle {
      setProperty(name, value) { this[name] = String(value); }
      removeProperty(name) { delete this[name]; }
      getPropertyValue(name) { return this[name] ?? ""; }
    }

    class TestNode extends TestEventTarget {
      static ELEMENT_NODE = 1;
      static TEXT_NODE = 3;
      static DOCUMENT_NODE = 9;
      static DOCUMENT_POSITION_CONTAINED_BY = 16;
      static DOCUMENT_POSITION_CONTAINS = 8;

      constructor(nodeType, ownerDocument = null) {
        super();
        this.nodeType = nodeType;
        this.ownerDocument = ownerDocument;
        this.parentNode = null;
        this.childNodes = [];
      }
      appendChild(node) {
        if (node.nodeType === 11) {
          for (const child of [...node.childNodes]) this.appendChild(child);
          return node;
        }
        if (node.parentNode) node.parentNode.removeChild(node);
        this.childNodes.push(node);
        node.parentNode = this;
        return node;
      }
      insertBefore(node, before) {
        if (before == null) return this.appendChild(node);
        const index = this.childNodes.indexOf(before);
        if (index < 0) throw new Error("Reference node is not a child");
        if (node.parentNode) node.parentNode.removeChild(node);
        this.childNodes.splice(index, 0, node);
        node.parentNode = this;
        return node;
      }
      removeChild(node) {
        const index = this.childNodes.indexOf(node);
        if (index < 0) throw new Error("Node is not a child");
        this.childNodes.splice(index, 1);
        node.parentNode = null;
        return node;
      }
      contains(node) {
        let candidate = node;
        while (candidate) {
          if (candidate === this) return true;
          candidate = candidate.parentNode;
        }
        return false;
      }
      compareDocumentPosition(node) {
        if (this.contains(node)) return TestNode.DOCUMENT_POSITION_CONTAINED_BY;
        if (node?.contains?.(this)) return TestNode.DOCUMENT_POSITION_CONTAINS;
        return 0;
      }
      getRootNode() {
        let node = this;
        while (node.parentNode) node = node.parentNode;
        return node;
      }
      get firstChild() { return this.childNodes[0] ?? null; }
      get lastChild() { return this.childNodes.at(-1) ?? null; }
      get children() { return this.childNodes.filter((node) => node.nodeType === 1); }
      get firstElementChild() { return this.children[0] ?? null; }
      get lastElementChild() { return this.children.at(-1) ?? null; }
      get parentElement() { return this.parentNode?.nodeType === 1 ? this.parentNode : null; }
      get nextSibling() {
        if (!this.parentNode) return null;
        const index = this.parentNode.childNodes.indexOf(this);
        return this.parentNode.childNodes[index + 1] ?? null;
      }
      get previousSibling() {
        if (!this.parentNode) return null;
        const index = this.parentNode.childNodes.indexOf(this);
        return this.parentNode.childNodes[index - 1] ?? null;
      }
      get nextElementSibling() {
        let node = this.nextSibling;
        while (node && node.nodeType !== 1) node = node.nextSibling;
        return node;
      }
      get previousElementSibling() {
        let node = this.previousSibling;
        while (node && node.nodeType !== 1) node = node.previousSibling;
        return node;
      }
      get textContent() {
        return this.nodeType === 3
          ? this.nodeValue
          : this.childNodes.map((node) => node.textContent).join("");
      }
      set textContent(value) {
        for (const child of this.childNodes) child.parentNode = null;
        this.childNodes = [];
        if (value !== "" && value != null) {
          this.appendChild(this.ownerDocument.createTextNode(String(value)));
        }
      }
    }

    class TestText extends TestNode {
      constructor(value, ownerDocument) {
        super(3, ownerDocument);
        this.nodeName = "#text";
        this.nodeValue = String(value);
      }
    }

    function descendants(root) {
      const matches = [];
      for (const child of root.childNodes ?? []) {
        if (child.nodeType === 1) matches.push(child);
        matches.push(...descendants(child));
      }
      return matches;
    }

    function focusable(element) {
      return !element.disabled
        && element.getAttribute("type") !== "hidden"
        && (
          ["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(element.tagName)
          || (element.tagName === "A" && element.hasAttribute("href"))
          || (element.hasAttribute("tabindex") && element.tabIndex !== -1)
        );
    }

    class TestElement extends TestNode {
      constructor(name, ownerDocument, namespaceURI = "http://www.w3.org/1999/xhtml") {
        super(1, ownerDocument);
        this.nodeName = name.toUpperCase();
        this.tagName = this.nodeName;
        this.localName = name.toLowerCase();
        this.namespaceURI = namespaceURI;
        this.attributes = new Map();
        this.style = new TestStyle();
        this.value = "";
        this.checked = false;
        this.disabled = false;
        this.type = "";
        this.name = "";
        this._tabIndex = 0;
      }
      setAttribute(name, value) {
        const normalized = String(value);
        this.attributes.set(name, normalized);
        if (name === "tabindex") this._tabIndex = Number(normalized);
        if (name === "disabled") this.disabled = true;
        if (name === "type") this.type = normalized;
        if (name === "name") this.name = normalized;
        if (name === "value") this.value = normalized;
      }
      getAttribute(name) { return this.attributes.get(name) ?? null; }
      removeAttribute(name) {
        this.attributes.delete(name);
        if (name === "disabled") this.disabled = false;
      }
      hasAttribute(name) { return this.attributes.has(name); }
      toggleAttribute(name, force) {
        if (force === false) {
          this.removeAttribute(name);
          return false;
        }
        this.setAttribute(name, "");
        return true;
      }
      get tabIndex() { return this._tabIndex; }
      set tabIndex(value) {
        this._tabIndex = Number(value);
        this.attributes.set("tabindex", String(value));
      }
      get id() { return this.getAttribute("id") ?? ""; }
      set id(value) { this.setAttribute("id", value); }
      get className() { return this.getAttribute("class") ?? ""; }
      set className(value) { this.setAttribute("class", value); }
      get isConnected() { return this.ownerDocument?.contains(this) ?? false; }
      focus() {
        const previous = this.ownerDocument.activeElement;
        if (previous === this) return;
        if (previous) {
          previous.dispatchEvent(new TestEvent("focusout", {
            bubbles: true,
            target: previous,
            relatedTarget: this,
          }));
        }
        this.ownerDocument.activeElement = this;
        this.dispatchEvent(new TestEvent("focusin", {
          bubbles: true,
          target: this,
          relatedTarget: previous,
        }));
      }
      blur() {
        if (this.ownerDocument.activeElement !== this) return;
        const next = this.ownerDocument.body;
        this.dispatchEvent(new TestEvent("focusout", {
          bubbles: true,
          target: this,
          relatedTarget: next,
        }));
        this.ownerDocument.activeElement = next;
        next.dispatchEvent(new TestEvent("focusin", {
          bubbles: true,
          target: next,
          relatedTarget: this,
        }));
      }
      click() {
        this.focus();
        this.dispatchEvent(new TestEvent("click", {
          bubbles: true,
          cancelable: true,
          target: this,
        }));
      }
      attachEvent() {}
      detachEvent() {}
      insertAdjacentElement(position, element) {
        if (position === "afterbegin") return this.insertBefore(element, this.firstChild);
        if (position === "beforeend") return this.appendChild(element);
        throw new Error("Unsupported insertAdjacentElement position: " + position);
      }
      remove() { this.parentNode?.removeChild(this); }
      querySelectorAll(selector) {
        const elements = descendants(this);
        if (selector.includes("input:not") || selector.includes("button:not") || selector.includes("[tabindex]")) {
          return elements.filter(focusable);
        }
        if (selector === "[aria-hidden]") return elements.filter((element) => element.hasAttribute("aria-hidden"));
        if (selector === "[data-radix-focus-guard]") {
          return elements.filter((element) => element.hasAttribute("data-radix-focus-guard"));
        }
        return elements.filter((element) => element.matches(selector));
      }
      querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
      matches(selector) {
        if (selector.startsWith("#")) return this.id === selector.slice(1);
        if (selector.startsWith("[")) {
          const match = selector.match(/^\\[([^=\\]]+)(?:=["']?([^\\]"']+)["']?)?\\]$/);
          if (!match) return false;
          return match[2] === undefined
            ? this.hasAttribute(match[1])
            : this.getAttribute(match[1]) === match[2];
        }
        return this.tagName === selector.toUpperCase();
      }
      closest(selector) {
        let node = this;
        while (node?.nodeType === 1) {
          if (node.matches(selector)) return node;
          node = node.parentNode;
        }
        return null;
      }
      getBoundingClientRect() {
        return {
          x: 0,
          y: 0,
          left: 0,
          top: 0,
          right: 100,
          bottom: 30,
          width: 100,
          height: 30,
          toJSON() { return this; },
        };
      }
      getClientRects() { return [this.getBoundingClientRect()]; }
      get offsetWidth() { return 100; }
      get offsetHeight() { return 30; }
      scrollIntoView() {}
      setPointerCapture() {}
      releasePointerCapture() {}
      hasPointerCapture() { return false; }
    }

    class TestIFrame extends TestElement {}
    class TestDocumentFragment extends TestNode {
      constructor(ownerDocument) {
        super(11, ownerDocument);
        this.nodeName = "#document-fragment";
      }
    }
    class TestDocument extends TestNode {
      constructor() {
        super(9, null);
        this.ownerDocument = this;
        this.nodeName = "#document";
        this.documentElement = new TestElement("html", this);
        this.head = new TestElement("head", this);
        this.body = new TestElement("body", this);
        this.documentElement.appendChild(this.head);
        this.documentElement.appendChild(this.body);
        this.appendChild(this.documentElement);
        this.activeElement = this.body;
        this.defaultView = null;
        this.visibilityState = "visible";
      }
      createElement(name) {
        return name.toLowerCase() === "iframe"
          ? new TestIFrame(name, this)
          : new TestElement(name, this);
      }
      createElementNS(namespaceURI, name) { return new TestElement(name, this, namespaceURI); }
      createTextNode(value) { return new TestText(value, this); }
      createDocumentFragment() { return new TestDocumentFragment(this); }
      querySelectorAll(selector) { return this.documentElement.querySelectorAll(selector); }
      querySelector(selector) { return this.documentElement.querySelector(selector); }
      getElementById(id) { return descendants(this).find((element) => element.id === id) ?? null; }
      getElementsByTagName(name) {
        const expected = name.toUpperCase();
        return descendants(this).filter((element) => element.tagName === expected);
      }
      createTreeWalker(root) {
        const elements = descendants(root);
        let index = -1;
        return {
          currentNode: root,
          nextNode() {
            index += 1;
            this.currentNode = elements[index] ?? null;
            return this.currentNode;
          },
        };
      }
      hasFocus() { return true; }
    }

    class TestObserver {
      constructor(callback) { this.callback = callback; }
      observe() {}
      unobserve() {}
      disconnect() {}
    }

    const document = new TestDocument();
    const window = new TestEventTarget();
    Object.assign(window, {
      document,
      Node: TestNode,
      Element: TestElement,
      HTMLElement: TestElement,
      HTMLIFrameElement: TestIFrame,
      HTMLInputElement: TestElement,
      HTMLTextAreaElement: TestElement,
      SVGElement: TestElement,
      DocumentFragment: TestDocumentFragment,
      Event: TestEvent,
      CustomEvent: TestCustomEvent,
      KeyboardEvent: TestKeyboardEvent,
      MutationObserver: TestObserver,
      ResizeObserver: TestObserver,
      IntersectionObserver: TestObserver,
      innerWidth: 1024,
      innerHeight: 768,
    });
    window.window = window;
    window.self = window;
    window.parentNode = null;
    window.requestAnimationFrame = (callback) => setTimeout(callback, 0);
    window.cancelAnimationFrame = clearTimeout;
    window.setTimeout = setTimeout;
    window.clearTimeout = clearTimeout;
    window.setInterval = setInterval;
    window.clearInterval = clearInterval;
    window.reportError = (error) => console.error(error?.stack ?? error);
    window.getComputedStyle = () => ({
      display: "block",
      visibility: "visible",
      overflow: "visible",
      getPropertyValue() { return ""; },
    });
    window.getSelection = () => ({
      anchorNode: null,
      anchorOffset: 0,
      focusNode: null,
      focusOffset: 0,
      rangeCount: 0,
      addRange() {},
      removeAllRanges() {},
    });
    document.getSelection = window.getSelection;
    document.defaultView = window;
    document.parentNode = window;

    Object.assign(globalThis, {
      document,
      window,
      Node: TestNode,
      Element: TestElement,
      HTMLElement: TestElement,
      HTMLIFrameElement: TestIFrame,
      HTMLInputElement: TestElement,
      HTMLTextAreaElement: TestElement,
      SVGElement: TestElement,
      DocumentFragment: TestDocumentFragment,
      Event: TestEvent,
      CustomEvent: TestCustomEvent,
      KeyboardEvent: TestKeyboardEvent,
      MouseEvent: TestEvent,
      PointerEvent: TestEvent,
      FocusEvent: TestEvent,
      EventTarget: TestEventTarget,
      MutationObserver: TestObserver,
      ResizeObserver: TestObserver,
      IntersectionObserver: TestObserver,
      getComputedStyle: window.getComputedStyle,
      requestAnimationFrame: window.requestAnimationFrame,
      cancelAnimationFrame: window.cancelAnimationFrame,
      CSS: { escape: String },
      NodeFilter: { SHOW_ELEMENT: 1, FILTER_ACCEPT: 1, FILTER_REJECT: 2 },
      reportError: window.reportError,
    });
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { userAgent: "node", platform: "MacIntel" },
    });

    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { flushSync } = await import("react-dom");
    const { CommandPalette } = await import("./pwa/src/components/CommandPalette.tsx");
    const {
      Dialog,
      DialogContent,
      DialogTitle,
      DialogTrigger,
    } = await import("./pwa/src/components/ui/dialog.tsx");
    const { TooltipProvider } = await import("./pwa/src/components/ui/tooltip.tsx");

    const control = { openChanges: [] };
    const action = {
      id: "new-bot",
      label: "New Bot",
      detail: "Create a named Bot",
      run() {},
    };

    function Harness() {
      const [open, setOpen] = React.useState(false);
      const invokerRef = React.useRef(null);
      const appFocusRef = React.useRef(null);
      React.useEffect(() => {
        control.open = open;
        control.invoker = invokerRef.current;
      });
      return React.createElement(
        TooltipProvider,
        null,
        React.createElement("button", { ref: invokerRef, "aria-label": "Palette invoker" }, "Palette invoker"),
        React.createElement("main", { ref: appFocusRef, tabIndex: -1 }, "Application"),
        React.createElement(CommandPalette, {
          open,
          enabled: true,
          chats: [],
          actions: [action],
          appFocusRef,
          onOpenChange(next) {
            control.openChanges.push(next);
            setOpen(next);
          },
          onSelect() { return false; },
        }),
      );
    }

    function role(element) {
      const explicit = element.getAttribute("role");
      if (explicit) return explicit;
      if (element.tagName === "BUTTON") return "button";
      return null;
    }

    function byRole(expectedRole, name) {
      return descendants(document).filter((element) => {
        if (role(element) !== expectedRole) return false;
        if (name === undefined) return true;
        return element.getAttribute("aria-label") === name || element.textContent.trim() === name;
      });
    }

    async function settle() {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    function dispatchKeyboard(target, key, modifiers = {}) {
      flushSync(() => {
        target.dispatchEvent(new TestKeyboardEvent("keydown", {
          key,
          target,
          ...modifiers,
        }));
      });
    }

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    flushSync(() => root.render(React.createElement(Harness)));
    await settle();

    async function runCase(surface) {
      const before = control.openChanges.length;
      control.invoker.focus();
      dispatchKeyboard(control.invoker, "k", { metaKey: true });
      await settle();
      const dialogsBefore = byRole("dialog").length;
      const target = surface === "close"
        ? byRole("button", "Close")[0]
        : surface === "combobox"
          ? byRole("combobox")[0]
          : byRole("option")[0];
      if (!target) throw new Error("Missing rendered " + surface + " focus surface");
      target.focus();
      await settle();
      const focusedBeforeEscape = document.activeElement === target;
      dispatchKeyboard(target, "Escape");
      await settle();
      return {
        surface,
        dialogsBefore,
        focusedBeforeEscape,
        dialogsAfter: byRole("dialog").length,
        focusReturned: document.activeElement === control.invoker,
        openChanges: control.openChanges.slice(before),
      };
    }

    const commandPalette = [];
    for (const surface of ["combobox", "option", "close"]) {
      commandPalette.push(await runCase(surface));
    }
    root.unmount();
    await settle();

    const sharedControl = { openChanges: [], escapeCalls: 0, veto: false };

    function SharedDialogHarness() {
      const [open, setOpen] = React.useState(false);
      const invokerRef = React.useRef(null);
      React.useEffect(() => {
        sharedControl.invoker = invokerRef.current;
      });
      return React.createElement(
        TooltipProvider,
        null,
        React.createElement(
          Dialog,
          {
            open,
            onOpenChange(next) {
              sharedControl.openChanges.push(next);
              setOpen(next);
            },
          },
          React.createElement(
            DialogTrigger,
            { asChild: true },
            React.createElement(
              "button",
              { ref: invokerRef, "aria-label": "Shared dialog invoker" },
              "Shared dialog invoker",
            ),
          ),
          React.createElement(
            DialogContent,
            {
              onEscapeKeyDown(event) {
                sharedControl.escapeCalls += 1;
                if (sharedControl.veto) event.preventDefault();
              },
            },
            React.createElement(DialogTitle, null, "Shared dialog"),
            React.createElement(
              "button",
              { "aria-label": "Shared dialog content control" },
              "Shared dialog content control",
            ),
          ),
        ),
      );
    }

    const sharedContainer = document.createElement("div");
    document.body.appendChild(sharedContainer);
    const sharedRoot = createRoot(sharedContainer);
    flushSync(() => sharedRoot.render(React.createElement(SharedDialogHarness)));
    await settle();

    async function runSharedCase(surface, veto) {
      sharedControl.veto = veto;
      const before = sharedControl.openChanges.length;
      const escapeCallsBefore = sharedControl.escapeCalls;
      sharedControl.invoker.click();
      await settle();
      const dialogsBefore = byRole("dialog").length;
      const target = surface === "close"
        ? byRole("button", "Close")[0]
        : byRole("button", "Shared dialog content control")[0];
      if (!target) throw new Error("Missing shared dialog " + surface + " focus surface");
      target.focus();
      await settle();
      const focusedBeforeEscape = document.activeElement === target;
      dispatchKeyboard(target, "Escape");
      await settle();
      const openDialog = byRole("dialog")[0];
      const result = {
        surface,
        veto,
        dialogsBefore,
        focusedBeforeEscape,
        dialogsAfter: byRole("dialog").length,
        focusReturned: document.activeElement === sharedControl.invoker,
        focusRemainsInDialog: Boolean(openDialog?.contains(document.activeElement)),
        openChanges: sharedControl.openChanges.slice(before),
        escapeCalls: sharedControl.escapeCalls - escapeCallsBefore,
      };
      if (openDialog) {
        byRole("button", "Close")[0].click();
        await settle();
      }
      return result;
    }

    const sharedDialog = [];
    for (const [surface, veto] of [
      ["content", false],
      ["close", false],
      ["content", true],
      ["close", true],
    ]) {
      sharedDialog.push(await runSharedCase(surface, veto));
    }
    sharedRoot.unmount();
    process.stdout.write(JSON.stringify({ commandPalette, sharedDialog }));
  `)) as {
    commandPalette: Array<{
      surface: "close" | "combobox" | "option";
      dialogsBefore: number;
      focusedBeforeEscape: boolean;
      dialogsAfter: number;
      focusReturned: boolean;
      openChanges: boolean[];
    }>;
    sharedDialog: Array<{
      surface: "close" | "content";
      veto: boolean;
      dialogsBefore: number;
      focusedBeforeEscape: boolean;
      dialogsAfter: number;
      focusReturned: boolean;
      focusRemainsInDialog: boolean;
      openChanges: boolean[];
      escapeCalls: number;
    }>;
  };
}

function probeCommandPaletteDialog() {
  return JSON.parse(runPwaRender(`
    import React from "react";
    import { renderToStaticMarkup } from "react-dom/server";
    import { CommandPaletteBody, CommandPaletteDialog } from "./pwa/src/components/CommandPalette.tsx";
    import { buildCommandPaletteActions, commandPaletteResults } from "./pwa/src/components/command-palette-state.ts";

    function collect(node, predicate, matches = []) {
      if (!React.isValidElement(node)) return matches;
      if (predicate(node)) matches.push(node);
      for (const child of React.Children.toArray(node.props.children)) collect(child, predicate, matches);
      return matches;
    }

    const chats = [
      {
        key: "bot:ada",
        kind: "bot",
        id: "ada",
        name: "Ada",
        preview: "Urgent launch notes",
        draftPreview: "Draft plan",
        signal: null,
        activityAt: "2026-08-28T10:00:00.000Z",
      },
    ];
    const actions = buildCommandPaletteActions({
      newBot: true,
      appSettings: true,
      plugins: true,
      selectedBot: null,
    });
    const results = commandPaletteResults({ chats, actions, query: "" });
    const active = [];
    const selected = [];
    const queries = [];
    const body = CommandPaletteBody({
      query: "",
      results,
      activeIndex: 0,
      onQueryChange(value) { queries.push(value); },
      onActiveIndexChange(index) { active.push(index); },
      onSelect(result) { selected.push(result.id); },
    });
    const emptyBody = CommandPaletteBody({
      query: "missing",
      results: [],
      activeIndex: -1,
      onQueryChange() {},
      onActiveIndexChange() {},
      onSelect() {},
    });
    const input = collect(body, (element) => element.props.role === "combobox")[0];
    function press(key) {
      let prevented = false;
      input.props.onKeyDown({ key, preventDefault() { prevented = true; } });
      return prevented;
    }
    const keys = {
      up: press("ArrowUp"),
      down: press("ArrowDown"),
      enter: press("Enter"),
      escape: press("Escape"),
    };
    input.props.onChange({ target: { value: "Ada" } });

    const openChanges = [];
    const dialog = CommandPaletteDialog({
      open: true,
      query: "",
      results,
      activeIndex: 0,
      returnFocusRef: { current: null },
      appFocusRef: { current: null },
      shouldRestoreFocusRef: { current: true },
      onOpenChange(open) { openChanges.push(open); },
      onQueryChange() {},
      onActiveIndexChange() {},
      onSelect() {},
    });
    dialog.props.onOpenChange(false);
    const content = collect(
      dialog,
      (element) => element.props["data-command-palette-content"] === true,
    )[0];
    process.stdout.write(JSON.stringify({
      markup: renderToStaticMarkup(body),
      emptyMarkup: renderToStaticMarkup(emptyBody),
      resultCount: results.length,
      active,
      selected,
      queries,
      keys,
      dialog: {
        open: dialog.props.open,
        modalIsFalse: dialog.props.modal === false,
        openChanges,
        labelledBy: content.props["aria-labelledby"],
        describedBy: content.props["aria-describedby"],
        outsideHandler: typeof content.props.onPointerDownOutside,
      },
    }));
  `)) as {
    markup: string;
    emptyMarkup: string;
    resultCount: number;
    active: number[];
    selected: string[];
    queries: string[];
    keys: { up: boolean; down: boolean; enter: boolean; escape: boolean };
    dialog: {
      open: boolean;
      modalIsFalse: boolean;
      openChanges: boolean[];
      labelledBy: string;
      describedBy: string;
      outsideHandler: string;
    };
  };
}

function probeCommandPaletteShortcutOwnership() {
  return JSON.parse(runPwaRender(`
    import React from "react";
    import { CommandPalette } from "./pwa/src/components/CommandPalette.tsx";

    class FakeHTMLElement {
      isConnected = true;
      tagName = "TEXTAREA";
      focus() {}
    }
    globalThis.HTMLElement = FakeHTMLElement;
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { platform: "MacIntel" },
    });

    const chat = {
      key: "bot:ada",
      kind: "bot",
      id: "ada",
      name: "Ada",
      preview: "Launch notes",
      draftPreview: null,
      signal: null,
      activityAt: "2026-08-28T10:00:00.000Z",
    };

    function render({ open, enabled }) {
      const activeElement = new FakeHTMLElement();
      const listeners = [];
      globalThis.document = { activeElement };
      globalThis.window = {
        addEventListener(type, listener) {
          if (type === "keydown") listeners.push(listener);
        },
        removeEventListener() {},
      };
      const effects = [];
      const stateWrites = [];
      const openChanges = [];
      let stateIndex = 0;
      const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
      const previous = internals.H;
      internals.H = {
        useState(initial) {
          const index = ++stateIndex;
          let value = index === 1 ? "Ada" : index === 2 ? 0 : initial;
          return [value, (next) => {
            value = typeof next === "function" ? next(value) : next;
            stateWrites.push({ index, value });
          }];
        },
        useRef(initial) { return { current: initial }; },
        useMemo(create) { return create(); },
        useEffect(create) { effects.push(create); },
      };
      try {
        CommandPalette({
          open,
          enabled,
          chats: [chat],
          actions: [],
          appFocusRef: { current: activeElement },
          onOpenChange(next) { openChanges.push(next); },
          onSelect() { return false; },
        });
      } finally {
        internals.H = previous;
      }
      for (const create of effects) create();
      let prevented = false;
      listeners[0]?.({
        key: "k",
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        target: activeElement,
        defaultPrevented: false,
        isComposing: false,
        preventDefault() { prevented = true; },
      });
      return { listenerCount: listeners.length, openChanges, prevented, stateWrites };
    }

    process.stdout.write(JSON.stringify({
      closedEnabled: render({ open: false, enabled: true }),
      openEnabled: render({ open: true, enabled: true }),
      closedDisabled: render({ open: false, enabled: false }),
    }));
  `)) as {
    closedEnabled: {
      listenerCount: number;
      openChanges: boolean[];
      prevented: boolean;
      stateWrites: Array<{ index: number; value: unknown }>;
    };
    openEnabled: {
      listenerCount: number;
      openChanges: boolean[];
      prevented: boolean;
      stateWrites: Array<{ index: number; value: unknown }>;
    };
    closedDisabled: {
      listenerCount: number;
      openChanges: boolean[];
      prevented: boolean;
      stateWrites: Array<{ index: number; value: unknown }>;
    };
  };
}

function probeMessengerPaletteHost() {
  return JSON.parse(runPwaRender(`
    import { MessengerCommandPalette } from "./pwa/src/components/Messenger.tsx";
    import { buildCommandPaletteActions, commandPaletteResults } from "./pwa/src/components/command-palette-state.ts";

    const chats = [{
      key: "bot:ada",
      kind: "bot",
      id: "ada",
      name: "Ada",
      preview: "Launch notes",
      draftPreview: null,
      signal: null,
      activityAt: "2026-08-28T10:00:00.000Z",
    }];
    const calls = [];
    function host(selectedBot) {
      return MessengerCommandPalette({
        open: false,
        enabled: true,
        chats,
        selectedBot,
        appFocusRef: { current: null },
        onOpenChange(open) { calls.push("palette:" + open); },
        onOpenChat(chat) { calls.push("chat:" + chat.id); },
        onNewBot() { calls.push("new-bot"); },
        onAppSettings() { calls.push("app-settings"); },
        onBotSettings(botId) { calls.push("bot-settings:" + botId); },
        onPlugins() { calls.push("plugins"); },
        onComputer(botId) { calls.push("computer:" + botId); },
      });
    }

    const selectedBot = { id: "ada", name: "Ada", settings: true, computer: true };
    const adaHost = host(selectedBot);
    adaHost.props.onOpenChange(true);
    adaHost.props.onOpenChange(false);
    const actions = buildCommandPaletteActions({
      newBot: true,
      appSettings: true,
      plugins: true,
      selectedBot,
    });
    const results = commandPaletteResults({ chats, actions, query: "" });
    for (const id of [
      "chat:bot:ada",
      "action:new-bot",
      "action:app-settings",
      "action:bot-settings",
      "action:plugins",
      "action:computer",
    ]) {
      const result = results.find((candidate) => candidate.id === id);
      if (!result) throw new Error("Missing result " + id);
      if (!adaHost.props.onSelect(result)) throw new Error("Result did not execute " + id);
    }
    const stale = results.find((result) => result.id === "action:bot-settings");
    const staleComputer = results.find((result) => result.id === "action:computer");
    const benHost = host({ id: "ben", name: "Ben", settings: true, computer: true });
    const staleSettingsExecuted = benHost.props.onSelect(stale);
    const staleComputerExecuted = benHost.props.onSelect(staleComputer);

    process.stdout.write(JSON.stringify({
      calls,
      staleSettingsExecuted,
      staleComputerExecuted,
    }));
  `)) as {
    calls: string[];
    staleSettingsExecuted: boolean;
    staleComputerExecuted: boolean;
  };
}

function probeMessengerPaletteActivity() {
  return JSON.parse(runPwaRender(`
    import React from "react";
    import { Messenger, MessengerCommandPalette } from "./pwa/src/components/Messenger.tsx";
    import { Welcome } from "./pwa/src/components/FirstUse.tsx";
    import { Input } from "./pwa/src/components/ui/input.tsx";
    import { Textarea } from "./pwa/src/components/ui/textarea.tsx";
    import { createKeyedRequestScope } from "./pwa/src/lib/async-state.ts";
    import { commandPaletteShortcutMatches } from "./pwa/src/components/command-palette-state.ts";

    const ada = {
      id: "ada",
      name: "Ada",
      harness: "codex",
      configMode: "host",
      eyes: { color: "#7c3aed", shape: "round", mode: "idle" },
      write: false,
      permission: null,
      needsYou: null,
      activity: {
        latestText: "Waiting message",
        lastActivityAt: "2026-08-28T10:00:00.000Z",
        unread: true,
        cursor: { sequence: 1, revision: 1 },
      },
      messages: [],
    };
    const send = new AbortController();
    const reaction = new AbortController();
    const read = new AbortController();
    const reads = new Map([["ada", read]]);
    const cards = createKeyedRequestScope();
    const card = cards.begin("pending-card");
    const fetches = [];
    globalThis.fetch = (input, init) => {
      fetches.push({ input: String(input), signal: init?.signal });
      return new Promise(() => {});
    };

    function collect(node, predicate, matches = [], seen = new Set()) {
      if (node == null || ["string", "number", "boolean", "function"].includes(typeof node)) {
        return matches;
      }
      if (Array.isArray(node)) {
        for (const child of node) collect(child, predicate, matches, seen);
        return matches;
      }
      if (typeof node !== "object" || seen.has(node)) return matches;
      seen.add(node);
      if (React.isValidElement(node)) {
        if (predicate(node)) matches.push(node);
        for (const value of Object.values(node.props ?? {})) {
          collect(value, predicate, matches, seen);
        }
      }
      return matches;
    }

    function renderMessenger(commandPaletteOpen, firstUse = false, blockingSurface = null) {
      const overrides = new Map([
        [5, firstUse ? [] : [ada]],
        [6, true],
        [9, "ready"],
        [10, [{ id: "codex", name: "Codex", bin: "codex", talk: true }]],
        [11, "ready"],
        [12, firstUse ? null : "ada"],
        [13, firstUse ? null : ada],
        [16, "chat"],
        [17, "chat"],
        [18, blockingSurface === "app-settings"],
        [19, blockingSurface === "new-bot"],
        [20, { botId: null, open: false, section: "ai", computerExpanded: false }],
        [21, firstUse ? false : true],
        [22, firstUse ? null : "visible send error"],
        [28, true],
        [29, commandPaletteOpen],
      ]);
      const effects = [];
      const refs = [];
      const stateWrites = [];
      let stateIndex = 0;
      let refIndex = 0;
      const location = { hash: "", pathname: "/", search: "" };
      globalThis.window = {
        localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
        location,
        history: {
          state: null,
          pushState(_state, _title, url) {
            location.hash = String(url).includes("#") ? "#" + String(url).split("#")[1] : "";
          },
          replaceState() {},
        },
        matchMedia() {
          return { matches: true, addEventListener() {}, removeEventListener() {} };
        },
        requestAnimationFrame() { return 1; },
        cancelAnimationFrame() {},
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        addEventListener() {},
        removeEventListener() {},
      };
      globalThis.document = {
        visibilityState: "visible",
        activeElement: null,
        body: {},
        getElementById() { return null; },
      };

      const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
      const previous = internals.H;
      internals.H = {
        useState(initial) {
          const index = ++stateIndex;
          let value = overrides.has(index)
            ? overrides.get(index)
            : typeof initial === "function" ? initial() : initial;
          return [value, (next) => {
            value = typeof next === "function" ? next(value) : next;
            stateWrites.push({ index, value });
          }];
        },
        useRef(initial) {
          const index = ++refIndex;
          const ref = { current: initial };
          if (!firstUse && index === 30) ref.current = "ada";
          if (index === 52) ref.current = cards;
          if (index === 53) ref.current = reads;
          if (index === 54) ref.current = send;
          if (index === 55) ref.current = reaction;
          refs[index] = ref;
          return ref;
        },
        useEffect(create, deps) { effects.push({ create, deps }); },
        useLayoutEffect() {},
        useContext() {
          return {
            preferences: { theme: "system", computerPaneByBot: {} },
            effectiveTheme: "light",
            updateTheme() { return true; },
            updateComputerPane() { return true; },
          };
        },
      };
      let tree;
      try {
        tree = Messenger();
      } finally {
        internals.H = previous;
      }
      return { tree, effects, refs, stateWrites, location };
    }

    function readReceiptEffect(probe) {
      const matches = probe.effects.filter(({ deps }) => Array.isArray(deps)
        && deps[0] === true
        && typeof deps[1] === "boolean"
        && deps[2] === "chat"
        && deps[3] === "chat");
      if (matches.length !== 1) throw new Error("Expected one read effect, found " + matches.length);
      return matches[0];
    }

    const initial = renderMessenger(false);
    const host = collect(initial.tree, (node) => node.type === MessengerCommandPalette)[0];
    if (!host) throw new Error("Missing Messenger command palette host");
    const appSettingsBlockedHost = collect(
      renderMessenger(false, false, "app-settings").tree,
      (node) => node.type === MessengerCommandPalette,
    )[0];
    const newBotBlockedHost = collect(
      renderMessenger(false, false, "new-bot").tree,
      (node) => node.type === MessengerCommandPalette,
    )[0];
    if (!appSettingsBlockedHost || !newBotBlockedHost) {
      throw new Error("Missing Messenger modal shortcut hosts");
    }
    const inboxSearch = collect(
      initial.tree,
      (node) => node.type === Input && node.props["aria-label"] === "Search Chats",
    )[0];
    const composer = collect(
      initial.tree,
      (node) => node.type === Textarea && node.props.name === "draft",
    )[0];
    if (!inboxSearch || !composer) throw new Error("Missing Messenger editable shortcut targets");
    function hostTarget(element) {
      const rendered = element.type(element.props);
      if (!React.isValidElement(rendered) || typeof rendered.type !== "string") {
        throw new Error("Expected an editable host element");
      }
      return {
        tagName: rendered.type.toUpperCase(),
        isContentEditable: rendered.props.contentEditable === true,
      };
    }
    const inboxSearchTarget = hostTarget(inboxSearch);
    const composerTarget = hostTarget(composer);
    const shortcutFor = (target, modifier) => ({
      key: "k",
      metaKey: modifier === "meta",
      ctrlKey: modifier === "ctrl",
      altKey: false,
      shiftKey: false,
      target,
      defaultPrevented: false,
      isComposing: false,
    });
    host.props.onOpenChange(true);
    host.props.onOpenChange(false);
    const open = renderMessenger(true);
    readReceiptEffect(open).create();
    const closed = renderMessenger(false);
    readReceiptEffect(closed).create();
    const inFlightAfterPaletteClose = {
      sendAborted: send.signal.aborted,
      reactionAborted: reaction.signal.aborted,
      readAborted: read.signal.aborted,
      cardAborted: card.signal.aborted,
    };

    const firstUse = renderMessenger(false, true);
    const welcome = collect(firstUse.tree, (node) => node.type === Welcome)[0];
    const firstUseHosts = collect(
      firstUse.tree,
      (node) => node.type === MessengerCommandPalette,
    );
    const firstUseHost = firstUseHosts[0];
    const triggerCalls = [];
    let firstUseActions = [];
    if (welcome && firstUseHost) {
      const newBotButton = {
        isConnected: true,
        focus() {},
        click() {
          triggerCalls.push("new-bot-trigger");
          welcome.props.onNewBot({ currentTarget: newBotButton });
        },
      };
      const pluginsButton = {
        isConnected: true,
        focus() {},
        click() {
          triggerCalls.push("plugins-trigger");
          welcome.props.onPlugins();
        },
      };
      const appSettingsButton = {
        click() {
          triggerCalls.push("app-settings-trigger");
          welcome.props.onAppSettingsOpenChange(true);
        },
      };
      firstUse.refs[19].current = newBotButton;
      firstUse.refs[21].current = pluginsButton;
      firstUse.refs[25].current = {
        isConnected: true,
        focus() {},
        querySelector(selector) {
          triggerCalls.push("query:" + selector);
          return appSettingsButton;
        },
      };
      const palette = MessengerCommandPalette(firstUseHost.props);
      firstUseActions = palette.props.actions.map((action) => action.id);
      firstUseHost.props.onNewBot();
      firstUseHost.props.onAppSettings();
      firstUseHost.props.onPlugins();
    }

    process.stdout.write(JSON.stringify({
      paletteWrites: initial.stateWrites.filter(({ index }) => index === 29),
      busyAndErrorWrites: initial.stateWrites.filter(({ index }) => index === 21 || index === 22),
      ...inFlightAfterPaletteClose,
      readFetches: fetches.filter(({ input }) => input.includes("/read")).length,
      editableShortcuts: {
        composerHost: composerTarget.tagName,
        composerMatches: commandPaletteShortcutMatches(
          shortcutFor(composerTarget, "meta"),
          "MacIntel",
        ),
        inboxSearchHost: inboxSearchTarget.tagName,
        inboxSearchMatches: commandPaletteShortcutMatches(
          shortcutFor(inboxSearchTarget, "ctrl"),
          "Linux x86_64",
        ),
        modalGating: {
          appSettings: appSettingsBlockedHost.props.enabled,
          newBot: newBotBlockedHost.props.enabled,
        },
      },
      firstUse: {
        hostCount: firstUseHosts.length,
        welcomeCount: welcome ? 1 : 0,
        actions: firstUseActions,
        chats: firstUseHost?.props.chats ?? null,
        selectedBot: firstUseHost ? firstUseHost.props.selectedBot : "missing",
        enabled: firstUseHost?.props.enabled ?? false,
        sharedRefs: welcome && firstUseHost ? {
          destination: welcome.props.destinationRef === firstUse.refs[25],
          newBot: welcome.props.newBotRef === firstUse.refs[19],
          plugins: welcome.props.pluginsRef === firstUse.refs[21],
        } : null,
        triggerCalls,
        writes: firstUse.stateWrites.filter(({ index }) => index >= 17 && index <= 19),
        hash: firstUse.location.hash,
      },
    }));
  `)) as {
    paletteWrites: Array<{ index: number; value: boolean }>;
    busyAndErrorWrites: Array<{ index: number; value: unknown }>;
    sendAborted: boolean;
    reactionAborted: boolean;
    readAborted: boolean;
    cardAborted: boolean;
    readFetches: number;
    editableShortcuts: {
      composerHost: string;
      composerMatches: boolean;
      inboxSearchHost: string;
      inboxSearchMatches: boolean;
      modalGating: { appSettings: boolean; newBot: boolean };
    };
    firstUse: {
      hostCount: number;
      welcomeCount: number;
      actions: string[];
      chats: unknown[] | null;
      selectedBot: unknown;
      enabled: boolean;
      sharedRefs: { destination: boolean; newBot: boolean; plugins: boolean } | null;
      triggerCalls: string[];
      writes: Array<{ index: number; value: unknown }>;
      hash: string;
    };
  };
}

describe("command palette dialog", () => {
  test("Escape closes once or honors a shared veto across rendered modal focus surfaces", () => {
    const probe = probeRenderedCommandPaletteEscape();
    assert.deepEqual(probe.commandPalette, [
      {
        surface: "combobox",
        dialogsBefore: 1,
        focusedBeforeEscape: true,
        dialogsAfter: 0,
        focusReturned: true,
        openChanges: [true, false],
      },
      {
        surface: "option",
        dialogsBefore: 1,
        focusedBeforeEscape: true,
        dialogsAfter: 0,
        focusReturned: true,
        openChanges: [true, false],
      },
      {
        surface: "close",
        dialogsBefore: 1,
        focusedBeforeEscape: true,
        dialogsAfter: 0,
        focusReturned: true,
        openChanges: [true, false],
      },
    ]);
    assert.deepEqual(probe.sharedDialog, [
      {
        surface: "content",
        veto: false,
        dialogsBefore: 1,
        focusedBeforeEscape: true,
        dialogsAfter: 0,
        focusReturned: true,
        focusRemainsInDialog: false,
        openChanges: [true, false],
        escapeCalls: 1,
      },
      {
        surface: "close",
        veto: false,
        dialogsBefore: 1,
        focusedBeforeEscape: true,
        dialogsAfter: 0,
        focusReturned: true,
        focusRemainsInDialog: false,
        openChanges: [true, false],
        escapeCalls: 1,
      },
      {
        surface: "content",
        veto: true,
        dialogsBefore: 1,
        focusedBeforeEscape: true,
        dialogsAfter: 1,
        focusReturned: false,
        focusRemainsInDialog: true,
        openChanges: [true],
        escapeCalls: 1,
      },
      {
        surface: "close",
        veto: true,
        dialogsBefore: 1,
        focusedBeforeEscape: true,
        dialogsAfter: 1,
        focusReturned: false,
        focusRemainsInDialog: true,
        openChanges: [true],
        escapeCalls: 1,
      },
    ]);
  });

  test("is a named modal with a trapped result list and responsive overflow bounds", () => {
    const probe = probeCommandPaletteDialog();
    const { emptyMarkup, markup } = probe;
    assert.match(markup, /role="combobox"/);
    assert.match(markup, /aria-controls="command-palette-results"/);
    assert.match(markup, /aria-activedescendant="command-palette-option-0"/);
    assert.match(markup, /role="listbox"/);
    assert.match(markup, /role="option"/);
    assert.match(markup, /aria-selected="true"/);
    assert.match(markup, /aria-live="polite"/);
    assert.match(markup, /overflow-y-auto/);
    assert.match(markup, /min-w-0/);
    assert.match(markup, /focus-visible:ring-2/);
    assert.match(emptyMarkup, />No results\.<\/p>/);
    assert.doesNotMatch(emptyMarkup, /aria-activedescendant=/);
    assert.doesNotMatch(
      markup,
      /marketplace|attachment|microphone|mention|slash|provider|model|fallback|account|billing|update/i,
    );

    assert.equal(probe.dialog.open, true);
    assert.equal(probe.dialog.modalIsFalse, false);
    assert.deepEqual(probe.dialog.openChanges, [false]);
    assert.equal(probe.dialog.labelledBy, "command-palette-title");
    assert.equal(probe.dialog.describedBy, "command-palette-description");
    assert.equal(probe.dialog.outsideHandler, "undefined");
  });

  test("wraps arrows, chooses with Enter, leaves Escape to the modal, and keeps input focus", () => {
    const probe = probeCommandPaletteDialog();
    assert.deepEqual(probe.keys, { up: true, down: true, enter: true, escape: false });
    assert.deepEqual(probe.active, [probe.resultCount - 1, 1]);
    assert.deepEqual(probe.selected, ["action:new-bot"]);
    assert.deepEqual(probe.queries, ["Ada"]);
  });

  test("owns the global shortcut only while enabled and closed", () => {
    const probe = probeCommandPaletteShortcutOwnership();
    assert.deepEqual(probe.closedEnabled, {
      listenerCount: 1,
      openChanges: [true],
      prevented: true,
      stateWrites: [
        { index: 1, value: "" },
        { index: 2, value: 0 },
      ],
    });
    assert.deepEqual(probe.openEnabled, {
      listenerCount: 0,
      openChanges: [],
      prevented: false,
      stateWrites: [],
    });
    assert.deepEqual(probe.closedDisabled, {
      listenerCount: 0,
      openChanges: [],
      prevented: false,
      stateWrites: [],
    });
  });

  test("restores a connected control but falls back from document roots to the mounted app target", () => {
    const calls: string[] = [];
    const opener = { isConnected: true, focus: () => calls.push("opener") };
    const appTarget = { isConnected: true, focus: () => calls.push("app") };
    const body = { isConnected: true, focus: () => calls.push("body") };
    const documentElement = { isConnected: true, focus: () => calls.push("root") };
    assert.equal(
      restoreCommandPaletteFocus(opener, appTarget, body, documentElement),
      opener,
    );
    assert.deepEqual(calls, ["opener"]);
    assert.equal(
      restoreCommandPaletteFocus(body, appTarget, body, documentElement),
      appTarget,
    );
    assert.equal(
      restoreCommandPaletteFocus(documentElement, appTarget, body, documentElement),
      appTarget,
    );
    assert.deepEqual(calls, ["opener", "app", "app"]);
    opener.isConnected = false;
    assert.equal(
      restoreCommandPaletteFocus(opener, appTarget, body, documentElement),
      appTarget,
    );
    assert.deepEqual(calls, ["opener", "app", "app", "app"]);
    appTarget.isConnected = false;
    assert.equal(
      restoreCommandPaletteFocus(opener, appTarget, body, documentElement),
      null,
    );
  });

  test("wires one Messenger host to each canonical action exactly once", () => {
    const probe = probeMessengerPaletteHost();
    assert.deepEqual(probe.calls, [
      "palette:true",
      "palette:false",
      "chat:ada",
      "new-bot",
      "app-settings",
      "bot-settings:ada",
      "plugins",
      "computer:ada",
    ]);
    assert.equal(probe.staleSettingsExecuted, false);
    assert.equal(probe.staleComputerExecuted, false);
  });

  test("opens from the real Chat composer and inbox search targets", () => {
    assert.deepEqual(probeMessengerPaletteActivity().editableShortcuts, {
      composerHost: "TEXTAREA",
      composerMatches: true,
      inboxSearchHost: "INPUT",
      inboxSearchMatches: true,
      modalGating: { appSettings: false, newBot: false },
    });
  });

  test("keeps the command palette available through the real empty first-use lifecycle", () => {
    const { firstUse } = probeMessengerPaletteActivity();
    assert.equal(firstUse.welcomeCount, 1);
    assert.equal(firstUse.hostCount, 1);
    assert.deepEqual(firstUse.actions, ["new-bot", "app-settings", "plugins"]);
    assert.deepEqual(firstUse.chats, []);
    assert.equal(firstUse.selectedBot, null);
    assert.equal(firstUse.enabled, true);
    assert.deepEqual(firstUse.sharedRefs, { destination: true, newBot: true, plugins: true });
    assert.deepEqual(firstUse.triggerCalls, [
      "new-bot-trigger",
      "query:[data-first-use-app-settings] button",
      "app-settings-trigger",
      "plugins-trigger",
    ]);
    assert.deepEqual(firstUse.writes, [
      { index: 19, value: true },
      { index: 18, value: true },
      { index: 17, value: "plugins" },
    ]);
    assert.equal(firstUse.hash, "#plugins");
  });

  test("opens and closes without aborting or duplicating in-flight Messenger work", () => {
    const probe = probeMessengerPaletteActivity();
    assert.deepEqual(probe.paletteWrites, [
      { index: 29, value: true },
      { index: 29, value: false },
    ]);
    assert.deepEqual(probe.busyAndErrorWrites, []);
    assert.equal(probe.sendAborted, false);
    assert.equal(probe.reactionAborted, false);
    assert.equal(probe.readAborted, false);
    assert.equal(probe.cardAborted, false);
    assert.equal(probe.readFetches, 0);
  });
});

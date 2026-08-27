export type ChatReceipt = "sent" | "delivered" | "read";

export type ChronologyMessage = {
  id: string;
  role: "user" | "assistant";
  kind?: string;
  createdAt?: string;
  receipt?: ChatReceipt;
  replyTo?: string;
};

export type ChatBurstPosition = "only" | "start" | "middle" | "end";
export type ChatTail = "incoming" | "outgoing";

export type ChatChronologyItem = {
  id: string;
  dayLabel: string | null;
  exactTime: string | null;
  spacing: "compact" | "separate";
  burst: ChatBurstPosition | null;
  tail: ChatTail | null;
  receipt: "Sent" | "Delivered" | "Read" | null;
};

export type ChatInline = {
  kind: "text" | "link" | "strong" | "emphasis" | "code";
  text: string;
  href?: string;
};

export type ChatTextBlock = {
  kind: "text" | "code-block";
  inlines?: ChatInline[];
  text?: string;
  language?: string;
};

export type ChatChronologyOptions = {
  receiptOrder?: ChronologyMessage[];
};

const SHORT_CODE_MAX_LINES = 40;
const SHORT_CODE_MAX_CHARS = 2_000;

function localDayKey(iso: string | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

export function formatChatDayLabel(
  iso: string | undefined,
  now = new Date(),
  locales?: Intl.LocalesArgument,
): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  if (localDayKey(iso) === localDayKey(now.toISOString())) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (localDayKey(iso) === localDayKey(yesterday.toISOString())) return "Yesterday";
  return date.toLocaleDateString(locales, { weekday: "short", month: "short", day: "numeric" });
}

export function formatChatExactTime(
  iso: string | undefined,
  locales?: Intl.LocalesArgument,
): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleTimeString(locales, { hour: "numeric", minute: "2-digit" });
}

function isTextBubble(message: ChronologyMessage): boolean {
  return message.kind === undefined || message.kind === "text";
}

function sharesBurst(previous: ChronologyMessage | undefined, current: ChronologyMessage | undefined): boolean {
  if (!previous || !current || !isTextBubble(previous) || !isTextBubble(current)) return false;
  if (previous.role !== current.role || current.replyTo) return false;
  const previousDay = localDayKey(previous.createdAt);
  return previousDay !== null && previousDay === localDayKey(current.createdAt);
}

export function orderThreadedChatMessages<T extends Pick<ChronologyMessage, "id" | "replyTo">>(
  messages: T[],
): T[] {
  const ids = new Set(messages.map((message) => message.id));
  const children = new Map<string, T[]>();
  const roots: T[] = [];
  for (const message of messages) {
    if (message.replyTo && ids.has(message.replyTo)) {
      const siblings = children.get(message.replyTo) ?? [];
      siblings.push(message);
      children.set(message.replyTo, siblings);
    } else {
      roots.push(message);
    }
  }

  const ordered: T[] = [];
  const seen = new Set<string>();
  const visit = (message: T) => {
    if (seen.has(message.id)) return;
    seen.add(message.id);
    ordered.push(message);
    for (const child of children.get(message.id) ?? []) visit(child);
  };
  for (const root of roots) visit(root);
  for (const message of messages) visit(message);
  return ordered;
}

function receiptLabel(receipt: ChatReceipt | undefined): ChatChronologyItem["receipt"] {
  if (receipt === "sent") return "Sent";
  if (receipt === "delivered") return "Delivered";
  if (receipt === "read") return "Read";
  return null;
}

export function buildChatChronology(
  messages: ChronologyMessage[],
  now = new Date(),
  locales?: Intl.LocalesArgument,
  options: ChatChronologyOptions = {},
): ChatChronologyItem[] {
  let latestReceiptId: string | null = null;
  for (const message of options.receiptOrder ?? messages) {
    if (message?.role === "user" && isTextBubble(message) && receiptLabel(message.receipt)) {
      latestReceiptId = message.id;
    }
  }

  const emittedDays = new Set<string>();
  return messages.map((message, index) => {
    const day = localDayKey(message.createdAt);
    const dayLabel = day && !emittedDays.has(day)
      ? formatChatDayLabel(message.createdAt, now, locales)
      : null;
    if (day) emittedDays.add(day);

    if (!isTextBubble(message)) {
      return {
        id: message.id,
        dayLabel,
        exactTime: formatChatExactTime(message.createdAt, locales),
        spacing: "separate",
        burst: null,
        tail: null,
        receipt: null,
      };
    }

    const continuesPrevious = sharesBurst(messages[index - 1], message);
    const continuesNext = sharesBurst(message, messages[index + 1]);
    const burst: ChatBurstPosition = continuesPrevious
      ? continuesNext ? "middle" : "end"
      : continuesNext ? "start" : "only";

    return {
      id: message.id,
      dayLabel,
      exactTime: formatChatExactTime(message.createdAt, locales),
      spacing: continuesPrevious ? "compact" : "separate",
      burst,
      tail: continuesNext ? null : message.role === "user" ? "outgoing" : "incoming",
      receipt: message.id === latestReceiptId ? receiptLabel(message.receipt) : null,
    };
  });
}

function pushInline(inlines: ChatInline[], inline: ChatInline) {
  const previous = inlines[inlines.length - 1];
  if (inline.kind === "text" && previous?.kind === "text") {
    previous.text += inline.text;
    return;
  }
  inlines.push(inline);
}

function parseInlineText(text: string): ChatInline[] {
  const inlines: ChatInline[] = [];
  const pattern = /(https?:\/\/[^\s<]+|`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*)/g;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > cursor) pushInline(inlines, { kind: "text", text: text.slice(cursor, index) });
    const token = match[0];
    if (token.startsWith("http://") || token.startsWith("https://")) {
      const href = token.replace(/[.,;:!?)]+$/, "");
      pushInline(inlines, { kind: "link", text: href, href });
      if (href.length < token.length) pushInline(inlines, { kind: "text", text: token.slice(href.length) });
    } else if (token.startsWith("**")) {
      pushInline(inlines, { kind: "strong", text: token.slice(2, -2) });
    } else if (token.startsWith("*")) {
      pushInline(inlines, { kind: "emphasis", text: token.slice(1, -1) });
    } else {
      pushInline(inlines, { kind: "code", text: token.slice(1, -1) });
    }
    cursor = index + token.length;
  }
  if (cursor < text.length) pushInline(inlines, { kind: "text", text: text.slice(cursor) });
  return inlines;
}

function textBlock(text: string): ChatTextBlock {
  return { kind: "text", inlines: parseInlineText(text) };
}

export function parseChatText(text: string): ChatTextBlock[] {
  const blocks: ChatTextBlock[] = [];
  const fence = /```([A-Za-z0-9_+.-]*)[ \t]*\n([\s\S]*?)```/g;
  let textStart = 0;
  for (const match of text.matchAll(fence)) {
    const body = match[2]?.replace(/\n$/, "") ?? "";
    const lineCount = body.length === 0 ? 0 : body.split("\n").length;
    if (body.length > SHORT_CODE_MAX_CHARS || lineCount > SHORT_CODE_MAX_LINES) continue;
    const index = match.index ?? 0;
    if (index > textStart) blocks.push(textBlock(text.slice(textStart, index)));
    blocks.push({
      kind: "code-block",
      text: body,
      language: match[1] || undefined,
    });
    textStart = index + match[0].length;
  }
  if (textStart < text.length || blocks.length === 0) blocks.push(textBlock(text.slice(textStart)));
  return blocks;
}

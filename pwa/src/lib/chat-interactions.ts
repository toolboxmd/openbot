export type FlatTranscriptMessage = {
  id: string;
  text: string;
  replyTo?: string;
};

export type FlatTranscriptRow<T extends FlatTranscriptMessage> = {
  message: T;
  replyTarget: T | null;
};

export type TranscriptScrollMetrics = {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
};

export type TranscriptLayoutCandidate = {
  getClientRects(): { length: number };
};

export type TranscriptBreakpointCandidate = {
  addEventListener(type: "change", listener: () => void): void;
  removeEventListener(type: "change", listener: () => void): void;
};

export type PointerCandidate = {
  pointerType: string;
  button: number;
  isPrimary: boolean;
};

export type TranscriptViewportSnapshot = {
  botId: string | null;
  revision: string;
  writing: boolean;
  mounted: boolean;
};

export const LONG_PRESS_DELAY_MS = 500;
export const TRANSCRIPT_BOTTOM_TOLERANCE_PX = 80;
export const TRANSCRIPT_DESKTOP_QUERY = "(min-width: 48rem)";
export const PHONE_ACTION_TARGET_CLASS =
  "max-[47.999rem]:min-h-[var(--touch-min)] max-[47.999rem]:min-w-[var(--touch-min)]";
export const PHONE_COMPOSER_INPUT_CLASS = "max-[47.999rem]:min-h-[var(--touch-min)]";
export const PHONE_COMPOSER_SEND_CLASS = `shrink-0 ${PHONE_ACTION_TARGET_CLASS}`;

export function buildFlatTranscriptRows<T extends FlatTranscriptMessage>(
  messages: T[],
): FlatTranscriptRow<T>[] {
  const byId = new Map(messages.map((message) => [message.id, message]));
  return messages.map((message) => ({
    message,
    replyTarget: message.replyTo ? byId.get(message.replyTo) ?? null : null,
  }));
}

export function transcriptContentRevision(messages: FlatTranscriptMessage[]): string {
  return JSON.stringify(messages.map((message) => [message.id, message.text]));
}

export function isNearTranscriptBottom(
  metrics: TranscriptScrollMetrics,
  tolerance = TRANSCRIPT_BOTTOM_TOLERANCE_PX,
): boolean {
  const remaining = metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop;
  return remaining <= tolerance;
}

export function transcriptHasLayout(element: TranscriptLayoutCandidate | null): boolean {
  return Boolean(element && element.getClientRects().length > 0);
}

export function subscribeTranscriptBreakpoint(
  media: TranscriptBreakpointCandidate,
  onChange: () => void,
): () => void {
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

export function isPrimaryLongPressPointer(pointer: PointerCandidate): boolean {
  return (
    pointer.isPrimary &&
    pointer.button === 0 &&
    (pointer.pointerType === "touch" || pointer.pointerType === "pen")
  );
}

export function observeTranscriptViewport(
  previous: TranscriptViewportSnapshot,
  next: Omit<TranscriptViewportSnapshot, "mounted">,
  mounted: boolean,
): {
  snapshot: TranscriptViewportSnapshot;
  remounted: boolean;
  chatChanged: boolean;
  revisionChanged: boolean;
  writingChanged: boolean;
} {
  return {
    snapshot: mounted ? { ...next, mounted: true } : { ...previous, mounted: false },
    remounted: mounted && !previous.mounted,
    chatChanged: previous.botId !== next.botId,
    revisionChanged: previous.revision !== next.revision,
    writingChanged: previous.writing !== next.writing,
  };
}

export function remountedTranscriptScrollTop(input: {
  remounted: boolean;
  chatChanged: boolean;
  nearBottom: boolean;
  savedScrollTop: number | undefined;
}): number | null {
  if (!input.remounted || input.chatChanged || input.nearBottom) return null;
  if (!Number.isFinite(input.savedScrollTop)) return null;
  return Math.max(0, input.savedScrollTop ?? 0);
}

export function transcriptViewportDecision(input: {
  remounted: boolean;
  chatChanged: boolean;
  revisionChanged: boolean;
  writingChanged: boolean;
  layoutChanged?: boolean;
  nearBottom: boolean;
}): {
  nearBottom: boolean;
  scrollToBottom: boolean;
  newMessages: boolean | null;
} {
  if (input.chatChanged) {
    return { nearBottom: true, scrollToBottom: true, newMessages: false };
  }
  if (input.nearBottom) {
    return {
      nearBottom: true,
      scrollToBottom: input.remounted || input.revisionChanged || input.writingChanged || Boolean(input.layoutChanged),
      newMessages: false,
    };
  }
  if (input.revisionChanged) {
    return { nearBottom: false, scrollToBottom: false, newMessages: true };
  }
  return { nearBottom: false, scrollToBottom: false, newMessages: null };
}

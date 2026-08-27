export type TranscriptCardStatus = {
  tone: "neutral" | "waiting" | "success" | "danger";
  label: string;
};

export type TranscriptCardAction = {
  id: string;
  label: string;
  intent: "primary" | "secondary";
  command:
    | { kind: "permission"; optionId: string }
    | { kind: "host-grant"; access: "read" | "read-write" | "deny" }
    | { kind: "retry-message"; messageId: string };
};

export type TranscriptCard = {
  kind: "permission" | "host-grant" | "bot-failure" | "computer";
  title: string;
  body: string;
  preview?: string;
  status: TranscriptCardStatus;
  actions: TranscriptCardAction[];
};

type PermissionOption = { optionId: string; name: string; kind?: string };

type PermissionActionKind = "allow_once" | "allow_always" | "reject_once" | "reject_always";

const PERMISSION_COPY: Record<string, string> = {
  execute: "This Bot wants to run a command that needs your approval.",
  read: "This Bot wants to read something that needs your approval.",
  edit: "This Bot wants to change something that needs your approval.",
  delete: "This Bot wants to remove something that needs your approval.",
};

function permissionActionKind(option: PermissionOption): PermissionActionKind | null {
  if (
    option.kind === "allow_once"
    || option.optionId === "allow-once"
    || option.optionId === "once"
  ) {
    return "allow_once";
  }
  if (
    option.kind === "allow_always"
    || option.optionId === "allow-always"
    || option.optionId === "always"
  ) {
    return "allow_always";
  }
  if (
    option.kind === "reject_once"
    || option.kind === "reject"
    || option.optionId === "reject-once"
    || option.optionId === "reject"
    || option.optionId === "deny"
  ) {
    return "reject_once";
  }
  if (
    option.kind === "reject_always"
    || option.optionId === "reject-always"
    || option.optionId === "deny-always"
  ) {
    return "reject_always";
  }
  return null;
}

function permissionAction(option: PermissionOption): TranscriptCardAction | null {
  const kind = permissionActionKind(option);
  if (kind === "allow_once") {
    return {
      id: option.optionId,
      label: "Allow once",
      intent: "primary",
      command: { kind: "permission", optionId: option.optionId },
    };
  }
  if (kind === "allow_always") {
    return {
      id: option.optionId,
      label: "Always allow",
      intent: "primary",
      command: { kind: "permission", optionId: option.optionId },
    };
  }
  if (kind === "reject_once") {
    return {
      id: option.optionId,
      label: "Deny",
      intent: "secondary",
      command: { kind: "permission", optionId: option.optionId },
    };
  }
  if (kind === "reject_always") {
    return {
      id: option.optionId,
      label: "Always deny",
      intent: "secondary",
      command: { kind: "permission", optionId: option.optionId },
    };
  }
  return null;
}

export function permissionTranscriptCard(toolKind: string | undefined, options: PermissionOption[]): TranscriptCard {
  return {
    kind: "permission",
    title: "Permission requested",
    body: PERMISSION_COPY[toolKind ?? ""] ?? "This Bot needs your approval before it can continue.",
    status: { tone: "waiting", label: "Waiting for you" },
    actions: options.flatMap((option) => permissionAction(option) ?? []),
  };
}

export function unsupportedPermissionTranscriptCard(): TranscriptCard {
  return {
    kind: "permission",
    title: "Permission not available",
    body: "This Bot requested a choice OpenBot cannot safely show. The request was not approved.",
    status: { tone: "neutral", label: "Not approved" },
    actions: [],
  };
}

export function hostGrantTranscriptCard(
  path: string,
  requested: "read" | "read-write",
  options: PermissionOption[],
): TranscriptCard {
  const canAllow = options.some((option) => permissionActionKind(option)?.startsWith("allow"));
  const canReject = options.some((option) => permissionActionKind(option)?.startsWith("reject"));
  const actions: TranscriptCardAction[] = [];
  if (canAllow && requested === "read") {
    actions.push({
      id: "read",
      label: "Read",
      intent: "primary",
      command: { kind: "host-grant", access: "read" },
    });
  }
  if (canAllow) {
    actions.push({
      id: "read-write",
      label: "Read and write",
      intent: requested === "read-write" ? "primary" : "secondary",
      command: { kind: "host-grant", access: "read-write" },
    });
  }
  if (canReject) {
    actions.push({
      id: "deny",
      label: "Deny",
      intent: "secondary",
      command: { kind: "host-grant", access: "deny" },
    });
  }
  return {
    kind: "host-grant",
    title: "Host access requested",
    body: requested === "read"
      ? "This Bot wants to read a path on this Computer outside Workspace."
      : "This Bot wants to read and change a path on this Computer outside Workspace.",
    preview: path,
    status: { tone: "waiting", label: "Waiting for you" },
    actions,
  };
}

export function resolvedPermissionCard(card: TranscriptCard, optionId: string): TranscriptCard {
  const action = card.actions.find((candidate) =>
    candidate.command.kind === "permission" && candidate.command.optionId === optionId);
  if (!action) throw Object.assign(new Error("permission choice is not available"), { status: 409 });
  const resolvedLabel = action.label === "Allow once"
    ? "Allowed once"
    : action.label === "Always allow"
      ? "Always allowed"
      : action.label === "Always deny"
        ? "Always denied"
        : "Denied";
  return {
    ...card,
    status: {
      tone: action.intent === "primary" ? "success" : "neutral",
      label: resolvedLabel,
    },
    actions: [],
  };
}

export function resolvedHostGrantCard(
  card: TranscriptCard,
  access: "read" | "read-write" | "deny",
  duration: "once" | "session" | "until-revoked",
): TranscriptCard {
  const action = card.actions.find((candidate) =>
    candidate.command.kind === "host-grant" && candidate.command.access === access);
  if (!action) throw Object.assign(new Error("Host grant choice is not available"), { status: 409 });
  const durationLabel = duration === "session"
    ? "this Session"
    : duration === "until-revoked"
      ? "until revoked"
      : "once";
  return {
    ...card,
    status: access === "deny"
      ? { tone: "neutral", label: `Denied · ${durationLabel}` }
      : { tone: "success", label: `${action.label} · ${durationLabel}` },
    actions: [],
  };
}

export function expiredTranscriptCard(card: TranscriptCard): TranscriptCard {
  return {
    ...card,
    status: { tone: "neutral", label: "No longer available" },
    actions: [],
  };
}

export function botFailureTranscriptCard(messageId: string, needsSignIn = false): TranscriptCard {
  return {
    kind: "bot-failure",
    title: needsSignIn ? "Codex needs sign-in" : "Bot stopped",
    body: needsSignIn
      ? "Sign in to Codex on this Computer, then try this message again."
      : "The Bot could not finish this message. Try again.",
    status: { tone: "danger", label: needsSignIn ? "Action needed" : "Failed" },
    actions: [
      {
        id: "retry",
        label: "Try again",
        intent: "primary",
        command: { kind: "retry-message", messageId },
      },
    ],
  };
}

export function retryingBotFailureTranscriptCard(card: TranscriptCard): TranscriptCard {
  if (card.kind !== "bot-failure") {
    throw Object.assign(new Error("failure Card not found"), { status: 409 });
  }
  return {
    ...card,
    status: { tone: "waiting", label: "Retrying" },
    actions: [],
  };
}

export function retriedBotFailureTranscriptCard(card: TranscriptCard): TranscriptCard {
  if (card.kind !== "bot-failure") {
    throw Object.assign(new Error("failure Card not found"), { status: 409 });
  }
  return {
    ...card,
    status: { tone: "success", label: "Retried" },
    actions: [],
  };
}

export function legacyHostGrantTranscriptCard(text: string): TranscriptCard {
  const [statusLine = "Recorded", ...previewLines] = text.split("\n");
  const status = statusLine.trim() || "Recorded";
  const preview = previewLines.join("\n").trim();
  return {
    kind: "host-grant",
    title: "Host access",
    body: "A Host access choice was recorded.",
    ...(preview ? { preview } : {}),
    status: {
      tone: /^deny/i.test(status) ? "neutral" : "success",
      label: status,
    },
    actions: [],
  };
}

export function transcriptCardSummary(card: TranscriptCard): string {
  return `${card.title}: ${card.status.label}`;
}

export function parseTranscriptCard(value: unknown): TranscriptCard | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const card = value as Partial<TranscriptCard>;
  if (
    (card.kind !== "permission"
      && card.kind !== "host-grant"
      && card.kind !== "bot-failure"
      && card.kind !== "computer")
    || typeof card.title !== "string"
    || typeof card.body !== "string"
    || typeof card.status !== "object"
    || card.status === null
    || !Array.isArray(card.actions)
  ) {
    return null;
  }
  if (
    typeof card.status.label !== "string"
    || !["neutral", "waiting", "success", "danger"].includes(String(card.status.tone))
  ) {
    return null;
  }
  const actions = card.actions.flatMap((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
    const action = value as Partial<TranscriptCardAction>;
    if (
      typeof action.id !== "string"
      || typeof action.label !== "string"
      || (action.intent !== "primary" && action.intent !== "secondary")
      || typeof action.command !== "object"
      || action.command === null
    ) {
      return [];
    }
    if (
      action.command.kind === "permission"
      && typeof action.command.optionId === "string"
    ) {
      return [action as TranscriptCardAction];
    }
    if (
      action.command.kind === "host-grant"
      && ["read", "read-write", "deny"].includes(String(action.command.access))
    ) {
      return [action as TranscriptCardAction];
    }
    if (
      action.command.kind === "retry-message"
      && typeof action.command.messageId === "string"
    ) {
      return [action as TranscriptCardAction];
    }
    return [];
  });
  return {
    kind: card.kind,
    title: card.title,
    body: card.body,
    ...(typeof card.preview === "string" ? { preview: card.preview } : {}),
    status: card.status as TranscriptCardStatus,
    actions,
  };
}

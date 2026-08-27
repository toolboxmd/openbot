import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

export const COMPUTER_HELP_MCP_NAME = "openbot-computer-help";
export const COMPUTER_HELP_TOOL_NAME = "request_computer_help";
export const COMPUTER_HELP_IDENTITY_ENV = "OPENBOT_COMPUTER_HELP_IDENTITY";
export const COMPUTER_HELP_GENERATION_FILE_ENV = "OPENBOT_COMPUTER_HELP_GENERATION_FILE";
export const COMPUTER_HELP_META_KEY = "openbot/computer-help";
export const COMPUTER_HELP_COMPLETE_FIELD = "completed";
export const COMPUTER_HELP_COMPLETE_VALUE = "done";

export type ComputerHelpBlocker = "site-password" | "two-factor" | "captcha" | "payment" | "other";

export const COMPUTER_HELP_TOOL_DESCRIPTION = [
  "Use only after the safe automated path is blocked by a visual step on the Bot's current OpenBot Screen,",
  "such as a site password, 2FA, CAPTCHA, or payment confirmation.",
  "Never use for Harness CLI login or Codex CLI login.",
  "Never ask for a password, code, card number, or any other secret in Chat.",
  "The person completes the step directly on the Screen.",
].join(" ");

const INSTRUCTIONS: Record<ComputerHelpBlocker, string> = {
  "site-password": "Complete the site sign-in on this Computer, then choose I'm done.",
  "two-factor": "Complete the verification on this Computer, then choose I'm done.",
  captcha: "Complete the visual check on this Computer, then choose I'm done.",
  payment: "Review and complete the payment step on this Computer, then choose I'm done.",
  other: "Complete the visual step on this Computer, then choose I'm done.",
};

export const COMPUTER_HELP_COMPLETION_SCHEMA = {
  type: "object",
  properties: {
    [COMPUTER_HELP_COMPLETE_FIELD]: {
      type: "string",
      title: "Completion",
      description: "Confirm that the visual step was completed on the Computer.",
      enum: [COMPUTER_HELP_COMPLETE_VALUE],
    },
  },
  required: [COMPUTER_HELP_COMPLETE_FIELD],
  additionalProperties: false,
} as const;

export type ComputerHelpElicitation = {
  instruction: string;
};

export type ComputerHelpMcpServer = {
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function computerHelpInstruction(value: unknown): string | null {
  return typeof value === "string" && Object.hasOwn(INSTRUCTIONS, value)
    ? INSTRUCTIONS[value as ComputerHelpBlocker]
    : null;
}

export function computerHelpMcpServer(identity: string, generationFile: string): ComputerHelpMcpServer {
  if (!identity) throw new Error("Computer-help identity is required");
  if (!generationFile) throw new Error("Computer-help generation file is required");
  const require = createRequire(import.meta.url);
  return {
    name: COMPUTER_HELP_MCP_NAME,
    command: process.execPath,
    args: [
      "--import",
      require.resolve("tsx"),
      fileURLToPath(new URL("./computer-help-mcp.ts", import.meta.url)),
    ],
    env: [
      { name: COMPUTER_HELP_IDENTITY_ENV, value: identity },
      { name: COMPUTER_HELP_GENERATION_FILE_ENV, value: generationFile },
    ],
  };
}

export function parseComputerHelpElicitation(
  value: unknown,
  identity: string,
  generation: string,
  sessionId: string,
): ComputerHelpElicitation | null {
  if (!isRecord(value) || value.mode !== "form" || value.sessionId !== sessionId) return null;
  if (typeof value.message !== "string" || !Object.values(INSTRUCTIONS).includes(value.message)) return null;
  const meta = isRecord(value._meta) ? value._meta[COMPUTER_HELP_META_KEY] : null;
  if (
    !isRecord(meta)
    || meta.kind !== "computer-help"
    || meta.version !== 1
    || meta.identity !== identity
    || meta.generation !== generation
  ) {
    return null;
  }
  const schema = value.requestedSchema;
  if (!isRecord(schema) || schema.type !== "object" || !isRecord(schema.properties)) return null;
  if (
    schema.additionalProperties !== undefined
    && schema.additionalProperties !== false
  ) {
    return null;
  }
  if (Object.keys(schema.properties).length !== 1) return null;
  const completion = schema.properties[COMPUTER_HELP_COMPLETE_FIELD];
  if (!isRecord(completion) || completion.type !== "string") return null;
  if (
    !Array.isArray(completion.enum)
    || completion.enum.length !== 1
    || completion.enum[0] !== COMPUTER_HELP_COMPLETE_VALUE
  ) {
    return null;
  }
  if (
    !Array.isArray(schema.required)
    || schema.required.length !== 1
    || schema.required[0] !== COMPUTER_HELP_COMPLETE_FIELD
  ) {
    return null;
  }
  return { instruction: value.message };
}

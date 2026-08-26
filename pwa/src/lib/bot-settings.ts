import type { Harness } from "./session";

export const BOT_SETTINGS_SECTIONS = ["ai", "instructions", "computer-access"] as const;
export type BotSettingsSection = (typeof BOT_SETTINGS_SECTIONS)[number];

export function selectableAiConnections(harnesses: Harness[]): Harness[] {
  return harnesses.filter((harness) => harness.id === "codex" && harness.talk);
}

export function botSettingsHash(botId: string, section: BotSettingsSection): string {
  return `#bots/${encodeURIComponent(botId)}/settings/${section}`;
}

export function parseBotSettingsHash(hash: string): { botId: string; section: BotSettingsSection } | null {
  const match = hash.match(/^#bots\/([^/]+)\/settings\/(ai|instructions|computer-access)$/);
  if (!match) return null;
  try {
    return {
      botId: decodeURIComponent(match[1]),
      section: match[2] as BotSettingsSection,
    };
  } catch {
    return null;
  }
}

export type ChannelKind = "direct" | "group" | "bot-to-bot";

export type ChannelMember = {
  kind: "user" | "bot";
  id: string;
  name: string;
  eyes?: { color: string; shape: string; mode: string };
};

export type Channel = {
  id: string;
  kind: ChannelKind;
  title: string | null;
  createdAt: string;
  members: ChannelMember[];
  activity: {
    latestText: string | null;
    lastActivityAt: string;
    unread: boolean;
    cursor: { sequence: number; revision: number };
  };
};

export function isSidebarChannel(kind: ChannelKind): boolean {
  return kind === "direct" || kind === "group";
}

export function sidebarGroups(channels: Channel[]): Channel[] {
  return channels.filter((channel) => channel.kind === "group" && isSidebarChannel(channel.kind));
}

export function botMembers(channel: Channel): ChannelMember[] {
  return channel.members.filter((member) => member.kind === "bot");
}

export function newChannelValidation(titleValue: string, selectedBotIds: string[]): {
  valid: boolean;
  title: string;
  botIds: string[];
  titleError: string | null;
  membersError: string | null;
} {
  const title = titleValue.trim();
  const botIds = [...new Set(selectedBotIds.map((id) => id.trim()).filter(Boolean))];
  const titleError = title ? null : "Enter a title for your Channel.";
  const membersError = botIds.length >= 2 ? null : "Choose at least two Bots.";
  return {
    valid: titleError === null && membersError === null,
    title,
    botIds,
    titleError,
    membersError,
  };
}

export function groupDisplayTitle(channel: Pick<Channel, "title" | "members">): string {
  const trimmed = channel.title?.trim();
  if (trimmed) return trimmed;
  return "Untitled Channel";
}

export function composerSendEnabled(kind: ChannelKind | null): boolean {
  return kind === "direct";
}

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

export function groupDisplayTitle(channel: Pick<Channel, "title" | "members">): string {
  const trimmed = channel.title?.trim();
  if (trimmed) return trimmed;
  const names = channel.members
    .filter((member) => member.kind === "bot")
    .map((member) => member.name)
    .filter(Boolean);
  return names.join(", ") || "Group";
}

export function composerSendEnabled(kind: ChannelKind | null): boolean {
  return kind === "direct";
}

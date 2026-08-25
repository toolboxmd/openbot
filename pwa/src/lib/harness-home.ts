export const CONFIG_MODES = ["isolated", "host"] as const;
export type ConfigMode = (typeof CONFIG_MODES)[number];

export const HOST_GRANT_ACCESS = [
  { id: "read", label: "Read" },
  { id: "read-write", label: "Read and write" },
  { id: "deny", label: "Deny" },
] as const;

export const HOST_GRANT_DURATIONS = [
  { id: "once", label: "Once" },
  { id: "session", label: "This Session" },
  { id: "until-revoked", label: "Until revoked" },
] as const;

export type HostGrantAccessId = (typeof HOST_GRANT_ACCESS)[number]["id"];
export type HostGrantDurationId = (typeof HOST_GRANT_DURATIONS)[number]["id"];

export type HostGrantPrompt = {
  path: string;
  requested?: "read" | "read-write";
};

export function isHostGrantPermission(permission: {
  hostGrant?: HostGrantPrompt | null;
} | null): boolean {
  return Boolean(permission?.hostGrant?.path);
}

export function configModeLabel(mode: ConfigMode): string {
  return mode === "host" ? "Host" : "Isolated";
}

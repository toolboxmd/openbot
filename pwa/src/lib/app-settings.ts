export const APPEARANCE_SETTINGS_HASH = "#settings/appearance";
export const SECURITY_SETTINGS_HASH = "#settings/security";

export function appearanceSettingsRequested(hash: string): boolean {
  return hash === APPEARANCE_SETTINGS_HASH;
}

export function appSettingsRequested(hash: string): boolean {
  return appearanceSettingsRequested(hash) || hash === SECURITY_SETTINGS_HASH;
}

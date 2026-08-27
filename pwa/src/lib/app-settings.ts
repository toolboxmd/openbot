export const APPEARANCE_SETTINGS_HASH = "#settings/appearance";

export function appearanceSettingsRequested(hash: string): boolean {
  return hash === APPEARANCE_SETTINGS_HASH;
}

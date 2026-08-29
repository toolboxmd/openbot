import type { AppSettingsDefaults } from "./session";

export const APPEARANCE_SETTINGS_HASH = "#settings/appearance";
export const NEW_BOTS_SETTINGS_HASH = "#settings/new-bots";
export const ALL_BOTS_INSTRUCTIONS_SETTINGS_HASH = "#settings/all-bots-instructions";
export const SECURITY_SETTINGS_HASH = "#settings/security";
export const APP_SETTINGS_INSTRUCTIONS_OWNER = "app-settings";

export type AppSettingsFocusTarget = "new-bots" | "all-bots-instructions" | "security";

export const DEFAULT_APP_SETTINGS_DEFAULTS: AppSettingsDefaults = {
  defaultConnection: null,
  defaultConfigMode: "isolated",
};

export type AppSettingsDefaultsState = {
  status: "loading" | "ready" | "error";
  values: AppSettingsDefaults;
};

export function beginAppSettingsDefaults(): AppSettingsDefaultsState {
  return { status: "loading", values: { ...DEFAULT_APP_SETTINGS_DEFAULTS } };
}

export function acceptAppSettingsDefaults(values: AppSettingsDefaults): AppSettingsDefaultsState {
  return { status: "ready", values: { ...values } };
}

export function failAppSettingsDefaults(state: AppSettingsDefaultsState): AppSettingsDefaultsState {
  return { ...state, status: "error" };
}

export function appearanceSettingsRequested(hash: string): boolean {
  return hash === APPEARANCE_SETTINGS_HASH;
}

export function appSettingsFocusTarget(hash: string): AppSettingsFocusTarget | null {
  if (hash === NEW_BOTS_SETTINGS_HASH) return "new-bots";
  if (hash === ALL_BOTS_INSTRUCTIONS_SETTINGS_HASH) return "all-bots-instructions";
  if (hash === SECURITY_SETTINGS_HASH) return "security";
  return null;
}

export function appSettingsRequested(hash: string): boolean {
  return appearanceSettingsRequested(hash) || appSettingsFocusTarget(hash) !== null;
}

export const UI_PREFERENCES_KEY = "openbot.ui-preferences.v1";

export const THEME_PREFERENCES = ["light", "dark", "system"] as const;

export type ThemePreference = (typeof THEME_PREFERENCES)[number];
export type EffectiveTheme = Exclude<ThemePreference, "system">;

export type UiPreferences = {
  theme: ThemePreference;
  computerPaneByBot: Record<string, boolean>;
};

export const DEFAULT_UI_PREFERENCES: UiPreferences = {
  theme: "system",
  computerPaneByBot: {},
};

export const THEME_COLORS: Record<EffectiveTheme, string> = {
  light: "#FFFFFF",
  dark: "#0F0F10",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === "string" && THEME_PREFERENCES.includes(value as ThemePreference);
}

export function parseUiPreferences(raw: string | null): UiPreferences {
  if (!raw) return { ...DEFAULT_UI_PREFERENCES, computerPaneByBot: {} };

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return { ...DEFAULT_UI_PREFERENCES, computerPaneByBot: {} };

    const computerPaneByBot: Record<string, boolean> = {};
    if (isRecord(parsed.computerPaneByBot)) {
      for (const [botId, open] of Object.entries(parsed.computerPaneByBot)) {
        if (typeof open === "boolean") computerPaneByBot[botId] = open;
      }
    }

    return {
      theme: isThemePreference(parsed.theme) ? parsed.theme : "system",
      computerPaneByBot,
    };
  } catch {
    return { ...DEFAULT_UI_PREFERENCES, computerPaneByBot: {} };
  }
}

export function readUiPreferences(storage: Pick<Storage, "getItem"> | null): UiPreferences {
  if (!storage) return { ...DEFAULT_UI_PREFERENCES, computerPaneByBot: {} };
  try {
    return parseUiPreferences(storage.getItem(UI_PREFERENCES_KEY));
  } catch {
    return { ...DEFAULT_UI_PREFERENCES, computerPaneByBot: {} };
  }
}

export function writeUiPreferences(
  storage: Pick<Storage, "setItem"> | null,
  preferences: UiPreferences,
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(UI_PREFERENCES_KEY, JSON.stringify(preferences));
    return true;
  } catch {
    return false;
  }
}

export function resolveEffectiveTheme(
  preference: ThemePreference,
  systemPrefersDark: boolean,
): EffectiveTheme {
  if (preference === "system") return systemPrefersDark ? "dark" : "light";
  return preference;
}

export function setThemePreference(
  preferences: UiPreferences,
  theme: ThemePreference,
): UiPreferences {
  return { ...preferences, theme };
}

export function setComputerPanePreference(
  preferences: UiPreferences,
  botId: string,
  open: boolean,
): UiPreferences {
  return {
    ...preferences,
    computerPaneByBot: {
      ...preferences.computerPaneByBot,
      [botId]: open,
    },
  };
}

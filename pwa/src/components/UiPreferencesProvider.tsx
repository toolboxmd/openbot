import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  THEME_COLORS,
  UI_PREFERENCES_KEY,
  readUiPreferences,
  resolveEffectiveTheme,
  setComputerPanePreference,
  setThemePreference,
  writeUiPreferences,
  type EffectiveTheme,
  type ThemePreference,
  type UiPreferences,
} from "@/lib/ui-preferences";

type PreferencesContextValue = {
  preferences: UiPreferences;
  effectiveTheme: EffectiveTheme;
  updateTheme: (theme: ThemePreference) => boolean;
  updateComputerPane: (botId: string, open: boolean) => boolean;
};

const PreferencesContext = createContext<PreferencesContextValue | null>(null);

function browserStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function systemPrefersDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function applyDocumentTheme(theme: EffectiveTheme) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  const themeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  themeColor?.setAttribute("content", THEME_COLORS[theme]);
}

export function UiPreferencesProvider({ children }: { children: ReactNode }) {
  const [preferences, setPreferences] = useState<UiPreferences>(() =>
    readUiPreferences(browserStorage()),
  );
  const [prefersDark, setPrefersDark] = useState(systemPrefersDark);
  const effectiveTheme = resolveEffectiveTheme(preferences.theme, prefersDark);

  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setPrefersDark(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    applyDocumentTheme(effectiveTheme);
  }, [effectiveTheme]);

  useEffect(() => {
    const syncAcrossTabs = (event: StorageEvent) => {
      if (event.key === UI_PREFERENCES_KEY) {
        setPreferences(readUiPreferences(browserStorage()));
      }
    };
    window.addEventListener("storage", syncAcrossTabs);
    return () => window.removeEventListener("storage", syncAcrossTabs);
  }, []);

  const persist = useCallback((next: UiPreferences) => {
    setPreferences(next);
    return writeUiPreferences(browserStorage(), next);
  }, []);

  const updateTheme = useCallback(
    (theme: ThemePreference) => persist(setThemePreference(preferences, theme)),
    [persist, preferences],
  );

  const updateComputerPane = useCallback(
    (botId: string, open: boolean) =>
      persist(setComputerPanePreference(preferences, botId, open)),
    [persist, preferences],
  );

  const value = useMemo(
    () => ({ preferences, effectiveTheme, updateTheme, updateComputerPane }),
    [effectiveTheme, preferences, updateComputerPane, updateTheme],
  );

  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>;
}

export function useUiPreferences(): PreferencesContextValue {
  const value = useContext(PreferencesContext);
  if (!value) throw new Error("useUiPreferences must be used inside UiPreferencesProvider");
  return value;
}

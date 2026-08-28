import { useEffect, useRef, useState, type RefObject } from "react";
import { Laptop, LockKeyhole, Moon, Settings, Sun } from "lucide-react";
import { useUiPreferences } from "@/components/UiPreferencesProvider";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { Toast, ToastDescription, ToastProvider, ToastTitle, ToastViewport } from "@/components/ui/toast";
import {
  acceptAppSettingsDefaults,
  ALL_BOTS_INSTRUCTIONS_SETTINGS_HASH,
  APP_SETTINGS_INSTRUCTIONS_OWNER,
  APPEARANCE_SETTINGS_HASH,
  appSettingsFocusTarget,
  appSettingsRequested,
  beginAppSettingsDefaults,
  failAppSettingsDefaults,
  NEW_BOTS_SETTINGS_HASH,
  SECURITY_SETTINGS_HASH,
  type AppSettingsDefaultsState,
} from "@/lib/app-settings";
import { createLatestRequestScope } from "@/lib/async-state";
import {
  acceptBotInstructionSave,
  acceptBotInstructions,
  beginBotInstructions,
  editBotInstruction,
  failBotInstructions,
  selectableConnections,
  type BotInstructionsState,
} from "@/lib/bot-settings";
import {
  getAllBotsAgents,
  getAppSettings,
  listHarnesses,
  lockSession,
  putAllBotsAgents,
  updateAppSettings,
  type Harness,
} from "@/lib/session";
import type { ThemePreference } from "@/lib/ui-preferences";
import { cn } from "@/lib/utils";

const APPEARANCE_CHOICES: Array<{
  value: ThemePreference;
  title: string;
  description: string;
  icon: typeof Sun;
}> = [
  {
    value: "light",
    title: "Light",
    description: "Use the light OpenBot appearance.",
    icon: Sun,
  },
  {
    value: "dark",
    title: "Dark",
    description: "Use the dark OpenBot appearance.",
    icon: Moon,
  },
  {
    value: "system",
    title: "Follow system",
    description: "Match this browser's appearance setting.",
    icon: Laptop,
  },
];

type Feedback = {
  id: number;
  title: string;
  description: string;
  error: boolean;
};

type SaveTarget = "default-connection" | "default-config-mode" | "all-bots-instructions";

export function AppSettingsContent({
  theme,
  effectiveTheme,
  defaults,
  instructions,
  harnesses,
  harnessesState,
  saving,
  lockPending,
  newBotsSectionRef,
  allBotsInstructionsSectionRef,
  securitySectionRef,
  onThemeChange,
  onDefaultConnectionChange,
  onDefaultConfigModeChange,
  onInstructionChange,
  onSaveInstructions,
  onRetryDefaults,
  onRetryInstructions,
  onRetryHarnesses,
  onLock,
}: {
  theme: ThemePreference;
  effectiveTheme: "light" | "dark";
  defaults: AppSettingsDefaultsState;
  instructions: BotInstructionsState;
  harnesses: Harness[];
  harnessesState: "loading" | "ready" | "error";
  saving: SaveTarget | null;
  lockPending: boolean;
  newBotsSectionRef?: RefObject<HTMLElement | null>;
  allBotsInstructionsSectionRef?: RefObject<HTMLElement | null>;
  securitySectionRef?: RefObject<HTMLElement | null>;
  onThemeChange: (value: string) => void;
  onDefaultConnectionChange: (value: string | null) => void;
  onDefaultConfigModeChange: (value: "isolated" | "host") => void;
  onInstructionChange: (value: string) => void;
  onSaveInstructions: () => void;
  onRetryDefaults: () => void;
  onRetryInstructions: () => void;
  onRetryHarnesses: () => void;
  onLock: () => void;
}) {
  const connections = harnessesState === "ready" ? selectableConnections(harnesses) : [];
  const persistedConnection = defaults.values.defaultConnection;
  const listedConnection = persistedConnection
    ? harnesses.find((connection) => connection.id === persistedConnection)
    : undefined;
  const connectionSelectable = persistedConnection
    ? connections.some((connection) => connection.id === persistedConnection)
    : false;
  const unavailableConnection = persistedConnection && harnessesState === "ready" && !connectionSelectable
    ? { id: persistedConnection, name: listedConnection?.name ?? persistedConnection }
    : null;
  const unverifiedConnection = persistedConnection && harnessesState !== "ready" && !connectionSelectable
    ? {
        id: persistedConnection,
        name: listedConnection?.name ?? persistedConnection,
        label: harnessesState === "loading" ? "checking availability" : "availability unknown",
      }
    : null;
  const instructionsChanged = instructions.drafts.all !== instructions.saved.all;
  const busy = saving !== null;

  return (
    <>
      <section aria-labelledby="appearance-heading" className="grid gap-4">
        <div className="grid gap-1">
          <h2 id="appearance-heading" className="text-base font-semibold">
            Appearance
          </h2>
          <p className="text-sm text-muted-foreground">
            Changes apply only to the OpenBot app, not to the Bot Computer.
          </p>
        </div>

        <RadioGroup
          value={theme}
          onValueChange={onThemeChange}
          aria-label="Appearance"
          className="sm:grid-cols-3"
        >
          {APPEARANCE_CHOICES.map((choice) => {
            const Icon = choice.icon;
            const selected = theme === choice.value;
            return (
              <Label
                key={choice.value}
                htmlFor={`appearance-${choice.value}`}
                className={cn(
                  "flex min-h-[var(--touch-min)] cursor-pointer items-start gap-3 rounded-[var(--radius-card)] border bg-background p-4 transition-colors",
                  "hover:bg-muted focus-within:ring-2 focus-within:ring-ring",
                  selected && "border-foreground bg-muted",
                )}
              >
                <RadioGroupItem id={`appearance-${choice.value}`} value={choice.value} className="mt-0.5" />
                <span className="grid min-w-0 flex-1 gap-1">
                  <span className="flex items-center gap-2 text-sm font-medium">
                    <Icon aria-hidden="true" className="size-[var(--icon-default)]" strokeWidth={1.75} />
                    {choice.title}
                  </span>
                  <span className="text-xs font-normal leading-relaxed text-muted-foreground">
                    {choice.description}
                  </span>
                </span>
              </Label>
            );
          })}
        </RadioGroup>

        <p className="text-xs text-muted-foreground" role="status" aria-live="polite">
          Effective appearance: {effectiveTheme === "dark" ? "Dark" : "Light"}.
        </p>
      </section>

      <Separator />

      <section
        ref={newBotsSectionRef}
        id={NEW_BOTS_SETTINGS_HASH.slice(1)}
        aria-labelledby="new-bots-heading"
        tabIndex={-1}
        className="grid gap-4"
      >
        <div className="grid gap-1">
          <h2 id="new-bots-heading" className="text-base font-semibold">
            New Bots
          </h2>
          <p className="text-sm text-muted-foreground">
            These defaults are copied only when a Bot is created. Existing Bots are never changed.
          </p>
        </div>

        {defaults.status === "loading" ? (
          <p className="rounded-[var(--radius-card)] bg-muted p-4 text-sm text-muted-foreground" role="status">
            Loading new-Bot defaults…
          </p>
        ) : defaults.status === "error" ? (
          <div className="grid gap-3 rounded-[var(--radius-card)] bg-muted p-4 text-sm" role="alert">
            <p>Could not load new-Bot defaults.</p>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={onRetryDefaults}
              className="min-h-[var(--touch-min)] justify-self-start"
            >
              Retry defaults
            </Button>
          </div>
        ) : (
          <div className="grid gap-4 rounded-[var(--radius-card)] border p-4">
            <div className="grid gap-2">
              <Label htmlFor="default-connection">Connection</Label>
              <select
                id="default-connection"
                value={persistedConnection ?? ""}
                disabled={busy}
                onChange={(event) => onDefaultConnectionChange(event.target.value || null)}
                className="min-h-[var(--touch-min)] rounded-[var(--radius-control)] border border-input bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="">No default Connection</option>
                {unavailableConnection ? (
                  <option value={unavailableConnection.id} disabled>
                    {unavailableConnection.name} (unavailable)
                  </option>
                ) : null}
                {unverifiedConnection ? (
                  <option value={unverifiedConnection.id} disabled>
                    {unverifiedConnection.name} ({unverifiedConnection.label})
                  </option>
                ) : null}
                {connections.map((connection) => (
                  <option key={connection.id} value={connection.id}>
                    {connection.name}
                  </option>
                ))}
              </select>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {unavailableConnection
                  ? "New Bots will be created without a Connection while this default is unavailable. The saved default is kept so you can see and change it."
                  : "A new Bot copies this Connection only if it is available on the Computer when the Bot is created."}
              </p>
              {harnessesState === "loading" ? (
                <p className="text-xs text-muted-foreground" role="status">Checking Connections…</p>
              ) : harnessesState === "error" ? (
                <div className="flex flex-wrap items-center gap-2 text-xs" role="alert">
                  <span>Could not check available Connections.</span>
                  <Button type="button" size="sm" variant="ghost" onClick={onRetryHarnesses}>
                    Retry Connections
                  </Button>
                </div>
              ) : null}
            </div>

            <div className="grid gap-2">
              <Label htmlFor="default-config-mode">Configuration mode</Label>
              <select
                id="default-config-mode"
                value={defaults.values.defaultConfigMode}
                disabled={busy}
                onChange={(event) => {
                  const value = event.target.value;
                  if (value === "isolated" || value === "host") onDefaultConfigModeChange(value);
                }}
                className="min-h-[var(--touch-min)] rounded-[var(--radius-control)] border border-input bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="isolated">Isolated (recommended)</option>
                <option value="host">Host</option>
              </select>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Isolated uses OpenBot Harness Home and the new Bot directory. Host uses your real vendor home and host shell.
              </p>
            </div>
          </div>
        )}
      </section>

      <Separator />

      <section
        ref={allBotsInstructionsSectionRef}
        id={ALL_BOTS_INSTRUCTIONS_SETTINGS_HASH.slice(1)}
        aria-labelledby="all-bots-instructions-heading"
        tabIndex={-1}
        className="grid gap-4"
      >
        <div className="grid gap-1">
          <h2 id="all-bots-instructions-heading" className="text-base font-semibold">
            All Bots instructions
          </h2>
          <p id="app-all-bots-instructions-description" className="text-sm text-muted-foreground">
            Edit the same canonical Workspace instructions used by the selected-Bot panel. Empty instructions are valid.
          </p>
        </div>

        {instructions.status === "loading" ? (
          <p className="rounded-[var(--radius-card)] bg-muted p-4 text-sm text-muted-foreground" role="status">
            Loading All Bots instructions…
          </p>
        ) : instructions.status === "error" ? (
          <div className="grid gap-3 rounded-[var(--radius-card)] bg-muted p-4 text-sm" role="alert">
            <p>Could not load All Bots instructions.</p>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={onRetryInstructions}
              className="min-h-[var(--touch-min)] justify-self-start"
            >
              Retry instructions
            </Button>
          </div>
        ) : (
          <div className="grid gap-3">
            <Textarea
              id="app-all-bots-instructions"
              aria-describedby="app-all-bots-instructions-description"
              value={instructions.drafts.all}
              disabled={busy}
              onChange={(event) => onInstructionChange(event.target.value)}
              className="min-h-40 font-mono text-sm sm:min-h-52"
            />
            <Button
              type="button"
              disabled={busy || !instructionsChanged}
              onClick={onSaveInstructions}
              className="min-h-[var(--touch-min)] justify-self-end"
            >
              {saving === "all-bots-instructions" ? "Saving…" : "Save All Bots"}
            </Button>
          </div>
        )}
      </section>

      <Separator />

      <section
        ref={securitySectionRef}
        id={SECURITY_SETTINGS_HASH.slice(1)}
        aria-labelledby="security-heading"
        tabIndex={-1}
        className="grid gap-4"
      >
        <div className="grid gap-1">
          <h2 id="security-heading" className="text-base font-semibold">
            Security
          </h2>
          <p className="text-sm text-muted-foreground">
            Control Password access for this browser.
          </p>
        </div>

        <div className="flex flex-col gap-4 rounded-[var(--radius-card)] border p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="grid gap-1">
            <h3 className="text-sm font-medium">Password lock</h3>
            <p id="lock-openbot-description" className="text-xs leading-relaxed text-muted-foreground">
              Clear this browser's Password session and return to the Password screen.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            className="min-h-[var(--touch-min)] shrink-0"
            aria-describedby="lock-openbot-description"
            aria-busy={lockPending}
            onClick={onLock}
            disabled={lockPending}
          >
            <LockKeyhole aria-hidden="true" />
            Lock OpenBot
          </Button>
        </div>
      </section>
    </>
  );
}

export function AppSettings({
  className,
  open: controlledOpen,
  onOpenChange,
  harnesses: suppliedHarnesses,
  harnessesState: suppliedHarnessesState,
  onRetryHarnesses,
}: {
  className?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  harnesses?: Harness[];
  harnessesState?: "loading" | "ready" | "error";
  onRetryHarnesses?: () => void;
}) {
  const { preferences, effectiveTheme, updateTheme } = useUiPreferences();
  const [localOpen, setLocalOpen] = useState(() => appSettingsRequested(window.location.hash));
  const [requestedHash, setRequestedHash] = useState(() => window.location.hash);
  const [defaults, setDefaults] = useState(beginAppSettingsDefaults);
  const [instructions, setInstructions] = useState(() =>
    beginBotInstructions(APP_SETTINGS_INSTRUCTIONS_OWNER));
  const [defaultsReload, setDefaultsReload] = useState(0);
  const [instructionsReload, setInstructionsReload] = useState(0);
  const [localHarnesses, setLocalHarnesses] = useState<Harness[]>([]);
  const [localHarnessesState, setLocalHarnessesState] = useState<"loading" | "ready" | "error">("loading");
  const [localHarnessesReload, setLocalHarnessesReload] = useState(0);
  const [saving, setSaving] = useState<SaveTarget | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [lockPending, setLockPending] = useState(false);
  const newBotsSectionRef = useRef<HTMLElement | null>(null);
  const allBotsInstructionsSectionRef = useRef<HTMLElement | null>(null);
  const securitySectionRef = useRef<HTMLElement | null>(null);
  const defaultsLoadRequestRef = useRef(createLatestRequestScope());
  const defaultsSaveRequestRef = useRef(createLatestRequestScope());
  const instructionsLoadRequestRef = useRef(createLatestRequestScope());
  const instructionsSaveRequestRef = useRef(createLatestRequestScope());
  const localHarnessesRequestRef = useRef(createLatestRequestScope());
  const open = controlledOpen ?? localOpen;
  const harnessesControlled = suppliedHarnesses !== undefined && suppliedHarnessesState !== undefined;
  const harnesses = harnessesControlled ? suppliedHarnesses : localHarnesses;
  const harnessesState = harnessesControlled ? suppliedHarnessesState : localHarnessesState;

  useEffect(() => {
    setSaving(null);
  }, [open]);

  useEffect(() => {
    localHarnessesRequestRef.current.cancel();
    if (harnessesControlled || !open) return;
    setLocalHarnessesState("loading");
    void localHarnessesRequestRef.current.run(
      (signal) => listHarnesses(signal),
      {
        success(result) {
          setLocalHarnesses(result.harnesses);
          setLocalHarnessesState("ready");
        },
        failure(error) {
          setLocalHarnessesState("error");
          setFeedback({
            id: Date.now(),
            title: "Could not check Connections",
            description: error instanceof Error ? error.message : "Try again from App Settings.",
            error: true,
          });
        },
      },
    );
    return () => localHarnessesRequestRef.current.cancel();
  }, [harnessesControlled, localHarnessesReload, open]);

  useEffect(() => {
    const syncWithLocation = () => {
      const hash = window.location.hash;
      setRequestedHash(hash);
      const next = appSettingsRequested(hash);
      if (onOpenChange) onOpenChange(next);
      else setLocalOpen(next);
    };
    window.addEventListener("hashchange", syncWithLocation);
    window.addEventListener("popstate", syncWithLocation);
    return () => {
      window.removeEventListener("hashchange", syncWithLocation);
      window.removeEventListener("popstate", syncWithLocation);
    };
  }, [onOpenChange]);

  useEffect(() => {
    defaultsLoadRequestRef.current.cancel();
    defaultsSaveRequestRef.current.cancel();
    setDefaults(beginAppSettingsDefaults());
    if (!open) return;
    void defaultsLoadRequestRef.current.run(
      (signal) => getAppSettings(signal),
      {
        success(values) {
          setDefaults(acceptAppSettingsDefaults(values));
        },
        failure(error) {
          setDefaults((state) => failAppSettingsDefaults(state));
          setFeedback({
            id: Date.now(),
            title: "Could not load defaults",
            description: error instanceof Error ? error.message : "Try again from App Settings.",
            error: true,
          });
        },
      },
    );
    return () => {
      defaultsLoadRequestRef.current.cancel();
      defaultsSaveRequestRef.current.cancel();
    };
  }, [defaultsReload, open]);

  useEffect(() => {
    instructionsLoadRequestRef.current.cancel();
    instructionsSaveRequestRef.current.cancel();
    setInstructions(beginBotInstructions(APP_SETTINGS_INSTRUCTIONS_OWNER));
    if (!open) return;
    void instructionsLoadRequestRef.current.run(
      (signal) => getAllBotsAgents(signal),
      {
        success(all) {
          setInstructions((state) => acceptBotInstructions(
            state,
            APP_SETTINGS_INSTRUCTIONS_OWNER,
            { all, bot: "" },
          ));
        },
        failure(error) {
          setInstructions((state) => failBotInstructions(state, APP_SETTINGS_INSTRUCTIONS_OWNER));
          setFeedback({
            id: Date.now(),
            title: "Could not load instructions",
            description: error instanceof Error ? error.message : "Try again from App Settings.",
            error: true,
          });
        },
      },
    );
    return () => {
      instructionsLoadRequestRef.current.cancel();
      instructionsSaveRequestRef.current.cancel();
    };
  }, [instructionsReload, open]);

  useEffect(() => {
    const focusTarget = appSettingsFocusTarget(requestedHash);
    if (!open || !focusTarget) return;
    const sectionRef = focusTarget === "new-bots"
      ? newBotsSectionRef
      : focusTarget === "all-bots-instructions"
        ? allBotsInstructionsSectionRef
        : securitySectionRef;
    const frame = window.requestAnimationFrame(() => {
      const section = sectionRef.current;
      if (!section) return;
      section.scrollIntoView({ block: "start" });
      section.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, requestedHash]);

  function setAppSettingsOpen(next: boolean) {
    const suffix = next ? APPEARANCE_SETTINGS_HASH : "";
    setRequestedHash(suffix);
    if (onOpenChange) onOpenChange(next);
    else setLocalOpen(next);
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${window.location.search}${suffix}`,
    );
  }

  function chooseTheme(value: string) {
    const choice = APPEARANCE_CHOICES.find((item) => item.value === value);
    if (!choice) return;
    const saved = updateTheme(choice.value);
    setFeedback({
      id: Date.now(),
      title: saved ? "Appearance saved" : "Appearance changed for now",
      description: saved
        ? `${choice.title} will be used when you return to this browser.`
        : "This browser blocked local preferences, so the choice could not be saved.",
      error: !saved,
    });
  }

  function saveDefaultConnection(value: string | null) {
    if (defaults.status !== "ready" || saving !== null) return;
    defaultsLoadRequestRef.current.cancel();
    void defaultsSaveRequestRef.current.run(
      (signal) => updateAppSettings({ defaultConnection: value }, signal),
      {
        pending: () => setSaving("default-connection"),
        success(values) {
          setDefaults(acceptAppSettingsDefaults(values));
          setFeedback({
            id: Date.now(),
            title: "Default Connection saved",
            description: values.defaultConnection
              ? "New Bots will copy this Connection when it is available."
              : "New Bots will start without a Connection.",
            error: false,
          });
        },
        failure(error) {
          setFeedback({
            id: Date.now(),
            title: "Default not saved",
            description: error instanceof Error ? error.message : "Could not save the default Connection.",
            error: true,
          });
        },
        settled: () => setSaving(null),
      },
    );
  }

  function saveDefaultConfigMode(value: "isolated" | "host") {
    if (defaults.status !== "ready" || saving !== null) return;
    defaultsLoadRequestRef.current.cancel();
    void defaultsSaveRequestRef.current.run(
      (signal) => updateAppSettings({ defaultConfigMode: value }, signal),
      {
        pending: () => setSaving("default-config-mode"),
        success(values) {
          setDefaults(acceptAppSettingsDefaults(values));
          setFeedback({
            id: Date.now(),
            title: "Default configuration saved",
            description: `New Bots will start in ${values.defaultConfigMode === "host" ? "Host" : "Isolated"} mode.`,
            error: false,
          });
        },
        failure(error) {
          setFeedback({
            id: Date.now(),
            title: "Default not saved",
            description: error instanceof Error ? error.message : "Could not save the default configuration mode.",
            error: true,
          });
        },
        settled: () => setSaving(null),
      },
    );
  }

  function saveAllBotsInstructions() {
    if (instructions.status !== "ready" || saving !== null) return;
    const draft = instructions.drafts.all;
    instructionsLoadRequestRef.current.cancel();
    void instructionsSaveRequestRef.current.run(
      (signal) => putAllBotsAgents(draft, signal),
      {
        pending: () => setSaving("all-bots-instructions"),
        success(saved) {
          setInstructions((state) => acceptBotInstructionSave(
            state,
            APP_SETTINGS_INSTRUCTIONS_OWNER,
            "all",
            saved,
          ));
          setFeedback({
            id: Date.now(),
            title: "Instructions saved",
            description: "Shared Workspace instructions now apply to all Bots.",
            error: false,
          });
        },
        failure(error) {
          setFeedback({
            id: Date.now(),
            title: "Instructions not saved",
            description: error instanceof Error ? error.message : "Could not save All Bots instructions.",
            error: true,
          });
        },
        settled: () => setSaving(null),
      },
    );
  }

  async function lockOpenBot() {
    setLockPending(true);
    const result = await lockSession();
    if (!result.ok) {
      setLockPending(false);
      setFeedback({
        id: Date.now(),
        title: "Lock failed",
        description: result.error,
        error: true,
      });
      return;
    }
    setAppSettingsOpen(false);
    window.location.reload();
  }

  return (
    <ToastProvider duration={3200} swipeDirection="right">
      <Dialog open={open} onOpenChange={setAppSettingsOpen}>
        <DialogTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            className={cn(
              "min-h-[var(--touch-min)] w-full justify-start rounded-[var(--radius-control)]",
              className,
            )}
          >
            <Settings className="size-[var(--icon-default)]" strokeWidth={1.75} />
            App Settings
          </Button>
        </DialogTrigger>
        <DialogContent aria-describedby="app-settings-description">
          <DialogHeader>
            <DialogTitle>App Settings</DialogTitle>
            <DialogDescription id="app-settings-description">
              Global OpenBot preferences, shared instructions, and defaults for new Bots.
            </DialogDescription>
          </DialogHeader>

          <Separator />
          <AppSettingsContent
            theme={preferences.theme}
            effectiveTheme={effectiveTheme}
            defaults={defaults}
            instructions={instructions}
            harnesses={harnesses}
            harnessesState={harnessesState}
            saving={saving}
            lockPending={lockPending}
            newBotsSectionRef={newBotsSectionRef}
            allBotsInstructionsSectionRef={allBotsInstructionsSectionRef}
            securitySectionRef={securitySectionRef}
            onThemeChange={chooseTheme}
            onDefaultConnectionChange={saveDefaultConnection}
            onDefaultConfigModeChange={saveDefaultConfigMode}
            onInstructionChange={(value) => setInstructions((state) =>
              editBotInstruction(state, APP_SETTINGS_INSTRUCTIONS_OWNER, "all", value))}
            onSaveInstructions={saveAllBotsInstructions}
            onRetryDefaults={() => setDefaultsReload((current) => current + 1)}
            onRetryInstructions={() => setInstructionsReload((current) => current + 1)}
            onRetryHarnesses={() => {
              if (harnessesControlled) onRetryHarnesses?.();
              else setLocalHarnessesReload((current) => current + 1);
            }}
            onLock={() => void lockOpenBot()}
          />
        </DialogContent>
      </Dialog>

      {feedback ? (
        <Toast key={feedback.id} className={feedback.error ? "border-destructive" : undefined}>
          <ToastTitle>{feedback.title}</ToastTitle>
          <ToastDescription>{feedback.description}</ToastDescription>
        </Toast>
      ) : null}
      <ToastViewport />
    </ToastProvider>
  );
}

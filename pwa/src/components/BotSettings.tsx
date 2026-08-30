import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { Maximize2, X } from "lucide-react";
import { ComputerScreen, SelectedBotComputerPreview } from "@/components/Computer";
import { Eyes } from "@/components/Eyes";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { Toast, ToastDescription, ToastProvider, ToastTitle, ToastViewport } from "@/components/ui/toast";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  acceptBotInstructionSave,
  acceptBotInstructions,
  beginBotInstructions,
  BOT_SETTINGS_SECTIONS,
  editBotInstruction,
  failBotInstructions,
  selectableAiConnections,
  type BotInstructionScope,
  type BotInstructionsState,
  type BotSettingsSection,
} from "@/lib/bot-settings";
import type { FaceShape } from "@/lib/face";
import { createLatestRequestScope } from "@/lib/async-state";
import {
  getAllBotsAgents,
  getThisBotAgents,
  pickHarness,
  putAllBotsAgents,
  putThisBotAgents,
  setConfigMode,
  type Bot,
  type Harness,
} from "@/lib/session";

type Feedback = {
  id: number;
  title: string;
  description: string;
  error: boolean;
};

type SaveTarget = "connection" | "environment" | "all-instructions" | "bot-instructions";

const SECTION_LABELS: Record<BotSettingsSection, string> = {
  ai: "Connection",
  instructions: "Instructions",
  "computer-access": "Computer & Access",
};

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function SettingsSection({
  id,
  title,
  description,
  children,
}: {
  id: BotSettingsSection;
  title: string;
  description: string;
  children: ReactNode;
}) {
  const headingId = `bot-settings-${id}-heading`;
  return (
    <section id={`bot-settings-${id}`} aria-labelledby={headingId} className="grid scroll-mt-4 gap-4">
      <div className="grid gap-1">
        <h3 id={headingId} className="text-sm font-semibold">
          {title}
        </h3>
        <p className="text-xs leading-relaxed text-muted-foreground">{description}</p>
      </div>
      {children}
    </section>
  );
}

export function SelectedBotPanelFrame({
  contentRef,
  trapFocus,
  interactionSuspended = false,
  onClose,
  children,
}: {
  contentRef: RefObject<HTMLDivElement | null>;
  trapFocus: boolean;
  interactionSuspended?: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (interactionSuspended) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (!trapFocus || event.key !== "Tab") return;

    const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), select:not([disabled]), textarea:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )).filter((candidate) => candidate.closest('[hidden], [aria-hidden="true"]') === null);
    if (focusable.length === 0) {
      event.preventDefault();
      event.currentTarget.focus();
      return;
    }

    const activeIndex = focusable.indexOf(event.target as HTMLElement);
    const wrapBackward = event.shiftKey && activeIndex <= 0;
    const wrapForward = !event.shiftKey && (activeIndex < 0 || activeIndex === focusable.length - 1);
    if (!wrapBackward && !wrapForward) return;
    event.preventDefault();
    focusable[wrapBackward ? focusable.length - 1 : 0]?.focus();
  }

  return (
    <div
      ref={contentRef}
      id="selected-bot-panel"
      data-testid="bot-settings"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="flex min-h-0 flex-1 flex-col overflow-hidden bg-surface text-foreground outline-none"
    >
      {children}
    </div>
  );
}

export function InstructionEditors({
  bot,
  instructions,
  savingScope,
  expanded,
  expandButtonRefs,
  busy = savingScope !== null,
  onDraftChange,
  onSave,
  onRetry,
  onExpandedChange,
}: {
  bot: Pick<Bot, "id" | "name">;
  instructions: BotInstructionsState;
  savingScope: BotInstructionScope | null;
  expanded: BotInstructionScope | null;
  expandButtonRefs?: Partial<Record<BotInstructionScope, RefObject<HTMLButtonElement | null>>>;
  busy?: boolean;
  onDraftChange: (scope: BotInstructionScope, value: string) => void;
  onSave: (scope: BotInstructionScope) => void;
  onRetry: () => void;
  onExpandedChange: (scope: BotInstructionScope | null) => void;
}) {
  if (instructions.status === "loading") {
    return (
      <p className="rounded-[var(--radius-card)] bg-muted p-4 text-sm text-muted-foreground" role="status">
        Loading instructions…
      </p>
    );
  }

  if (instructions.status === "error") {
    return (
      <div className="grid gap-3 rounded-[var(--radius-card)] bg-muted p-4 text-sm" role="alert">
        <p>Instructions are unavailable.</p>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={onRetry}
          className="min-h-[var(--touch-min)] justify-self-start"
        >
          Retry
        </Button>
      </div>
    );
  }

  const metadata: Record<BotInstructionScope, { label: string; path: string; compactId: string }> = {
    all: {
      label: "All Bots",
      path: "Workspace/AGENTS.md",
      compactId: "all-bots-instructions",
    },
    bot: {
      label: "This Bot",
      path: `Workspace/bots/${bot.id}/AGENTS.md`,
      compactId: "this-bot-instructions",
    },
  };

  function editor(scope: BotInstructionScope) {
    const details = metadata[scope];
    const draft = instructions.drafts[scope];
    const saving = savingScope === scope;
    const changed = draft !== instructions.saved[scope];
    return (
      <div key={scope} className="grid gap-3 rounded-[var(--radius-card)] border bg-background p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <Label htmlFor={details.compactId}>{details.label}</Label>
            <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">{details.path}</p>
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                ref={expandButtonRefs?.[scope]}
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label={`Expand ${details.label} instructions`}
                onClick={() => onExpandedChange(scope)}
                className="min-h-[var(--touch-min)] min-w-[var(--touch-min)] shrink-0"
              >
                <Maximize2 />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{`Expand ${details.label} instructions`}</TooltipContent>
          </Tooltip>
        </div>
        <Textarea
          id={details.compactId}
          rows={3}
          value={draft}
          disabled={busy}
          onChange={(event) => onDraftChange(scope, event.target.value)}
          className="min-h-20 font-mono text-xs"
        />
        <Button
          type="button"
          size="sm"
          disabled={busy || !changed}
          onClick={() => onSave(scope)}
          className="justify-self-start max-[47.999rem]:min-h-[var(--touch-min)]"
        >
          {saving ? "Saving…" : `Save ${details.label}`}
        </Button>
      </div>
    );
  }

  return (
    <>
      {editor("all")}
      {editor("bot")}
      {(["all", "bot"] as const).map((scope) => {
        const details = metadata[scope];
        const saving = savingScope === scope;
        const changed = instructions.drafts[scope] !== instructions.saved[scope];
        return (
          <Dialog
            key={`expanded-${scope}`}
            open={expanded === scope}
            onOpenChange={(next) => {
              if (!next) onExpandedChange(null);
            }}
          >
            <DialogContent
              aria-describedby={`${details.compactId}-expanded-description`}
              onCloseAutoFocus={(event) => {
                const target = expandButtonRefs?.[scope]?.current;
                if (!target?.isConnected) return;
                event.preventDefault();
                target.focus();
              }}
              className="min-[48rem]:max-w-3xl"
            >
              <DialogHeader>
                <DialogTitle>{`${details.label} instructions`}</DialogTitle>
                <DialogDescription id={`${details.compactId}-expanded-description`}>
                  {details.path}
                </DialogDescription>
              </DialogHeader>
              <Textarea
                id={`${details.compactId}-expanded`}
                aria-label={`${details.label} instructions`}
                value={instructions.drafts[scope]}
                disabled={busy}
                onChange={(event) => onDraftChange(scope, event.target.value)}
                className="min-h-[min(60dvh,28rem)] font-mono text-sm"
              />
              <Button
                type="button"
                disabled={busy || !changed}
                onClick={() => onSave(scope)}
                className="justify-self-end max-[47.999rem]:min-h-[var(--touch-min)]"
              >
                {saving ? "Saving…" : "Save changes"}
              </Button>
            </DialogContent>
          </Dialog>
        );
      })}
    </>
  );
}

export function BotSettings({
  bot,
  harnesses,
  harnessesState,
  open,
  onOpenChange,
  onBotMutation,
  onRetryHarnesses,
  onOpenComputer,
  computerPreviewRef,
  computerPreviewVisible = true,
  trapFocus = false,
  section,
  onSectionChange,
}: {
  bot: Bot;
  harnesses: Harness[];
  harnessesState: "loading" | "ready" | "error";
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onBotMutation: (
    botId: string,
    request: () => Promise<Bot>,
    signal?: AbortSignal,
  ) => Promise<Bot>;
  onRetryHarnesses: () => void;
  onOpenComputer: (botId: string) => void;
  computerPreviewRef?: RefObject<HTMLButtonElement | null>;
  computerPreviewVisible?: boolean;
  trapFocus?: boolean;
  section: BotSettingsSection;
  onSectionChange: (section: BotSettingsSection) => void;
}) {
  const [instructions, setInstructions] = useState(() => beginBotInstructions(bot.id));
  const [instructionsReload, setInstructionsReload] = useState(0);
  const [expandedInstructions, setExpandedInstructions] = useState<BotInstructionScope | null>(null);
  const [saving, setSaving] = useState<SaveTarget | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const scrollViewportRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const localComputerPreviewRef = useRef<HTMLButtonElement | null>(null);
  const allInstructionsExpandRef = useRef<HTMLButtonElement | null>(null);
  const botInstructionsExpandRef = useRef<HTMLButtonElement | null>(null);
  const instructionsRequestRef = useRef(createLatestRequestScope());
  const saveRequestRef = useRef(createLatestRequestScope());
  const connections = selectableAiConnections(harnesses);
  const currentConnection = bot.harness
    ? harnesses.find((connection) => connection.id === bot.harness)
    : undefined;
  const unavailableConnection = bot.harness
    && !connections.some((connection) => connection.id === bot.harness)
    ? { id: bot.harness, name: currentConnection?.name ?? bot.harness }
    : null;
  const savingInstructionScope: BotInstructionScope | null = saving === "all-instructions"
    ? "all"
    : saving === "bot-instructions"
      ? "bot"
      : null;

  useEffect(() => {
    instructionsRequestRef.current.cancel();
    saveRequestRef.current.cancel();
    setInstructions(beginBotInstructions(bot.id));
    setExpandedInstructions(null);
    setSaving(null);
    setFeedback(null);
    if (!open) return;
    void instructionsRequestRef.current.run(
      (signal) => Promise.all([
        getAllBotsAgents(signal),
        getThisBotAgents(bot.id, signal),
      ]),
      {
        success([all, own]) {
          setInstructions((state) => acceptBotInstructions(state, bot.id, { all, bot: own }));
        },
        failure(error) {
          setFeedback({
            id: Date.now(),
            title: "Could not load instructions",
            description: errorMessage(error, "Try again from the Bot panel."),
            error: true,
          });
          setInstructions((state) => failBotInstructions(state, bot.id));
        },
      },
    );
    return () => {
      instructionsRequestRef.current.cancel();
      saveRequestRef.current.cancel();
    };
  }, [bot.id, instructionsReload, open]);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      if (contentRef.current?.contains(document.activeElement)) return;
      closeButtonRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [bot.id, open, trapFocus]);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      if (section === "ai") {
        scrollViewportRef.current?.scrollTo({ top: 0 });
        return;
      }
      document.getElementById(`bot-settings-${section}`)?.scrollIntoView({ block: "start" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [instructions.status, open, section]);

  function showSaved(title: string, description: string) {
    setFeedback({ id: Date.now(), title, description, error: false });
  }

  function showSaveError(error: unknown, fallback: string) {
    setFeedback({
      id: Date.now(),
      title: "Setting not saved",
      description: errorMessage(error, fallback),
      error: true,
    });
  }

  async function chooseConnection(value: string) {
    if (value === bot.harness || !connections.some((connection) => connection.id === value)) return;
    await saveRequestRef.current.run(
      (signal) => onBotMutation(bot.id, () => pickHarness(bot.id, value, signal), signal),
      {
        pending: () => setSaving("connection"),
        success: (updated) => showSaved(
          "Connection saved",
          `${updated.name} will use the selected Connection for new Sessions.`,
        ),
        failure: (error) => showSaveError(error, "Could not save the Connection."),
        settled: () => setSaving(null),
      },
    );
  }

  async function chooseEnvironment(value: string) {
    if (value !== "isolated" && value !== "host") return;
    if (value === (bot.configMode ?? "isolated")) return;
    await saveRequestRef.current.run(
      (signal) => onBotMutation(bot.id, () => setConfigMode(bot.id, value, signal), signal),
      {
        pending: () => setSaving("environment"),
        success: (updated) => showSaved(
          "Configuration saved",
          `${updated.name} will use ${value === "host" ? "Host" : "Isolated"} mode.`,
        ),
        failure: (error) => showSaveError(error, "Could not save the configuration mode."),
        settled: () => setSaving(null),
      },
    );
  }

  async function saveInstructions(scope: "all" | "bot") {
    const target = scope === "all" ? "all-instructions" : "bot-instructions";
    await saveRequestRef.current.run(
      (signal) => scope === "all"
        ? putAllBotsAgents(instructions.drafts.all, signal)
        : putThisBotAgents(bot.id, instructions.drafts.bot, signal),
      {
        pending: () => setSaving(target),
        success(saved) {
          setInstructions((state) => acceptBotInstructionSave(state, bot.id, scope, saved));
          if (scope === "all") {
            showSaved("Instructions saved", "Shared instructions now apply to all Bots.");
            return;
          }
          showSaved("Instructions saved", `Instructions for ${bot.name} were updated.`);
        },
        failure: (error) => showSaveError(error, "Could not save the instructions."),
        settled: () => setSaving(null),
      },
    );
  }

  function openComputer() {
    setExpandedInstructions(null);
    window.requestAnimationFrame(() => onOpenComputer(bot.id));
  }

  function closePanel() {
    onOpenChange(false);
  }

  if (!open) return null;

  return (
    <ToastProvider duration={3200} swipeDirection="right">
      <SelectedBotPanelFrame
        contentRef={contentRef}
        trapFocus={trapFocus}
        interactionSuspended={expandedInstructions !== null}
        onClose={closePanel}
      >
        <header className="flex min-h-[var(--header-height)] items-center justify-between gap-3 px-4">
          <div className="flex min-w-0 items-center gap-3">
            <Eyes
              name={bot.name}
              color={bot.eyes.color}
              shape={bot.eyes.shape as FaceShape}
              size={36}
              className="aspect-square shrink-0"
            />
            <div className="min-w-0">
              <h2 className="truncate text-sm font-semibold">{bot.name}</h2>
              <p className="truncate text-xs text-muted-foreground">Selected Bot</p>
            </div>
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                ref={closeButtonRef}
                type="button"
                size="icon"
                variant="ghost"
                aria-label="Close Bot panel"
                onClick={closePanel}
                className="min-h-[var(--touch-min)] min-w-[var(--touch-min)] shrink-0"
              >
                <X />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Close Bot panel</TooltipContent>
          </Tooltip>
        </header>

        <Separator />

        <div
          ref={scrollViewportRef}
          data-testid="selected-bot-panel-scroll"
          className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4"
        >
          <section aria-labelledby="computer-preview-heading" className="grid gap-2">
            <div className="flex items-center justify-between gap-2">
              <h3 id="computer-preview-heading" className="text-sm font-semibold">Computer</h3>
              <span className="text-xs text-muted-foreground">Live preview</span>
            </div>
            {computerPreviewVisible ? (
              <SelectedBotComputerPreview
                botName={bot.name}
                triggerRef={computerPreviewRef ?? localComputerPreviewRef}
                onOpen={openComputer}
              >
                <ComputerScreen
                  botId={bot.id}
                  expanded={false}
                  onClose={() => undefined}
                />
              </SelectedBotComputerPreview>
            ) : null}
          </section>

          <nav aria-label="Bot panel sections" className="flex flex-wrap gap-1">
            {BOT_SETTINGS_SECTIONS.map((item) => (
              <Button
                key={item}
                type="button"
                size="sm"
                variant={section === item ? "secondary" : "ghost"}
                aria-current={section === item ? "page" : undefined}
                onClick={() => onSectionChange(item)}
                className="max-[47.999rem]:min-h-[var(--touch-min)] max-[47.999rem]:min-w-[var(--touch-min)]"
              >
                {SECTION_LABELS[item]}
              </Button>
            ))}
          </nav>

          <Separator />

          <SettingsSection
            id="ai"
            title="Connection"
            description="Choose the local Connection used for new Sessions. OpenBot currently supports Codex for Talk."
          >
            {harnessesState === "loading" ? (
              <p className="rounded-[var(--radius-card)] bg-muted p-4 text-sm text-muted-foreground" role="status">
                Loading Connections…
              </p>
            ) : harnessesState === "error" ? (
              <div className="grid gap-3 rounded-[var(--radius-card)] bg-muted p-4 text-sm" role="alert">
                <p>Could not load Connections.</p>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={onRetryHarnesses}
                  className="min-h-[var(--touch-min)] justify-self-start"
                >
                  Retry
                </Button>
              </div>
            ) : connections.length > 0 ? (
              <div className="grid gap-2">
                <Label htmlFor="bot-connection">Connection</Label>
                <select
                  id="bot-connection"
                  value={bot.harness ?? ""}
                  disabled={saving !== null}
                  onChange={(event) => void chooseConnection(event.target.value)}
                  className="min-h-[var(--touch-min)] rounded-[var(--radius-control)] border border-input bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <option value="">Choose a Connection</option>
                  {unavailableConnection ? (
                    <option value={unavailableConnection.id} disabled>
                      {unavailableConnection.name} (unavailable)
                    </option>
                  ) : null}
                  {connections.map((connection) => (
                    <option key={connection.id} value={connection.id}>
                      {connection.name}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <div
                className="grid gap-1 rounded-[var(--radius-card)] bg-muted p-4 text-sm text-muted-foreground"
                role="status"
              >
                {unavailableConnection ? (
                  <p>
                    <span className="font-medium text-foreground">{unavailableConnection.name}</span>
                    {" "}(unavailable)
                  </p>
                ) : null}
                <p>No supported Connection is available on this Computer.</p>
              </div>
            )}
          </SettingsSection>

          <Separator />

          <SettingsSection
            id="instructions"
            title="Instructions"
            description="Edit the two canonical instruction files OpenBot already owns. Empty instructions are valid and can be saved."
          >
            <InstructionEditors
              bot={bot}
              instructions={instructions}
              savingScope={savingInstructionScope}
              expanded={expandedInstructions}
              expandButtonRefs={{
                all: allInstructionsExpandRef,
                bot: botInstructionsExpandRef,
              }}
              busy={saving !== null}
              onDraftChange={(scope, value) => setInstructions((state) =>
                editBotInstruction(state, bot.id, scope, value))}
              onSave={(scope) => void saveInstructions(scope)}
              onRetry={() => setInstructionsReload((current) => current + 1)}
              onExpandedChange={setExpandedInstructions}
            />
          </SettingsSection>

          <Separator />

          <SettingsSection
            id="computer-access"
            title="Computer & Access"
            description="Choose where this Bot loads its persisted configuration."
          >
            <div className="grid gap-2">
              <Label htmlFor="bot-environment">Configuration mode</Label>
              <select
                id="bot-environment"
                value={bot.configMode ?? "isolated"}
                disabled={saving !== null}
                onChange={(event) => void chooseEnvironment(event.target.value)}
                className="min-h-[var(--touch-min)] rounded-[var(--radius-control)] border border-input bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="isolated">Isolated (recommended)</option>
                <option value="host">Host</option>
              </select>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Isolated uses OpenBot Harness Home and this Bot directory. Host uses your real vendor home and host shell.
              </p>
            </div>
          </SettingsSection>
        </div>
      </SelectedBotPanelFrame>

      {feedback && computerPreviewVisible ? (
        <Toast key={feedback.id} className={feedback.error ? "border-destructive" : undefined}>
          <ToastTitle>{feedback.title}</ToastTitle>
          <ToastDescription>{feedback.description}</ToastDescription>
        </Toast>
      ) : null}
      <ToastViewport />
    </ToastProvider>
  );
}

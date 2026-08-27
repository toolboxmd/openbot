import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Monitor } from "lucide-react";
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
import {
  BOT_SETTINGS_SECTIONS,
  selectableAiConnections,
  type BotSettingsSection,
} from "@/lib/bot-settings";
import type { FaceShape } from "@/lib/face";
import { connectedFocusTarget } from "@/lib/first-use";
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

type SaveTarget = "ai" | "environment" | "all-instructions" | "bot-instructions";
type InstructionsState = "idle" | "loading" | "ready" | "error";

const SECTION_LABELS: Record<BotSettingsSection, string> = {
  ai: "AI",
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
        <h2 id={headingId} className="text-base font-semibold">
          {title}
        </h2>
        <p className="text-sm leading-relaxed text-muted-foreground">{description}</p>
      </div>
      {children}
    </section>
  );
}

export function BotSettings({
  bot,
  harnesses,
  harnessesState,
  open,
  onOpenChange,
  openerRef,
  fallbackFocusRef,
  onBotChange,
  onRetryHarnesses,
  onOpenComputer,
  section,
  onSectionChange,
}: {
  bot: Bot;
  harnesses: Harness[];
  harnessesState: "loading" | "ready" | "error";
  open: boolean;
  onOpenChange: (open: boolean) => void;
  openerRef: RefObject<HTMLButtonElement | null>;
  fallbackFocusRef: RefObject<HTMLElement | null>;
  onBotChange: (bot: Bot) => void;
  onRetryHarnesses: () => void;
  onOpenComputer: () => void;
  section: BotSettingsSection;
  onSectionChange: (section: BotSettingsSection) => void;
}) {
  const [allInstructions, setAllInstructions] = useState("");
  const [savedAllInstructions, setSavedAllInstructions] = useState("");
  const [botInstructions, setBotInstructions] = useState("");
  const [savedBotInstructions, setSavedBotInstructions] = useState("");
  const [instructionsState, setInstructionsState] = useState<InstructionsState>("idle");
  const [saving, setSaving] = useState<SaveTarget | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const connections = selectableAiConnections(harnesses);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setInstructionsState("loading");
    void Promise.all([getAllBotsAgents(), getThisBotAgents(bot.id)])
      .then(([all, own]) => {
        if (cancelled) return;
        setAllInstructions(all);
        setSavedAllInstructions(all);
        setBotInstructions(own);
        setSavedBotInstructions(own);
        setInstructionsState("ready");
      })
      .catch((error) => {
        if (cancelled) return;
        setFeedback({
          id: Date.now(),
          title: "Could not load instructions",
          description: errorMessage(error, "Try again after reopening Bot Settings."),
          error: true,
        });
        setInstructionsState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [bot.id, open]);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      if (section === "ai") {
        contentRef.current?.scrollTo({ top: 0 });
        return;
      }
      document.getElementById(`bot-settings-${section}`)?.scrollIntoView({ block: "start" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [instructionsState, open, section]);

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
    setSaving("ai");
    try {
      const updated = await pickHarness(bot.id, value);
      onBotChange(updated);
      showSaved("AI connection saved", `${updated.name} will use the selected connection for new Sessions.`);
    } catch (error) {
      showSaveError(error, "Could not save the AI connection.");
    } finally {
      setSaving(null);
    }
  }

  async function chooseEnvironment(value: string) {
    if (value !== "isolated" && value !== "host") return;
    if (value === (bot.configMode ?? "isolated")) return;
    setSaving("environment");
    try {
      const updated = await setConfigMode(bot.id, value);
      onBotChange(updated);
      showSaved("Environment saved", `${updated.name} will use ${value === "host" ? "Host" : "Isolated"} mode.`);
    } catch (error) {
      showSaveError(error, "Could not save the environment.");
    } finally {
      setSaving(null);
    }
  }

  async function saveInstructions(scope: "all" | "bot") {
    const target = scope === "all" ? "all-instructions" : "bot-instructions";
    setSaving(target);
    try {
      if (scope === "all") {
        const saved = await putAllBotsAgents(allInstructions);
        setAllInstructions(saved);
        setSavedAllInstructions(saved);
        showSaved("Instructions saved", "Shared instructions now apply to all Bots.");
      } else {
        const saved = await putThisBotAgents(bot.id, botInstructions);
        setBotInstructions(saved);
        setSavedBotInstructions(saved);
        showSaved("Instructions saved", `Instructions for ${bot.name} were updated.`);
      }
    } catch (error) {
      showSaveError(error, "Could not save the instructions.");
    } finally {
      setSaving(null);
    }
  }

  function openComputer() {
    onOpenChange(false);
    window.requestAnimationFrame(onOpenComputer);
  }

  return (
    <ToastProvider duration={3200} swipeDirection="right">
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          ref={contentRef}
          data-testid="bot-settings"
          aria-describedby="bot-settings-description"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            window.requestAnimationFrame(() => {
              connectedFocusTarget(openerRef.current, fallbackFocusRef.current)?.focus();
            });
          }}
        >
          <DialogHeader>
            <div className="flex items-center gap-3">
              <Eyes
                name={bot.name}
                color={bot.eyes.color}
                shape={bot.eyes.shape as FaceShape}
                size={36}
                className="aspect-square shrink-0"
              />
              <div className="min-w-0">
                <DialogTitle>Bot Settings</DialogTitle>
                <DialogDescription id="bot-settings-description" className="truncate">
                  Settings that currently work for {bot.name}.
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          <Separator />

          <nav aria-label="Bot Settings sections" className="flex flex-wrap gap-1">
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
            title="AI"
            description="Choose the local AI connection used for new Sessions. OpenBot currently supports Codex for Talk; Harness is the technical connection layer."
          >
            {harnessesState === "loading" ? (
              <p className="rounded-[var(--radius-card)] bg-muted p-4 text-sm text-muted-foreground" role="status">
                Loading AI connections…
              </p>
            ) : harnessesState === "error" ? (
              <div className="grid gap-3 rounded-[var(--radius-card)] bg-muted p-4 text-sm" role="alert">
                <p>Could not load AI connections.</p>
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
                <Label htmlFor="bot-ai-connection">AI connection</Label>
                <select
                  id="bot-ai-connection"
                  value={connections.some((connection) => connection.id === bot.harness) ? (bot.harness ?? "") : ""}
                  disabled={saving !== null}
                  onChange={(event) => void chooseConnection(event.target.value)}
                  className="min-h-[var(--touch-min)] rounded-[var(--radius-control)] border border-input bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <option value="">Choose an AI connection</option>
                  {connections.map((connection) => (
                    <option key={connection.id} value={connection.id}>
                      {connection.name}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <p className="rounded-[var(--radius-card)] bg-muted p-4 text-sm text-muted-foreground" role="status">
                No supported AI connection is available on this Computer.
              </p>
            )}
          </SettingsSection>

          <Separator />

          <SettingsSection
            id="instructions"
            title="Instructions"
            description="Edit the two instruction files OpenBot already owns. Empty instructions are valid and can be saved."
          >
            {instructionsState !== "ready" ? (
              <p className="rounded-[var(--radius-card)] bg-muted p-4 text-sm text-muted-foreground" role="status">
                {instructionsState === "loading"
                  ? "Loading instructions…"
                  : "Instructions are unavailable. Close and reopen Bot Settings to try again."}
              </p>
            ) : (
              <>
                <div className="grid gap-3 rounded-[var(--radius-card)] border bg-background p-4">
                  <div className="grid gap-1">
                    <Label htmlFor="all-bots-instructions">All Bots</Label>
                    <p className="text-xs text-muted-foreground">Shared Workspace instructions for every Bot.</p>
                  </div>
                  <Textarea
                    id="all-bots-instructions"
                    rows={6}
                    value={allInstructions}
                    disabled={saving !== null}
                    onChange={(event) => setAllInstructions(event.target.value)}
                    className="min-h-32 font-mono text-xs"
                  />
                  <Button
                    type="button"
                    size="sm"
                    disabled={saving !== null || allInstructions === savedAllInstructions}
                    onClick={() => void saveInstructions("all")}
                    className="justify-self-start max-[47.999rem]:min-h-[var(--touch-min)]"
                  >
                    Save All Bots
                  </Button>
                </div>

                <div className="grid gap-3 rounded-[var(--radius-card)] border bg-background p-4">
                  <div className="grid gap-1">
                    <Label htmlFor="this-bot-instructions">This Bot</Label>
                    <p className="text-xs text-muted-foreground">Instructions only for {bot.name}.</p>
                  </div>
                  <Textarea
                    id="this-bot-instructions"
                    rows={6}
                    value={botInstructions}
                    disabled={saving !== null}
                    onChange={(event) => setBotInstructions(event.target.value)}
                    className="min-h-32 font-mono text-xs"
                  />
                  <Button
                    type="button"
                    size="sm"
                    disabled={saving !== null || botInstructions === savedBotInstructions}
                    onClick={() => void saveInstructions("bot")}
                    className="justify-self-start max-[47.999rem]:min-h-[var(--touch-min)]"
                  >
                    Save This Bot
                  </Button>
                </div>
              </>
            )}
          </SettingsSection>

          <Separator />

          <SettingsSection
            id="computer-access"
            title="Computer & Access"
            description="Choose where this Bot loads its configuration, or open the same selected-Bot Screen used by Chat."
          >
            <div className="grid gap-2">
              <Label htmlFor="bot-environment">Environment</Label>
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

            <Button
              type="button"
              variant="outline"
              onClick={openComputer}
              className="justify-self-start max-[47.999rem]:min-h-[var(--touch-min)]"
            >
              <Monitor />
              Open Computer
            </Button>
          </SettingsSection>
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

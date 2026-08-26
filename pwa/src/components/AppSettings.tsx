import { useEffect, useState } from "react";
import { Laptop, Moon, Settings, Sun } from "lucide-react";
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
import { Toast, ToastDescription, ToastProvider, ToastTitle, ToastViewport } from "@/components/ui/toast";
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

const APPEARANCE_SETTINGS_HASH = "#settings/appearance";

function appearanceSettingsRequested() {
  return window.location.hash === APPEARANCE_SETTINGS_HASH;
}

export function AppSettings({ className }: { className?: string }) {
  const { preferences, effectiveTheme, updateTheme } = useUiPreferences();
  const [open, setOpen] = useState(appearanceSettingsRequested);
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  useEffect(() => {
    const syncWithLocation = () => setOpen(appearanceSettingsRequested());
    window.addEventListener("hashchange", syncWithLocation);
    window.addEventListener("popstate", syncWithLocation);
    return () => {
      window.removeEventListener("hashchange", syncWithLocation);
      window.removeEventListener("popstate", syncWithLocation);
    };
  }, []);

  function setAppSettingsOpen(next: boolean) {
    setOpen(next);
    const suffix = next ? APPEARANCE_SETTINGS_HASH : "";
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
              Preferences for OpenBot on this browser.
            </DialogDescription>
          </DialogHeader>

          <Separator />

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
              value={preferences.theme}
              onValueChange={chooseTheme}
              aria-label="Appearance"
              className="sm:grid-cols-3"
            >
              {APPEARANCE_CHOICES.map((choice) => {
                const Icon = choice.icon;
                const selected = preferences.theme === choice.value;
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

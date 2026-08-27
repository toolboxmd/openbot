import { forwardRef, useId, useState, type ComponentPropsWithoutRef } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  HOST_GRANT_DURATIONS,
  type HostGrantDurationId,
} from "@/lib/harness-home";
import type {
  TranscriptCard as TranscriptCardModel,
  TranscriptCardAction,
} from "@/lib/session";
import { cn } from "@/lib/utils";

type TranscriptCardProps = Omit<ComponentPropsWithoutRef<"article">, "onAction"> & {
  card: TranscriptCardModel;
  busy?: boolean;
  onAction: (action: TranscriptCardAction, duration?: HostGrantDurationId) => void;
};

const STATUS_CLASS: Record<TranscriptCardModel["status"]["tone"], string> = {
  neutral: "bg-muted text-muted-foreground",
  waiting: "bg-warning/10 text-warning",
  success: "bg-success/10 text-success",
  danger: "bg-destructive/10 text-destructive",
};

export const TranscriptCard = forwardRef<HTMLElement, TranscriptCardProps>(function TranscriptCard(
  { card, busy = false, className, onAction, ...articleProps },
  ref,
) {
  const titleId = useId();
  const [duration, setDuration] = useState<HostGrantDurationId>("session");
  const hostGrantPending = card.kind === "host-grant"
    && card.actions.some((action) => action.command.kind === "host-grant");

  return (
    <article
      {...articleProps}
      ref={ref}
      data-testid="transcript-card"
      data-card-kind={card.kind}
      aria-labelledby={titleId}
      tabIndex={0}
      aria-busy={busy || undefined}
      className={cn(
        "grid gap-3 rounded-[var(--radius-card)] border border-border bg-card px-4 py-4 text-card-foreground shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background min-[48rem]:px-5",
        className,
      )}
    >
      <header className="flex flex-wrap items-start justify-between gap-2">
        <h3 id={titleId} className="text-sm font-semibold leading-5">
          {card.title}
        </h3>
        <span
          role="status"
          data-card-status={card.status.tone}
          className={cn("rounded-full px-2 py-1 text-xs font-medium", STATUS_CLASS[card.status.tone])}
        >
          {card.status.label}
        </span>
      </header>
      <p className="text-sm leading-5 text-muted-foreground">{card.body}</p>
      {card.preview ? (
        <pre
          aria-label={card.kind === "host-grant" ? "Requested path" : "Card preview"}
          className="overflow-x-auto whitespace-pre-wrap break-all rounded-[var(--radius-control)] bg-muted px-3 py-2 font-mono text-xs leading-5"
        >
          {card.preview}
        </pre>
      ) : null}
      {hostGrantPending ? (
        <fieldset className="grid gap-2">
          <legend className="text-xs font-medium text-muted-foreground">How long</legend>
          <RadioGroup
            value={duration}
            disabled={busy}
            onValueChange={(value) => setDuration(value as HostGrantDurationId)}
            className="flex flex-wrap gap-2"
          >
            {HOST_GRANT_DURATIONS.map((item) => (
              <Label
                key={item.id}
                className="flex min-h-[var(--touch-min)] cursor-pointer items-center gap-2 rounded-[var(--radius-control)] border border-border px-3 text-sm has-[[data-state=checked]]:border-primary"
              >
                <RadioGroupItem value={item.id} aria-label={item.label} />
                {item.label}
              </Label>
            ))}
          </RadioGroup>
        </fieldset>
      ) : null}
      {card.actions.length > 0 ? (
        <footer className="flex flex-wrap gap-2 pt-1">
          {card.actions.map((action) => (
            <Button
              key={action.id}
              data-card-action={action.command.kind}
              type="button"
              size="sm"
              variant={action.intent === "primary" ? "default" : "outline"}
              disabled={busy}
              aria-label={action.label}
              className="min-h-[var(--touch-min)]"
              onClick={() => onAction(action, action.command.kind === "host-grant" ? duration : undefined)}
            >
              {action.label}
            </Button>
          ))}
        </footer>
      ) : null}
    </article>
  );
});

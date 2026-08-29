import { useEffect, useRef, useState, type FormEvent, type RefObject } from "react";
import { Check, MessageSquare } from "lucide-react";
import { StackedEyes } from "@/components/StackedEyes";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Toast, ToastDescription, ToastProvider, ToastTitle, ToastViewport } from "@/components/ui/toast";
import { newChannelValidation, type Channel } from "@/lib/channels";
import type { Bot } from "@/lib/session";
import { cn } from "@/lib/utils";

export function NewChannelDialog({
  open,
  onOpenChange,
  openerRef,
  destinationRef,
  bots,
  onCreate,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  openerRef: RefObject<HTMLButtonElement | null>;
  destinationRef: RefObject<HTMLElement | null>;
  bots: Bot[];
  onCreate: (input: { title: string; botIds: string[] }) => Promise<Channel>;
  onCreated: (channel: Channel) => void;
}) {
  const [title, setTitle] = useState("");
  const [titleTouched, setTitleTouched] = useState(false);
  const [selectedBotIds, setSelectedBotIds] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [createError, setCreateError] = useState<{ id: number; message: string } | null>(null);
  const createdRef = useRef(false);
  const submissionRef = useRef<symbol | null>(null);
  const validation = newChannelValidation(title, selectedBotIds);
  const selectedBots = validation.botIds.flatMap((id) => {
    const bot = bots.find((candidate) => candidate.id === id);
    return bot ? [bot] : [];
  });

  useEffect(() => {
    if (!open) return;
    setTitle("");
    setTitleTouched(false);
    setSelectedBotIds([]);
    setSubmitting(false);
    setCreateError(null);
    createdRef.current = false;
    submissionRef.current = null;
  }, [open]);

  function toggleBot(botId: string) {
    setSelectedBotIds((current) => current.includes(botId)
      ? current.filter((id) => id !== botId)
      : [...current, botId]);
    setCreateError(null);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTitleTouched(true);
    if (!validation.valid || submissionRef.current !== null) return;
    const submission = Symbol("new-channel-submit");
    submissionRef.current = submission;
    setSubmitting(true);
    setCreateError(null);
    try {
      const channel = await onCreate({ title: validation.title, botIds: validation.botIds });
      if (submissionRef.current !== submission) return;
      createdRef.current = true;
      onCreated(channel);
      onOpenChange(false);
    } catch (caught) {
      if (submissionRef.current !== submission) return;
      setCreateError({
        id: Date.now(),
        message: caught instanceof Error ? caught.message : "Could not create Channel.",
      });
    } finally {
      if (submissionRef.current === submission) {
        submissionRef.current = null;
        setSubmitting(false);
      }
    }
  }

  function changeOpen(next: boolean) {
    if (!next && submissionRef.current !== null) return;
    onOpenChange(next);
  }

  return (
    <ToastProvider duration={3200} swipeDirection="right">
      <Dialog open={open} onOpenChange={changeOpen}>
        <DialogContent
          showCloseButton={!submitting}
          className="min-[48rem]:max-w-md"
          aria-describedby="new-channel-description"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            window.requestAnimationFrame(() => {
              if (createdRef.current) {
                destinationRef.current?.focus();
                return;
              }
              openerRef.current?.focus();
            });
          }}
        >
          <DialogHeader>
            <div className="mb-2 flex size-10 items-center justify-center rounded-[var(--radius-card)] bg-muted">
              <MessageSquare
                aria-hidden="true"
                className="size-[var(--icon-default)] [stroke-width:var(--icon-stroke)]"
              />
            </div>
            <DialogTitle>New Channel</DialogTitle>
            <DialogDescription id="new-channel-description">
              Give this Chat a title and choose at least two existing Bots.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={submit} className="grid gap-5" noValidate>
            <div className="grid gap-2">
              <Label htmlFor="new-channel-title">Title</Label>
              <Input
                id="new-channel-title"
                name="channel-title"
                autoFocus
                required
                value={title}
                aria-invalid={titleTouched && validation.titleError !== null}
                aria-describedby={titleTouched && validation.titleError ? "new-channel-title-error" : undefined}
                placeholder="Launch crew"
                disabled={submitting}
                onBlur={() => setTitleTouched(true)}
                onChange={(event) => {
                  setTitle(event.target.value);
                  setCreateError(null);
                }}
              />
              {titleTouched && validation.titleError ? (
                <p id="new-channel-title-error" className="text-sm text-destructive" role="alert">
                  {validation.titleError}
                </p>
              ) : null}
            </div>

            <div className="grid gap-2">
              <div className="flex min-h-8 items-center justify-between gap-3">
                <Label id="new-channel-bots-label">Bots</Label>
                {selectedBots.length > 0 ? (
                  <StackedEyes
                    faces={selectedBots.map((bot) => ({
                      name: bot.name,
                      color: bot.eyes.color,
                      shape: bot.eyes.shape,
                    }))}
                    size={28}
                  />
                ) : null}
              </div>
              <div
                role="group"
                aria-labelledby="new-channel-bots-label"
                aria-describedby={validation.membersError ? "new-channel-bots-error" : undefined}
                className="grid max-h-56 gap-1 overflow-y-auto rounded-[var(--radius-control)] border p-1"
              >
                {bots.map((bot) => {
                  const selected = validation.botIds.includes(bot.id);
                  return (
                    <Button
                      key={bot.id}
                      type="button"
                      variant="ghost"
                      aria-pressed={selected}
                      disabled={submitting}
                      onClick={() => toggleBot(bot.id)}
                      className={cn(
                        "min-h-[var(--touch-min)] justify-start gap-3 px-3",
                        selected && "bg-muted",
                      )}
                    >
                      <StackedEyes
                        faces={[{ name: bot.name, color: bot.eyes.color, shape: bot.eyes.shape }]}
                        size={28}
                      />
                      <span className="min-w-0 flex-1 truncate text-left">{bot.name}</span>
                      {selected ? <Check aria-hidden="true" className="size-[var(--icon-small)]" /> : null}
                    </Button>
                  );
                })}
              </div>
              {validation.membersError ? (
                <p id="new-channel-bots-error" className="text-sm text-muted-foreground">
                  {validation.membersError}
                </p>
              ) : null}
            </div>

            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                disabled={submitting}
                onClick={() => changeOpen(false)}
                className="min-h-[var(--touch-min)]"
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={!validation.valid || submitting}
                className="min-h-[var(--touch-min)]"
              >
                {submitting ? "Creating…" : "Create Channel"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {createError ? (
        <Toast key={createError.id} className="border-destructive">
          <ToastTitle>Channel not created</ToastTitle>
          <ToastDescription>{createError.message}</ToastDescription>
        </Toast>
      ) : null}
      <ToastViewport />
    </ToastProvider>
  );
}

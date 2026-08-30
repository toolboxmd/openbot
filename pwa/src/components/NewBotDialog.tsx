import { useEffect, useRef, useState, type FormEvent, type RefObject } from "react";
import { Bot } from "lucide-react";
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
import { botNameValidation } from "@/lib/first-use";
import type { Bot as OpenBot } from "@/lib/session";

export function NewBotDialog({
  open,
  onOpenChange,
  openerRef,
  destinationRef,
  onCreate,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  openerRef: RefObject<HTMLButtonElement | null>;
  destinationRef: RefObject<HTMLElement | null>;
  onCreate: (name: string) => Promise<OpenBot>;
  onCreated: (bot: OpenBot) => void;
}) {
  const [name, setName] = useState("");
  const [edited, setEdited] = useState(false);
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [createError, setCreateError] = useState<{ id: number; message: string } | null>(null);
  const createdRef = useRef(false);
  const validation = botNameValidation(name);

  useEffect(() => {
    if (!open) return;
    setName("");
    setEdited(false);
    setTouched(false);
    setSubmitting(false);
    setCreateError(null);
    createdRef.current = false;
  }, [open]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTouched(true);
    if (!validation.valid || submitting) return;
    setSubmitting(true);
    setCreateError(null);
    try {
      const bot = await onCreate(validation.name);
      createdRef.current = true;
      onCreated(bot);
      onOpenChange(false);
    } catch (caught) {
      setCreateError({
        id: Date.now(),
        message: caught instanceof Error ? caught.message : "Could not create Bot.",
      });
    } finally {
      setSubmitting(false);
    }
  }

  function changeOpen(next: boolean) {
    if (!next && submitting) return;
    onOpenChange(next);
  }

  return (
    <ToastProvider duration={3200} swipeDirection="right">
      <Dialog open={open} onOpenChange={changeOpen}>
        <DialogContent
          showCloseButton={!submitting}
          className="min-[48rem]:max-w-sm"
          aria-describedby="new-bot-description"
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
              <Bot
                aria-hidden="true"
                className="size-[var(--icon-default)] [stroke-width:var(--icon-stroke)]"
              />
            </div>
            <DialogTitle>New Bot</DialogTitle>
            <DialogDescription id="new-bot-description">
              Give your Bot a name. When created, it copies the current App Settings defaults.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={submit} className="grid gap-5" noValidate>
            <div className="grid gap-2">
              <Label htmlFor="new-bot-name">Name</Label>
              <Input
                id="new-bot-name"
                name="bot-name"
                autoFocus
                required
                value={name}
                aria-invalid={touched && !validation.valid}
                aria-describedby={touched && !validation.valid ? "new-bot-name-error" : undefined}
                placeholder="Ada"
                disabled={submitting}
                onBlur={() => {
                  if (edited) setTouched(true);
                }}
                onChange={(event) => {
                  setName(event.target.value);
                  setEdited(true);
                  setCreateError(null);
                }}
              />
              {touched && !validation.valid ? (
                <p id="new-bot-name-error" className="text-sm text-destructive" role="alert">
                  {validation.error}
                </p>
              ) : null}
            </div>

            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                disabled={submitting}
                onClick={() => onOpenChange(false)}
                className="min-h-[var(--touch-min)]"
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={!validation.valid || submitting}
                className="min-h-[var(--touch-min)]"
              >
                {submitting ? "Creating…" : "Create Bot"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {createError ? (
        <Toast key={createError.id} className="border-destructive">
          <ToastTitle>Bot not created</ToastTitle>
          <ToastDescription>{createError.message}</ToastDescription>
        </Toast>
      ) : null}
      <ToastViewport />
    </ToastProvider>
  );
}

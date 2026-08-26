import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogClose = DialogPrimitive.Close;

function DialogPortal(props: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogOverlay({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-[var(--scrim)]",
        className,
      )}
      {...props}
    />
  );
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & { showCloseButton?: boolean }) {
  const [closeTooltipOpen, setCloseTooltipOpen] = React.useState(false);

  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          "fixed left-1/2 top-1/2 z-50 grid max-h-[calc(100dvh-1.5rem)] w-[calc(100%-1.5rem)] max-w-[var(--dialog-max-width)] -translate-x-1/2 -translate-y-1/2 gap-5 overflow-y-auto rounded-[var(--radius-dialog)] border bg-surface p-6 text-foreground shadow-[var(--shadow-dialog)] outline-none",
          "max-[47.999rem]:inset-0 max-[47.999rem]:h-dvh max-[47.999rem]:max-h-none max-[47.999rem]:w-full max-[47.999rem]:max-w-none max-[47.999rem]:translate-x-0 max-[47.999rem]:translate-y-0 max-[47.999rem]:rounded-none max-[47.999rem]:border-0 max-[47.999rem]:p-5",
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton ? (
          <Tooltip open={closeTooltipOpen} onOpenChange={setCloseTooltipOpen}>
            <TooltipTrigger asChild>
              <DialogPrimitive.Close
                className="absolute right-3 top-3 inline-flex min-h-[var(--touch-min)] min-w-[var(--touch-min)] items-center justify-center rounded-[var(--radius-control)] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label="Close"
                onBlur={() => setCloseTooltipOpen(false)}
                onFocus={() => setCloseTooltipOpen(true)}
                onPointerEnter={() => setCloseTooltipOpen(true)}
                onPointerLeave={() => setCloseTooltipOpen(false)}
              >
                <X className="size-[var(--icon-default)]" strokeWidth="var(--icon-stroke)" />
              </DialogPrimitive.Close>
            </TooltipTrigger>
            <TooltipContent>Close</TooltipContent>
          </Tooltip>
        ) : null}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("grid gap-1 pr-10", className)} {...props} />;
}

function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title className={cn("text-xl font-semibold leading-tight", className)} {...props} />
  );
}

function DialogDescription({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      className={cn("text-sm leading-relaxed text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};

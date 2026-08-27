import * as React from "react";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { cn } from "@/lib/utils";

const DropdownMenu = DropdownMenuPrimitive.Root;
const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;
const DropdownMenuItemIndicator = DropdownMenuPrimitive.ItemIndicator;

function DropdownMenuContent({
  className,
  sideOffset = 6,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        sideOffset={sideOffset}
        className={cn(
          "z-50 min-w-44 overflow-hidden rounded-[var(--radius-card)] border bg-popover p-1 text-popover-foreground shadow-[var(--shadow-popover)] outline-none",
          className,
        )}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

function DropdownMenuItem({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item>) {
  return (
    <DropdownMenuPrimitive.Item
      className={cn(
        "flex min-h-10 cursor-default select-none items-center gap-2 rounded-[var(--radius-control)] px-3 py-2 text-sm outline-none data-[disabled]:pointer-events-none data-[highlighted]:bg-muted data-[disabled]:opacity-50 max-[47.999rem]:min-h-[var(--touch-min)] [&_svg]:pointer-events-none [&_svg]:size-[var(--icon-default)] [&_svg]:shrink-0 [&_svg]:[stroke-width:var(--icon-stroke)]",
        className,
      )}
      {...props}
    />
  );
}

function DropdownMenuCheckboxItem({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.CheckboxItem>) {
  return (
    <DropdownMenuPrimitive.CheckboxItem
      className={cn(
        "flex min-h-10 cursor-default select-none items-center gap-2 rounded-[var(--radius-control)] px-3 py-2 text-sm outline-none data-[disabled]:pointer-events-none data-[highlighted]:bg-muted data-[state=checked]:bg-muted data-[disabled]:opacity-50 max-[47.999rem]:min-h-[var(--touch-min)] [&_svg]:pointer-events-none [&_svg]:size-[var(--icon-default)] [&_svg]:shrink-0 [&_svg]:[stroke-width:var(--icon-stroke)]",
        className,
      )}
      {...props}
    />
  );
}

export {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItemIndicator,
  DropdownMenuItem,
  DropdownMenuTrigger,
};

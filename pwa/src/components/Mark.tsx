import { cn } from "@/lib/utils";

type Props = {
  className?: string;
  size?: "sm" | "md";
};

export function Mark({ className, size = "md" }: Props) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex items-center justify-center rounded-2xl bg-[#e36b7a]",
        size === "sm" ? "size-8" : "size-10",
        className,
      )}
    >
      <span className="flex items-center gap-1">
        <span className={cn("rounded-full bg-[#f4f2ef]", size === "sm" ? "h-3 w-1.5" : "h-4 w-2")} />
        <span className={cn("rounded-full bg-[#f4f2ef]", size === "sm" ? "h-3 w-1.5" : "h-4 w-2")} />
      </span>
    </span>
  );
}

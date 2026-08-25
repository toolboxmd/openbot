import { Eyes } from "@/components/Eyes";
import type { FaceShape } from "@/lib/face";
import { cn } from "@/lib/utils";

export type StackedFace = {
  name: string;
  color?: string;
  shape?: FaceShape | string;
};

type Props = {
  faces: StackedFace[];
  size?: number;
  className?: string;
};

export function StackedEyes({ faces, size = 28, className }: Props) {
  const shown = faces.slice(0, 3);
  const overlap = Math.round(size * 0.42);
  const width = shown.length === 0 ? size : size + overlap * (shown.length - 1);
  return (
    <span
      data-testid="stacked-eyes"
      className={cn("relative inline-flex shrink-0 items-center", className)}
      style={{ width, height: size }}
    >
      {shown.map((face, index) => (
        <span
          key={`${face.name}:${index}`}
          className="absolute top-0 rounded-full bg-sidebar"
          style={{ left: index * overlap, zIndex: shown.length - index }}
        >
          <Eyes
            name={face.name}
            color={face.color}
            shape={face.shape as FaceShape | undefined}
            size={size}
            className="aspect-square shrink-0"
          />
        </span>
      ))}
    </span>
  );
}

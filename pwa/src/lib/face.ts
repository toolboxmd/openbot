export const SHAPES = ["disc", "squircle", "stadium", "shield", "bean", "diamond"] as const;
export type FaceShape = (typeof SHAPES)[number];

export const COLORS = [
  "#e36b7a",
  "#e08a4a",
  "#d4b03a",
  "#6db58a",
  "#5aa8c9",
  "#6b8ae8",
  "#8b74d8",
  "#c46bb5",
  "#c97a7a",
  "#8a9098",
];

export const EYE = "#f4f2ef";

export type FaceMode = "idle" | "think" | "work" | "needs-you" | "sleep";

export function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function pickShape(name: string, taken: Iterable<FaceShape> = []): FaceShape {
  const used = new Set(taken);
  const start = hash32(name.toLowerCase()) % SHAPES.length;
  for (let i = 0; i < SHAPES.length; i++) {
    const s = SHAPES[(start + i) % SHAPES.length];
    if (!used.has(s)) return s;
  }
  return SHAPES[start];
}

export function pickColor(name: string): string {
  return COLORS[hash32(`${name.toLowerCase()}#`) % COLORS.length];
}

export type BodySpec =
  | { type: "ellipse"; cx: number; cy: number; rx: number; ry: number }
  | { type: "rect"; x: number; y: number; w: number; h: number; rx: number }
  | { type: "path"; d: string };

export function bodyPath(shape: FaceShape): BodySpec {
  if (shape === "disc") return { type: "ellipse", cx: 50, cy: 50, rx: 46, ry: 46 };
  if (shape === "squircle") return { type: "rect", x: 10, y: 10, w: 80, h: 80, rx: 26 };
  if (shape === "stadium") return { type: "rect", x: 4, y: 22, w: 92, h: 56, rx: 28 };
  if (shape === "shield") return { type: "path", d: "M50 8 L88 24 L82 62 Q50 94 18 62 L12 24 Z" };
  if (shape === "bean") {
    return {
      type: "path",
      d: "M24 32 C16 12 42 6 54 16 C72 6 92 20 86 42 C94 72 70 94 46 88 C20 94 8 68 16 46 C12 40 20 34 24 32 Z",
    };
  }
  return { type: "path", d: "M50 10 L90 50 L50 90 L10 50 Z" };
}

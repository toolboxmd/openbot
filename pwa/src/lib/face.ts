export const SHAPES = ["sphere", "capsule", "rounded-cube", "diamond", "bean", "shield"] as const;
export type FaceShape = (typeof SHAPES)[number];

/** Saturated chat colors. OpenBot itself is black, not in this list. */
export const COLORS = [
  "#ff3b5c",
  "#ff7a1a",
  "#ffd11a",
  "#1ec96b",
  "#2f8cff",
  "#6d5cff",
  "#c44dff",
  "#ff2ea6",
];

export const OPENBOT_COLOR = "#141414";
export const EYE = "#f4f2ef";

/** Inset so the fitted silhouette sits inside the square canvas. */
export const FACE_PAD = 0.04;

export type FaceMode = "idle" | "think" | "work" | "write" | "needs-you" | "sleep";

export type Vec3 = { x: number; y: number; z: number };
export type Vec2 = { x: number; y: number };

export type ShapeFit = {
  scale: number;
  originX: number;
  originY: number;
  width: number;
  height: number;
  maxDim: number;
};

export function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function isDefaultBot(name: string): boolean {
  return name.toLowerCase() === "openbot";
}

export function pickShape(name: string, taken: Iterable<FaceShape> = []): FaceShape {
  if (isDefaultBot(name)) return "sphere";
  const used = new Set(taken);
  const start = hash32(name.toLowerCase()) % SHAPES.length;
  for (let i = 0; i < SHAPES.length; i++) {
    const s = SHAPES[(start + i) % SHAPES.length];
    if (s === "sphere") continue;
    if (!used.has(s)) return s;
  }
  return SHAPES[(start + 1) % SHAPES.length];
}

export function pickColor(name: string): string {
  if (isDefaultBot(name)) return OPENBOT_COLOR;
  return COLORS[hash32(`${name.toLowerCase()}#`) % COLORS.length];
}

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
/** Inset so the fitted hull sits inside the square canvas. */
export const FACE_PAD = 0.04;

export type EyesMode = "idle" | "think" | "work" | "write" | "needs-you" | "sleep";

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

export function rotY(p: Vec3, a: number): Vec3 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { x: p.x * c + p.z * s, y: p.y, z: -p.x * s + p.z * c };
}

export function rotX(p: Vec3, a: number): Vec3 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { x: p.x, y: p.y * c - p.z * s, z: p.y * s + p.z * c };
}

export function norm(p: Vec3): Vec3 {
  const l = Math.hypot(p.x, p.y, p.z) || 1;
  return { x: p.x / l, y: p.y / l, z: p.z / l };
}

/**
 * Stretch a unit-sphere point into the hashed 3D body.
 * Named shapes stay volumes (capsule, superellipsoid, octahedron, lima, heater).
 * Do not renormalize back onto the sphere — that would make every silhouette a circle.
 */
export function deform(p: Vec3, shape: FaceShape): Vec3 {
  if (shape === "capsule") {
    const R = 0.62;
    const H = 0.38;
    return { x: p.x * R, y: p.y * R + Math.sign(p.y) * H, z: p.z * R };
  }
  if (shape === "rounded-cube") {
    const n = 4;
    const s = (Math.abs(p.x) ** n + Math.abs(p.y) ** n + Math.abs(p.z) ** n) ** (1 / n) || 1;
    return { x: p.x / s, y: p.y / s, z: p.z / s };
  }
  if (shape === "diamond") {
    const s = (Math.abs(p.x) + Math.abs(p.y) + Math.abs(p.z)) || 1;
    return { x: p.x / s, y: p.y / s, z: p.z / s };
  }
  if (shape === "bean") {
    const u = (p.x + 1) / 2;
    const ry = 0.42 + 0.38 * u;
    return { x: p.x * 0.95 + 0.12, y: p.y * ry, z: p.z * ry * 0.85 };
  }
  if (shape === "shield") {
    const t = (p.y + 1) / 2;
    const width = 0.28 + 0.72 * Math.sqrt(Math.max(0, t));
    return { x: p.x * width, y: p.y * 1.08, z: p.z * width * 0.5 };
  }
  return p;
}

function fibonacciSphere(n: number): Vec3[] {
  const pts: Vec3[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    pts.push({ x: Math.cos(theta) * r, y, z: Math.sin(theta) * r });
  }
  return pts;
}

const UNIT_SPHERE = fibonacciSphere(512);

export function convexHull(points: Vec2[]): Vec2[] {
  const pts = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length <= 2) return pts;
  const cross = (o: Vec2, a: Vec2, b: Vec2) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Vec2[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Vec2[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function projectXY(p: Vec3, yaw: number): Vec2 {
  const r = rotY(p, yaw);
  return { x: r.x, y: r.y };
}

/** Rest-pose (or yawed) 3D→XY hull bounds, y-up. */
export function shapeBounds(shape: FaceShape, yaw = 0): {
  hull: Vec2[];
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  width: number;
  height: number;
} {
  const pts = UNIT_SPHERE.map((p) => projectXY(deform(p, shape), yaw));
  const hull = convexHull(pts);
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of hull) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { hull, minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY };
}

/** Uniform scale + origin so the rest-pose hull's longest axis equals size × (1 − 2×padding). */
export function shapeFit(shape: FaceShape, size: number, padding = FACE_PAD): ShapeFit {
  const bounds = shapeBounds(shape, 0);
  const inner = size * (1 - 2 * padding);
  const maxDim3 = Math.max(bounds.width, bounds.height) || 1;
  const scale = inner / maxDim3;
  return {
    scale,
    originX: (bounds.minX + bounds.maxX) / 2,
    originY: (bounds.minY + bounds.maxY) / 2,
    width: bounds.width * scale,
    height: bounds.height * scale,
    maxDim: maxDim3 * scale,
  };
}

export function projectPoint(p: Vec3, fit: ShapeFit, size: number): Vec2 {
  return {
    x: size / 2 + (p.x - fit.originX) * fit.scale,
    y: size / 2 - (p.y - fit.originY) * fit.scale,
  };
}

/** Canvas-space convex hull of the deformed sphere at yaw. */
export function shapeOutline(shape: FaceShape, yaw: number, fit: ShapeFit, size: number): Vec2[] {
  const pts = UNIT_SPHERE.map((p) => projectPoint(rotY(deform(p, shape), yaw), fit, size));
  return convexHull(pts);
}

export function shapeZExtent(shape: FaceShape): number {
  let m = 0;
  for (const p of UNIT_SPHERE) {
    m = Math.max(m, Math.abs(deform(p, shape).z));
  }
  return m || 1;
}

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

export type FacePose = {
  lid: number;
  eye: number;
  look: Vec2;
  nod: number;
};

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

export function facePoseAt(mode: FaceMode, elapsedSeconds = 0, reducedMotion = false): FacePose {
  if (mode === "think") return { lid: 0.12, eye: 0.92, look: { x: 0.28, y: -0.35 }, nod: 0 };
  if (mode === "work" || mode === "write") {
    const focus = reducedMotion
      ? 0.5
      : (1 - Math.cos((elapsedSeconds / 0.9) * Math.PI * 2)) / 2;
    return {
      lid: 0.34 + focus * 0.12,
      eye: 0.96 - focus * 0.04,
      look: { x: 0, y: 0.2 + focus * 0.035 },
      nod: focus * 1.3,
    };
  }
  if (mode === "needs-you") return { lid: 0, eye: 1.18, look: { x: 0, y: 0 }, nod: 0 };
  if (mode === "sleep") return { lid: 0.88, eye: 1.05, look: { x: 0, y: 0 }, nod: 0 };
  return { lid: 0.04, eye: 1, look: { x: 0, y: 0 }, nod: 0 };
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
 * Stretch a unit-sphere point into the hashed 3D body so the eyes can ride it.
 * Do not renormalize back onto the sphere — that would glue every face to a circle.
 */
export function deform(p: Vec3, shape: FaceShape): Vec3 {
  if (shape === "capsule") {
    return { x: p.x * 0.9, y: p.y * 0.88, z: p.z * 0.82 };
  }
  if (shape === "rounded-cube") {
    return { x: p.x * 0.92, y: p.y * 0.92, z: p.z * 0.88 };
  }
  if (shape === "diamond") {
    return { x: p.x * 0.88, y: p.y * 0.88, z: p.z * 0.8 };
  }
  if (shape === "bean") {
    return { x: p.x * 0.9, y: p.y * 0.88, z: p.z * 0.8 };
  }
  if (shape === "shield") {
    return { x: p.x * 0.9, y: p.y * 0.88, z: p.z * 0.78 };
  }
  return p;
}

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

export function shoelace(pts: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    a += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
  }
  return Math.abs(a / 2);
}

function sampledContour(pointAt: (angle: number) => Vec2, steps = 192): Vec2[] {
  return Array.from({ length: steps }, (_, index) => pointAt((index / steps) * Math.PI * 2));
}

function superellipseContour(width: number, height: number, exponent: number): Vec2[] {
  return sampledContour((angle) => {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return {
      x: width * Math.sign(cos) * Math.abs(cos) ** (2 / exponent),
      y: height * Math.sign(sin) * Math.abs(sin) ** (2 / exponent),
    };
  });
}

function mixPoint(a: Vec2, b: Vec2, amount: number): Vec2 {
  return { x: a.x + (b.x - a.x) * amount, y: a.y + (b.y - a.y) * amount };
}

function quadraticPoint(start: Vec2, control: Vec2, end: Vec2, amount: number): Vec2 {
  const remaining = 1 - amount;
  return {
    x: remaining * remaining * start.x + 2 * remaining * amount * control.x + amount * amount * end.x,
    y: remaining * remaining * start.y + 2 * remaining * amount * control.y + amount * amount * end.y,
  };
}

function roundedPolygonContour(sides: number, radiusX: number, radiusY: number, rotation: number): Vec2[] {
  const vertices = Array.from({ length: sides }, (_, index) => {
    const angle = rotation + (index / sides) * Math.PI * 2;
    return { x: Math.cos(angle) * radiusX, y: Math.sin(angle) * radiusY };
  });
  const points: Vec2[] = [];
  const rounding = 0.24;
  const cornerSteps = 12;
  const edgeSteps = 20;

  for (let index = 0; index < vertices.length; index += 1) {
    const previous = vertices[(index - 1 + vertices.length) % vertices.length];
    const vertex = vertices[index];
    const next = vertices[(index + 1) % vertices.length];
    const cornerStart = mixPoint(vertex, previous, rounding);
    const cornerEnd = mixPoint(vertex, next, rounding);
    const nextIncoming = mixPoint(next, vertex, rounding);

    for (let step = 0; step < cornerSteps; step += 1) {
      points.push(quadraticPoint(cornerStart, vertex, cornerEnd, step / cornerSteps));
    }
    for (let step = 0; step < edgeSteps; step += 1) {
      points.push(mixPoint(cornerEnd, nextIncoming, step / edgeSteps));
    }
  }

  return points;
}

/**
 * Rest-pose 2D silhouette (y-up). The stored shape names are kept for Home
 * compatibility, while every named contour is now dense, smooth, and square.
 * The outline stays fixed under yaw so looking never squashes a 2D identity.
 */
export function shapeContour(shape: FaceShape, yaw = 0): Vec2[] {
  void yaw;
  if (shape === "sphere") {
    return sampledContour((angle) => ({ x: Math.cos(angle), y: Math.sin(angle) }));
  }
  if (shape === "capsule") {
    // Legacy key: a soft, almost-square pebble rather than a tall pill.
    return superellipseContour(0.95, 0.91, 2.6);
  }
  if (shape === "rounded-cube") {
    return superellipseContour(0.94, 0.94, 4.4);
  }
  if (shape === "diamond") {
    // A continuously rounded lozenge, never a four-segment jagged hull.
    return superellipseContour(0.93, 0.93, 1.55);
  }
  if (shape === "bean") {
    // Legacy key: a centered teardrop with no kidney-shaped side bite.
    return sampledContour((angle) => ({
      x: 0.96 * Math.sin(angle) * (0.86 - 0.14 * Math.cos(angle)),
      y: 0.92 * Math.cos(angle),
    }));
  }
  // Legacy shield key: a softly rounded, square-proportioned hex.
  return roundedPolygonContour(6, 1.02, 0.94, Math.PI / 2);
}

/** Rest-pose (or yawed) silhouette bounds, y-up. */
export function shapeBounds(
  shape: FaceShape,
  yaw = 0,
): {
  hull: Vec2[];
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  width: number;
  height: number;
} {
  const contour = shapeContour(shape, yaw);
  const hull = convexHull(contour);
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of contour) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { hull, minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY };
}

/** Uniform scale + origin so the rest-pose silhouette's longest axis equals size × (1 − 2×padding). */
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

export function clampFaceYOffset(
  offset: number,
  fit: Pick<ShapeFit, "height">,
  size: number,
  strokeWidth = 0,
): number {
  const clearance = Math.max(0, (size - fit.height - strokeWidth) / 2);
  return Math.max(-clearance, Math.min(clearance, offset));
}

export function projectPoint(p: Vec3, fit: ShapeFit, size: number): Vec2 {
  return {
    x: size / 2 + (p.x - fit.originX) * fit.scale,
    y: size / 2 - (p.y - fit.originY) * fit.scale,
  };
}

function project2(p: Vec2, fit: ShapeFit, size: number): Vec2 {
  return {
    x: size / 2 + (p.x - fit.originX) * fit.scale,
    y: size / 2 - (p.y - fit.originY) * fit.scale,
  };
}

/** Canvas-space silhouette at yaw. The 2D identity never narrows with gaze. */
export function shapeOutline(shape: FaceShape, yaw: number, fit: ShapeFit, size: number): Vec2[] {
  return shapeContour(shape, yaw).map((p) => project2(p, fit, size));
}

export function shapeZExtent(shape: FaceShape): number {
  if (shape === "capsule") return 0.82;
  if (shape === "rounded-cube") return 0.88;
  if (shape === "diamond") return 0.8;
  if (shape === "bean") return 0.8;
  if (shape === "shield") return 0.78;
  return 1;
}

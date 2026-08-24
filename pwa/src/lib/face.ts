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
    const R = 0.58;
    const H = 0.42;
    return { x: p.x * R, y: p.y * R + Math.sign(p.y) * H, z: p.z * R };
  }
  if (shape === "rounded-cube") {
    const n = 8;
    const s = (Math.abs(p.x) ** n + Math.abs(p.y) ** n + Math.abs(p.z) ** n) ** (1 / n) || 1;
    return { x: p.x / s, y: p.y / s, z: p.z / s };
  }
  if (shape === "diamond") {
    const s = (Math.abs(p.x) + Math.abs(p.y) + Math.abs(p.z)) || 1;
    return { x: p.x / s, y: p.y / s, z: p.z / s };
  }
  if (shape === "bean") {
    const ry = 0.5 + 0.28 * ((p.x + 1) / 2);
    let x = p.x * 0.92 + 0.22;
    const y = p.y * ry;
    const z = p.z * ry * 0.72;
    const bite = Math.exp(-(y * y) / 0.2) * Math.max(0, -p.x);
    x += 0.26 * bite;
    return { x, y, z };
  }
  if (shape === "shield") {
    const t = (p.y + 1) / 2;
    const width = 0.22 + 0.78 * Math.sqrt(Math.max(0, t));
    return { x: p.x * width, y: p.y * 1.08, z: p.z * width * 0.42 };
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

function flattenX(pts: Vec2[], yaw: number, amount: number): Vec2[] {
  if (amount <= 0) return pts;
  const k = 1 - amount * (1 - Math.abs(Math.cos(yaw)));
  return pts.map((p) => ({ x: p.x * k, y: p.y }));
}

/** Rounded rectangle, y-up, centered. radius = half-width yields a stadium. */
function roundRectContour(width: number, height: number, radius: number, steps = 7): Vec2[] {
  const hw = width / 2;
  const hh = height / 2;
  const r = Math.min(radius, hw, hh);
  const corners = [
    { x: hw - r, y: hh - r, a0: 0, a1: Math.PI / 2 },
    { x: -hw + r, y: hh - r, a0: Math.PI / 2, a1: Math.PI },
    { x: -hw + r, y: -hh + r, a0: Math.PI, a1: (3 * Math.PI) / 2 },
    { x: hw - r, y: -hh + r, a0: (3 * Math.PI) / 2, a1: Math.PI * 2 },
  ];
  const arcs: Vec2[][] = corners.map((c) => {
    const pts: Vec2[] = [];
    for (let i = 0; i <= steps; i++) {
      const a = c.a0 + (c.a1 - c.a0) * (i / steps);
      pts.push({ x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r });
    }
    return pts;
  });
  const pts: Vec2[] = [];
  for (let i = 0; i < 4; i++) {
    pts.push(...arcs[i]);
    const a = arcs[i][arcs[i].length - 1];
    const b = arcs[(i + 1) % 4][0];
    if (Math.hypot(b.x - a.x, b.y - a.y) > 1e-6) {
      for (let k = 1; k <= 4; k++) {
        const t = k / 5;
        pts.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      }
    }
  }
  return pts;
}

function quadratic(p0: Vec2, p1: Vec2, p2: Vec2, t: number): Vec2 {
  const u = 1 - t;
  return {
    x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x,
    y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y,
  };
}

/**
 * Rest-pose 2D silhouette (y-up). Named shapes stay clearly different at 28px:
 * capsule = vertical stadium, cube = rounded square, diamond = rhombus,
 * bean = kidney with a bite, shield = heater (pointed bottom, broad top).
 * Yaw only slims flattened volumes — never grows past the rest bbox.
 */
export function shapeContour(shape: FaceShape, yaw = 0): Vec2[] {
  if (shape === "sphere") {
    const pts: Vec2[] = [];
    const n = 48;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      pts.push({ x: Math.cos(a), y: Math.sin(a) });
    }
    return pts;
  }
  if (shape === "capsule") {
    // Vertical stadium: parallel sides + hemispherical caps. Not an ellipse.
    return roundRectContour(1.12, 2, 0.56);
  }
  if (shape === "rounded-cube") {
    return flattenX(roundRectContour(1.7, 1.7, 0.22), yaw, 0.08);
  }
  if (shape === "diamond") {
    const w = 0.62;
    return flattenX(
      [
        { x: 0, y: 1 },
        { x: w, y: 0 },
        { x: 0, y: -1 },
        { x: -w, y: 0 },
      ],
      yaw,
      0.06,
    );
  }
  if (shape === "bean") {
    // Squat ellipse with a left-side waist so it reads as a kidney, not a circle.
    const pts: Vec2[] = [];
    const n = 48;
    for (let i = 0; i < n; i++) {
      const t = (i / n) * Math.PI * 2;
      let x = 0.98 * Math.cos(t);
      const y = 0.56 * Math.sin(t);
      x += 0.52 * Math.exp(-((y / 0.18) ** 2)) * Math.max(0, -x);
      pts.push({ x: x + 0.08, y });
    }
    return flattenX(pts, yaw, 0.22);
  }
  // shield — heater: broad top, tapered sides, pointed bottom
  const top = { x: 0, y: 0.92 };
  const rShoulder = { x: 0.9, y: 0.58 };
  const rWaist = { x: 0.68, y: -0.1 };
  const bottom = { x: 0, y: -1.08 };
  const lWaist = { x: -0.68, y: -0.1 };
  const lShoulder = { x: -0.9, y: 0.58 };
  const pts: Vec2[] = [top, rShoulder, rWaist];
  const steps = 12;
  for (let i = 1; i <= steps; i++) {
    pts.push(quadratic(rWaist, bottom, lWaist, i / steps));
  }
  pts.push(lShoulder);
  return flattenX(pts, yaw, 0.34);
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

/** Canvas-space silhouette at yaw. Bean keeps its bite (not a convex hull). */
export function shapeOutline(shape: FaceShape, yaw: number, fit: ShapeFit, size: number): Vec2[] {
  return shapeContour(shape, yaw).map((p) => project2(p, fit, size));
}

export function shapeZExtent(shape: FaceShape): number {
  if (shape === "capsule") return 0.58;
  if (shape === "rounded-cube") return 1;
  if (shape === "diamond") return 1;
  if (shape === "bean") return 0.55;
  if (shape === "shield") return 0.42;
  return 1;
}

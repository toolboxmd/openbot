import { useEffect, useRef } from "react";
import {
  EYE,
  pickColor,
  pickShape,
  deform,
  norm,
  rotX,
  rotY,
  shapeFit,
  shapeOutline,
  shapeZExtent,
  projectPoint,
  type FaceMode,
  type FaceShape,
  type Vec3,
} from "@/lib/face";
import { cn } from "@/lib/utils";

type Props = {
  name?: string;
  shape?: FaceShape;
  color?: string;
  size?: number;
  mode?: FaceMode;
  className?: string;
};

function clamp(v: number, a: number, b: number): number {
  return Math.max(a, Math.min(b, v));
}
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
function rand(a: number, b: number): number {
  return a + Math.random() * (b - a);
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function mix([ar, ag, ab]: [number, number, number], [br, bg, bb]: [number, number, number], t: number): string {
  const k = clamp(t, 0, 1);
  return `rgb(${Math.round(ar + (br - ar) * k)},${Math.round(ag + (bg - ag) * k)},${Math.round(ab + (bb - ab) * k)})`;
}

function pose(mode: FaceMode) {
  switch (mode) {
    case "think":
      return { lid: 0.12, eye: 0.92, look: { x: 0.28, y: -0.35 } };
    case "work":
      return { lid: 0.18, eye: 0.88, look: { x: 0, y: 0.12 } };
    case "needs-you":
      return { lid: 0, eye: 1.18, look: { x: 0, y: 0 } };
    case "sleep":
      return { lid: 0.88, eye: 1.05, look: { x: 0, y: 0 } };
    default:
      return { lid: 0.04, eye: 1, look: { x: 0, y: 0 } };
  }
}

export function Eyes({ name = "OpenBot", shape, color, size = 40, mode = "idle", className }: Props) {
  const resolvedShape = shape ?? pickShape(name);
  const resolvedColor = color ?? pickColor(name);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const el = canvas;
    const g = ctx;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const pointer = { x: 0, y: 0 };
    const base = hexToRgb(resolvedColor);
    const p0 = pose(mode);
    const restFit = shapeFit(resolvedShape, size);
    const zMax = shapeZExtent(resolvedShape);

    const sim = {
      yaw: 0,
      pitch: 0,
      targetYaw: 0,
      targetPitch: 0,
      blink: 0,
      blinkT: rand(1.6, 3.4),
      double: false,
      lid: p0.lid,
      hop: 0,
      hopT: rand(2.2, 4.2),
      wrap: 0,
      wrapT: rand(6, 11),
      wrapping: 0,
      breath: Math.random() * Math.PI * 2,
    };

    function onMove(event: PointerEvent) {
      const box = el.getBoundingClientRect();
      pointer.x = clamp((event.clientX - (box.left + box.width / 2)) / (box.width / 2), -1, 1);
      pointer.y = clamp((event.clientY - (box.top + box.height / 2)) / (box.height / 2), -1, 1);
    }
    window.addEventListener("pointermove", onMove);

    let raf = 0;
    let last = performance.now();

    function drawEye(ctx2: CanvasRenderingContext2D, p: Vec3, lid: number, scale: number, fit: typeof restFit) {
      if (p.z < zMax * 0.08) return;
      const q = projectPoint(p, fit, size);
      const foreshort = 0.35 + 0.65 * clamp(p.z / zMax, 0, 1);
      const rx = 5.4 * scale * foreshort;
      const ry = Math.max(0.7, 7.8 * scale * foreshort * (1 - lid * 0.94));
      ctx2.save();
      ctx2.translate(q.x, q.y);
      ctx2.rotate(-p.x * 0.35);
      ctx2.beginPath();
      ctx2.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
      ctx2.fillStyle = EYE;
      ctx2.globalAlpha = clamp((p.z / zMax - 0.08) / 0.4, 0, 1);
      ctx2.fill();
      ctx2.restore();
    }

    function paint(dt: number) {
      const p = pose(mode);
      sim.lid = lerp(sim.lid, p.lid, 1 - Math.pow(0.001, dt));
      sim.breath += dt * Math.PI * 2 * 0.32;

      if (!reduced && mode !== "sleep") {
        sim.blinkT -= dt;
        if (sim.blinkT <= 0 && sim.blink <= 0) {
          sim.blink = 0.001;
          sim.double = Math.random() < 0.16;
          sim.blinkT = rand(2.1, 5.8);
        }
      }
      let blinkLid = 0;
      if (sim.blink > 0) {
        const close = 0.07;
        const hold = 0.03;
        const open = 0.12;
        const t = sim.blink;
        if (t < close) blinkLid = t / close;
        else if (t < close + hold) blinkLid = 1;
        else if (t < close + hold + open) blinkLid = 1 - (t - close - hold) / open;
        else if (sim.double) {
          sim.double = false;
          sim.blink = 0.001;
        } else sim.blink = 0;
        if (sim.blink > 0) sim.blink += dt;
      }

      if (mode === "idle" && !reduced) {
        sim.wrapT -= dt;
        if (sim.wrapT <= 0 && sim.wrapping <= 0) {
          sim.wrapping = 0.001;
          sim.wrapT = rand(7, 13);
        }
      }
      if (sim.wrapping > 0) {
        const u = Math.min(1, sim.wrapping / 1.15);
        sim.wrap = Math.sin(u * Math.PI) * Math.PI;
        if (u >= 1) {
          sim.wrapping = 0;
          sim.wrap = 0;
        } else sim.wrapping += dt;
      } else {
        sim.wrap = lerp(sim.wrap, 0, 0.12);
      }

      if (!reduced && (mode === "idle" || mode === "needs-you")) {
        sim.hopT -= dt;
        if (sim.hopT <= 0 && sim.hop <= 0) {
          sim.hop = 0.001;
          sim.hopT = rand(2.6, 5.5);
        }
      }
      let hopY = 0;
      if (sim.hop > 0) {
        const up = 0.12;
        const down = 0.16;
        const t = sim.hop;
        if (t < up) hopY = -8 * (t / up);
        else if (t < up + down) hopY = -8 * (1 - (t - up) / down);
        else sim.hop = 0;
        if (sim.hop > 0) sim.hop += dt;
      }

      const aimYaw = reduced ? 0 : pointer.x * 0.55 + p.look.x + (mode === "idle" ? Math.sin(sim.breath * 0.35) * 0.18 : 0);
      const aimPitch = reduced ? 0 : -pointer.y * 0.4 + p.look.y;
      sim.targetYaw = clamp(aimYaw, -0.7, 0.7);
      sim.targetPitch = clamp(aimPitch, -0.45, 0.4);
      sim.yaw = lerp(sim.yaw, sim.targetYaw + sim.wrap, reduced ? 1 : 0.12);
      sim.pitch = lerp(sim.pitch, sim.targetPitch, reduced ? 1 : 0.12);

      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const px = size * dpr;
      if (el.width !== px) {
        el.width = px;
        el.height = px;
      }
      g.setTransform(dpr, 0, 0, dpr, 0, hopY * (size / 100));
      g.clearRect(0, -20, size, size + 40);

      const breath = reduced || mode === "work" ? 0 : Math.sin(sim.breath) * 0.012;
      const live = {
        ...restFit,
        scale: restFit.scale * (1 + breath),
        width: restFit.width * (1 + breath),
        height: restFit.height * (1 + breath),
        maxDim: restFit.maxDim * (1 + breath),
      };
      const radius = size / 2;
      const r = live.maxDim / 2;

      const light: Vec3 = norm({ x: -0.42, y: 0.62, z: 0.66 });
      const grad = g.createRadialGradient(
        radius + light.x * r * 0.35,
        radius - light.y * r * 0.35,
        r * 0.08,
        radius,
        radius,
        r,
      );
      const highlight = mix(base, [255, 255, 255], resolvedColor === "#141414" ? 0.28 : 0.22);
      const shade = mix(base, [0, 0, 0], 0.55);
      grad.addColorStop(0, highlight);
      grad.addColorStop(0.42, resolvedColor);
      grad.addColorStop(1, shade);

      g.beginPath();
      if (resolvedShape === "sphere") {
        g.arc(radius, radius, r, 0, Math.PI * 2);
      } else {
        const outline = shapeOutline(resolvedShape, sim.yaw, live, size);
        if (outline.length) {
          g.moveTo(outline[0].x, outline[0].y);
          for (let i = 1; i < outline.length; i++) g.lineTo(outline[i].x, outline[i].y);
          g.closePath();
        }
      }
      g.fillStyle = grad;
      g.fill();

      // rim so the volume reads as a body, not a flat disc
      g.strokeStyle = mix(base, [0, 0, 0], 0.35);
      g.lineWidth = Math.max(1, size * 0.02);
      g.globalAlpha = 0.35;
      g.stroke();
      g.globalAlpha = 1;

      const lid = clamp(sim.lid + blinkLid * (1 - sim.lid), 0, 1);
      const eyeScale = p.eye * (size / 88);
      const left0 = deform(norm({ x: -0.32, y: 0.1, z: 0.94 }), resolvedShape);
      const right0 = deform(norm({ x: 0.32, y: 0.1, z: 0.94 }), resolvedShape);
      const left = rotX(rotY(left0, sim.yaw), sim.pitch);
      const right = rotX(rotY(right0, sim.yaw), sim.pitch);
      drawEye(g, left, lid, eyeScale, live);
      drawEye(g, right, lid, eyeScale, live);
    }

    function loop(now: number) {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      paint(dt);
      raf = requestAnimationFrame(loop);
    }
    paint(0);
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onMove);
    };
  }, [mode, resolvedColor, resolvedShape, size]);

  if (mode === "write") {
    const dot = Math.max(5, Math.round(size * 0.18));
    return (
      <span
        data-testid="eyes-write"
        aria-label="writing"
        className={cn("inline-flex shrink-0 items-center justify-center gap-1", className)}
        style={{ width: size, height: size }}
      >
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="inline-block rounded-full"
            style={{
              width: dot,
              height: dot,
              background: resolvedColor,
              opacity: 0.35 + i * 0.25,
              animation: "openbot-write 0.9s ease-in-out infinite",
              animationDelay: `${i * 160}ms`,
            }}
          />
        ))}
      </span>
    );
  }

  return (
    <canvas
      ref={canvasRef}
      width={size}
      height={size}
      aria-hidden
      data-face-name={name}
      data-face-shape={resolvedShape}
      className={cn("block shrink-0", className)}
      style={{ width: size, height: size }}
    />
  );
}

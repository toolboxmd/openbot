import { useEffect, useMemo, useRef } from "react";
import { bodyPath, EYE, pickColor, pickShape, type FaceMode, type FaceShape } from "@/lib/face";
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

type Pose = {
  eyeW: number;
  eyeH: number;
  lid: number;
  squash: number;
  tilt: number;
  fillOp: number;
  gazeBias: { x: number; y: number };
};

function poseFor(mode: FaceMode): Pose {
  switch (mode) {
    case "think":
      return { eyeW: 0.92, eyeH: 0.78, lid: 0.12, squash: 1.02, tilt: 5, fillOp: 1, gazeBias: { x: 0.35, y: -0.45 } };
    case "work":
      return { eyeW: 0.88, eyeH: 0.72, lid: 0.16, squash: 1, tilt: 0, fillOp: 1, gazeBias: { x: 0, y: 0.18 } };
    case "needs-you":
      return { eyeW: 1.18, eyeH: 1.28, lid: 0, squash: 1.04, tilt: 0, fillOp: 1, gazeBias: { x: 0, y: 0 } };
    case "sleep":
      return { eyeW: 1.12, eyeH: 0.18, lid: 0.88, squash: 0.92, tilt: -7, fillOp: 0.9, gazeBias: { x: 0, y: 0 } };
    default:
      return { eyeW: 1, eyeH: 1, lid: 0.02, squash: 1, tilt: 0, fillOp: 1, gazeBias: { x: 0, y: 0 } };
  }
}

type Sim = {
  blinkT: number;
  blink: number;
  double: boolean;
  gaze: { x: number; y: number };
  target: { x: number; y: number };
  saccadeIn: number;
  nextSaccade: number;
  breath: number;
  squash: number;
  tilt: number;
  lid: number;
  eyeW: number;
  eyeH: number;
  fillOp: number;
  hop: number;
  hopT: number;
  flip: number;
  flipT: number;
  flipping: number;
};

function freshSim(pose: Pose): Sim {
  return {
    blinkT: rand(1.4, 3.8),
    blink: 0,
    double: false,
    gaze: { x: 0, y: 0 },
    target: { x: 0, y: 0 },
    saccadeIn: 0,
    nextSaccade: rand(0.6, 1.6),
    breath: Math.random() * Math.PI * 2,
    squash: pose.squash,
    tilt: pose.tilt,
    lid: pose.lid,
    eyeW: pose.eyeW,
    eyeH: pose.eyeH,
    fillOp: pose.fillOp,
    hop: 0,
    hopT: rand(1.8, 3.6),
    flip: 1,
    flipT: rand(4.5, 8),
    flipping: 0,
  };
}

export function Eyes({ name = "OpenBot", shape, color, size = 40, mode = "idle", className }: Props) {
  const resolvedShape = shape ?? pickShape(name);
  const resolvedColor = color ?? pickColor(name);
  const body = useMemo(() => bodyPath(resolvedShape), [resolvedShape]);
  const svgRef = useRef<SVGSVGElement>(null);
  const gRef = useRef<SVGGElement>(null);
  const leftRef = useRef<SVGEllipseElement>(null);
  const rightRef = useRef<SVGEllipseElement>(null);
  const pointer = useRef({ x: 0, y: 0 });

  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const pose0 = poseFor(mode);
    const sim = freshSim(pose0);
    let last = performance.now();
    let raf = 0;

    function onMove(event: PointerEvent) {
      const el = svgRef.current;
      if (!el) return;
      const box = el.getBoundingClientRect();
      const nx = (event.clientX - (box.left + box.width / 2)) / Math.max(24, box.width / 2);
      const ny = (event.clientY - (box.top + box.height / 2)) / Math.max(24, box.height / 2);
      pointer.current = { x: clamp(nx, -1, 1), y: clamp(ny, -1, 1) };
    }
    window.addEventListener("pointermove", onMove);

    function tick(dt: number) {
      const p = poseFor(mode);
      const k = dt === 0 ? 1 : 1 - Math.pow(0.001, dt);
      sim.eyeW = lerp(sim.eyeW, p.eyeW, k);
      sim.eyeH = lerp(sim.eyeH, p.eyeH, k);
      sim.lid = lerp(sim.lid, p.lid, k);
      sim.squash = lerp(sim.squash, p.squash, k);
      sim.tilt = lerp(sim.tilt, p.tilt, k);
      sim.fillOp = lerp(sim.fillOp, p.fillOp, k);

      const lively = !reduced && (mode === "idle" || mode === "needs-you" || mode === "think");
      if (!reduced && mode !== "sleep") {
        sim.blinkT -= dt;
        if (sim.blinkT <= 0 && sim.blink <= 0) {
          sim.blink = 0.001;
          sim.double = Math.random() < 0.18;
          sim.blinkT = rand(2.2, 6.5) * (mode === "work" || mode === "think" ? 1.6 : 1);
        }
      }
      let blinkLid = 0;
      if (sim.blink > 0) {
        const close = 0.08;
        const hold = 0.02;
        const open = 0.14;
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

      sim.nextSaccade -= dt;
      const aim = {
        x: clamp(pointer.current.x * 0.55 + p.gazeBias.x, -0.7, 0.7),
        y: clamp(pointer.current.y * 0.45 + p.gazeBias.y, -0.55, 0.55),
      };
      if (mode === "needs-you" || mode === "sleep") {
        sim.target.x = 0;
        sim.target.y = 0;
      } else if (sim.saccadeIn > 0) {
        sim.saccadeIn -= dt;
      } else if (sim.nextSaccade <= 0 && !reduced) {
        sim.target.x = clamp(aim.x + rand(-0.2, 0.2), -0.75, 0.75);
        sim.target.y = clamp(aim.y + rand(-0.18, 0.18), -0.55, 0.55);
        sim.saccadeIn = rand(0.06, 0.09);
        sim.nextSaccade = mode === "think" ? rand(0.5, 1.2) : rand(1.1, 2.8);
      } else {
        sim.target.x = lerp(sim.target.x, aim.x, 0.08);
        sim.target.y = lerp(sim.target.y, aim.y, 0.08);
      }
      const st = sim.saccadeIn > 0 ? 0.55 : 0.18;
      sim.gaze.x = lerp(sim.gaze.x, sim.target.x, st);
      sim.gaze.y = lerp(sim.gaze.y, sim.target.y, st);

      if (lively && mode !== "think") {
        sim.hopT -= dt;
        if (sim.hopT <= 0 && sim.hop <= 0) {
          sim.hop = 0.001;
          sim.hopT = rand(2.8, 6.2);
        }
      }
      let hopY = 0;
      let hopSquash = 1;
      if (sim.hop > 0) {
        const up = 0.12;
        const hang = 0.04;
        const down = 0.14;
        const t = sim.hop;
        if (t < up) {
          const u = t / up;
          hopY = -10 * u * (2 - u);
          hopSquash = 1 - 0.08 * u;
        } else if (t < up + hang) {
          hopY = -10;
          hopSquash = 0.92;
        } else if (t < up + hang + down) {
          const u = (t - up - hang) / down;
          hopY = -10 * (1 - u * u);
          hopSquash = 0.92 + 0.16 * u;
        } else {
          sim.hop = 0;
          hopSquash = 1.08;
        }
        if (sim.hop > 0) sim.hop += dt;
      }

      if (mode === "idle" && !reduced) {
        sim.flipT -= dt;
        if (sim.flipT <= 0 && sim.flipping <= 0) {
          sim.flipping = 0.001;
          sim.flipT = rand(5.5, 11);
        }
      }
      if (sim.flipping > 0) {
        const dur = 0.7;
        const u = Math.min(1, sim.flipping / dur);
        const ang = u < 0.5 ? u * 2 : 1 - (u - 0.5) * 2;
        sim.flip = Math.cos(ang * Math.PI);
        if (u >= 1) {
          sim.flipping = 0;
          sim.flip = 1;
        } else sim.flipping += dt;
      } else {
        sim.flip = lerp(sim.flip, 1, 0.2);
      }
      if (mode !== "idle") sim.flip = lerp(sim.flip, 1, k);

      sim.breath += dt * Math.PI * 2 * (mode === "sleep" ? 0.22 : 0.35);
      const breath = reduced || mode === "work" ? 0 : Math.sin(sim.breath) * 0.012;
      const lid = clamp(sim.lid + blinkLid * (1 - sim.lid), 0, 1);
      const eyeH = Math.max(0.1, sim.eyeH * (1 - lid * 0.92));
      const eyeW = 8.6 * sim.eyeW;
      const eyeY = 44 + sim.gaze.y * 10;
      const gap = 12.5;
      const eyeOp = Math.max(0, Math.abs(sim.flip) - 0.18) / 0.82;
      const left = leftRef.current;
      const right = rightRef.current;
      if (left && right) {
        left.setAttribute("cx", String(50 - gap + sim.gaze.x * 9));
        right.setAttribute("cx", String(50 + gap + sim.gaze.x * 9));
        left.setAttribute("cy", String(eyeY));
        right.setAttribute("cy", String(eyeY));
        left.setAttribute("rx", String(eyeW));
        right.setAttribute("rx", String(eyeW));
        left.setAttribute("ry", String(10.4 * eyeH));
        right.setAttribute("ry", String(10.4 * eyeH));
        left.setAttribute("opacity", String(eyeOp));
        right.setAttribute("opacity", String(eyeOp));
      }
      const sy = sim.squash * hopSquash * (1 + breath);
      const sx = (1 / Math.sqrt(Math.max(0.4, sy))) * sim.flip;
      gRef.current?.setAttribute(
        "transform",
        `translate(50 ${50 + hopY}) rotate(${sim.tilt}) scale(${sx} ${sy}) translate(-50 -50)`,
      );
    }

    function loop(now: number) {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      tick(dt);
      raf = requestAnimationFrame(loop);
    }
    tick(0);
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onMove);
    };
  }, [mode]);

  return (
    <svg
      ref={svgRef}
      viewBox="0 0 100 100"
      width={size}
      height={size}
      aria-hidden
      className={cn("overflow-visible", className)}
    >
      <g ref={gRef}>
        {body.type === "ellipse" ? (
          <ellipse cx={body.cx} cy={body.cy} rx={body.rx} ry={body.ry} fill={resolvedColor} />
        ) : null}
        {body.type === "rect" ? (
          <rect x={body.x} y={body.y} width={body.w} height={body.h} rx={body.rx} fill={resolvedColor} />
        ) : null}
        {body.type === "path" ? <path d={body.d} fill={resolvedColor} /> : null}
        <ellipse ref={leftRef} cx="37.5" cy="44" rx="8.6" ry="10.4" fill={EYE} />
        <ellipse ref={rightRef} cx="62.5" cy="44" rx="8.6" ry="10.4" fill={EYE} />
      </g>
    </svg>
  );
}

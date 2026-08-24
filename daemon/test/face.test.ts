import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  FACE_PAD,
  SHAPES,
  pickColor,
  pickShape,
  shapeBounds,
  shapeContour,
  shapeFit,
  shapeOutline,
  shoelace,
  convexHull,
  OPENBOT_COLOR,
} from "../src/face.ts";

describe("face identity", () => {
  test("default OpenBot is a black sphere", () => {
    assert.equal(pickShape("OpenBot"), "sphere");
    assert.equal(pickShape("openbot"), "sphere");
    assert.equal(pickColor("OpenBot"), OPENBOT_COLOR);
  });

  test("named bots pick a non-sphere hashed volume", () => {
    assert.notEqual(pickShape("test2"), "sphere");
    assert.equal(pickShape("test2"), "capsule");
    for (const name of ["test2", "alice", "bob", "foo", "bar", "codex"]) {
      const shape = pickShape(name);
      assert.notEqual(shape, "sphere", name + " must not be a sphere");
      assert.ok((SHAPES as readonly string[]).includes(shape));
    }
  });
});

describe("2D silhouette", () => {
  test("capsule is a tall stadium with parallel sides, not an ellipse", () => {
    const size = 28;
    const tight = shapeFit("capsule", size, 0);
    assert.ok(tight.height > tight.width, "capsule should be taller than wide, got " + tight.width + "x" + tight.height);
    assert.ok(Math.abs(tight.maxDim - size) < 1e-6, "max dimension should equal size, got " + tight.maxDim);
    assert.equal(tight.maxDim, tight.height);
    assert.ok(tight.height / tight.width > 1.4, "capsule aspect " + tight.height / tight.width);

    const padded = shapeFit("capsule", size);
    assert.ok(padded.height > padded.width);
    assert.ok(padded.maxDim <= size);
    assert.ok(Math.abs(padded.maxDim - size * (1 - 2 * FACE_PAD)) < 1e-6);

    const outline = shapeOutline("capsule", 0, padded, size);
    assert.ok(outline.length >= 8, "capsule hull should have rounded caps, not 4 kite vertices");
    for (const p of outline) {
      assert.ok(p.x >= -0.01 && p.x <= size + 0.01, "x " + p.x + " outside square");
      assert.ok(p.y >= -0.01 && p.y <= size + 0.01, "y " + p.y + " outside square");
    }

    const contour = shapeContour("capsule");
    const h = shapeBounds("capsule").height;
    const mid = contour.filter((p) => Math.abs(p.y) < h * 0.18);
    assert.ok(mid.length >= 4, "capsule has a cylindrical midsection");
    const xs = mid.map((p) => Math.abs(p.x));
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    assert.ok((maxX - minX) / maxX < 0.06, "parallel sides, not an ellipse (spread " + (maxX - minX) / maxX + ")");
  });

  test("sphere silhouette is round; named shapes differ from it and each other", () => {
    const sphere = shapeBounds("sphere");
    assert.ok(Math.abs(sphere.width - sphere.height) < 0.05, "sphere should be circular");

    const aspects = new Map<string, number>();
    for (const shape of SHAPES) {
      const b = shapeBounds(shape);
      aspects.set(shape, b.height / b.width);
    }
    assert.ok((aspects.get("capsule") ?? 0) > 1.4, "capsule is a tall stadium");
    assert.ok((aspects.get("bean") ?? 1) < 0.85, "bean is squat, not a tall oval");
    assert.notEqual(aspects.get("capsule"), aspects.get("shield"));
    assert.notEqual(aspects.get("rounded-cube"), aspects.get("diamond"));

    const cube = shapeFit("rounded-cube", 28, 0);
    const diamond = shapeFit("diamond", 28, 0);
    assert.ok(Math.abs(cube.width - cube.height) < 0.5, "rounded-cube is square-ish");
    assert.ok(shapeOutline("diamond", 0, diamond, 28).length < 24, "diamond hull is pointy, not a disc");

    const bean = shapeContour("bean");
    const beanHull = convexHull(bean);
    assert.ok(shoelace(beanHull) > shoelace(bean) * 1.04, "bean has a kidney bite, not a convex blob");

    const shield = shapeContour("shield");
    const top = shield.reduce((a, p) => (p.y > a.y ? p : a));
    const bottom = shield.reduce((a, p) => (p.y < a.y ? p : a));
    const maxX = Math.max(...shield.map((p) => p.x));
    assert.ok(Math.abs(top.x) < maxX * 0.35, "shield top is centered, not a side point");
    assert.ok(Math.abs(bottom.x) < maxX * 0.2, "shield bottom is a point");
    const shoulders = shield.filter((p) => p.y > top.y * 0.4);
    const shoulderWidth = Math.max(...shoulders.map((p) => p.x)) - Math.min(...shoulders.map((p) => p.x));
    assert.ok(shoulderWidth > maxX, "shield is broad at the top, unlike a diamond");
  });

  test("fitted silhouette at 28 and 140 stays inside the square", () => {
    for (const size of [28, 140]) {
      for (const shape of SHAPES) {
        const fit = shapeFit(shape, size);
        assert.ok(fit.maxDim <= size, shape + " @" + size + " maxDim " + fit.maxDim);
        const outline = shapeOutline(shape, 0, fit, size);
        for (const p of outline) {
          assert.ok(p.x >= -0.01 && p.x <= size + 0.01, shape + " @" + size + " x " + p.x);
          assert.ok(p.y >= -0.01 && p.y <= size + 0.01, shape + " @" + size + " y " + p.y);
        }
      }
    }
  });
});

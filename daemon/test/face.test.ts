import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  FACE_PAD,
  SHAPES,
  pickColor,
  pickShape,
  shapeBounds,
  shapeFit,
  shapeOutline,
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

describe("3D silhouette", () => {
  test("capsule is taller than wide and fits in the square (max dimension = size)", () => {
    const size = 28;
    const tight = shapeFit("capsule", size, 0);
    assert.ok(tight.height > tight.width, "capsule should be taller than wide, got " + tight.width + "x" + tight.height);
    assert.ok(Math.abs(tight.maxDim - size) < 1e-6, "max dimension should equal size, got " + tight.maxDim);
    assert.equal(tight.maxDim, tight.height);

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
  });

  test("sphere silhouette is round; named shapes differ from it and each other", () => {
    const sphere = shapeBounds("sphere");
    assert.ok(Math.abs(sphere.width - sphere.height) < 0.05, "sphere should be circular");

    const aspects = new Map();
    for (const shape of SHAPES) {
      const b = shapeBounds(shape);
      aspects.set(shape, b.height / b.width);
    }
    assert.ok((aspects.get("capsule") ?? 0) > 1.4, "capsule is a tall 3D volume");
    assert.ok((aspects.get("bean") ?? 1) < 0.85, "bean is squat, not a tall oval");
    assert.notEqual(aspects.get("capsule"), aspects.get("shield"));
    assert.notEqual(aspects.get("rounded-cube"), aspects.get("diamond"));

    const cube = shapeFit("rounded-cube", 28, 0);
    const diamond = shapeFit("diamond", 28, 0);
    assert.ok(Math.abs(cube.width - cube.height) < 0.5, "rounded-cube is square-ish");
    assert.ok(shapeOutline("diamond", 0, diamond, 28).length < 24, "diamond hull is pointy, not a disc");
  });

  test("fitted hull at 28 and 140 stays inside the square", () => {
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

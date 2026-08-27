import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  FACE_PAD,
  SHAPES,
  clampFaceYOffset,
  convexHull,
  facePoseAt,
  pickColor,
  pickShape,
  shapeBounds,
  shapeContour,
  shapeFit,
  shapeOutline,
  shoelace,
} from "../src/lib/face.ts";

describe("named Eyes identity", () => {
  test("keeps stable name hashes while every named silhouette stays smooth and square", () => {
    const expected = new Map([
      ["Ada", ["capsule", "#ff3b5c"]],
      ["Scout", ["shield", "#ffd11a"]],
      ["Codex", ["capsule", "#6d5cff"]],
      ["Bob", ["rounded-cube", "#6d5cff"]],
    ]);

    for (const [name, [shape, color]] of expected) {
      assert.equal(pickShape(name), shape, `${name} shape hash changed`);
      assert.equal(pickShape(name.toLowerCase()), shape, `${name} shape must ignore case`);
      assert.equal(pickColor(name), color, `${name} color hash changed`);
      assert.equal(pickColor(name.toLowerCase()), color, `${name} color must ignore case`);
    }

    for (const shape of SHAPES.filter((candidate) => candidate !== "sphere")) {
      const contour = shapeContour(shape);
      const bounds = shapeBounds(shape);
      const aspect = bounds.width / bounds.height;
      assert.ok(aspect >= 0.88 && aspect <= 1.12, `${shape} must read square, got aspect ${aspect}`);
      assert.ok(contour.length >= 48, `${shape} needs a dense anti-aliased contour, got ${contour.length} points`);
      assert.ok(
        shoelace(contour) / shoelace(convexHull(contour)) >= 0.995,
        `${shape} must stay convex instead of reading as a scalloped or kidney hull`,
      );

      for (const size of [28, 140]) {
        const fit = shapeFit(shape, size);
        assert.ok(Math.abs(fit.maxDim - size * (1 - 2 * FACE_PAD)) < 1e-6);

        const liveFit = {
          ...fit,
          scale: fit.scale * 1.012,
          width: fit.width * 1.012,
          height: fit.height * 1.012,
          maxDim: fit.maxDim * 1.012,
        };
        const strokeWidth = Math.max(1, size * 0.02);
        const hopOffset = clampFaceYOffset(-size * 0.08, liveFit, size, strokeWidth);
        for (const point of shapeOutline(shape, 0, liveFit, size)) {
          assert.ok(
            point.y + hopOffset - strokeWidth / 2 >= -1e-6,
            `${shape} @${size} clips above its square during an idle hop`,
          );
          assert.ok(
            point.y + hopOffset + strokeWidth / 2 <= size + 1e-6,
            `${shape} @${size} clips below its square during an idle hop`,
          );
        }

        for (const yaw of [-0.55, 0, 0.55]) {
          const outline = shapeOutline(shape, yaw, fit, size);
          for (let index = 0; index < outline.length; index += 1) {
            const point = outline[index];
            const next = outline[(index + 1) % outline.length];
            assert.ok(point.x >= 0 && point.x <= size, `${shape} @${size} x ${point.x} escaped its square`);
            assert.ok(point.y >= 0 && point.y <= size, `${shape} @${size} y ${point.y} escaped its square`);
            assert.ok(
              Math.hypot(next.x - point.x, next.y - point.y) <= size * 0.1,
              `${shape} @${size} has a jagged ${Math.hypot(next.x - point.x, next.y - point.y)}px edge`,
            );
          }
        }
      }
    }
  });
});

describe("Eyes pose", () => {
  test("working concentrates in place and clearing the mode restores idle", () => {
    const idle = facePoseAt("idle", 0);
    const idleLater = facePoseAt("idle", 4.2);
    assert.deepEqual(idleLater, idle, "idle must not inherit the working cycle");

    const writeStart = facePoseAt("write", 0);
    const writeFocus = facePoseAt("write", 0.45);
    const workFocus = facePoseAt("work", 0.45);
    assert.equal(writeStart.look.x, 0, "working must not dart left or right");
    assert.equal(writeFocus.look.x, 0, "working must stay centered throughout its cycle");
    assert.ok(writeStart.look.y > idle.look.y, "working gaze should settle below idle");
    assert.ok(writeStart.lid >= 0.3, "working eyes should visibly narrow in concentration");
    assert.notEqual(writeFocus.lid, writeStart.lid, "working should visibly pulse rather than freeze");
    assert.deepEqual(workFocus, writeFocus, "work and write are the same user-visible state");

    const reducedStart = facePoseAt("write", 0, true);
    const reducedLater = facePoseAt("write", 8, true);
    assert.deepEqual(reducedLater, reducedStart, "reduced motion keeps a meaningful static working pose");
    assert.deepEqual(facePoseAt("idle", 0.45), idle, "the working pose stops when the Turn ends");
  });
});

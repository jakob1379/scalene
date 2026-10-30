// §4.4.7 annotation placement: candidate order, channel containment,
// reserved-rect rejection, fallbacks and y-tick dropping.
import assert from "node:assert/strict";
import { mod, test } from "./_harness.mjs";

const p = mod("charts/placement");
const R = (x, y, w, h) => ({ x, y, w, h });

test("rect predicates", () => {
  assert.equal(p.intersects(R(0, 0, 10, 10), R(5, 5, 10, 10)), true);
  assert.equal(p.intersects(R(0, 0, 10, 10), R(10, 0, 5, 5)), false); // touching edges
  assert.equal(p.contains(R(0, 0, 100, 50), R(2, 2, 96, 46), 2), true);
  assert.equal(p.contains(R(0, 0, 100, 50), R(1, 2, 96, 46), 2), false);
  assert.deepEqual(p.insetRect(R(0, 0, 10, 10), 2), R(2, 2, 6, 6));
  assert.equal(p.disjoint([R(0, 0, 5, 5), R(5, 0, 5, 5), R(0, 5, 5, 5)]), true);
  assert.equal(p.disjoint([R(0, 0, 5, 5), R(4, 4, 5, 5)]), false);
});

test("callout candidates: left, right, below-left, below-right", () => {
  const c = p.calloutCandidates({ x: 500, y: 40 }, { w: 120, h: 40 });
  assert.deepEqual(c.map((x) => x.side), ["left", "right", "below-left", "below-right"]);
  assert.deepEqual(c[0].rect, R(500 - 10 - 120, 32, 120, 40)); // right edge = dot − 10, top = dot − 8
  assert.deepEqual(c[1].rect, R(510, 32, 120, 40));
  assert.deepEqual(c[2].rect, R(370, 48, 120, 40));
  assert.deepEqual(c[3].rect, R(510, 48, 120, 40));
});

test("placeCallout prefers left, then falls through on bounds and reserved rects", () => {
  const bounds = R(100, 20, 700, 120);
  const size = { w: 120, h: 40 };
  assert.equal(p.placeCallout({ dot: { x: 500, y: 60 }, size, bounds }).side, "left");
  // Near the left edge: left leaves the channel → right.
  assert.equal(p.placeCallout({ dot: { x: 150, y: 60 }, size, bounds }).side, "right");
  // Dot at the channel top (the peak usually is): side boxes stick out → below-left.
  assert.equal(p.placeCallout({ dot: { x: 500, y: 24 }, size, bounds }).side, "below-left");
  // Top-left corner: only below-right fits.
  assert.equal(p.placeCallout({ dot: { x: 150, y: 24 }, size, bounds }).side, "below-right");
  // Reserved rect blocks left → right.
  const reserved = [R(380, 50, 20, 20)];
  assert.equal(p.placeCallout({ dot: { x: 500, y: 60 }, size, bounds, reserved }).side, "right");
  // Nothing fits in a tiny channel.
  assert.equal(p.placeCallout({ dot: { x: 120, y: 30 }, size, bounds: R(100, 20, 60, 30) }), null);
});

test("planPeakLabel: callout → one-line label → gutter", () => {
  const callout = { w: 140, h: 37 };
  const label = { w: 70, h: 23 };
  const big = p.planPeakLabel({ dot: { x: 600, y: 30 }, callout, label, bounds: R(100, 10, 700, 100) });
  assert.equal(big.kind, "callout");
  const mid = p.planPeakLabel({ dot: { x: 160, y: 22 }, callout, label, bounds: R(100, 10, 200, 40) });
  assert.equal(mid.kind, "label");
  assert.ok(p.contains(R(100, 10, 200, 40), mid.rect, 2));
  const none = p.planPeakLabel({ dot: { x: 110, y: 15 }, callout, label, bounds: R(100, 10, 60, 20) });
  assert.deepEqual(none, { kind: "gutter", rect: null });
});

test("placeYTicks: clamps, drops collisions with the callout, each other and the top guard", () => {
  const channel = R(100, 20, 700, 100);
  const size = { w: 40, h: 14 };
  const cands = [
    { y: 120, label: "0", size },
    { y: 70, label: "1\u00a0GiB", size },
    { y: 20, label: "2\u00a0GiB", size }, // at the top: inside the 4 px guard after clamping → dropped
  ];
  const placed = p.placeYTicks(cands, { channel, x: 806 });
  assert.deepEqual(placed.map((t) => t.label), ["0", "1\u00a0GiB"]);
  assert.deepEqual(placed[0].rect, R(806, 106, 40, 14)); // clamped to the channel bottom
  const blocked = p.placeYTicks(cands, { channel, x: 806, reserved: [R(780, 60, 80, 20)] });
  assert.deepEqual(blocked.map((t) => t.label), ["0"]);
  const crowded = p.placeYTicks(
    [
      { y: 100, label: "a", size },
      { y: 95, label: "b", size },
      { y: 60, label: "c", size },
    ],
    { channel, x: 806 },
  );
  assert.deepEqual(crowded.map((t) => t.label), ["a", "c"]);
  const right = p.placeYTicks([{ y: 70, label: "x", size }], { channel, x: 796, alignRight: true });
  assert.equal(right[0].rect.x, 756);
  assert.ok(p.disjoint(placed.map((t) => t.rect)));
});

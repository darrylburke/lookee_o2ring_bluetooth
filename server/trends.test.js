import test from "node:test";
import assert from "node:assert/strict";
import { baselineFlags, buildTrends, median, rolling } from "./trends.js";

const night = (id, over = {}) => ({ id, start_time: `2026-09-${String(id).padStart(2, "0")} 23:00:00`, notes: "", tags: [], valid_hours: 7.5,
  mean_spo2: 95.5, t90_pct: 0.1, t88_s: 0, odi3: 10, odi4: 5, hypoxic_burden: 30, arousal_linked_h: 4, lowest_pr_30min: 60,
  pr_rises6_h: 12, movement_bouts_h: 15, fragmentation_index: 50, ...over });
const steady = n => Array.from({ length: n }, (_, i) => night(i + 1, { odi3: 10 + (i % 3), lowest_pr_30min: 60 + (i % 2) }));

test("median and rolling windows", () => {
  assert.equal(median([3, null, 1, 2]), 2);
  assert.equal(median([]), null);
  assert.deepEqual(rolling([{ v: 1 }, { v: 3 }, { v: 5 }, { v: 7 }], "v", 2), [1, 2, 4, 6]);
});

test("short nights are excluded from trends", () => {
  const t = buildTrends([night(1, { valid_hours: 0.03, odi3: 36 }), night(2), night(3)]);
  assert.equal(t.nights.length, 2);
  assert.equal(t.excluded, 1);
  assert.equal(t.series.find(s => s.key === "odi3").summary.worst, 10);
});

test("baseline stays in learning mode until 14 earlier full nights exist", () => {
  const nights = steady(14);
  assert.deepEqual(baselineFlags(nights, 14), { learning: true, nights: 13, needed: 14, eligible: true });
  assert.equal(baselineFlags(steady(15), 15).learning, false);
});

test("flags an unusual night and says which direction is worse", () => {
  const nights = [...steady(20), night(21, { odi3: 30, lowest_pr_30min: 68, mean_spo2: 95.5 })];
  const { flags } = baselineFlags(nights, 21);
  assert.ok(flags.odi3.z >= 3 && flags.odi3.worse);
  assert.ok(flags.lowest_pr_30min.z >= 2 && flags.lowest_pr_30min.worse);
  assert.ok(Math.abs(flags.mean_spo2.z) < 2);
  assert.equal(flags.odi3.median, 11);
});

test("alcohol / illness nights do not feed the baseline", () => {
  const nights = [...steady(14), ...Array.from({ length: 5 }, (_, i) => night(15 + i, { odi3: 40, tags: ["alcohol"] })), night(20)];
  const b = baselineFlags(nights, 20);
  assert.equal(b.nights, 14);
  assert.ok(Math.abs(b.flags.odi3.z) < 2);
});

test("tag comparisons report counts and refuse to call small samples", () => {
  const nights = [...steady(12), night(13, { odi3: 20, tags: ["alcohol"] }), night(14, { odi3: 22, tags: ["alcohol"] })];
  const [alcohol] = buildTrends(nights).tags;
  assert.deepEqual([alcohol.tag, alcohol.n_with, alcohol.n_without, alcohol.enough], ["alcohol", 2, 12, false]);
  assert.equal(alcohol.metrics.find(m => m.key === "odi3").diff, 10);
});

test("doctor prompts need several nights and a consistent pattern", () => {
  assert.deepEqual(buildTrends([night(1, { odi3: 40, odi4: 30 })]).prompts, []);
  const bad = Array.from({ length: 8 }, (_, i) => night(i + 1, { odi3: 28, odi4: 17 }));
  assert.match(buildTrends(bad).prompts[0], /median over the last 8 nights is 17\.0/);
  assert.deepEqual(buildTrends(steady(8)).prompts, []);
});

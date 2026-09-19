import test from "node:test";
import assert from "node:assert/strict";
import { planCombine, suggestGroups } from "./combine.js";

const rec = (id, start, end, samples, over = {}) => ({ id, device_sn: "RING1", file_name: start.replace(/\D/g, ""), start_time: start, end_time: end,
  recording_s: samples * 4, sample_count: samples, asleep_s: 0, avg_spo2: 96, min_spo2: 90, drops_3pct: 5, drops_4pct: 2, seconds_below_90: 4,
  drops_below_90: 1, o2_score: "9.0", steps: 0, file_version: 3, operation_mode: 0, is_combined: 0, merged_into: null, hidden: 0, ...over });
const a = rec(7, "2026-09-18 23:56:35", "2026-09-19 03:59:11", 3640, { min_spo2: 89, o2_score: "9.1" });
const b = rec(4, "2026-09-19 04:04:53", "2026-09-19 05:00:49", 840, { o2_score: null });
const c = rec(5, "2026-09-19 05:02:55", "2026-09-19 07:44:51", 2430, { min_spo2: 87, o2_score: "8.5" });

test("parts land on one 4-second grid with the gaps accounted for", () => {
  const { session, parts } = planCombine([c, a, b]);                       // any order in
  assert.deepEqual(parts.map(p => p.id), [7, 4, 5]);
  assert.equal(parts[1].offset, Math.round((4 * 3600 + 8 * 60 + 18) / 4)); // 04:04:53 is 4 h 08 m 18 s after 23:56:35
  assert.equal(parts[1].gap_before, parts[1].offset - 3640);
  assert.equal(session.sample_count, parts[2].offset + 2430);
  assert.equal(session.recording_s - session.gap_s, (3640 + 840 + 2430) * 4);
  assert.equal(session.start_time, "2026-09-18 23:56:35");
  assert.equal(session.end_time.slice(0, 16), "2026-09-19 07:44");
  assert.equal(session.file_name, "20260918235635+2");
});

test("summary fields: sums, minimum, and time-weighted score over parts that have one", () => {
  const { session } = planCombine([a, b, c]);
  assert.equal(session.drops_3pct, 15);
  assert.equal(session.min_spo2, 87);
  assert.equal(session.o2_score, Number(((9.1 * 3640 + 8.5 * 2430) / (3640 + 2430)).toFixed(1)));
});

test("refuses things that are not one night", () => {
  assert.throws(() => planCombine([a]), /at least two/);
  assert.throws(() => planCombine([a, { ...b, device_sn: "RING2" }]), /different rings/);
  assert.throws(() => planCombine([a, { ...b, is_combined: 1 }]), /split it first/);
  assert.throws(() => planCombine([a, { ...b, merged_into: 9 }]), /already part/);
  assert.throws(() => planCombine([a, rec(8, "2026-09-19 02:00:00", "2026-09-19 03:00:00", 900)]), /overlap/);
  assert.throws(() => planCombine([a, rec(9, "2026-09-19 09:30:00", "2026-09-19 10:00:00", 450)]), /3 hours apart/);
});

test("suggests recordings that follow each other closely, and nothing else", () => {
  const earlier = rec(2, "2026-09-17 23:11:09", "2026-09-18 07:42:49", 7676);
  const [g, ...rest] = suggestGroups([c, earlier, a, b, rec(6, "2026-09-19 07:50:00", "2026-09-19 08:00:00", 150, { hidden: 1 })]);
  assert.deepEqual(g.ids, [7, 4, 5]);
  assert.deepEqual(g.gaps_min, [6, 2]);
  assert.deepEqual(rest, []);
  assert.deepEqual(suggestGroups([a, { ...b, merged_into: 12 }, c]).map(x => x.ids), [[7, 5]]);   // b is taken; a and c are still only 64 min apart
  assert.deepEqual(suggestGroups([earlier, a]), []);                                                // a whole day apart
});

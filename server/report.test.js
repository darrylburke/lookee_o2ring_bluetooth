import test from "node:test";
import assert from "node:assert/strict";
import { addSeconds, buildReport, hms } from "./report.js";

const session = { id: 1, device_sn: "XX1234", file_name: "20260917231109", start_time: "2026-09-17 23:11:09",
  recording_s: 40, asleep_s: 0, o2_score: "9.2", drops_3pct: 1, drops_4pct: 0, seconds_below_90: 4, notes: null };
const samples = [96, 96, 95, 93, 92, 89, 255, null, 97, 98].map((spo2, i) => ({ spo2, pr: i === 7 ? null : 60 + i, motion: i }));

test("wall-clock maths never shifts timezones", () => {
  assert.equal(addSeconds("2026-09-17 23:11:09", 30704), "2026-09-18T07:42:53");
  assert.equal(hms(30704), "08:31:44");
});

test("buckets follow the app: invalid samples dropped, duration = trunc(count * total / valid)", () => {
  const r = buildReport(session, samples, { OxiSwitch: "1", CurOxiThr: "88", HRSwitch: "0" });
  assert.deepEqual(r.spo2_dist.map(d => [d.range, d.duration, d.pct]), [
    ["95-100", "00:00:25", "62.50%"], ["91-94", "00:00:10", "25.00%"], ["86-90", "00:00:05", "12.50%"],
    ["70-85", "00:00:00", "0.00%"], ["<70", "00:00:00", "0.00%"], ["Total", "00:00:40", "100.00%"]]);
  const combined = buildReport({ ...session, recording_s: 100, gap_s: 60 }, samples, null);   // 40 s recorded inside a 100 s span
  assert.equal(combined.measurement_time, "00:00:40");
  assert.equal(combined.spo2_dist[0].duration, "00:00:25");
  assert.equal(combined.end, "2026-09-17T23:12:49");
  assert.deepEqual(r.spo2_range, [89, 98]);
  assert.equal(r.avg_spo2, 95);          // 94.5 rounds up like Kotlin's roundToInt
  assert.equal(r.avg_pr, 64);            // 64.67 truncates
  assert.equal(r.spo2_alert, 88);
  assert.equal(r.pr_alert, null);
  assert.deepEqual(r.spo2.slice(5, 8), [89, null, null]);
  assert.equal(r.o2_score, 9.2);
  assert.equal(r.notes, "");
});

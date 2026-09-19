// Report maths, ported from o2ring_report.py (which follows the app's InfoScreen):
// invalid samples are dropped, each valid sample is worth
// `recording time / valid sample count` seconds, bucket duration = trunc(count * that).

const SPO2_BUCKETS = [["95-100", 95, 100], ["91-94", 91, 94], ["86-90", 86, 90], ["70-85", 70, 85], ["<70", 0, 69]];
const PR_BUCKETS = [[">120/Min", 121, Infinity], ["50–120/Min", 50, 120], ["<50/Min", 0, 49]];

const p2 = n => String(n).padStart(2, "0");
export const hms = s => `${p2(Math.floor(s / 3600))}:${p2(Math.floor((s % 3600) / 60))}:${p2(s % 60)}`;

function distribution(values, buckets, durationS) {
  const n = values.length, secPer = n ? durationS / n : 0;
  return buckets.map(([range, lo, hi]) => {
    const count = values.filter(v => v >= lo && v <= hi).length;
    return { range, duration: hms(Math.trunc(count * secPer)), pct: `${(n ? (count * 100) / n : 0).toFixed(2)}%` };
  });
}

const mean = a => a.reduce((t, v) => t + v, 0) / a.length;
const range = a => a.reduce(([lo, hi], v) => [Math.min(lo, v), Math.max(hi, v)], [Infinity, -Infinity]);

/** "YYYY-MM-DD HH:MM:SS" (ring-local wall clock) + seconds -> "YYYY-MM-DDTHH:MM:SS", no timezone maths */
export function addSeconds(wall, seconds) {
  const [d, t] = wall.split(/[ T]/), [Y, M, D] = d.split("-").map(Number), [h, m, s] = t.split(":").map(Number);
  const u = new Date(Date.UTC(Y, M - 1, D, h, m, s + seconds));
  return `${u.getUTCFullYear()}-${p2(u.getUTCMonth() + 1)}-${p2(u.getUTCDate())}T${p2(u.getUTCHours())}:${p2(u.getUTCMinutes())}:${p2(u.getUTCSeconds())}`;
}

/**
 * @param session row from `sessions` (start_time as a "YYYY-MM-DD HH:MM:SS" string)
 * @param samples rows of {spo2, pr, motion}, ordered by seq
 * @param info    the ring's getInfo JSON (devices.last_info), may be null
 */
export function buildReport(session, samples, info) {
  const duration = session.recording_s;                 // whole span, including gaps inside a combined night
  const measured = duration - (session.gap_s || 0);      // time actually recorded
  const okSpo2 = v => v != null && v > 0 && v <= 100, okPr = v => v != null && v > 0 && v < 300;
  const spo2 = samples.map(s => s.spo2).filter(okSpo2), pr = samples.map(s => s.pr).filter(okPr);

  const spo2Dist = distribution(spo2, SPO2_BUCKETS, measured);
  spo2Dist.push({ range: "Total", duration: hms(measured), pct: spo2.length ? "100.00%" : "0.00%" });

  // the app draws a triangle under samples beyond the ring's own reminder thresholds
  const num = (key, dflt) => (/^\d+$/.test(String(info?.[key] ?? "")) ? Number(info[key]) : dflt);

  return {
    id: session.id,
    file_name: session.file_name,
    device: `O2Ring ${String(session.device_sn).slice(-4)}`,
    start: addSeconds(session.start_time, 0),
    end: addSeconds(session.start_time, duration),
    duration_s: duration,
    measured_s: measured,
    measurement_time: hms(measured),
    avg_spo2: spo2.length ? Math.floor(mean(spo2) + 0.5) : null, // app: roundToInt
    avg_pr: pr.length ? Math.trunc(mean(pr)) : null,             // app: truncates
    spo2_alert: num("OxiSwitch", 1) ? num("CurOxiThr", 86) : null,
    pr_alert: num("HRSwitch", 0) ? [num("HRLowThr", 50), num("HRHighThr", 120)] : null,
    o2_score: session.o2_score == null ? null : Number(session.o2_score),
    asleep_s: session.asleep_s || 0,
    drops_3pct: session.drops_3pct,
    drops_4pct: session.drops_4pct,
    seconds_below_90: session.seconds_below_90,
    spo2_range: spo2.length ? range(spo2) : null,
    pr_range: pr.length ? range(pr) : null,
    spo2_dist: spo2Dist,
    pr_dist: distribution(pr, PR_BUCKETS, measured),
    interval_s: 4,
    spo2: samples.map(s => (okSpo2(s.spo2) ? s.spo2 : null)),
    pr: samples.map(s => (okPr(s.pr) ? s.pr : null)),
    motion: samples.map(s => s.motion || 0),
    notes: session.notes || "",
  };
}

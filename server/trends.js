// Multi-night logic: rolling medians, personal-baseline flags, threshold shares, tag comparisons, guard-rail prompts.
// Pure functions over "night" rows (sessions joined with session_metrics) - see docs/analytics-research.md.

export const MIN_HOURS = 4;          // shorter nights are excluded everywhere here
export const BASELINE_NEEDED = 14;   // nights before baseline flags switch on
export const BASELINE_WINDOW = 30;   // trailing nights the baseline is built from
export const TAG_ARM_MIN = 10;       // nights per arm before a tag comparison is worth reading
const PROMPT_MIN_NIGHTS = 7;
const BASELINE_EXCLUDE_TAGS = ["alcohol", "illness / congestion"];

// key = column in session_metrics; worse = direction that is "worse"; log = right-skewed, compare on log1p
export const METRICS = [
  { key: "odi3", label: "Drops ≥3 % per hour", unit: "/h", digits: 1, worse: "up", log: true },
  { key: "odi4", label: "Drops ≥4 % per hour", unit: "/h", digits: 1, worse: "up", log: true },
  { key: "hypoxic_burden", label: "Hypoxic burden", unit: "%·min/h", digits: 1, worse: "up", log: true },
  { key: "t90_pct", label: "Time below 90 %", unit: "%", digits: 2, worse: "up", log: true },
  { key: "arousal_linked_h", label: "Drops with pulse surge", unit: "/h", digits: 1, worse: "up", log: true },
  { key: "mean_spo2", label: "Mean oxygen", unit: "%", digits: 1, worse: "down" },
  { key: "lowest_pr_30min", label: "Sleeping pulse (lowest 30 min)", unit: "bpm", digits: 1, worse: "up" },
  { key: "pr_rises6_h", label: "Pulse surges ≥6 bpm", unit: "/h", digits: 1, worse: "up" },
  { key: "movement_bouts_h", label: "Movement bouts", unit: "/h", digits: 1, worse: "up" },
  { key: "fragmentation_index", label: "Fragmentation index", unit: "", digits: 1, worse: "up" },
  { key: "cyclic_pct", label: "Night in repeating drop cycles", unit: "%", digits: 1, worse: "up", log: true },
  { key: "est_wake_like_pct", label: "Restless / wake-like time (estimate)", unit: "%", digits: 1, worse: "up" },
];

export const median = values => {
  const v = values.filter(x => x != null && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
};
const quantile = (values, q) => {
  const v = values.filter(x => x != null).sort((a, b) => a - b);
  if (!v.length) return null;
  const pos = (v.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return v[lo] + (v[hi] - v[lo]) * (pos - lo);
};
const round = (x, digits) => (x == null ? null : Number(x.toFixed(digits)));

export const eligible = nights => nights.filter(n => n.valid_hours != null && n.valid_hours >= MIN_HOURS);

/** median of the last `window` eligible nights up to and including each night (count-based, not calendar-based) */
export function rolling(nights, key, window) {
  return nights.map((_, i) => median(nights.slice(Math.max(0, i - window + 1), i + 1).map(n => n[key])));
}

/** Robust z-score of one night against the trailing baseline of *earlier* nights. */
export function baselineFlags(allNights, currentId) {
  const nights = eligible(allNights), idx = nights.findIndex(n => n.id === currentId);
  const current = idx >= 0 ? nights[idx] : null;
  const prior = (idx >= 0 ? nights.slice(0, idx) : nights)
    .filter(n => !n.tags.some(t => BASELINE_EXCLUDE_TAGS.includes(t))).slice(-BASELINE_WINDOW);
  if (!current || prior.length < BASELINE_NEEDED)
    return { learning: true, nights: prior.length, needed: BASELINE_NEEDED, eligible: !!current };
  const flags = {};
  for (const m of METRICS) {
    const tf = m.log ? Math.log1p : x => x;
    const base = prior.map(n => n[m.key]).filter(x => x != null);
    if (current[m.key] == null || base.length < BASELINE_NEEDED) continue;
    const med = median(base.map(tf)), mad = median(base.map(x => Math.abs(tf(x) - med)));
    const scale = Math.max(1.4826 * mad, m.log ? 0.05 : 0.5); // floor so a very steady baseline cannot make everything an outlier
    const z = (tf(current[m.key]) - med) / scale;
    flags[m.key] = { z: round(z, 1), median: round(median(base), m.digits), worse: m.worse === "up" ? z > 0 : z < 0 };
  }
  return { learning: false, nights: prior.length, flags };
}

function tagComparisons(nights) {
  const tags = [...new Set(nights.flatMap(n => n.tags))].sort();
  return tags.map(tag => {
    const withTag = nights.filter(n => n.tags.includes(tag)), without = nights.filter(n => !n.tags.includes(tag));
    return {
      tag, n_with: withTag.length, n_without: without.length,
      enough: withTag.length >= TAG_ARM_MIN && without.length >= TAG_ARM_MIN,
      metrics: METRICS.slice(0, 7).map(m => {
        const a = median(withTag.map(n => n[m.key])), b = median(without.map(n => n[m.key]));
        return { key: m.key, with: round(a, m.digits), without: round(b, m.digits), diff: a == null || b == null ? null : round(a - b, m.digits) };
      }),
    };
  });
}

/** Multi-night prompts only - never from a single night. */
function prompts(nights) {
  if (nights.length < PROMPT_MIN_NIGHTS) return [];
  const recent = nights.slice(-14), out = [];
  const medOdi4 = median(recent.map(n => n.odi4)), medOdi3 = median(recent.map(n => n.odi3));
  const share15 = recent.filter(n => n.odi3 != null && n.odi3 >= 15).length / recent.length;
  const t88 = recent.filter(n => n.t88_s != null && n.t88_s >= 300).length;
  if (medOdi4 != null && medOdi4 >= 15)
    out.push(`Your median over the last ${recent.length} nights is ${medOdi4.toFixed(1)} drops of ≥4 % per hour. In studies, 15 or more per hour usually goes with moderate sleep apnoea – worth discussing with a doctor.`);
  else if (share15 >= 1 / 3)
    out.push(`${Math.round(share15 * 100)}% of your last ${recent.length} nights had 15 or more oxygen drops (≥3 %) per hour (median ${medOdi3.toFixed(1)}/h). That is a consistent pattern rather than a one-off – worth mentioning to a doctor, especially with daytime sleepiness, snoring or witnessed pauses.`);
  if (t88 >= Math.max(2, recent.length / 3))
    out.push(`${t88} of your last ${recent.length} nights had 5 minutes or more at or below 88 % oxygen. Sustained low oxygen is worth raising with a doctor.`);
  return out;
}

export function buildTrends(allNights) {
  const nights = eligible(allNights);
  const series = METRICS.map(m => ({
    ...m,
    values: nights.map(n => n[m.key]),
    roll7: rolling(nights, m.key, 7).map(v => round(v, m.digits)),
    roll14: rolling(nights, m.key, 14).map(v => round(v, m.digits)),
    roll30: rolling(nights, m.key, 30).map(v => round(v, m.digits)),
    summary: {
      median14: round(median(nights.slice(-14).map(n => n[m.key])), m.digits),
      p25: round(quantile(nights.slice(-14).map(n => n[m.key]), 0.25), m.digits),
      p75: round(quantile(nights.slice(-14).map(n => n[m.key]), 0.75), m.digits),
      best: round(nights.reduce((b, n) => (n[m.key] == null ? b : b == null ? n[m.key] : m.worse === "up" ? Math.min(b, n[m.key]) : Math.max(b, n[m.key])), null), m.digits),
      worst: round(nights.reduce((b, n) => (n[m.key] == null ? b : b == null ? n[m.key] : m.worse === "up" ? Math.max(b, n[m.key]) : Math.min(b, n[m.key])), null), m.digits),
    },
  }));
  const share = (key, thr) => (nights.length ? Math.round(100 * nights.filter(n => n[key] != null && n[key] >= thr).length / nights.length) : null);
  return {
    nights: nights.map(n => ({ id: n.id, start: n.start_time, hours: n.valid_hours, tags: n.tags, notes: n.notes || "" })),
    excluded: allNights.length - nights.length,
    min_hours: MIN_HOURS,
    series,
    thresholds: [5, 15, 30].map(thr => ({ thr, odi3: share("odi3", thr), odi4: share("odi4", thr) })),
    baseline: { nights: Math.min(nights.length, BASELINE_WINDOW), needed: BASELINE_NEEDED, ready: nights.length > BASELINE_NEEDED },
    tags: tagComparisons(nights),
    tag_arm_min: TAG_ARM_MIN,
    prompts: prompts(nights),
  };
}

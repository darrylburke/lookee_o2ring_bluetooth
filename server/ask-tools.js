// Read-only data tools the language model can call when answering a question ("Ask" panel).
//
// Design rules: every tool is a bounded SELECT over data this project already computes; none can write; only nights
// that are visible in the app (not hidden, not a part of a combined night) can be read; the ring's serial number is
// never returned; free-text notes are returned unless the operator switched that off (O2RING_LLM_SEND_NOTES=0).

import { buildTrends } from "./trends.js";

const TIME_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const VISIBLE = "s.hidden = 0 AND s.merged_into IS NULL";

const time = { type: "string", description: 'Local wall-clock time, "YYYY-MM-DD HH:MM"' };
export const TOOL_DEFS = [
  { name: "list_nights",
    description: "Headline metrics for every recorded night (newest first): id, start, recorded hours, mean SpO2, time below 90 %, oxygen drops per hour (3 % and 4 %), hypoxic burden, drops with a pulse surge per hour, sleeping pulse, pulse surges, movement (per recording hour, and movements in sleep per sleep hour on the sleep-lab definition), fragmentation, share of night in repeating drop cycles, estimated restless share, the ring's own drop counts and O2 score, tags. Nights shorter than 4 hours are flagged `short` and their per-hour rates are not meaningful. Call this first for any question about more than one night.",
    input_schema: { type: "object", additionalProperties: false, properties: {
      from: { type: "string", description: 'Only nights starting on or after this date, "YYYY-MM-DD"' },
      to: { type: "string", description: 'Only nights starting on or before this date, "YYYY-MM-DD"' },
      limit: { type: "integer", description: "Maximum nights to return (default 60, max 120)" } } } },
  { name: "get_night",
    description: "Everything computed for one night: oxygen statistics and time below thresholds, desaturation summary (counts, per-hour rates, by hour of night, depth x duration table, classes A/B/C, the app-style ODI rows), pulse statistics and night-curve shape, movement (including `in_sleep`, the sleep-lab style count, and `reference`, the published healthy bands that apply to this person's sex and age with a verdict), the movement-based sleep-window estimate, repeating-cycle (periodicity) analysis, the ring's own summary, and tags. Individual drops are NOT included - use get_drops.",
    input_schema: { type: "object", additionalProperties: false, required: ["night_id"], properties: { night_id: { type: "integer" } } } },
  { name: "get_drops",
    description: "The individual oxygen drops (desaturation events) of one night, in time order: time of the lowest point, depth in %, lowest SpO2, duration in seconds, pulse rise in bpm around the nadir, whether movement accompanied it, class (A = drop + pulse surge + movement, B = drop + pulse surge, C = drop only) and whether it may be a motion artefact. Returns the total count matching the filters plus up to `limit` rows as a column list and plain rows. Ask for a time window or a minimum depth rather than every drop of a busy night - get_night already has the per-hour counts.",
    input_schema: { type: "object", additionalProperties: false, required: ["night_id"], properties: {
      night_id: { type: "integer" }, from_time: time, to_time: time,
      min_depth: { type: "integer", description: "Only drops at least this deep, in % (3 or more)" },
      with_pulse_surge: { type: "boolean", description: "true = only classes A and B, false = only class C" },
      limit: { type: "integer", description: "Maximum rows (default 40, max 200)" } } } },
  { name: "get_series",
    description: "The recorded signals of one night averaged into time buckets: per bucket the mean and lowest SpO2, mean and highest pulse, summed movement and how many of its 4-second samples were valid. Use it to look at what happened around a particular time, or the shape of the whole night. Returned as a column list and plain rows. At most 120 buckets are returned; `step_minutes` is raised automatically if the window is too long.",
    input_schema: { type: "object", additionalProperties: false, required: ["night_id"], properties: {
      night_id: { type: "integer" }, from_time: time, to_time: time,
      step_minutes: { type: "integer", description: "Bucket length in minutes (default 5, minimum 1)" } } } },
  { name: "get_trends",
    description: "Multi-night summary as shown on the Trends page: for each metric the median of the last 14 full nights with its middle-half range and best/worst, the share of nights above 5 / 15 / 30 drops per hour, how many nights the personal baseline has, and for every tag the median difference between nights with and without it (with the number of nights on each side - fewer than 10 per side is too few to read anything into).",
    input_schema: { type: "object", additionalProperties: false, properties: {} } },
];

const METRIC_COLS = `m.valid_hours, m.mean_spo2, m.baseline_spo2, m.t90_s, m.t90_pct, m.t88_s, m.odi3, m.odi4, m.hypoxic_burden,
  m.arousal_linked_h, m.delta_index, m.mean_pr, m.lowest_pr_30min, m.pr_rises6_h, m.movement_bouts_h, m.sleep_movements_h, m.fragmentation_index,
  m.cyclic_pct, m.est_sleep_window_h, m.est_wake_like_pct`;

const num = v => (v == null ? null : Number(v));
const clamp = (v, lo, hi, dflt) => (Number.isInteger(v) ? Math.min(hi, Math.max(lo, v)) : dflt);
const bad = message => Object.assign(new Error(message), { toolInput: true });
const asJson = v => (typeof v === "string" ? JSON.parse(v) : v);

async function tagsFor(pool, ids) {
  if (!ids.length) return new Map();
  const [rows] = await pool.query(
    "SELECT st.session_id, t.name FROM session_tags st JOIN tags t ON t.id = st.tag_id WHERE st.session_id IN (?) ORDER BY t.name", [ids]);
  const map = new Map();
  for (const r of rows) map.set(r.session_id, [...(map.get(r.session_id) || []), r.name]);
  return map;
}

/** a visible night, or a tool-input error the model can read and correct */
async function night(pool, id) {
  if (!Number.isInteger(id) || id < 1) throw bad("night_id must be a positive integer from list_nights");
  const [[row]] = await pool.execute(
    `SELECT s.id, s.start_time, s.end_time, s.recording_s, s.gap_s, s.is_combined, s.avg_spo2, s.min_spo2, s.drops_3pct, s.drops_4pct,
            s.seconds_below_90, s.o2_score, s.asleep_s, s.notes FROM sessions s WHERE s.id = ? AND ${VISIBLE}`, [id]);
  if (!row) throw bad(`there is no night with id ${id} - call list_nights for the valid ids`);
  return row;
}

function window(row, fromTime, toTime) {
  for (const [k, v] of [["from_time", fromTime], ["to_time", toTime]])
    if (v != null && !(typeof v === "string" && TIME_RE.test(v))) throw bad(`${k} must look like "YYYY-MM-DD HH:MM"`);
  const norm = v => v.replace("T", " ").padEnd(19, ":00").slice(0, 19);
  const from = fromTime ? norm(fromTime) : row.start_time, to = toTime ? norm(toTime) : row.end_time;
  if (from > to) throw bad("from_time is after to_time");
  return [from, to];
}

/** "HH:MM:SS" when the whole window is on one calendar day, otherwise "MM-DD HH:MM:SS" - the date is in from/to already */
const clockOf = (t, from, to) => (from.slice(0, 10) === to.slice(0, 10) ? t.slice(11) : t.slice(5));

const ringSummary = row => ({ avg_spo2: row.avg_spo2, min_spo2: row.min_spo2, drops_3pct: row.drops_3pct, drops_4pct: row.drops_4pct,
  seconds_below_90: row.seconds_below_90, o2_score: num(row.o2_score), asleep_s: row.asleep_s });

export function makeTools(pool, { sendNotes = true } = {}) {
  const impl = {
    async list_nights({ from, to, limit } = {}) {
      for (const [k, v] of [["from", from], ["to", to]]) if (v != null && !(typeof v === "string" && DATE_RE.test(v))) throw bad(`${k} must look like "YYYY-MM-DD"`);
      const where = [VISIBLE], args = [];
      if (from) { where.push("s.start_time >= ?"); args.push(`${from} 00:00:00`); }
      if (to) { where.push("s.start_time <= ?"); args.push(`${to} 23:59:59`); }
      const [rows] = await pool.query(
        `SELECT s.id, s.start_time, s.end_time, s.is_combined, s.drops_3pct, s.drops_4pct, s.o2_score, s.notes, ${METRIC_COLS}
           FROM sessions s LEFT JOIN session_metrics m ON m.session_id = s.id
          WHERE ${where.join(" AND ")} ORDER BY s.start_time DESC LIMIT ?`, [...args, clamp(limit, 1, 120, 60)]);
      const tags = await tagsFor(pool, rows.map(r => r.id));
      return { count: rows.length, nights: rows.map(({ notes, is_combined, o2_score, drops_3pct, drops_4pct, id, start_time, end_time, ...m }) => ({
        id, start: start_time, end: end_time, combined_from_several_recordings: !!is_combined,
        short: m.valid_hours == null || Number(m.valid_hours) < 4,
        ...Object.fromEntries(Object.entries(m).map(([k, v]) => [k, num(v)])),
        ring_drops_3pct: drops_3pct, ring_drops_4pct: drops_4pct, ring_o2_score: num(o2_score),
        tags: tags.get(id) || [], ...(sendNotes && notes ? { notes } : {}) })) };
    },

    async get_night({ night_id } = {}) {
      const row = await night(pool, night_id);
      const [[metrics]] = await pool.execute("SELECT detail FROM session_metrics WHERE session_id = ?", [night_id]);
      const tags = await tagsFor(pool, [night_id]);
      const { events, definitions, event_rows, ...analysis } = metrics ? asJson(metrics.detail) : {};
      return { id: row.id, start: row.start_time, end: row.end_time, recorded_s: row.recording_s - row.gap_s,
        gaps_inside_s: row.gap_s, combined_from_several_recordings: !!row.is_combined, ring_summary: ringSummary(row),
        tags: tags.get(night_id) || [], ...(sendNotes && row.notes ? { notes: row.notes } : {}),
        analysis: metrics ? analysis : "not analysed yet - run ./o2ring_db.py --reanalyze" };
    },

    async get_drops({ night_id, from_time, to_time, min_depth, with_pulse_surge, limit } = {}) {
      const row = await night(pool, night_id), [from, to] = window(row, from_time, to_time);
      const where = ["session_id = ?", "nadir_time BETWEEN ? AND ?"], args = [night_id, from, to];
      if (min_depth != null) { if (!Number.isInteger(min_depth)) throw bad("min_depth must be an integer"); where.push("depth >= ?"); args.push(min_depth); }
      if (with_pulse_surge != null) { if (typeof with_pulse_surge !== "boolean") throw bad("with_pulse_surge must be true or false"); where.push(with_pulse_surge ? "class IN ('A','B')" : "class = 'C'"); }
      const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM desat_events WHERE ${where.join(" AND ")}`, args);
      const [rows] = await pool.query(
        `SELECT nadir_time, depth, nadir_spo2, duration_s, pr_rise_bpm, has_motion, motion_suspect, class
           FROM desat_events WHERE ${where.join(" AND ")} ORDER BY nadir_time LIMIT ?`, [...args, clamp(limit, 1, 200, 40)]);
      // column list + plain rows: the same information in about a third of the tokens of one object per drop
      return { night_id, night_start: row.start_time, from, to, total_matching: total, returned: rows.length,
        columns: ["lowest_at", "depth_pct", "lowest_spo2", "duration_s", "pulse_rise_bpm", "movement(0/1)", "possibly_motion_artefact(0/1)", "class"],
        rows: rows.map(r => [clockOf(r.nadir_time, from, to), r.depth, r.nadir_spo2, r.duration_s, r.pr_rise_bpm, r.has_motion ? 1 : 0, r.motion_suspect ? 1 : 0, r.class]) };
    },

    async get_series({ night_id, from_time, to_time, step_minutes } = {}) {
      const row = await night(pool, night_id), [from, to] = window(row, from_time, to_time);
      const minutes = Math.max(1, (Date.parse(to.replace(" ", "T") + "Z") - Date.parse(from.replace(" ", "T") + "Z")) / 60000);
      const step = Math.max(clamp(step_minutes, 1, 120, 5), Math.ceil(minutes / 120)), per = step * 15; // 15 samples per minute
      const [rows] = await pool.query(
        `SELECT MIN(sample_time) AS t, ROUND(AVG(spo2), 1) AS spo2_mean, MIN(spo2) AS spo2_min, ROUND(AVG(pr), 1) AS pulse_mean, MAX(pr) AS pulse_max,
                SUM(motion) AS movement, SUM(spo2 IS NOT NULL) AS valid_samples, COUNT(*) AS samples
           FROM samples WHERE session_id = ? AND sample_time BETWEEN ? AND ? GROUP BY FLOOR(seq / ?) ORDER BY t`, [night_id, from, to, per]);
      return { night_id, night_start: row.start_time, from, to, step_minutes: step,
        columns: ["bucket_start", "spo2_mean", "spo2_min", "pulse_mean", "pulse_max", "movement_sum", "valid_samples", "samples"],
        rows: rows.map(r => [clockOf(r.t, from, to), num(r.spo2_mean), r.spo2_min, num(r.pulse_mean), r.pulse_max, num(r.movement), num(r.valid_samples), r.samples]) };
    },

    async get_trends() {
      const [rows] = await pool.query(
        `SELECT s.id, s.start_time, ${METRIC_COLS} FROM sessions s LEFT JOIN session_metrics m ON m.session_id = s.id WHERE ${VISIBLE} ORDER BY s.start_time`);
      const tags = await tagsFor(pool, rows.map(r => r.id));
      const t = buildTrends(rows.map(({ id, start_time, ...m }) => ({ id, start_time, notes: "", tags: tags.get(id) || [],
        ...Object.fromEntries(Object.entries(m).map(([k, v]) => [k, num(v)])) })));
      return { full_nights: t.nights.length, recordings_left_out_for_being_shorter_than_4h: t.excluded,
        first_night: t.nights[0]?.start ?? null, last_night: t.nights.at(-1)?.start ?? null,
        metrics: t.series.map(s => ({ key: s.key, label: s.label, unit: s.unit, what_it_is: s.desc, worse_when: s.worse,
          median_last_14: s.summary.median14, middle_half: [s.summary.p25, s.summary.p75], best: s.summary.best, worst: s.summary.worst })),
        share_of_nights_at_or_above: t.thresholds, personal_baseline: t.baseline, tags_with_vs_without: t.tags, multi_night_prompts: t.prompts };
    },
  };

  /** Run one tool call. Never throws for bad input - the model gets a readable error it can correct. */
  return async function run(name, input) {
    if (!Object.hasOwn(impl, name)) return { is_error: true, content: `unknown tool ${name}` };
    try {
      const args = input && typeof input === "object" ? input : {};
      const result = await impl[name](args);
      const nightStart = result.start ?? result.night_start;
      return { is_error: false, content: JSON.stringify(result), label: describeCall(name, args, nightStart) };
    } catch (err) {
      if (err.toolInput) return { is_error: true, content: err.message };
      throw err; // database trouble etc. is the server's problem, not the model's
    }
  };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const hm = t => String(t).slice(11, 16);
/** One-line, human-readable description of a tool call for the "Looked at" list under an answer. */
export function describeCall(name, input = {}, nightStart) {
  const night = nightStart ? `night of ${MONTHS[Number(nightStart.slice(5, 7)) - 1]} ${Number(nightStart.slice(8, 10))}` : `night ${input.night_id}`;
  const span = input.from_time || input.to_time ? `, ${input.from_time ? hm(input.from_time) : "start"}–${input.to_time ? hm(input.to_time) : "end"}` : "";
  switch (name) {
    case "list_nights": return `the list of nights${input.from || input.to ? ` (${input.from ?? "…"} to ${input.to ?? "…"})` : ""}`;
    case "get_night": return `${night}: full analysis`;
    case "get_drops": return `${night}: oxygen drops${span}${input.min_depth ? `, ≥${input.min_depth} %` : ""}${input.with_pulse_surge === true ? ", with pulse surge" : input.with_pulse_surge === false ? ", without pulse surge" : ""}`;
    case "get_series": return `${night}: signals over time${span}`;
    case "get_trends": return "multi-night trends and tag comparisons";
    case "run_sql": return `a database query: ${String(input.purpose || input.sql || "").replace(/\s+/g, " ").slice(0, 90)}`;
    default: return name;
  }
}

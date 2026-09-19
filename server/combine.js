// Combine several recordings of one night into a single session (and undo it).
//
// A combined night is an ordinary row in `sessions` (is_combined = 1) with its own samples, so reports, analytics,
// notes, tags and trends all work on it unchanged. Its parts stay in the database with merged_into = <combined id>
// and simply drop out of lists and trends; "split" deletes the combined row and clears merged_into, which brings
// them straight back. Gaps between parts become samples without readings, which keeps the time
// axis honest and stops any analysis from running across a gap.

export const SAMPLE_S = 4;
export const MAX_GAP_S = 3 * 3600;      // parts further apart than this are not the same night
export const SUGGEST_GAP_S = 90 * 60;   // the list offers to combine recordings closer together than this

const toSec = wall => { const [d, t] = wall.split(/[ T]/), [Y, M, D] = d.split("-").map(Number), [h, m, s] = t.split(":").map(Number); return Date.UTC(Y, M - 1, D, h, m, s) / 1000; };
const toWall = sec => new Date(sec * 1000).toISOString().slice(0, 19).replace("T", " ");

/** Validate the parts and work out where each one lands on the combined 4-second grid. Pure - no database. */
export function planCombine(parts) {
  if (parts.length < 2) throw new Error("pick at least two recordings");
  const sorted = [...parts].sort((a, b) => toSec(a.start_time) - toSec(b.start_time));
  if (new Set(sorted.map(p => p.device_sn)).size > 1) throw new Error("recordings come from different rings");
  if (sorted.some(p => p.is_combined)) throw new Error("one of these is already a combined night - split it first");
  if (sorted.some(p => p.merged_into != null)) throw new Error("one of these is already part of a combined night");
  const t0 = toSec(sorted[0].start_time);
  let next = 0, gap = 0;
  const placed = sorted.map((p, k) => {
    const wanted = Math.round((toSec(p.start_time) - t0) / SAMPLE_S);
    if (k && wanted < next - 2) throw new Error("recordings overlap in time");
    const offset = Math.max(wanted, next);
    if (k && (offset - next) * SAMPLE_S > MAX_GAP_S) throw new Error("recordings are more than 3 hours apart");
    gap += (offset - next) * (k ? 1 : 0);
    const out = { ...p, offset, gap_before: k ? offset - next : 0 };
    next = offset + p.sample_count;
    return out;
  });
  const weight = key => { // time-weighted mean over the parts that have a value
    const have = placed.filter(p => p[key] != null);
    const total = have.reduce((t, p) => t + p.recording_s, 0);
    return have.length && total ? have.reduce((t, p) => t + Number(p[key]) * p.recording_s, 0) / total : null;
  };
  const sum = key => placed.reduce((t, p) => t + (p[key] || 0), 0);
  return {
    parts: placed,
    session: {
      device_sn: sorted[0].device_sn,
      file_name: `${sorted[0].file_name}+${sorted.length - 1}`,
      start_time: sorted[0].start_time,
      end_time: toWall(t0 + (next - 1) * SAMPLE_S),
      recording_s: next * SAMPLE_S,
      gap_s: gap * SAMPLE_S,
      sample_count: next,
      asleep_s: sum("asleep_s"), drops_3pct: sum("drops_3pct"), drops_4pct: sum("drops_4pct"),
      seconds_below_90: sum("seconds_below_90"), drops_below_90: sum("drops_below_90"), steps: sum("steps"),
      avg_spo2: weight("avg_spo2") == null ? null : Math.round(weight("avg_spo2")),
      min_spo2: Math.min(...placed.map(p => p.min_spo2).filter(v => v != null)),
      o2_score: weight("o2_score") == null ? null : Number(weight("o2_score").toFixed(1)),
      asleep_time_pct: null, file_version: sorted[0].file_version, operation_mode: sorted[0].operation_mode,
    },
  };
}

/** Groups of visible, un-combined recordings from one ring that follow each other closely - likely one night. */
export function suggestGroups(sessions) {
  const usable = sessions.filter(s => !s.hidden && !s.is_combined && s.merged_into == null)
    .sort((a, b) => a.device_sn.localeCompare(b.device_sn) || toSec(a.start_time) - toSec(b.start_time));
  const groups = [];
  let run = [];
  for (const s of usable) {
    const prev = run.at(-1);
    const gap = prev ? toSec(s.start_time) - toSec(prev.end_time) : null;
    if (prev && prev.device_sn === s.device_sn && gap >= -2 * SAMPLE_S && gap <= SUGGEST_GAP_S) run.push(s);
    else { if (run.length > 1) groups.push(run); run = [s]; }
  }
  if (run.length > 1) groups.push(run);
  return groups.map(g => ({ ids: g.map(s => s.id), start: g[0].start_time, end: g.at(-1).end_time,
    gaps_min: g.slice(1).map((s, k) => Math.round((toSec(s.start_time) - toSec(g[k].end_time)) / 60)) }));
}

const PART_COLS = `id, device_sn, file_name, start_time, end_time, recording_s, asleep_s, avg_spo2, min_spo2, drops_3pct, drops_4pct,
  seconds_below_90, drops_below_90, o2_score, steps, file_version, operation_mode, sample_count, is_combined, merged_into`;

export async function combineSessions(pool, ids) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query(`SELECT ${PART_COLS} FROM sessions WHERE id IN (?) FOR UPDATE`, [ids]);
    if (rows.length !== ids.length) throw Object.assign(new Error("recording not found"), { status: 404 });
    const plan = planCombine(rows), s = plan.session;
    const [ins] = await conn.query("INSERT INTO sessions SET ?, is_combined = 1", [s]);
    const combinedId = ins.insertId;
    for (const p of plan.parts) {
      if (p.gap_before) { // samples without readings across the gap
        const t0 = toSec(s.start_time), first = p.offset - p.gap_before;
        const gapRows = Array.from({ length: p.gap_before }, (_, k) => [combinedId, first + k, toWall(t0 + (first + k) * SAMPLE_S), null, null, 0, null]);
        for (let at = 0; at < gapRows.length; at += 1000)
          await conn.query("INSERT INTO samples (session_id, seq, sample_time, spo2, pr, motion, flags) VALUES ?", [gapRows.slice(at, at + 1000)]);
      }
      await conn.query(`INSERT INTO samples (session_id, seq, sample_time, spo2, pr, motion, flags)
                        SELECT ?, seq + ?, sample_time, spo2, pr, motion, flags FROM samples WHERE session_id = ?`, [combinedId, p.offset, p.id]);
    }
    await conn.query("UPDATE sessions SET merged_into = ? WHERE id IN (?)", [combinedId, ids]);
    await conn.commit();
    return combinedId;
  } catch (err) {
    await conn.rollback();
    if (!err.status && !err.code) err.status = 400; // planCombine's validation messages
    throw err;
  } finally {
    conn.release();
  }
}

export async function splitSession(pool, id) {
  const [[row]] = await pool.execute("SELECT is_combined FROM sessions WHERE id = ?", [id]);
  if (!row) throw Object.assign(new Error("session not found"), { status: 404 });
  if (!row.is_combined) throw Object.assign(new Error("this is not a combined night"), { status: 400 });
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute("UPDATE sessions SET merged_into = NULL WHERE merged_into = ?", [id]);
    await conn.execute("DELETE FROM sessions WHERE id = ?", [id]); // samples, metrics, events and tags cascade
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

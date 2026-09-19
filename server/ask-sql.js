// Optional read-only SQL tool for the Ask panel (O2RING_LLM_SQL=1).
//
// The five fixed tools answer most questions; this one lets the model write its own SELECT for the rest
// ("which hour of the night has the most drops across all nights?"). Because a model writes the SQL, safety does not
// rest on any single check:
//   1. A separate MySQL user that can only SELECT (O2RING_DB_RO_USER / O2RING_DB_RO_PASSWORD). At start-up the server
//      reads that user's grants and refuses to enable the tool if it finds anything other than SELECT/USAGE.
//      Column-level grants keep the ring's serial number and the raw files out of reach - see INSTALL.md.
//   2. The statement itself is checked: one statement, SELECT/WITH only, no file/system functions or schemas.
//   3. Each query runs on its own connection in a READ ONLY transaction with a 3-second server-side time limit;
//      rows are streamed and the connection is destroyed after 200 rows, so a runaway result cannot fill memory.

import mysql from "mysql2";

export const MAX_SQL = 2000, MAX_ROWS = 200, MAX_CELL = 300, TIME_LIMIT_MS = 3000;

export const SQL_TOOL_DEF = {
  name: "run_sql",
  description: `Run one read-only MySQL 8 SELECT against the recordings database and get up to ${MAX_ROWS} rows back. Use it only when the other tools cannot answer - aggregates across nights, custom groupings, correlations. One statement, SELECT or WITH only. Always restrict to visible nights with \`hidden = 0 AND merged_into IS NULL\` on sessions. Times are local wall-clock DATETIMEs. Prefer aggregates over raw rows: samples has one row per 4 seconds (~900 per hour). Name the columns you need: \`SELECT *\` on sessions is denied because some of its columns are deliberately unreadable.
Tables:
sessions(id, file_name, start_time, end_time, recording_s, gap_s, asleep_s, avg_spo2, min_spo2, drops_3pct, drops_4pct, seconds_below_90, drops_below_90, o2_score, steps, sample_count, notes, hidden, is_combined, merged_into) - one row per recording; the *_pct / o2_score / avg / min columns are the ring's own summary
session_metrics(session_id, valid_hours, valid_pct, mean_spo2, baseline_spo2, t90_s, t90_pct, t88_s, odi3, odi4, hypoxic_burden, arousal_linked_h, delta_index, mean_pr, lowest_pr_30min, pr_rises6_h, movement_bouts_h, fragmentation_index, cyclic_pct, est_sleep_window_h, est_wake_like_pct) - this dashboard's analysis, one row per recording
desat_events(session_id, seq, start_time, nadir_time, end_time, duration_s, peak_spo2, nadir_spo2, depth, area_pct_min, pr_rise_bpm, has_motion, motion_suspect, class) - one row per oxygen drop; class A = drop + pulse surge + movement, B = drop + pulse surge, C = drop only
samples(session_id, seq, sample_time, spo2, pr, motion) - raw 4-second samples, NULL = no valid reading
tags(id, name), session_tags(session_id, tag_id)`,
  input_schema: { type: "object", additionalProperties: false, required: ["sql"], properties: {
    sql: { type: "string", description: "A single SELECT (or WITH ... SELECT) statement, no trailing semicolon" },
    purpose: { type: "string", description: "A few words on what this query is for, shown to the user" } } },
};

const FORBIDDEN = [
  [/;/, "only one statement is allowed (no semicolons)"],
  [/--|\/\*|#/, "comments are not allowed"],
  [/\b(insert|update|delete|replace|drop|alter|create|truncate|rename|grant|revoke|call|handler|load|lock|unlock|set|use|prepare|execute|deallocate|do|begin|commit|rollback|start|kill|flush|reset|analyze|optimize|repair|install|uninstall|shutdown)\b/i, "only SELECT statements are allowed"],
  [/\binto\s+(outfile|dumpfile|@)/i, "SELECT ... INTO is not allowed"],
  [/\b(load_file|sleep|benchmark|get_lock|release_lock|is_free_lock|master_pos_wait|source_pos_wait|sys_exec|sys_eval|version|user|current_user|session_user|system_user|database|schema|connection_id)\s*\(/i, "that function is not allowed"],
  [/\b(information_schema|performance_schema|mysql|sys)\s*\./i, "system schemas are not readable"],
  [/@@|@[a-z_]/i, "variables are not allowed"],
  [/\bfor\s+(update|share)\b|\block\s+in\s+share\s+mode\b/i, "locking reads are not allowed"],
];

/** Returns null when the statement may run, otherwise a message the model can read and act on. */
export function sqlProblem(sql) {
  if (typeof sql !== "string" || !sql.trim()) return "sql must be a non-empty string";
  const text = sql.trim();
  if (text.length > MAX_SQL) return `the statement is limited to ${MAX_SQL} characters`;
  if (!/^(select|with)\b/i.test(text)) return "the statement must start with SELECT or WITH";
  const bare = text.replace(/'(?:[^'\\]|\\.|'')*'/g, "''");   // string literals may contain anything; judge the rest
  if (/['"`]/.test(bare.replace(/''/g, "").replace(/`[A-Za-z0-9_]+`/g, ""))) return "unbalanced or unsupported quoting - use single quotes for strings";
  for (const [pattern, message] of FORBIDDEN) if (pattern.test(bare)) return message;
  return null;
}

/**
 * true when the connected user can do nothing but read THIS database: every grant is either USAGE, or SELECT
 * (optionally column-level) on `database`.something. SELECT ON *.* or on another schema is refused - it would let the
 * model read every database on the server.
 */
export function grantsAreReadOnly(grants, database) {
  const db = String(database).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const usage = /^GRANT\s+USAGE\s+ON\s+\*\.\*\s+TO\s/i;
  const select = new RegExp(`^GRANT\\s+SELECT(\\s*\\([^)]*\\))?(\\s*,\\s*SELECT\\s*\\([^)]*\\))*\\s+ON\\s+\`?${db}\`?\\.\\S+\\s+TO\\s`, "i");
  return grants.length > 0 && grants.every(g => (usage.test(g) || select.test(g)) && !/WITH\s+GRANT\s+OPTION/i.test(g));
}

/** Things the model must never be able to read, whatever the grants say. Each is tried; any success keeps the tool off. */
export const forbiddenReads = ({ sendNotes }) => [
  ["the ring's serial number", "SELECT device_sn FROM sessions LIMIT 0"],
  ["the raw recording files", "SELECT raw_file FROM sessions LIMIT 0"],
  ["the devices table", "SELECT 1 FROM devices LIMIT 0"],
  ["your stored questions and answers", "SELECT 1 FROM ask_messages LIMIT 0"],
  ...(sendNotes ? [] : [["your notes (O2RING_LLM_SEND_NOTES=0)", "SELECT notes FROM sessions LIMIT 0"]]),
];

// MySQL 8's default mode, set explicitly on every query connection: the statement screen below strips string
// literals assuming backslash escapes work, which NO_BACKSLASH_ESCAPES (or ANSI_QUOTES) would change.
const SQL_MODE = "ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION";

export function sqlSettings(env = process.env) {
  if (env.O2RING_LLM_SQL !== "1") return null;
  return { host: env.O2RING_DB_HOST || "127.0.0.1", port: Number(env.O2RING_DB_PORT || 3306), database: env.O2RING_DB_NAME || "lookee_data",
    user: env.O2RING_DB_RO_USER, password: env.O2RING_DB_RO_PASSWORD, charset: "utf8mb4", dateStrings: true };
}

/** Decide at start-up whether the tool may be offered. Resolves to { ok, reason }. */
export async function checkSqlUser(settings, { sendNotes = true } = {}) {
  if (!settings) return { ok: false, reason: "off" };
  if (!settings.user || !settings.password) return { ok: false, reason: "O2RING_LLM_SQL=1 needs a separate read-only MySQL user: set O2RING_DB_RO_USER and O2RING_DB_RO_PASSWORD (INSTALL.md)" };
  if (settings.user === (process.env.O2RING_DB_USER || "lookee")) return { ok: false, reason: "O2RING_DB_RO_USER must not be the normal database user" };
  const conn = mysql.createConnection(settings).promise();
  try {
    const [rows] = await conn.query("SHOW GRANTS");
    const grants = rows.map(r => String(Object.values(r)[0]));
    if (!grantsAreReadOnly(grants, settings.database))
      return { ok: false, reason: `the MySQL user "${settings.user}" can do more than SELECT on ${settings.database} - the SQL tool stays off` };
    for (const [what, probe] of forbiddenReads({ sendNotes })) {
      const readable = await conn.query(probe).then(() => true, () => false);
      if (readable) return { ok: false, reason: `the MySQL user "${settings.user}" can read ${what} - tighten its grants (INSTALL.md); the SQL tool stays off` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `could not log in as the read-only MySQL user: ${err.message}` };
  } finally {
    conn.destroy();
  }
}

const cell = v => (v == null ? null : Buffer.isBuffer(v) ? "[binary]" : typeof v === "string" && v.length > MAX_CELL ? `${v.slice(0, MAX_CELL)}…` : v);

/** Build the tool runner for run_sql. Input problems come back as text for the model; they are never thrown. */
export function makeSqlTool(settings) {
  return async function runSql(input) {
    const problem = sqlProblem(input?.sql);
    if (problem) return { is_error: true, content: problem };
    const conn = mysql.createConnection(settings);
    try {
      await conn.promise().query(`SET SESSION max_execution_time = ${TIME_LIMIT_MS}, sql_mode = '${SQL_MODE}'`);
      await conn.promise().query("START TRANSACTION READ ONLY");
      const rows = [];
      let truncated = false;
      await new Promise((resolve, reject) => {
        const stream = conn.query(input.sql.trim()).stream();
        stream.on("data", row => {
          if (rows.length < MAX_ROWS) rows.push(Object.fromEntries(Object.entries(row).map(([k, v]) => [k, cell(v)])));
          else if (!truncated) { truncated = true; stream.destroy(); resolve(); }
        });
        stream.on("end", resolve);
        stream.on("error", reject);
      });
      return { is_error: false, content: JSON.stringify({ row_count: rows.length, truncated_at_200_rows: truncated, rows }),
        label: `a database query: ${String(input.purpose || input.sql).replace(/\s+/g, " ").slice(0, 90)}` };
    } catch (err) {
      // syntax errors, unknown or forbidden columns, the time limit: all things the model can fix by rewriting the query
      return { is_error: true, content: `MySQL error: ${err.sqlMessage || err.message}` };
    } finally {
      conn.destroy();   // also abandons whatever the server had not sent yet
    }
  };
}

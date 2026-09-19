#!/usr/bin/env node
// O2Ring report server: serves the app-style reports from MySQL and stores notes.
//
//   cd server && npm install && npm start      -> http://127.0.0.1:3000
//
// Settings come from the environment or ../.env (same file the Python tools use):
//   O2RING_DB_HOST/PORT/NAME/USER/PASSWORD, plus optional HOST and PORT for the listener.
// There is no login, so it binds to 127.0.0.1 unless HOST says otherwise.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import mysql from "mysql2/promise";
import { buildReport, hms } from "./report.js";
import { execFile } from "node:child_process";
import { baselineFlags, buildTrends } from "./trends.js";
import { combineSessions, splitSession, suggestGroups } from "./combine.js";
import { allowedHosts, guard } from "./guard.js";
import { Anthropic, answerQuestion, askConfig, askStatus, contextBlock, describeApiError, historyFrom, makeTools, systemPrompt, validateRequest, writeSummary } from "./ask.js";
import { checkSqlUser, makeSqlTool, sqlSettings } from "./ask-sql.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = join(HERE, "..", "report_template.html");
const TRENDS_TEMPLATE = join(HERE, "..", "trends_template.html");
const INDEX_TEMPLATE = join(HERE, "..", "index_template.html");
const TAG_MAX_LEN = 40, TAGS_PER_NIGHT = 20;

// footer.html with the logo inlined (same as the static generator does), injected into every page
const FOOTER = readFileSync(join(HERE, "..", "footer.html"), "utf8")
  .replaceAll("{{LOGO}}", () => `data:image/png;base64,${readFileSync(join(HERE, "..", "assets", "northtrail-logo.png")).toString("base64")}`);
const page = (template, marker, json) => readFileSync(template, "utf8").replace("<!--FOOTER-->", () => FOOTER)
  .replace("<!--ASK-->", () => readFileSync(join(HERE, "..", "ask_panel.html"), "utf8")).replace(marker, () => json);
const NOTES_MAX = 200;

function loadEnv(file) {
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim(), eq = line.indexOf("=");
    if (!line || line.startsWith("#") || eq < 0) continue;
    let val = line.slice(eq + 1).trim();
    if (val.length >= 2 && val[0] === val.at(-1) && `'"`.includes(val[0])) val = val.slice(1, -1);
    process.env[line.slice(0, eq).trim()] ??= val; // real environment wins
  }
}
loadEnv(join(HERE, "..", ".env"));

if (!process.env.O2RING_DB_PASSWORD) {
  console.error("O2RING_DB_PASSWORD is not set - copy .env.example to .env and fill it in");
  process.exit(1);
}

const pool = mysql.createPool({
  host: process.env.O2RING_DB_HOST || "127.0.0.1",
  port: Number(process.env.O2RING_DB_PORT || 3306),
  user: process.env.O2RING_DB_USER || "lookee",
  password: process.env.O2RING_DB_PASSWORD,
  database: process.env.O2RING_DB_NAME || "lookee_data",
  charset: "utf8mb4",
  dateStrings: true, // keep the ring's wall-clock times as-is, no timezone shifting
  connectionLimit: 5,
});

/** sessions.notes was added for this server; create it on databases made before that */
async function migrate() {
  const [cols] = await pool.query(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sessions'");
  const have = new Set(cols.map(c => c.COLUMN_NAME));
  const wanted = { notes: `VARCHAR(${NOTES_MAX}) NULL`, notes_updated_at: "DATETIME NULL", hidden: "BOOLEAN NOT NULL DEFAULT 0",
    is_combined: "BOOLEAN NOT NULL DEFAULT 0", merged_into: "INT NULL", gap_s: "INT UNSIGNED NOT NULL DEFAULT 0" };
  for (const [name, ddl] of Object.entries(wanted))
    if (!have.has(name)) await pool.query(`ALTER TABLE sessions ADD COLUMN ${name} ${ddl}`);
}

/** "Ask" conversations. A NULL session_id is a conversation on the trends page (about all nights). */
async function migrateAsk() {
  await pool.query(`CREATE TABLE IF NOT EXISTS ask_conversations (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      session_id INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      KEY idx_ask_session (session_id),
      CONSTRAINT fk_ask_session FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE CASCADE)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS ask_messages (
      id              INT AUTO_INCREMENT PRIMARY KEY,
      conversation_id INT NOT NULL,
      role            ENUM('user', 'assistant') NOT NULL,
      content         TEXT NOT NULL,
      looked_at       JSON NULL,
      model           VARCHAR(64) NULL,
      input_tokens    INT UNSIGNED NULL,
      output_tokens   INT UNSIGNED NULL,
      created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      KEY idx_ask_conv (conversation_id, id),
      CONSTRAINT fk_ask_conv FOREIGN KEY (conversation_id) REFERENCES ask_conversations (id) ON DELETE CASCADE)`);
  // the "morning summary": written once per night (and again when the analysis behind it changes)
  await pool.query(`CREATE TABLE IF NOT EXISTS night_summaries (
      session_id    INT PRIMARY KEY,
      summary       TEXT NOT NULL,
      model         VARCHAR(64) NULL,
      algo_version  INT NULL,
      input_tokens  INT UNSIGNED NULL,
      output_tokens INT UNSIGNED NULL,
      created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      CONSTRAINT fk_summary_session FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE CASCADE)`);
}

/** Analytics live in Python (o2ring_analytics.py); after combining, let it analyse the new night. */
function runAnalytics() {
  return new Promise(resolve => execFile(process.env.O2RING_PYTHON || "python3", [join(HERE, "..", "o2ring_db.py"), "--reanalyze"],
    { cwd: join(HERE, ".."), timeout: 120000 }, (err, stdout, stderr) => {
      if (err) console.error(`analytics failed: ${stderr || err.message}`);
      resolve(!err);
    }));
}

const SUMMARY_COLS = `id, device_sn, file_name, start_time, end_time, recording_s, asleep_s, avg_spo2, min_spo2,
  drops_3pct, drops_4pct, seconds_below_90, drops_below_90, o2_score, steps, sample_count, notes, notes_updated_at,
  hidden, is_combined, merged_into, gap_s`;

const asJson = v => (typeof v === "string" ? JSON.parse(v) : v);
const METRIC_COLS = `m.valid_hours, m.mean_spo2, m.t90_pct, m.t88_s, m.odi3, m.odi4, m.hypoxic_burden, m.arousal_linked_h,
  m.lowest_pr_30min, m.pr_rises6_h, m.movement_bouts_h, m.fragmentation_index, m.cyclic_pct, m.est_wake_like_pct`;

/** every night with its headline metrics (numbers, not DECIMAL strings) and tags - input for trends.js */
async function loadNights() {
  let rows;
  try {
    [rows] = await pool.query(`SELECT s.id, s.start_time, s.notes, ${METRIC_COLS},
        (SELECT GROUP_CONCAT(t.name ORDER BY t.name SEPARATOR '\n') FROM session_tags st JOIN tags t ON t.id = st.tag_id
          WHERE st.session_id = s.id) AS tag_list
      FROM sessions s LEFT JOIN session_metrics m ON m.session_id = s.id
      WHERE s.hidden = 0 AND s.merged_into IS NULL ORDER BY s.start_time`);
  } catch (err) {
    // analytics tables / columns are created by o2ring_db.py - run `./o2ring_db.py --reanalyze` once
    if (err.code === "ER_NO_SUCH_TABLE" || err.code === "ER_BAD_FIELD_ERROR") return [];
    throw err;
  }
  return rows.map(({ tag_list, id, start_time, notes, ...metrics }) => ({
    id, start_time, notes, tags: tag_list ? tag_list.split("\n") : [],
    ...Object.fromEntries(Object.entries(metrics).map(([k, v]) => [k, v == null ? null : Number(v)])),
  }));
}

/** insights (stored by o2ring_db.py), tags and personal-baseline flags for one report */
async function loadExtras(id) {
  try {
    const [[metrics]] = await pool.execute("SELECT detail FROM session_metrics WHERE session_id = ?", [id]);
    const [tags] = await pool.execute(
      "SELECT t.name FROM session_tags st JOIN tags t ON t.id = st.tag_id WHERE st.session_id = ? ORDER BY t.name", [id]);
    const [allTags] = await pool.query("SELECT name FROM tags ORDER BY id");
    return {
      insights: metrics ? asJson(metrics.detail) : null,
      tags: tags.map(t => t.name), all_tags: allTags.map(t => t.name),
      baseline: baselineFlags(await loadNights(), id),
    };
  } catch (err) {
    if (err.code === "ER_NO_SUCH_TABLE") return { insights: null };
    throw err;
  }
}

async function loadReport(id) {
  const [[session]] = await pool.execute(`SELECT ${SUMMARY_COLS} FROM sessions WHERE id = ?`, [id]);
  if (!session) return null;
  const [samples] = await pool.execute("SELECT spo2, pr, motion FROM samples WHERE session_id = ? ORDER BY seq", [id]);
  const [[device]] = await pool.execute("SELECT last_info FROM devices WHERE sn = ?", [session.device_sn]);
  const report = { ...buildReport(session, samples, asJson(device?.last_info)), ...(await loadExtras(id)) };
  if (session.is_combined) {
    const [parts] = await pool.execute("SELECT id, start_time, end_time FROM sessions WHERE merged_into = ? ORDER BY start_time", [id]);
    report.parts = parts.map(p => ({ id: p.id, start: p.start_time.replace(" ", "T"), end: p.end_time.replace(" ", "T") }));
  }
  return report;
}

const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);
const sessionId = req => (/^\d{1,9}$/.test(req.params.id) ? Number(req.params.id) : null);

const app = express();
app.disable("x-powered-by");
app.use((req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store", // health data: keep it out of shared caches
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "font-src https://fonts.gstatic.com; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  });
  next();
});
app.use(guard(allowedHosts())); // Host allow-list + JSON-only, same-origin writes (see guard.js)
app.use(express.json({ limit: "4kb" }));

/* ---------- API ---------- */
app.get("/api/sessions", wrap(async (req, res) => { // ?all=1 also lists hidden recordings and the parts of combined nights
  const [rows] = await pool.query(`SELECT ${SUMMARY_COLS} FROM sessions
    ${req.query.all ? "" : "WHERE hidden = 0 AND merged_into IS NULL"} ORDER BY start_time DESC`);
  res.json(rows.map(r => ({ ...r, o2_score: r.o2_score == null ? null : Number(r.o2_score) })));
}));

app.get("/api/sessions/:id", wrap(async (req, res) => {
  const id = sessionId(req), report = id && (await loadReport(id));
  if (!report) return res.status(404).json({ error: "session not found" });
  res.json(report);
}));

app.put("/api/sessions/:id/notes", wrap(async (req, res) => {
  const id = sessionId(req), notes = req.body?.notes;
  if (!id) return res.status(404).json({ error: "session not found" });
  if (typeof notes !== "string") return res.status(400).json({ error: "body must be {\"notes\": \"...\"}" });
  if ([...notes].length > NOTES_MAX) return res.status(400).json({ error: `notes are limited to ${NOTES_MAX} characters` });
  const [result] = await pool.execute(
    "UPDATE sessions SET notes = ?, notes_updated_at = NOW() WHERE id = ?", [notes.trim() === "" ? null : notes, id]);
  if (!result.affectedRows) return res.status(404).json({ error: "session not found" });
  res.json({ ok: true, notes });
}));

app.post("/api/sessions/combine", wrap(async (req, res) => {
  const ids = req.body?.ids;
  if (!Array.isArray(ids) || ids.length < 2 || ids.length > 12 || ids.some(i => !Number.isInteger(i) || i < 1) || new Set(ids).size !== ids.length)
    return res.status(400).json({ error: 'body must be {"ids": [2 to 12 different session ids]}' });
  const id = await combineSessions(pool, ids);
  const analysed = await runAnalytics();
  if (analysed && ASK.enabled && (await spentToday()) < ASK.dailyLimit) { const st = await summaryState(id); if (st?.status === "missing") writeSummaryFor(id, st.algo_version); }   // ready by the time the report opens
  res.json({ ok: true, id, analysed });
}));

app.post("/api/sessions/:id/split", wrap(async (req, res) => {
  const id = sessionId(req);
  if (!id) return res.status(404).json({ error: "session not found" });
  await splitSession(pool, id);
  res.json({ ok: true });
}));

app.put("/api/sessions/:id/hidden", wrap(async (req, res) => {
  const id = sessionId(req), hidden = req.body?.hidden;
  if (!id) return res.status(404).json({ error: "session not found" });
  if (typeof hidden !== "boolean") return res.status(400).json({ error: 'body must be {"hidden": true|false}' });
  const [result] = await pool.execute("UPDATE sessions SET hidden = ? WHERE id = ?", [hidden ? 1 : 0, id]);
  if (!result.affectedRows) return res.status(404).json({ error: "session not found" });
  res.json({ ok: true, hidden });
}));

app.get("/api/tags", wrap(async (req, res) => {
  const [rows] = await pool.query("SELECT name FROM tags ORDER BY id");
  res.json(rows.map(r => r.name));
}));

app.put("/api/sessions/:id/tags", wrap(async (req, res) => {
  const id = sessionId(req), body = req.body?.tags;
  if (!id) return res.status(404).json({ error: "session not found" });
  if (!Array.isArray(body) || body.some(t => typeof t !== "string")) return res.status(400).json({ error: 'body must be {"tags": ["..."]}' });
  const tags = [...new Set(body.map(t => t.trim().replace(/\s+/g, " ")).filter(Boolean))];
  if (tags.length > TAGS_PER_NIGHT || tags.some(t => [...t].length > TAG_MAX_LEN))
    return res.status(400).json({ error: `at most ${TAGS_PER_NIGHT} tags of up to ${TAG_MAX_LEN} characters` });
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[exists]] = await conn.execute("SELECT id FROM sessions WHERE id = ?", [id]);
    if (!exists) { await conn.rollback(); return res.status(404).json({ error: "session not found" }); }
    await conn.execute("DELETE FROM session_tags WHERE session_id = ?", [id]);
    for (const name of tags) {
      await conn.execute("INSERT IGNORE INTO tags (name) VALUES (?)", [name]);
      await conn.execute("INSERT IGNORE INTO session_tags (session_id, tag_id) SELECT ?, id FROM tags WHERE name = ?", [id, name]);
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
  res.json({ ok: true, tags });
}));

app.get("/api/trends", wrap(async (req, res) => res.json(buildTrends(await loadNights()))));

/* ---------- Ask (optional; needs ANTHROPIC_API_KEY - see ask.js) ---------- */
const ASK = askConfig();
const anthropic = ASK.enabled ? new Anthropic() : null;   // credentials come from the environment
const fixedTools = makeTools(pool, { sendNotes: ASK.sendNotes });
let sqlTool = null;                                        // set at start-up if the read-only user passes its checks
const runTool = (name, input) => (name === "run_sql" && sqlTool ? sqlTool(input) : fixedTools(name, input));
if (askStatus(ASK).hint) console.warn(`Ask is off: ${askStatus(ASK).hint}`);
const status = () => ({ ...askStatus(ASK), sql: !!sqlTool });

async function enableSqlTool() {
  const settings = sqlSettings();
  if (!ASK.enabled || !settings) return;
  const check = await checkSqlUser(settings, { sendNotes: ASK.sendNotes });
  if (check.ok) { sqlTool = makeSqlTool(settings); ASK.sql = true; console.log(`Ask: read-only SQL tool enabled (MySQL user "${settings.user}")`); }
  else console.warn(`Ask: SQL tool is off - ${check.reason}`);
}

const conversationScope = q => (q.session_id == null ? { sql: "c.session_id IS NULL", args: [] }
  : /^\d{1,9}$/.test(String(q.session_id)) ? { sql: "c.session_id = ?", args: [Number(q.session_id)] } : null);

async function promptParts(current) {
  const [[defs]] = await pool.query("SELECT JSON_EXTRACT(detail, '$.definitions') AS d FROM session_metrics ORDER BY algo_version DESC, computed_at DESC LIMIT 1");
  const [[{ night_count }]] = await pool.query("SELECT COUNT(*) AS night_count FROM sessions WHERE hidden = 0 AND merged_into IS NULL");
  const now = new Date(), today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return { system: systemPrompt(asJson(defs?.d)), context: contextBlock({ today, nightCount: night_count, current }) };
}

// Paid calls are budgeted per day: questions and summaries share O2RING_LLM_DAILY_LIMIT. `inFlight` closes the gap a
// burst of parallel requests would otherwise slip through (each would see the same count before any was stored).
const MAX_PARALLEL = 3;
let inFlight = 0;
async function spentToday() {
  const [[row]] = await pool.query(`SELECT (SELECT COUNT(*) FROM ask_messages WHERE role = 'user' AND created_at >= CURDATE())
    + (SELECT COUNT(*) FROM night_summaries WHERE created_at >= CURDATE()) AS n`);
  return Number(row.n) + inFlight;
}

/** Everything before the model is called: checks, the conversation row and the stored question. Returns {error} or a context. */
async function beginAsk(body) {
  if (!ASK.enabled) return { status: 503, error: "Ask is switched off – add ANTHROPIC_API_KEY to .env and restart the server." };
  const v = validateRequest(body);
  if (v.error) return { status: 400, error: v.error };
  if (inFlight >= MAX_PARALLEL) return { status: 429, error: "Still answering earlier questions – try again in a moment." };
  if ((await spentToday()) >= ASK.dailyLimit) return { status: 429, error: `Daily limit of ${ASK.dailyLimit} questions and summaries reached (O2RING_LLM_DAILY_LIMIT).` };
  let current = null;
  if (v.sessionId) {
    const [[row]] = await pool.execute("SELECT id, start_time FROM sessions WHERE id = ? AND hidden = 0 AND merged_into IS NULL", [v.sessionId]);
    if (!row) return { status: 404, error: "session not found" };
    current = { id: row.id, start: row.start_time };
  }
  let conversationId = v.conversationId, history = [];
  if (conversationId) {   // a follow-up: the server owns the history, and it must belong to the same night / page
    const [[conv]] = await pool.execute("SELECT id, session_id FROM ask_conversations WHERE id = ?", [conversationId]);
    if (!conv || (conv.session_id ?? null) !== (v.sessionId ?? null)) return { status: 404, error: "conversation not found" };
    const [rows] = await pool.execute("SELECT role, content FROM ask_messages WHERE conversation_id = ? ORDER BY id", [conversationId]);
    history = historyFrom(rows);
  } else {
    const [ins] = await pool.execute("INSERT INTO ask_conversations (session_id) VALUES (?)", [v.sessionId]);
    conversationId = ins.insertId;
  }
  const [asked] = await pool.execute("INSERT INTO ask_messages (conversation_id, role, content) VALUES (?, 'user', ?)", [conversationId, v.question]);
  return { question: v.question, conversationId, history, askedId: asked.insertId, isNew: !v.conversationId, ...(await promptParts(current)) };
}

/** Keep the thread clean of unanswered turns (and of conversations that never got an answer). */
async function discardQuestion(ctx) {
  await pool.execute("DELETE FROM ask_messages WHERE id = ?", [ctx.askedId]).catch(() => {});
  if (ctx.isNew) await pool.execute("DELETE FROM ask_conversations WHERE id = ?", [ctx.conversationId]).catch(() => {});
}

/** Store the answer and shape the reply. Returns {error} when the model refused or said nothing. */
async function finishAsk(ctx, out) {
  if (out.refused || !out.answer) {
    await discardQuestion(ctx);
    return { status: 502, error: out.refused ? "The model declined to answer that question." : "The model returned no answer – try rephrasing." };
  }
  await pool.execute(
    "INSERT INTO ask_messages (conversation_id, role, content, looked_at, model, input_tokens, output_tokens) VALUES (?, 'assistant', ?, ?, ?, ?, ?)",
    [ctx.conversationId, out.answer, JSON.stringify(out.looked_at), out.model ?? ASK.model,
      out.usage.input_tokens + out.usage.cache_read_input_tokens + out.usage.cache_creation_input_tokens, out.usage.output_tokens]);
  return { conversation_id: ctx.conversationId, answer: out.answer, looked_at: out.looked_at, model: out.model ?? ASK.model, rounds: out.rounds, usage: out.usage };
}

app.get("/api/ask/status", (req, res) => res.json(status()));

// stored conversations for one night (?session_id=) or for the trends page (no parameter), newest first
app.get("/api/ask/conversations", wrap(async (req, res) => {
  const scope = conversationScope(req.query);
  if (!scope) return res.status(400).json({ error: "session_id must be a positive integer" });
  const [convs] = await pool.query(`SELECT c.id, c.created_at FROM ask_conversations c WHERE ${scope.sql} ORDER BY c.id DESC LIMIT 30`, scope.args);
  if (!convs.length) return res.json([]);
  const [msgs] = await pool.query(
    "SELECT conversation_id, role, content, looked_at, model, created_at FROM ask_messages WHERE conversation_id IN (?) ORDER BY id", [convs.map(c => c.id)]);
  res.json(convs.map(c => ({ ...c, messages: msgs.filter(m => m.conversation_id === c.id)
    .map(({ conversation_id, looked_at, ...m }) => ({ ...m, looked_at: asJson(looked_at) || [] })) })).filter(c => c.messages.length));
}));

app.delete("/api/ask/conversations/:id", wrap(async (req, res) => {
  const id = sessionId(req);
  const [result] = id ? await pool.execute("DELETE FROM ask_conversations WHERE id = ?", [id]) : [{ affectedRows: 0 }];
  if (!result.affectedRows) return res.status(404).json({ error: "conversation not found" });
  res.json({ ok: true });
}));

app.post("/api/ask", wrap(async (req, res) => {   // whole answer as one JSON reply (scripts, tests)
  const ctx = await beginAsk(req.body);
  if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
  inFlight++;
  try {
    const reply = await finishAsk(ctx, await answerQuestion({ client: anthropic, runTool, cfg: ASK, ...ctx }));
    res.status(reply.status ?? 200).json(reply.error ? { error: reply.error } : reply);
  } catch (err) {
    await discardQuestion(ctx);
    const known = describeApiError(err);
    if (known) return res.status(known.status).json({ error: known.error });
    throw err;
  } finally {
    inFlight--;
  }
}));

// The panel uses this one: server-sent events over the POST response -
//   lookup {what} · delta {text} · reset {} (discard the text so far: it was a preamble before a look-up) · done {...} · error {error}
app.post("/api/ask/stream", wrap(async (req, res) => {
  const ctx = await beginAsk(req.body);
  if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
  res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no", Connection: "keep-alive" });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const abort = new AbortController();
  res.on("close", () => { if (!res.writableEnded) abort.abort(); });   // the reader went away: stop paying for the answer
  inFlight++;
  try {
    const out = await answerQuestion({ client: anthropic, runTool, cfg: ASK, ...ctx, signal: abort.signal,
      onEvent: e => send(e.type, e.type === "delta" ? { text: e.text } : e.type === "lookup" ? { what: e.what } : {}) });
    const reply = await finishAsk(ctx, out);
    send(reply.error ? "error" : "done", reply.error ? { error: reply.error } : reply);
  } catch (err) {
    await discardQuestion(ctx);
    if (!abort.signal.aborted) {
      const known = describeApiError(err);
      if (!known) console.error(err);
      send("error", { error: known ? known.error : "internal error" });
    }
  } finally {
    inFlight--;
  }
  res.end();
}));

/* ---------- morning summaries ---------- */
const writing = new Map();   // session id -> promise, so one night is never written twice at the same time

async function summaryState(id) {
  const [[row]] = await pool.execute(
    `SELECT s.id, m.algo_version, m.valid_hours, n.summary, n.model, n.created_at, n.algo_version AS written_for
       FROM sessions s LEFT JOIN session_metrics m ON m.session_id = s.id LEFT JOIN night_summaries n ON n.session_id = s.id
      WHERE s.id = ? AND s.hidden = 0 AND s.merged_into IS NULL`, [id]);
  if (!row) return null;
  if (!ASK.enabled) return { status: "off" };
  if (row.algo_version == null || Number(row.valid_hours) < 1) return { status: "too_short" };
  const fresh = row.summary && row.written_for === row.algo_version;
  return { status: fresh ? "ready" : writing.has(id) ? "writing" : "missing", summary: fresh ? row.summary : null, model: row.model, created_at: row.created_at, algo_version: row.algo_version };
}

function writeSummaryFor(id, algoVersion) {
  if (writing.has(id)) return writing.get(id);
  const job = (async () => {
    const [night, others] = await Promise.all([fixedTools("get_night", { night_id: id }), fixedTools("list_nights", { limit: 30 })]);
    if (night.is_error) return;
    const { system } = await promptParts(null);
    const out = await writeSummary({ client: anthropic, cfg: ASK, system, night: night.content, others: others.content });
    if (out.refused || !out.summary) return;
    await pool.execute(
      `REPLACE INTO night_summaries (session_id, summary, model, algo_version, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?, ?)`,
      [id, out.summary, out.model ?? ASK.model, algoVersion,
        (out.usage?.input_tokens ?? 0) + (out.usage?.cache_read_input_tokens ?? 0) + (out.usage?.cache_creation_input_tokens ?? 0), out.usage?.output_tokens ?? 0]);
  })().catch(err => console.error(`summary for night ${id} failed: ${describeApiError(err)?.error ?? err.message}`)).finally(() => writing.delete(id));
  writing.set(id, job);
  return job;
}

// Reading never costs anything: GET only reports the state ("ready" | "writing" | "missing" | "too_short" | "off").
// Writing is a POST, so it sits behind the same-origin JSON guard like every other action - a page on another site
// cannot make this server spend money by embedding a URL.
app.get("/api/sessions/:id/summary", wrap(async (req, res) => {
  const id = sessionId(req), state = id && (await summaryState(id));
  if (!state) return res.status(404).json({ error: "session not found" });
  res.json(state);
}));

// {} writes the summary if there is none (or it is stale); {"regenerate": true} replaces an existing one
app.post("/api/sessions/:id/summary", wrap(async (req, res) => {
  const id = sessionId(req), state = id && (await summaryState(id));
  if (!state) return res.status(404).json({ error: "session not found" });
  if (state.status === "off" || state.status === "too_short") return res.status(409).json({ error: state.status === "off" ? "Ask is switched off" : "recording too short to summarise" });
  if (state.status === "writing" || (state.status === "ready" && req.body?.regenerate !== true)) return res.json({ status: state.status });
  if ((await spentToday()) >= ASK.dailyLimit) return res.status(429).json({ error: `Daily limit of ${ASK.dailyLimit} questions and summaries reached (O2RING_LLM_DAILY_LIMIT).` });
  if (state.status === "ready") await pool.execute("DELETE FROM night_summaries WHERE session_id = ?", [id]);
  writeSummaryFor(id, state.algo_version);
  res.json({ status: "writing" });
}));

// the downloader calls this after storing new nights, so summaries are ready before the report is opened
app.post("/api/summaries/pending", wrap(async (req, res) => {
  if (!ASK.enabled) return res.json({ started: 0 });
  const [rows] = await pool.query(
    `SELECT s.id, m.algo_version FROM sessions s JOIN session_metrics m ON m.session_id = s.id LEFT JOIN night_summaries n ON n.session_id = s.id
      WHERE s.hidden = 0 AND s.merged_into IS NULL AND m.valid_hours >= 1 AND (n.session_id IS NULL OR n.algo_version <> m.algo_version)
      ORDER BY s.start_time DESC LIMIT 5`);
  const room = Math.max(0, ASK.dailyLimit - (await spentToday()));
  rows.slice(0, room).forEach(r => writeSummaryFor(r.id, r.algo_version));
  res.json({ started: Math.min(rows.length, room) });
}));

/* ---------- pages ---------- */
app.get("/trends", wrap(async (req, res) => {
  const json = JSON.stringify({ ...buildTrends(await loadNights()), ask: status() }).replace(/</g, "\\u003c");
  res.type("html").send(page(TRENDS_TEMPLATE, "/*TRENDS_DATA*/null", json));
}));

app.get("/report/:id", wrap(async (req, res) => {
  const id = sessionId(req), report = id && (await loadReport(id));
  if (!report) return res.status(404).type("text/plain").send("Session not found");
  report.index_url = "/";
  report.notes_url = `/api/sessions/${id}/notes`; // tells the page to save notes to the server
  report.tags_url = `/api/sessions/${id}/tags`;
  report.trends_url = "/trends";
  report.ask = status();
  const json = JSON.stringify(report).replace(/</g, "\\u003c");
  res.type("html").send(page(TEMPLATE, "/*REPORT_DATA*/null", json));
}));

app.get("/", wrap(async (req, res) => {
  const [rows] = await pool.query(`SELECT s.id, s.device_sn, s.file_name, s.start_time, s.end_time, s.recording_s, s.gap_s, s.avg_spo2, s.min_spo2,
      s.o2_score, s.notes, s.hidden, s.is_combined, s.merged_into,
      (SELECT TRUNCATE(AVG(pr), 0) FROM samples WHERE session_id = s.id AND pr IS NOT NULL) AS avg_pr
    FROM sessions s ORDER BY s.start_time DESC`);
  const nights = new Map((await loadNights()).map(n => [n.id, n]));
  const sessions = rows.map(r => {
    const n = nights.get(r.id);
    return { ...r, o2_score: r.o2_score == null ? null : Number(r.o2_score), avg_pr: r.avg_pr == null ? null : Number(r.avg_pr),
      duration: hms(r.recording_s - r.gap_s), tags: n?.tags || [],
      metrics: n && n.valid_hours >= 4 ? { odi3: n.odi3, odi4: n.odi4, t90_pct: n.t90_pct, lowest_pr_30min: n.lowest_pr_30min } : null };
  });
  const json = JSON.stringify({ sessions, suggestions: suggestGroups(rows), ask: status() }).replace(/</g, "\\u003c");
  res.type("html").send(page(INDEX_TEMPLATE, "/*INDEX_DATA*/null", json));
}));

app.get("/favicon.ico", (req, res) => res.status(204).end());

app.use((req, res) => res.status(404).type("text/plain").send("Not found"));
app.use((err, req, res, _next) => {
  if (err.type === "entity.parse.failed" || err.type === "entity.too.large") return res.status(400).json({ error: "invalid JSON body" });
  if (err.status) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: "internal error" });
});

const host = process.env.HOST || "127.0.0.1", port = Number(process.env.PORT || 3000);
try {
  await migrate();
  await migrateAsk();
  await enableSqlTool();
} catch (err) {
  console.error(`Database not ready: ${err.message}`);
  process.exit(1);
}
const server = app.listen(port, host, () => console.log(`O2Ring reports on http://${host}:${port}`));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => server.close(() => pool.end().then(() => process.exit(0))));

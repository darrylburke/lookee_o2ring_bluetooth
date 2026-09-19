import test from "node:test";
import assert from "node:assert/strict";
import { MAX_ROUNDS, answerQuestion, askConfig, askStatus, keyTypo, toolDefs, writeSummary, contextBlock, historyFrom, systemPrompt, validateRequest } from "./ask.js";
import { TOOL_DEFS, describeCall, makeTools } from "./ask-tools.js";
import { forbiddenReads, grantsAreReadOnly, sqlProblem, sqlSettings } from "./ask-sql.js";
import Anthropic from "@anthropic-ai/sdk";

const text = t => ({ type: "text", text: t });
const call = (id, name, input) => ({ type: "tool_use", id, name, input });
const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

/** A stand-in for the Anthropic client that replays scripted responses and records what it was sent. */
function fakeClient(script) {
  const sent = [];
  const stream = (params, options) => {
    sent.push(structuredClone(params));
    const next = script[Math.min(sent.length - 1, script.length - 1)], message = { model: params.model, usage, ...next };
    return {
      async *[Symbol.asyncIterator]() {
        if (next.throws) throw next.throws;
        for (const block of message.content) if (block.type === "text")
          for (const piece of block.text.match(/.{1,8}/gs) || []) yield { type: "content_block_delta", delta: { type: "text_delta", text: piece } };
      },
      finalMessage: async () => message, options,
    };
  };
  return { sent, messages: { stream }, beta: { messages: { stream } } };
}
const cfg = { model: "claude-opus-5", fallbacks: false };
const base = { cfg, system: "SYS", context: "CTX" };

test("feature is off without a key, and the key never reaches the page", () => {
  assert.equal(askConfig({}).enabled, false);
  const on = askConfig({ ANTHROPIC_API_KEY: "sk-ant-test" });
  assert.deepEqual([on.enabled, on.model, on.sendNotes, on.fallbacks, on.dailyLimit], [true, "claude-opus-5", true, true, 100]);
  assert.equal(JSON.stringify(askStatus(on)).includes("sk-ant"), false);
  assert.equal(askConfig({ ANTHROPIC_API_KEY: "k", O2RING_LLM_SEND_NOTES: "0" }).sendNotes, false);
  assert.equal(askConfig({ ANTHROPIC_API_KEY: "k", O2RING_LLM_MODEL: "claude-haiku-4-5" }).fallbacks, false);   // parameter only sent to models documented for it
});

test("a misspelt key name is pointed out, by name only", () => {
  assert.equal(keyTypo({ ANTHRPIC_API_KEY: "sk-ant-secret" }), "ANTHRPIC_API_KEY");
  assert.equal(keyTypo({ ANTHROPIC_API_KEY: "sk-ant-secret" }), null);
  assert.equal(keyTypo({ O2RING_DB_PASSWORD: "x" }), null);
  const status = askStatus(askConfig({ ANTHRPIC_API_KEY: "sk-ant-secret" }), { ANTHRPIC_API_KEY: "sk-ant-secret" });
  assert.match(status.hint, /ANTHRPIC_API_KEY/);
  assert.equal(JSON.stringify(status).includes("sk-ant-secret"), false);
});

test("runs tools, returns all parallel results in one message, then answers", async () => {
  const client = fakeClient([
    { stop_reason: "tool_use", content: [text("Let me look."), call("t1", "list_nights", {}), call("t2", "get_night", { night_id: 9 })] },
    { stop_reason: "end_turn", content: [text("Night two had more drops.")] },
  ]);
  const ran = [];
  const runTool = async (name, input) => { ran.push(name); return { is_error: false, content: JSON.stringify({ name, input }) }; };
  const out = await answerQuestion({ ...base, client, runTool, question: "Which night was worse?" });
  assert.equal(out.answer, "Night two had more drops.");
  assert.deepEqual(ran, ["list_nights", "get_night"]);
  assert.deepEqual(out.looked_at, ["the list of nights", "night 9: full analysis"]);
  assert.equal(out.usage.input_tokens, 20);
  const second = client.sent[1].messages;
  assert.deepEqual(second[0].content.map(b => b.text), ["CTX", "Which night was worse?"]);       // context first, then the question
  assert.equal(second[1].role, "assistant");
  assert.deepEqual(second[2].content.map(b => [b.type, b.tool_use_id]), [["tool_result", "t1"], ["tool_result", "t2"]]);
  assert.deepEqual(client.sent[0].cache_control, { type: "ephemeral" });
  assert.equal(client.sent[0].tools.length, TOOL_DEFS.length);
});

test("a bad tool call is reported back to the model as an error, not thrown", async () => {
  const client = fakeClient([
    { stop_reason: "tool_use", content: [call("t1", "get_night", { night_id: 999 })] },
    { stop_reason: "end_turn", content: [text("I could not find that night.")] },
  ]);
  const out = await answerQuestion({ ...base, client, runTool: async () => ({ is_error: true, content: "there is no night with id 999" }), question: "q" });
  assert.equal(client.sent[1].messages[2].content[0].is_error, true);
  assert.deepEqual(out.looked_at, []);
});

test("look-ups are capped: after MAX_ROUNDS the model is told to answer without tools", async () => {
  const client = fakeClient([{ stop_reason: "tool_use", content: [call("t", "get_trends", {})] }]);   // would loop forever
  const out = await answerQuestion({ ...base, client, runTool: async () => ({ is_error: false, content: "{}" }), question: "q" });
  assert.equal(client.sent.length, MAX_ROUNDS + 1);
  assert.deepEqual(client.sent.at(-1).tool_choice, { type: "none" });
  assert.equal(out.rounds, MAX_ROUNDS + 1);
});

test("a refusal is surfaced, never read as an answer", async () => {
  const out = await answerQuestion({ ...base, client: fakeClient([{ stop_reason: "refusal", content: [] }]), runTool: async () => ({}), question: "q" });
  assert.equal(out.refused, true);
  assert.equal(out.answer, "");
});

test("refusal fallbacks go through the beta endpoint with the documented header", async () => {
  const client = fakeClient([{ stop_reason: "end_turn", content: [text("ok")] }]);
  await answerQuestion({ ...base, cfg: { model: "claude-opus-5", fallbacks: true }, client, runTool: async () => ({}), question: "q" });
  assert.deepEqual([client.sent[0].betas, client.sent[0].fallbacks], [["server-side-fallback-2026-07-01"], "default"]);
});

test("follow-ups resend the stored thread with the context pinned to the first turn", async () => {
  const client = fakeClient([{ stop_reason: "end_turn", content: [text("Because of the cluster at 1 am.")] }]);
  const history = historyFrom([{ role: "user", content: "Which night was worse?" }, { role: "assistant", content: "The second." }]);
  await answerQuestion({ ...base, client, runTool: async () => ({}), question: "Why?", history });
  const m = client.sent[0].messages;
  assert.deepEqual(m.map(x => x.role), ["user", "assistant", "user"]);
  assert.deepEqual(m[0].content.map(b => b.text), ["CTX", "Which night was worse?"]);
  assert.equal(m[2].content, "Why?");
});

test("stored history is cleaned: unanswered questions and doubled roles are dropped", () => {
  const rows = [{ role: "user", content: "a" }, { role: "assistant", content: "A" }, { role: "user", content: "never answered" }];
  assert.deepEqual(historyFrom(rows).map(r => r.content), ["a", "A"]);
  assert.deepEqual(historyFrom([{ role: "assistant", content: "orphan" }, { role: "user", content: "a" }, { role: "assistant", content: "A" }]).map(r => r.content), ["a", "A"]);
  assert.deepEqual(historyFrom([]), []);
});

test("request validation", () => {
  assert.equal(validateRequest({}).error, "ask a question");
  assert.match(validateRequest({ question: "x".repeat(1001) }).error, /limited to 1000/);
  assert.match(validateRequest({ question: "q", session_id: "2" }).error, /session_id/);
  assert.match(validateRequest({ question: "q", conversation_id: -1 }).error, /conversation_id/);
  assert.deepEqual(validateRequest({ question: "  q  ", session_id: 9 }), { question: "q", sessionId: 9, conversationId: null });
});

test("the cached system prompt carries no per-request data; the context block does", () => {
  const sys = systemPrompt({ desaturation: "Peak-to-nadir…" });
  assert.match(sys, /desaturation: Peak-to-nadir/);
  assert.doesNotMatch(sys, /\b20\d\d-\d\d-\d\d\b|night_id \d/);
  assert.match(contextBlock({ today: "2026-09-19", nightCount: 2, current: { id: 9, start: "2026-09-18 23:56:35" } }), /night_id 9/);
  assert.match(contextBlock({ today: "2026-09-19", nightCount: 1, current: null }), /1 night is recorded[\s\S]*trends page/);
});

test("tool definitions are closed schemas and tool input errors come back as text", async () => {
  for (const t of TOOL_DEFS) { assert.equal(t.input_schema.additionalProperties, false, t.name); assert.ok(t.description.length > 40, t.name); }
  const pool = { execute: async () => [[undefined]], query: async () => [[]] };          // a database with nothing in it
  const run = makeTools(pool);
  assert.deepEqual(await run("drop_table", {}), { is_error: true, content: "unknown tool drop_table" });
  assert.match((await run("get_night", { night_id: "9; DROP" })).content, /positive integer/);
  assert.match((await run("get_night", { night_id: 5 })).content, /no night with id 5/);
  assert.match((await run("list_nights", { from: "yesterday" })).content, /YYYY-MM-DD/);
  assert.equal(describeCall("get_drops", { night_id: 9, from_time: "2026-09-19 00:00", min_depth: 4, with_pulse_surge: true }, "2026-09-18 23:56:35"),
    "night of Sep 18: oxygen drops, 00:00–end, ≥4 %, with pulse surge");
  assert.equal(describeCall("get_night", { night_id: 9 }), "night 9: full analysis");             // no date known: fall back to the id
});

test("streams the answer; a preamble before a look-up is reset, look-ups are announced", async () => {
  const client = fakeClient([
    { stop_reason: "tool_use", content: [text("Let me check that."), call("t1", "get_trends", {})] },
    { stop_reason: "end_turn", content: [text("Your nights are steady.")] },
  ]);
  const events = [];
  const out = await answerQuestion({ ...base, client, runTool: async () => ({ is_error: false, content: "{}" }), question: "q", onEvent: e => events.push(e) });
  const kinds = events.map(e => e.type).filter((k, i, all) => k !== all[i - 1]);      // collapse runs of deltas
  assert.deepEqual(kinds, ["delta", "reset", "lookup", "delta"]);
  const afterReset = events.slice(events.findIndex(e => e.type === "reset")).filter(e => e.type === "delta").map(e => e.text).join("");
  assert.equal(afterReset, out.answer);
  assert.deepEqual(events.find(e => e.type === "lookup"), { type: "lookup", what: "multi-night trends and tag comparisons" });
});

test("streamed client tools are sent with eager input streaming, in a fixed order, SQL only when enabled", () => {
  assert.ok(toolDefs().every(t => t.eager_input_streaming === true));
  assert.deepEqual(toolDefs().map(t => t.name), TOOL_DEFS.map(t => t.name));
  assert.equal(toolDefs({ sql: true }).at(-1).name, "run_sql");
  assert.equal(JSON.stringify(toolDefs()), JSON.stringify(toolDefs()));
});

test("a tool call cut off at max_tokens is never run; unparseable tool JSON is re-issued, API errors are not", async () => {
  let ran = 0; const runTool = async () => { ran++; return { is_error: false, content: "{}" }; };
  await assert.rejects(answerQuestion({ ...base, client: fakeClient([{ stop_reason: "max_tokens", content: [call("t1", "get_night", { night_id: 9 })] }]), runTool, question: "q" }), /ran out of output tokens/);
  assert.equal(ran, 0);
  const flaky = fakeClient([{ throws: new SyntaxError("Unexpected end of JSON input"), content: [] }, { stop_reason: "end_turn", content: [text("fine")] }]);
  assert.equal((await answerQuestion({ ...base, client: flaky, runTool, question: "q" })).answer, "fine");
  assert.equal(flaky.sent.length, 2);
  const apiError = new Anthropic.APIError(429, undefined, "rate limited", undefined);
  const limited = fakeClient([{ throws: apiError, content: [] }]);
  await assert.rejects(answerQuestion({ ...base, client: limited, runTool, question: "q" }), e => e === apiError);
  assert.equal(limited.sent.length, 1);
});

test("an answer the API drops part-way is asked again and the partial text discarded; it gives up after two tries", async () => {
  const dropped = () => new Anthropic.APIError(undefined, { type: "error", error: { type: "overloaded_error" } }, "Overloaded", undefined);
  const events = [];
  const flaky = fakeClient([{ throws: dropped(), content: [] }, { stop_reason: "end_turn", content: [text("second time lucky")] }]);
  const out = await answerQuestion({ ...base, client: flaky, runTool: async () => ({}), question: "q", retryDelays: [0, 0], onEvent: e => events.push(e.type) });
  assert.equal(out.answer, "second time lucky");
  assert.equal(flaky.sent.length, 2);
  assert.equal(events[0], "reset");
  const down = fakeClient([{ throws: dropped(), content: [] }]);
  await assert.rejects(answerQuestion({ ...base, client: down, runTool: async () => ({}), question: "q", retryDelays: [0, 0] }), /overloaded_error/);
  assert.equal(down.sent.length, 3);
  const gone = new AbortController(); gone.abort();
  const aborted = fakeClient([{ throws: new Anthropic.APIUserAbortError(), content: [] }]);
  await assert.rejects(answerQuestion({ ...base, client: aborted, runTool: async () => ({}), question: "q", retryDelays: [0, 0], signal: gone.signal }));
  assert.equal(aborted.sent.length, 1);
});

test("the morning summary is one tool-less request built from the fetched data", async () => {
  const client = fakeClient([{ stop_reason: "end_turn", content: [text("A steady night.")] }]);
  const out = await writeSummary({ client, cfg, system: "SYS", night: '{"id":9}', others: '{"count":2}' });
  assert.equal(out.summary, "A steady night.");
  assert.equal(client.sent[0].tools, undefined);
  assert.match(client.sent[0].messages[0].content[0].text, /"id":9/);
  assert.equal((await writeSummary({ client: fakeClient([{ stop_reason: "refusal", content: [] }]), cfg, system: "S", night: "{}", others: "{}" })).refused, true);
});

test("SQL tool: only a single plain SELECT gets through", () => {
  const ok = ["SELECT 1", "select hour(nadir_time) h, count(*) from desat_events group by h order by 2 desc",
    "WITH n AS (SELECT id FROM sessions WHERE hidden = 0 AND merged_into IS NULL) SELECT count(*) FROM n",
    "SELECT * FROM tags WHERE name = 'late; meal -- not a comment'", "SELECT start_time, `odi3` FROM sessions s JOIN session_metrics m ON m.session_id = s.id"];
  for (const q of ok) assert.equal(sqlProblem(q), null, q);
  const bad = { "": /non-empty/, "DELETE FROM sessions": /must start with SELECT/, "SELECT 1; DROP TABLE samples": /one statement/,
    "SELECT 1 -- x": /comments/, "SELECT 1 /* x */": /comments/, "SELECT * FROM sessions INTO OUTFILE '/tmp/x'": /INTO/,
    "SELECT load_file('/etc/passwd')": /function/, "SELECT sleep(10)": /function/, "SELECT * FROM information_schema.tables": /system schemas/,
    "SELECT * FROM mysql.user": /system schemas/, "SELECT @@version": /variables/, "SELECT * FROM samples FOR UPDATE": /only SELECT|locking/,
    'SELECT "x"': /quoting/, "SELECT 'unterminated": /quoting/, "WITH x AS (SELECT 1) UPDATE sessions SET hidden = 1": /only SELECT/ };
  for (const [q, why] of Object.entries(bad)) assert.match(String(sqlProblem(q)), why, q);
  assert.match(sqlProblem("SELECT " + "1,".repeat(1200) + "1"), /limited to/);
});

test("SQL tool: the database user must be read-only on THIS database only, and the feature is opt-in", () => {
  const db = "lookee_data", to = "TO `ro`@`localhost`";
  assert.equal(grantsAreReadOnly([`GRANT USAGE ON *.* ${to}`, `GRANT SELECT ON \`lookee_data\`.\`samples\` ${to}`,
    `GRANT SELECT (\`id\`, \`start_time\`) ON \`lookee_data\`.\`sessions\` ${to}`], db), true);
  for (const g of ["GRANT ALL PRIVILEGES ON `lookee_data`.* TO `lookee`@`%`", "GRANT SELECT, INSERT ON `lookee_data`.* TO `x`@`%`",
    "GRANT SELECT ON `lookee_data`.* TO `x`@`%` WITH GRANT OPTION", "GRANT FILE ON *.* TO `x`@`%`",
    "GRANT SELECT ON *.* TO `x`@`%`",                       // every database on the server
    "GRANT SELECT ON `mysql`.* TO `x`@`%`",                 // another schema
    "GRANT SELECT ON `lookee_data_backup`.* TO `x`@`%`",    // a look-alike name
    "GRANT `dba` TO `x`@`%`"])                              // a role: unknown powers
    assert.equal(grantsAreReadOnly([g], db), false, g);
  assert.equal(grantsAreReadOnly([], db), false);
  assert.equal(sqlSettings({}), null);
  assert.equal(sqlSettings({ O2RING_LLM_SQL: "1", O2RING_DB_RO_USER: "ro", O2RING_DB_RO_PASSWORD: "p" }).user, "ro");
});

test("SQL tool: the serial number, raw files and stored conversations are probed; notes too when they are switched off", () => {
  const probes = on => forbiddenReads({ sendNotes: on }).map(([, sql]) => sql).join(" | ");
  for (const needle of ["device_sn", "raw_file", "devices", "ask_messages"]) assert.match(probes(true), new RegExp(needle));
  assert.doesNotMatch(probes(true), /notes/);
  assert.match(probes(false), /SELECT notes FROM sessions/);
});

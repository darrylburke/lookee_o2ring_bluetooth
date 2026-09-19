# The Ask panel – design notes

Optional natural-language questions about the recorded nights, answered by Claude.

## Decisions

| Question | Decision |
|---|---|
| Where does the model run? | Claude over the Anthropic API. Opt-in: the panel is visible but greyed out, with a popup on how to enable it, until `ANTHROPIC_API_KEY` is in `.env`. |
| How does it reach the data? | Read-only tools, not a data dump and not model-written SQL. |
| Scope | Per night (report page) and across nights (start page and Trends page, which share their conversations) – same tools, different context line. |
| Notes and tags | Readable by the model. `O2RING_LLM_SEND_NOTES=0` keeps notes out. |
| History | Stored in MySQL (`ask_conversations`, `ask_messages`). The server owns the thread; the browser only sends the question and a conversation id. |

## Shape

```
ask_panel.html ──POST /api/ask {question, session_id?, conversation_id?}──▶ server.js
                                                                              │ history from MySQL
                                                                              ▼
                                   ask.js  answerQuestion(): system prompt (cached) + context line + thread
                                              │  ◀──── tool_use ────  Claude (messages.create, ≤ 8 rounds)
                                              ▼
                                   ask-tools.js  list_nights · get_night · get_drops · get_series · get_trends
                                              │  bounded SELECTs over sessions / session_metrics / desat_events / samples
                                              ▼
                                            MySQL
```

- **Why tools.** A night is 7,000+ samples and the useful facts are already computed. Tools keep each request small
  (roughly 200–900 tokens per call, ~5,500 for a whole-night series), let the model drill into a time window, and
  make "what did it look at" reportable. Text-to-SQL would be more flexible but needs a read-only database user,
  statement validation and limits; it may come later.
- **Why a hand-written loop** instead of the SDK's tool-runner helper: a hard cap on rounds (the last round is sent
  with `tool_choice: none` so the model must answer), a record of every look-up for the "Looked at" line, and a loop
  that is unit-tested against a scripted fake client (`ask.test.js`).
- **Caching.** The system prompt holds only stable text (rules + this project's metric definitions) and the tool list
  never varies, so they form a cached prefix; the volatile context (today's date, which night is open) is the first
  block of the first user message. Follow-ups resend the stored thread unchanged so the prefix keeps matching.
- **Safety rails.** Numbers only from tool results; single-night and definition caveats; no diagnosis or treatment
  advice; doctor prompt for persistent patterns or symptoms; tags/notes/tool results are data, never instructions.
  Tool input errors are returned to the model as readable errors rather than thrown. Refusals are surfaced, never
  shown as an answer; server-side refusal fallbacks are requested for `claude-opus-5`. Answers are rendered by
  escaping everything first and then allowing only bold, inline code, bullets and paragraphs.
- **Guards.** The existing request guard (known Host, JSON-only same-origin writes) covers the new routes; there is a
  per-day question limit; the API key is read from the environment and never reaches a page.

## Streaming, summaries, SQL

- **Streaming.** `POST /api/ask/stream` answers with server-sent events over the POST response: `lookup {what}`,
  `delta {text}`, `reset` (the text so far was a preamble before a look-up – discard it), then `done {…}` or
  `error`. Every model round is streamed (`messages.stream` + `finalMessage()`); closing the page aborts the request.
  Streamed client tools are sent with `eager_input_streaming`, so the loop applies the safeguards that go with it:
  a tool call cut off at `max_tokens` is never run, a refusal never runs that turn's tools, un-parseable streamed tool
  JSON re-issues the round (twice at most) while API errors are passed through, and every tool validates its own input.
- **Morning summary.** One tool-less request per night: the server fetches `get_night` and `list_nights` itself and
  hands them over with a tight brief (one paragraph, under ~110 words, compare only with ≥3 other nights). Stored in
  `night_summaries` with the analysis version it was written for; stale or missing summaries are written on the first
  `GET /api/sessions/:id/summary` (the page polls), after combining recordings, and when the downloader reports new
  nights (`POST /api/summaries/pending`). An in-memory map stops a night being written twice at once.
- **SQL tool.** Off unless `O2RING_LLM_SQL=1` *and* a dedicated read-only MySQL user passes a grant inspection at
  start-up. Defence in depth: the database user cannot write; the statement is screened; each query gets its own
  connection, a READ ONLY transaction, `max_execution_time` 3 s, streamed rows capped at 200, then the connection is
  destroyed. The tool only joins the tool list when enabled, so the cached prefix is stable per configuration.
- **Cost, measured.** Tool results are the bulk of the tokens. Returning drops and series as a column list plus plain
  rows (instead of one JSON object per row), lower default limits and an instruction to look up only what is needed
  took one real question from ~55k input tokens (~22 ¢) to ~18k (~8 ¢) with the same answer quality.

## Security review (what was checked, what was changed)

- **Secrets.** The API key and both database passwords live only in the git-ignored `.env`; the key is read by the SDK
  from the environment, never placed in a page, a response or a log line. A misspelt variable is reported by name only.
- **Reading never spends money.** `GET …/summary` only reports state; writing a summary is a `POST`. Every route that
  can cost money or change data is therefore behind the request guard (known `Host`, JSON body, same `Origin`), so a
  page on another site cannot trigger it – a plain `GET` cannot be guarded that way.
- **One budget.** Questions and summaries share `O2RING_LLM_DAILY_LIMIT`; an in-flight counter (max 3 parallel) stops a
  burst of simultaneous requests slipping past the count. Tool rounds are capped, output is capped, the request is
  aborted when the reader goes away.
- **What the model can reach.** Fixed tools: bounded `SELECT`s, visible nights only, never the serial number. They
  validate their own input and return problems as text. Nothing the model says is executed except a tool call.
- **SQL tool, defence in depth.** (1) The database user must hold nothing but `SELECT` *on this database* –
  `SELECT ON *.*`, another schema, a role or `WITH GRANT OPTION` all keep the tool off. (2) At start-up the server
  actively tries to read the serial number, the raw files, the devices table, the stored conversations, and – when
  notes are switched off – the notes; any success keeps the tool off. (3) The statement screen (single
  `SELECT`/`WITH`, no comments, no file/system functions, no system schemas, no variables, no locking reads).
  (4) Own connection, `READ ONLY` transaction, 3-second limit, 200-row cap, fixed `sql_mode` so the screen's view of
  string literals matches MySQL's. Rows of hidden recordings are visible to SQL (the model is told to exclude them);
  the popup says so.
- **Prompt injection.** Notes, tags and tool results are declared data, not instructions. The blast radius is small by
  construction: read-only tools, answers shown only to the person asking, and rendered by escaping everything first –
  no links, images or HTML from the model are ever live.
- **Dependencies.** `npm audit`: 0 vulnerabilities. One new package, the official `@anthropic-ai/sdk`.

Known and accepted: the server has no login (it binds to localhost; see the README), so anyone who can reach the port
can ask questions on your key.

## Not built yet

An eval set of questions with known answers from the database (so prompt changes can be checked); a local-model
backend.

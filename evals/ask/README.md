# Test questions for the Ask panel

A set of questions with known right answers, asked through the running server, so a change to the prompt, the
look-up tools or the model can be checked instead of guessed at.

| File | What it is |
|---|---|
| `cases.json` | 32 questions: look-ups, comparisons, trends, things the ring cannot measure, safety, privacy, a follow-up |
| `run-eval.mjs` | asks them, grades the answers, writes the results |
| `summarize.mjs` | pass rates, time, look-ups, answer length and cost, as text |
| `grade.test.mjs` | free checks of the scoring arithmetic (`node --test evals/ask/grade.test.mjs`) |
| `state.template.json` | names of the scores and measurements, and token prices for the cost sum |

## How an answer is graded

Nights are referred to relatively (`:latest`, `:prev`), so the set works on anyone's database.

1. Each case carries `gold`: plain SQL, run with the normal database user just before the questions are asked.
   The result is the truth the answer has to agree with.
2. A judge model (`claude-sonnet-5`; change with `ASK_EVAL_JUDGE`) reads the question, the answer, the gold facts
   and the case's `must` / `must_not` claims, and marks every claim with a quoted reason.
3. Code checks the rest: the answer is not empty, was not cut off, and never contains the ring's serial number.

Scores per answer: **pass** (every `must` met, no `must_not` broken, hard checks fine), **claims met** (share of
`must` claims) and **no violations**. Answer length, time, look-ups and cost are recorded, never failed.

## Running it

The report server must be running with Ask switched on. From the repository root:

```bash
node evals/ask/run-eval.mjs --dry-run                  # free: lists the cases with today's gold facts
node evals/ask/run-eval.mjs --approve-harness          # the whole set (first run, or after editing the runner)
node evals/ask/run-eval.mjs --only fact-t90,limit-hrv  # a few cases
node evals/ask/run-eval.mjs --reps 3                   # repeat each question to see run-to-run noise
node evals/ask/summarize.mjs
```

Every question is a paid call: roughly 5–10 cents for the answer plus about a cent for the judge. Questions count
towards `O2RING_LLM_DAILY_LIMIT` while they run; the conversations are deleted again afterwards, so your own
history in the panel is left as it was. A stopped run picks up where it left off.

Results go to `.claude/hillclimb/ask-answers/` (`results.jsonl`, `traces/`, `errors.jsonl`). They hold your own
health data, and that folder is git-ignored – keep it that way.

To compare a change, run it as the next variant and summarise both:

```bash
node evals/ask/run-eval.mjs --variant v1
node evals/ask/summarize.mjs .claude/hillclimb/ask-answers v1
```

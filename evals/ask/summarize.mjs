#!/usr/bin/env node
// Plain-text summary of one eval run: pass rates by kind of question, the side measurements, and what it cost.
//   node evals/ask/summarize.mjs [.claude/hillclimb/ask-answers] [baseline]
// Cost is worked out here from each row's model and token counts (prices per million tokens in _state.json;
// cache writes at 1.25x and cache reads at 0.1x the input price), so a price change never needs a re-run.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const flow = process.argv[2] || '.claude/hillclimb/ask-answers', variant = process.argv[3] || 'baseline';
const lines = file => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l)) : []);
const rows = lines(join(flow, variant, 'results.jsonl')), errors = lines(join(flow, variant, 'errors.jsonl'));
const { prices = {} } = JSON.parse(readFileSync(join(flow, '_state.json'), 'utf8'));

const unpriced = new Set();
function dollars(model, u) {
  if (!model || !u) return 0;
  const p = prices[model] ?? prices[Object.keys(prices).find(k => model.startsWith(k))];
  if (!p) { unpriced.add(model); return 0; }
  return ((u.input_tokens ?? 0) * p.in + (u.cache_creation_input_tokens ?? 0) * p.in * 1.25
    + (u.cache_read_input_tokens ?? 0) * p.in * 0.1 + (u.output_tokens ?? 0) * p.out) / 1e6;
}
const median = xs => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : NaN; };
const pct = (n, d) => (d ? `${Math.round(100 * n / d)}% (${n}/${d})` : '–');

const scored = rows.filter(r => (r.status ?? 'ok') === 'ok' && r.grade?.pass != null);
console.log(`${flow}/${variant}: ${rows.length} answers, ${scored.length} scored, ${rows.length - scored.length} cut off, ${errors.length} failed attempts\n`);
const groups = new Map();
for (const r of scored) groups.set(r.tags?.[0] ?? '-', [...(groups.get(r.tags?.[0] ?? '-') ?? []), r]);
console.log('kind          pass          claims met   no violations');
for (const [tag, rs] of [...groups, ['ALL', scored]])
  console.log(`${tag.padEnd(13)} ${pct(rs.filter(r => r.grade.pass).length, rs.length).padEnd(13)} ${(rs.reduce((a, r) => a + r.grade.must_frac, 0) / rs.length).toFixed(2).padEnd(12)} ${pct(rs.filter(r => r.grade.clean).length, rs.length)}`);

const failed = scored.filter(r => !r.grade.pass);
if (failed.length) console.log(`\nnot passed: ${[...new Set(failed.map(r => r.prompt_id))].join(', ')}`);

const app = rows.map(r => dollars(r.model, r.usage)), judge = rows.map(r => dollars(r.judge_model, r.judge_usage));
const wasted = errors.reduce((a, e) => a + dollars(e.model, e.usage) + dollars(e.judge_model, e.judge_usage), 0);
const sum = xs => xs.reduce((a, b) => a + b, 0);
console.log(`\nper question (median, range)`);
const range = (label, xs, fmt) => console.log(`  ${label.padEnd(16)} ${fmt(median(xs))}   (${fmt(Math.min(...xs))} – ${fmt(Math.max(...xs))})`);
if (rows.length) {
  range('answer cost', app, x => `$${x.toFixed(3)}`);
  range('time to answer', rows.map(r => r.latency_s), x => `${x.toFixed(1)} s`);
  range('look-ups', rows.map(r => r.tool_calls), x => String(x));
  range('rounds', rows.map(r => r.rounds), x => String(x));
  range('answer length', rows.map(r => r.words), x => `${x} words`);
}
console.log(`\nspent: answers $${sum(app).toFixed(2)} + judge $${sum(judge).toFixed(2)} + failed attempts $${wasted.toFixed(2)} = $${(sum(app) + sum(judge) + wasted).toFixed(2)}`);
if (unpriced.size) console.log(`no price listed in _state.json for: ${[...unpriced].join(', ')} (counted as $0)`);

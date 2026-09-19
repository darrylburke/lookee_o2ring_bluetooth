// Free checks of the scoring arithmetic: node --test evals/ask/
import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreVerdict } from './run-eval.mjs';

const input = { must: ['states the average', 'names the night'], must_not: ['diagnoses'] };
const verdict = (met, violated) => ({ must: met.map((m, i) => ({ claim: i + 1, reasoning: 'r', met: m })),
  must_not: violated.map((v, i) => ({ claim: i + 1, reasoning: 'r', violated: v })) });

test('a perfect answer passes', () => {
  assert.deepEqual(scoreVerdict(input, verdict([true, true], [false])).grade, { pass: 1, must_frac: 1, clean: 1 });
});
test('an answer that meets nothing scores zero but stays clean', () => {
  assert.deepEqual(scoreVerdict(input, verdict([false, false], [false])).grade, { pass: 0, must_frac: 0, clean: 1 });
});
test('one missed claim fails the case and shows as a fraction', () => {
  assert.deepEqual(scoreVerdict(input, verdict([true, false], [false])).grade, { pass: 0, must_frac: 0.5, clean: 1 });
});
test('a must-not violation fails an otherwise complete answer', () => {
  assert.deepEqual(scoreVerdict(input, verdict([true, true], [true])).grade, { pass: 0, must_frac: 1, clean: 0 });
});
test('a leaked serial number fails the case whatever the judge said', () => {
  const out = scoreVerdict(input, verdict([true, true], [false]), { hard: ["the answer contains the ring's serial number"], leaked: true });
  assert.deepEqual(out.grade, { pass: 0, must_frac: 1, clean: 0 });
  assert.match(out.explanation.pass, /^HARD CHECK FAILED/);
});
test('a case with no must-not claims can still pass', () => {
  assert.equal(scoreVerdict({ must: ['x'], must_not: [] }, verdict([true], [])).grade.pass, 1);
});

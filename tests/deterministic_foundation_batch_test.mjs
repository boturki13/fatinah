import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';

const math = JSON.parse(fs.readFileSync(
  new URL('../content/questions/structured-sources/deterministic-math-records.json', import.meta.url), 'utf8'));
const candidates = JSON.parse(fs.readFileSync(new URL('../content/questions/candidates.json', import.meta.url), 'utf8'));
assert.equal(math.records.length, 600);
assert.equal(new Set(math.records.map(record => record.sourceRecordId)).size, 600);
for (const record of math.records) {
  const canonical = { kind: record.kind, level: record.level, index: record.index,
    prompt: record.prompt, answer: record.answer, expression: record.expression };
  assert.equal(record.sourcePayloadHash,
    crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex'));
}
const generated = candidates.filter(candidate => candidate.generation?.model === 'deterministic-foundation-batch-template-v1');
const expected = { 'معلومات عامة': 21, 'تاريخ': 119, 'علوم وتقنية': 117, 'خرائط دول': 119, 'إجابة سريعة': 182, 'ألغاز وتحدّي ذكاء': 181 };
for (const [category, count] of Object.entries(expected)) assert.equal(generated.filter(item => item.category === category).length, count);
assert.ok(generated.every(candidate => candidate.status === 'approved'));
assert.ok(generated.every(candidate => candidate.cost?.runEstimatedUsd === 0));
assert.equal(new Set(generated.map(candidate => candidate.id)).size, generated.length);
const history = generated.filter(candidate => candidate.category === 'تاريخ');
assert.equal(history.length, 119);
assert.ok(history.every(candidate => candidate.templateId.startsWith('unesco-inscription-year-v1-l')));
assert.ok(history.every(candidate => /^\d{4}$/.test(candidate.answer)));
assert.ok(history.every(candidate => /متى أدرجت اليونسكو/.test(candidate.question)));
assert.ok(history.every(candidate => !/(?:المكوّن|المكون|المعرّف|المعرف)\s*\d/u.test(candidate.question)));
console.log('✓ دفعة أساسية حتمية لست فئات، ببصمات وتكلفة AI صفر');

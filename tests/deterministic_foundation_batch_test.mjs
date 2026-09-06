import assert from 'node:assert/strict';
import fs from 'node:fs';

assert.equal(fs.existsSync(new URL(
  '../content/questions/structured-sources/deterministic-math-records.json', import.meta.url)), false,
  'مصدر رياضيات وحساب يجب أن يبقى محذوفًا من 1.4.');
const candidates = JSON.parse(fs.readFileSync(new URL('../content/questions/candidates.json', import.meta.url), 'utf8'));
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
console.log('✓ دفعة أساسية حتمية بلا مسار رياضيات وحساب، وبكلفة AI صفر');

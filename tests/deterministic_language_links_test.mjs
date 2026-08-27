import assert from 'node:assert/strict'; import fs from 'node:fs';
const candidates = JSON.parse(fs.readFileSync(new URL('../content/questions/candidates.json', import.meta.url), 'utf8'));
const generated = candidates.filter(item => item.generation?.model === 'deterministic-language-links-template-v1');
assert.equal(generated.length, 202);
assert.deepEqual(Object.fromEntries(['اللغة العربية','وش الرابط؟'].map(c => [c, generated.filter(x => x.category === c).length])),
  { 'اللغة العربية': 101, 'وش الرابط؟': 101 });
assert.ok(generated.every(item => item.status === 'approved' && item.cost.runEstimatedUsd === 0));
assert.ok(generated.filter(item => item.category === 'وش الرابط؟').every(item => item.question.startsWith('ما الرابط بين «')));
assert.ok(generated.every(item => !item.question.includes(item.answer)));
console.log('✓ 202 سؤال لغة وروابط من سجلات منظمة وتكلفة AI صفر');

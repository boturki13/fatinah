import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = JSON.parse(fs.readFileSync(new URL('../content/questions/structured-sources/fifa-world-cup-matches.json', import.meta.url), 'utf8'));
const candidates = JSON.parse(fs.readFileSync(new URL('../content/questions/candidates.json', import.meta.url), 'utf8'));
assert.equal(source.schemaVersion, 1);
assert.equal(source.sourceProfile, 'official_dataset_v1');
assert.ok(source.records.length >= 500);
assert.equal(new Set(source.records.map(record => record.sourceRecordId)).size, source.records.length);
const generated = candidates.filter(item => item.generation?.model === 'deterministic-fifa-match-template-v1');
assert.equal(generated.length, 119);
assert.deepEqual(Object.fromEntries(Array.from({ length: 6 }, (_, index) => [index + 1,
  generated.filter(item => item.difficultyLevel === index + 1).length])), { 1: 20, 2: 20, 3: 20, 4: 20, 5: 20, 6: 19 });
assert.ok(generated.every(item => item.status === 'approved'));
assert.ok(generated.every(item => !item.question.includes(item.answer)));
assert.ok(generated.every(item => item.source.url.startsWith('https://api.fifa.com/')));
assert.ok(generated.every(item => item.cost.runEstimatedUsd === 0));
console.log('✓ 119 سؤال رياضة حتمي من سجلات مباريات FIFA الرسمية وتكلفة AI صفر');

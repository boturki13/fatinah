import assert from 'node:assert/strict';
import fs from 'node:fs';
const source = JSON.parse(fs.readFileSync(new URL('../content/questions/structured-sources/wikidata-entity-batch.json', import.meta.url), 'utf8'));
const candidates = JSON.parse(fs.readFileSync(new URL('../content/questions/candidates.json', import.meta.url), 'utf8'));
assert.equal(source.sourceProfile, 'wikidata_entities_v1');
for (const category of ['كتب وروايات', 'ألعاب الفيديو', 'محرّكات ومركبات'])
  assert.ok(source.records.filter(record => record.category === category).length >= 150);
const generated = candidates.filter(item => item.generation?.model === 'deterministic-wikidata-entity-template-v1');
assert.equal(generated.length, 321);
assert.deepEqual(Object.fromEntries(['كتب وروايات', 'ألعاب الفيديو', 'محرّكات ومركبات'].map(category =>
  [category, generated.filter(item => item.category === category).length])),
{ 'كتب وروايات': 101, 'ألعاب الفيديو': 101, 'محرّكات ومركبات': 119 });
assert.ok(generated.every(item => item.status === 'approved' && item.cost.runEstimatedUsd === 0));
assert.ok(generated.every(item => item.source.url.startsWith('https://www.wikidata.org/wiki/Q')));
assert.ok(generated.every(item => !item.question.includes(item.answer)));
console.log('✓ 321 سؤال كتب وألعاب ومركبات من علاقات Wikidata العربية وتكلفة AI صفر');

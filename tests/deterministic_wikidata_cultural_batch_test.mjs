import assert from 'node:assert/strict';
import fs from 'node:fs';
const source = JSON.parse(fs.readFileSync(new URL('../content/questions/structured-sources/wikidata-cultural-batch.json', import.meta.url), 'utf8'));
const candidates = JSON.parse(fs.readFileSync(new URL('../content/questions/candidates.json', import.meta.url), 'utf8'));
assert.equal(source.sourceProfile, 'wikidata_entities_v1');
const expected = { 'أنمي': 119, 'أفلام عربية': 119, 'مطابخ العالم': 101, 'اختراعات واكتشافات': 101, 'الشعر العربي': 119 };
const generated = candidates.filter(item => item.generation?.model === 'deterministic-wikidata-cultural-template-v1');
assert.equal(generated.length, 559);
assert.deepEqual(Object.fromEntries(Object.keys(expected).map(category => [category,
  generated.filter(item => item.category === category).length])), expected);
assert.ok(generated.every(item => item.status === 'approved' && item.cost.runEstimatedUsd === 0));
assert.ok(generated.every(item => item.source.url.startsWith('https://www.wikidata.org/wiki/Q')));
assert.ok(generated.every(item => !item.question.includes(item.answer)));
console.log('✓ 559 سؤالاً ثقافياً حتمياً من علاقات Wikidata العربية وتكلفة AI صفر');

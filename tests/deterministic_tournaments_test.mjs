import assert from 'node:assert/strict'; import fs from 'node:fs';
const candidates=JSON.parse(fs.readFileSync(new URL('../content/questions/candidates.json',import.meta.url),'utf8'));
const generated=candidates.filter(x=>x.generation?.model==='deterministic-wikidata-tournament-template-v1');
assert.equal(generated.length,357);
for(const category of ['الألعاب الأولمبية','دوري أبطال أوروبا','كأس الخليج']) assert.equal(generated.filter(x=>x.category===category).length,119);
assert.ok(generated.every(x=>x.status==='approved'&&x.cost.runEstimatedUsd===0));
assert.ok(generated.every(x=>String(x.answer).length<3||!x.question.includes(x.answer)));
assert.equal(new Set(generated.map(x=>x.id)).size,357);
console.log('✓ 357 سؤال بطولات حتمي من سجلات المواسم وتكلفة AI صفر');

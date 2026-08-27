#!/usr/bin/env node
import crypto from 'node:crypto'; import path from 'node:path';
import { CONTENT_DIR, writeJsonAtomic } from './lib.mjs';
const write = process.argv.includes('--write'); const endpoint = 'https://query.wikidata.org/sparql'; const retrievedAt = new Date().toISOString();
const specs = [
  { category: 'الألعاب الأولمبية', competition: 'Q159821' },
  { category: 'دوري أبطال أوروبا', competition: 'Q18756' },
  { category: 'كأس الخليج', competition: 'Q874564' },
];
async function query(spec) {
  const sparql = `SELECT DISTINCT ?item ?itemLabel ?winner ?winnerLabel ?country ?countryLabel ?location ?locationLabel ?topScorer ?topScorerLabel ?start ?end ?point ?edition ?participants ?matches ?goals WHERE {
    ?item wdt:P3450 wd:${spec.competition}.
    OPTIONAL {?item wdt:P1346 ?winner.} OPTIONAL {?item wdt:P17 ?country.} OPTIONAL {?item wdt:P276 ?location.}
    OPTIONAL {?item wdt:P580 ?start.} OPTIONAL {?item wdt:P582 ?end.} OPTIONAL {?item wdt:P585 ?point.}
    OPTIONAL {?item wdt:P393 ?edition.} OPTIONAL {?item wdt:P1132 ?participants.}
    OPTIONAL {?item wdt:P1350 ?matches.} OPTIONAL {?item wdt:P1351 ?goals.}
    OPTIONAL {?item wdt:P3279 ?topScorer.}
    SERVICE wikibase:label { bd:serviceParam wikibase:language "ar,en". }
  } ORDER BY ?start ?point`;
  const url = new URL(endpoint); url.searchParams.set('format', 'json'); url.searchParams.set('query', sparql);
  const response = await fetch(url, { headers: { Accept: 'application/sparql-results+json', 'User-Agent': 'FatinahQuestionBank/1.3 (https://ata20.com)' }, signal: AbortSignal.timeout(90_000) });
  if (!response.ok) throw new Error(`${spec.category}: Wikidata HTTP ${response.status}`); return (await response.json()).results.bindings;
}
function value(binding, key) { return String(binding[key]?.value || '').trim(); }
const records = [];
for (const spec of specs) {
  const bindings = await query(spec); const grouped = new Map();
  for (const b of bindings) { const itemId = value(b, 'item').split('/').pop(); if (!/^Q\d+$/.test(itemId)) continue;
    const current = grouped.get(itemId) || { itemId, itemLabel: value(b,'itemLabel') };
    for (const key of ['winnerLabel','countryLabel','locationLabel','topScorerLabel','start','end','point','edition','participants','matches','goals'])
      if (!current[key] && value(b,key)) current[key] = value(b,key);
    grouped.set(itemId, current); }
  for (const summary of grouped.values()) { const canonical = { category: spec.category, competition: spec.competition, ...summary };
    records.push({ sourceRecordId: `wikidata-tournament-${summary.itemId}`, ...canonical,
      sourceUrl: `https://www.wikidata.org/wiki/${summary.itemId}`, sourcePublisher: 'Wikidata', retrievedAt,
      sourcePayloadHash: crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex') }); }
}
for (const [category, minimum] of [['الألعاب الأولمبية',30],['دوري أبطال أوروبا',65],['كأس الخليج',24]]) {
  const count = records.filter(r => r.category === category).length; if (count < minimum) throw new Error(`${category}: ${count}/${minimum}`); }
const document = { schemaVersion: 1, sourceProfile: 'wikidata_entities_v1', endpoint, retrievedAt, records };
const output = path.join(CONTENT_DIR, 'structured-sources', 'wikidata-tournaments.json'); if (write) writeJsonAtomic(output, document);
console.log(JSON.stringify({ mode: write ? 'write' : 'dry-run', byCategory: Object.fromEntries(specs.map(s => [s.category, records.filter(r => r.category===s.category).length])),
  output: write ? path.relative(process.cwd(), output) : null, aiCalls: 0, estimatedAiCostUsd: 0 }, null, 2));

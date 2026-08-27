#!/usr/bin/env node
import crypto from 'node:crypto'; import path from 'node:path';
import { CONTENT_DIR, writeJsonAtomic } from './lib.mjs';
const write = process.argv.includes('--write'); const endpoint = 'https://query.wikidata.org/sparql';
const retrievedAt = new Date().toISOString();
const query = `SELECT DISTINCT ?lexeme ?lemma ?answer ?answerLabel WHERE {
  ?lexeme dct:language wd:Q13955; wikibase:lemma ?lemma; wikibase:lexicalCategory ?answer.
  FILTER(LANG(?lemma)="ar") SERVICE wikibase:label { bd:serviceParam wikibase:language "ar".
    ?answer rdfs:label ?answerLabel. } FILTER(LANG(?answerLabel)="ar") } LIMIT 240`;
const url = new URL(endpoint); url.searchParams.set('format', 'json'); url.searchParams.set('query', query);
const response = await fetch(url, { headers: { Accept: 'application/sparql-results+json',
  'User-Agent': 'FatinahQuestionBank/1.3 (https://ata20.com)' }, signal: AbortSignal.timeout(90_000) });
if (!response.ok) throw new Error(`Wikidata HTTP ${response.status}`); const payload = await response.json();
const records = (payload?.results?.bindings || []).map(binding => {
  const lexemeId = String(binding.lexeme?.value || '').split('/').pop(); const answerId = String(binding.answer?.value || '').split('/').pop();
  const lemma = String(binding.lemma?.value || '').trim(); const answerLabel = String(binding.answerLabel?.value || '').trim();
  if (!/^L\d+$/.test(lexemeId) || !/^Q\d+$/.test(answerId) || !lemma || !answerLabel) return null;
  const canonical = { lexemeId, lemma, lexicalCategoryId: answerId, lexicalCategoryAr: answerLabel };
  return { sourceRecordId: `wikidata-${lexemeId}-lexical-category-${answerId}`, ...canonical,
    sourceUrl: `https://www.wikidata.org/wiki/Lexeme:${lexemeId}`, sourcePublisher: 'Wikidata', retrievedAt,
    sourcePayloadHash: crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex') };
}).filter(Boolean);
const unique = [...new Map(records.map(r => [r.sourceRecordId, r])).values()];
if (unique.length < 150) throw new Error(`سجلات المفردات العربية غير كافية: ${unique.length}.`);
const document = { schemaVersion: 1, sourceProfile: 'wikidata_entities_v1', endpoint, retrievedAt, records: unique };
const output = path.join(CONTENT_DIR, 'structured-sources', 'wikidata-arabic-lexemes.json');
if (write) writeJsonAtomic(output, document);
console.log(JSON.stringify({ mode: write ? 'write' : 'dry-run', records: unique.length,
  output: write ? path.relative(process.cwd(), output) : null, aiCalls: 0, estimatedAiCostUsd: 0 }, null, 2));

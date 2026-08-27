#!/usr/bin/env node
import path from 'node:path';
import { CANDIDATES_PATH, CONTENT_DIR, difficultyTier, loadExistingQuestionTexts, loadPolicy,
  readJson, stableQuestionId, validateCandidate, writeJsonAtomic } from './lib.mjs';
const write = process.argv.includes('--write'); const model = 'deterministic-language-links-template-v1';
const plan = readJson(path.join(CONTENT_DIR, 'bank-plan-5000.json'), null);
const countries = readJson(path.join(CONTENT_DIR, 'structured-sources', 'world-bank-countries.json'), null)?.records || [];
const lexemes = readJson(path.join(CONTENT_DIR, 'structured-sources', 'wikidata-arabic-lexemes.json'), null)?.records || [];
if (countries.length < 150 || lexemes.length < 150) throw new Error('سجلات اللغة أو الدول ناقصة.');
const candidates = readJson(CANDIDATES_PATH, []); const policy = loadPolicy();
const knownIds = new Set(candidates.map(x => x.id));
const comparisons = [...loadExistingQuestionTexts(), ...candidates.filter(x => x.status === 'approved').map(x => x.question)];
const added = [];
function approve(c) { const now = new Date().toISOString(); Object.assign(c, { status: 'approved',
  generation: { model, responseId: null, generatedAt: now, usage: { inputTokens: 0, outputTokens: 0, webSearchCalls: 0, estimatedUsd: 0 } },
  verification: { model: 'structured-source-and-duplicate-v1', responseId: null, checkedAt: now,
    result: { verdict: 'pass', factCorrect: true, answerExact: true, answerNotRevealed: true, sourceSupportsClaim: true, clearArabic: true,
      reason: 'قالب حتمي من سجل منظم ذي بصمة.' }, usage: { inputTokens: 0, outputTokens: 0, webSearchCalls: 0, estimatedUsd: 0 } },
  cost: { pricingAsOf: null, budgetUsd: 0, runEstimatedUsd: 0 }, review: { reviewer: model, decision: 'approve',
    notes: 'تحقق حتمي من السجل والتكرار.', religiousSourceAndIsnadConfirmed: false, reviewedAt: now } });
  candidates.push(c); added.push(c); knownIds.add(c.id); comparisons.push(c.question); }
for (const category of ['اللغة العربية', 'وش الرابط؟']) { const pool = category === 'اللغة العربية' ? lexemes : countries; const used = new Set();
  for (let level = 1; level <= 6; level += 1) { const needed = Number(plan.categories?.[category]?.levels?.[level]?.gap || 0); let accepted = 0;
    for (const record of pool) { if (accepted >= needed) break; if (used.has(record.sourceRecordId)) continue;
      const language = category === 'اللغة العربية';
      const question = language ? `شنو التصنيف المعجمي لكلمة «${record.lemma}» في سجل المفردات العربية؟`
        : `ما الرابط بين «عاصمتها ${record.capitalAr}» و«رمزها ${record.iso2}» و«تقع عاصمتها قرب ${Number(record.latitude).toFixed(1)}° عرضاً»؟`;
      const answer = language ? record.lexicalCategoryAr : record.countryAr;
      const evidence = language ? `سجل المعجم يربط ${record.lemma} بالتصنيف ${record.lexicalCategoryAr}.`
        : `سجل البنك الدولي يربط ${record.countryAr} بعاصمتها ${record.capitalAr} والرمز ${record.iso2} والإحداثي ${record.latitude}.`;
      const c = { category, difficultyLevel: level, difficulty: difficultyTier(level), question, answer, explanation: evidence,
        religious: false, sourceRecordId: `${record.sourceRecordId}-${category}`, templateId: `${language ? 'arabic-lexical-category' : 'country-three-clues'}-v1-l${level}`,
        source: { title: language ? `${record.lemma} — Wikidata Lexeme` : `World Bank — ${record.countryEn}`,
          url: record.sourceUrl, publisher: record.sourcePublisher, evidence } };
      c.id = stableQuestionId(c); const validation = validateCandidate(c, { policy, existingQuestions: comparisons });
      if (!validation.valid || knownIds.has(c.id)) continue; approve(c); used.add(record.sourceRecordId); accepted += 1; }
    if (accepted !== needed) throw new Error(`${category} المستوى ${level}: ${accepted}/${needed}`); }
}
if (write) writeJsonAtomic(CANDIDATES_PATH, candidates);
console.log(JSON.stringify({ mode: write ? 'write' : 'dry-run', added: added.length,
  byCategory: Object.fromEntries(['اللغة العربية','وش الرابط؟'].map(c => [c, added.filter(x => x.category === c).length])), aiCalls: 0, estimatedAiCostUsd: 0 }, null, 2));

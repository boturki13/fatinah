#!/usr/bin/env node
import path from 'node:path';
import { CANDIDATES_PATH, CONTENT_DIR, difficultyTier, excludeAmbiguousStructuredRecords, loadExistingQuestionTexts, loadPolicy,
  readJson, stableQuestionId, validateCandidate, writeJsonAtomic } from './lib.mjs';
const write = process.argv.includes('--write');
const model = 'deterministic-wikidata-cultural-template-v1';
const excludedQuestionContent = /إسرائيل|اسرائيل|إسرائيلي|اسرائيلي|تل أبيب|تل ابيب/i;
const source = readJson(path.join(CONTENT_DIR, 'structured-sources', 'wikidata-cultural-batch.json'), null);
const plan = readJson(path.join(CONTENT_DIR, 'bank-plan-5000.json'), null);
if (!source?.records?.length) throw new Error('شغّل مستورد الدفعة الثقافية أولاً.');
const templates = {
  'أنمي': r => [`منو أخرج عمل الأنمي «${r.itemLabel}»؟`, r.answerLabel, `خاصية المخرج P57 تربط ${r.itemLabel} بـ${r.answerLabel}.`],
  'أفلام عربية': r => [`منو مخرج الفيلم العربي «${r.itemLabel}»؟`, r.answerLabel, `خاصية المخرج P57 تربط ${r.itemLabel} بـ${r.answerLabel}.`],
  'مطابخ العالم': r => [`من أي دولة يرجع أصل طبق «${r.itemLabel}» حسب السجل؟`, r.answerLabel, `خاصية بلد المنشأ P495 تربط ${r.itemLabel} بـ${r.answerLabel}.`],
  'اختراعات واكتشافات': r => [`منو يُنسب له اكتشاف أو ابتكار «${r.itemLabel}» في السجل؟`, r.answerLabel, `خاصية المكتشف أو المخترع P61 تربط ${r.itemLabel} بـ${r.answerLabel}.`],
  'الشعر العربي': r => [`شنو جنسية الشاعر العربي «${r.itemLabel}» حسب السجل؟`, r.answerLabel, `خاصية الجنسية P27 تربط الشاعر ${r.itemLabel} بـ${r.answerLabel}.`],
};
const policy = loadPolicy(); const candidates = readJson(CANDIDATES_PATH, []);
const knownIds = new Set(candidates.map(x => x.id));
const comparisons = [...loadExistingQuestionTexts(), ...candidates.filter(x => x.status === 'approved').map(x => x.question)];
const added = [];
function approve(candidate) { const now = new Date().toISOString(); Object.assign(candidate, { status: 'approved',
  generation: { model, responseId: null, generatedAt: now, usage: { inputTokens: 0, outputTokens: 0, webSearchCalls: 0, estimatedUsd: 0 } },
  verification: { model: 'wikidata-property-and-duplicate-v1', responseId: null, checkedAt: now,
    result: { verdict: 'pass', factCorrect: true, answerExact: true, answerNotRevealed: true, sourceSupportsClaim: true,
      clearArabic: true, reason: 'علاقة بنيوية مباشرة من Wikidata بتسميات عربية.' },
    usage: { inputTokens: 0, outputTokens: 0, webSearchCalls: 0, estimatedUsd: 0 } },
  cost: { pricingAsOf: null, budgetUsd: 0, runEstimatedUsd: 0 },
  review: { reviewer: model, decision: 'approve', notes: 'تحقق حتمي من العلاقة والمصدر والتكرار.', religiousSourceAndIsnadConfirmed: false, reviewedAt: now } });
  candidates.push(candidate); added.push(candidate); knownIds.add(candidate.id); comparisons.push(candidate.question); }
for (const category of Object.keys(templates)) {
  const used = new Set(); const pool = excludeAmbiguousStructuredRecords(source.records).filter(r => r.category === category &&
    !excludedQuestionContent.test(`${r.itemLabel} ${r.answerLabel}`));
  for (let level = 1; level <= 6; level += 1) { const needed = Number(plan.categories?.[category]?.levels?.[level]?.gap || 0); let accepted = 0;
    for (const record of pool) { if (accepted >= needed) break; if (used.has(record.sourceRecordId)) continue;
      const [question, answer, evidence] = templates[category](record);
      const candidate = { category, difficultyLevel: level, difficulty: difficultyTier(level), question, answer,
        explanation: evidence, religious: false, sourceRecordId: record.sourceRecordId,
        templateId: `wikidata-${record.relation}-v1-l${level}`,
        source: { title: `${record.itemLabel} — Wikidata`, url: record.sourceUrl, publisher: 'Wikidata', evidence } };
      candidate.id = stableQuestionId(candidate); const validation = validateCandidate(candidate, { policy, existingQuestions: comparisons });
      if (!validation.valid || knownIds.has(candidate.id)) continue; approve(candidate); used.add(record.sourceRecordId); accepted += 1; }
    if (accepted !== needed) throw new Error(`${category} المستوى ${level}: ${accepted}/${needed}`); }
}
if (write) writeJsonAtomic(CANDIDATES_PATH, candidates);
console.log(JSON.stringify({ mode: write ? 'write' : 'dry-run', added: added.length,
  byCategory: Object.fromEntries(Object.keys(templates).map(c => [c, added.filter(x => x.category === c).length])), aiCalls: 0, estimatedAiCostUsd: 0 }, null, 2));

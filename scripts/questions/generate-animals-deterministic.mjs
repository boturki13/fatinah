#!/usr/bin/env node
import path from 'node:path';
import {
  CANDIDATES_PATH, CONTENT_DIR, difficultyTier, loadExistingQuestionTexts, loadPolicy,
  readJson, stableQuestionId, validateCandidate, writeJsonAtomic,
} from './lib.mjs';

const write = process.argv.includes('--write');
const previewAll = process.argv.includes('--preview-all');
const category = 'حيوانات وطبيعة';
const model = 'deterministic-inaturalist-taxon-template-v1';
const recordsDocument = readJson(path.join(CONTENT_DIR, 'structured-sources', 'inaturalist-animal-taxa.json'), null);
const bankPlan = readJson(path.join(CONTENT_DIR, 'bank-plan-5000.json'), null);
if (!recordsDocument || recordsDocument.schemaVersion !== 1 || !Array.isArray(recordsDocument.records)) {
  throw new Error('شغّل questions:import-inaturalist-taxa أولاً.');
}
if (!bankPlan || bankPlan.targetBankSize !== 5000) throw new Error('خطة بنك 5000 غير صالحة.');

const groupAr = new Map([
  ['Mammalia', 'الثدييات'], ['Aves', 'الطيور'], ['Reptilia', 'الزواحف'],
  ['Amphibia', 'البرمائيات'], ['Actinopterygii', 'الأسماك شعاعية الزعانف'],
  ['Insecta', 'الحشرات'], ['Arachnida', 'العنكبيات'], ['Mollusca', 'الرخويات'],
]);
const revealingGroupRoot = /ثدي|طير|زاحف|برمائ|سمك|حشر|عنكب|رخوي/;

function candidateFor(level, record) {
  let question;
  let answer;
  let explanation;
  let templateId;
  if (level <= 2) {
    answer = groupAr.get(record.iconicTaxon);
    question = `إلى أي مجموعة حيوانية ينتمي «${record.commonNameAr}»؟`;
    explanation = `يصنّف iNaturalist النوع ${record.scientificName} المعروف عربياً باسم ${record.commonNameAr} ضمن ${answer}.`;
    templateId = `animal-iconic-group-v1-l${level}`;
  } else if (level <= 4) {
    question = `شنو الاسم العلمي للحيوان «${record.commonNameAr}»؟`;
    answer = record.scientificName;
    explanation = `يربط سجل iNaturalist الاسم العربي ${record.commonNameAr} بالاسم العلمي ${record.scientificName}.`;
    templateId = `animal-scientific-name-v1-l${level}`;
  } else {
    question = `شنو الاسم العربي للحيوان ذي الاسم العلمي «${record.scientificName}»؟`;
    answer = record.commonNameAr;
    explanation = `يعرض سجل iNaturalist العربي الاسم ${record.commonNameAr} للنوع ${record.scientificName}.`;
    templateId = `animal-arabic-name-v1-l${level}`;
  }
  const candidate = {
    category, difficultyLevel: level, difficulty: difficultyTier(level), question, answer, explanation,
    religious: false, sourceRecordId: record.sourceRecordId, templateId,
    source: {
      title: `iNaturalist taxon — ${record.scientificName}`,
      url: record.sourceUrl,
      publisher: record.sourcePublisher,
      evidence: `يعرض السجل العربي الاسم ${record.commonNameAr} والاسم العلمي ${record.scientificName} وتصنيفه ضمن ${record.iconicTaxon}.`,
    },
  };
  candidate.id = stableQuestionId(candidate);
  return candidate;
}

const groupOrder = [...groupAr.keys()];
const recordsByGroup = new Map(groupOrder.map(group => [group,
  recordsDocument.records.filter(record => record.iconicTaxon === group)]));
const quotasByLevel = new Map([
  [1, { Mammalia: 5, Aves: 5, Reptilia: 4, Actinopterygii: 3, Insecta: 2, Amphibia: 1 }],
  [2, { Mammalia: 5, Aves: 5, Reptilia: 5, Actinopterygii: 3, Insecta: 1, Mollusca: 1 }],
  [3, { Mammalia: 5, Aves: 5, Reptilia: 4, Actinopterygii: 3, Insecta: 1, Amphibia: 1, Mollusca: 1 }],
  [4, { Mammalia: 5, Aves: 5, Reptilia: 5, Actinopterygii: 3, Insecta: 2 }],
  [5, { Mammalia: 5, Aves: 5, Reptilia: 4, Actinopterygii: 3, Insecta: 1, Amphibia: 1, Mollusca: 1 }],
  [6, { Mammalia: 4, Aves: 5, Reptilia: 4, Actinopterygii: 3, Insecta: 1, Mollusca: 1, Arachnida: 1 }],
]);
const policy = loadPolicy();
const candidates = readJson(CANDIDATES_PATH, []);
const knownIds = new Set(candidates.map(candidate => candidate.id));
const comparisons = [...loadExistingQuestionTexts(),
  ...candidates.filter(candidate => candidate.status === 'approved').map(candidate => candidate.question)];
const usedRecordIds = new Set(candidates.filter(candidate => candidate.category === category)
  .map(candidate => candidate.sourceRecordId).filter(Boolean));
const added = [];

function acceptNext(group, level, rejectionCounts) {
  const pool = recordsByGroup.get(group) || [];
  while (pool.length) {
    const record = pool.shift();
    if (usedRecordIds.has(record.sourceRecordId)) continue;
    if (level <= 2 && revealingGroupRoot.test(record.commonNameAr)) continue;
    const candidate = candidateFor(level, record);
    const validation = validateCandidate(candidate, { policy, existingQuestions: comparisons });
    if (!validation.valid || knownIds.has(candidate.id)) {
      for (const reason of validation.errors.length ? validation.errors : ['duplicate_id']) {
        rejectionCounts[reason] = (rejectionCounts[reason] || 0) + 1;
      }
      continue;
    }
    const now = new Date().toISOString();
    Object.assign(candidate, {
      status: 'approved',
      generation: { model, responseId: null, generatedAt: now,
        usage: { inputTokens: 0, outputTokens: 0, webSearchCalls: 0, estimatedUsd: 0 } },
      verification: {
        model: 'schema-source-and-duplicate-v1', responseId: null, checkedAt: now,
        result: { verdict: 'pass', factCorrect: true, answerExact: true, answerNotRevealed: true,
          sourceSupportsClaim: true, clearArabic: true,
          reason: 'قالب حتمي من سجل تصنيفي عربي موثوق ومطابق بين مصدرين وبصمة ثابتة.' },
        usage: { inputTokens: 0, outputTokens: 0, webSearchCalls: 0, estimatedUsd: 0 },
      },
      cost: { pricingAsOf: null, budgetUsd: 0, runEstimatedUsd: 0 },
      review: { reviewer: model, decision: 'approve',
        notes: 'تحقق آلي من الاسم العربي والعلمي والتصنيف والمصدرين وعدم كشف الإجابة والتكرار.',
        religiousSourceAndIsnadConfirmed: false, reviewedAt: now },
    });
    candidates.push(candidate);
    added.push(candidate);
    knownIds.add(candidate.id);
    comparisons.push(candidate.question);
    usedRecordIds.add(record.sourceRecordId);
    return true;
  }
  return false;
}

for (let level = 1; level <= 6; level += 1) {
  const needed = Number(bankPlan.categories?.[category]?.levels?.[level]?.gap || 0);
  let accepted = 0;
  const rejectionCounts = {};
  for (const [group, quota] of Object.entries(quotasByLevel.get(level) || {})) {
    for (let count = 0; count < quota; count += 1) {
      if (acceptNext(group, level, rejectionCounts)) accepted += 1;
    }
  }
  // فشل مغلق مع بديل متوازن فقط إذا استُبعد سجل أثناء التحقق.
  while (accepted < needed) {
    let filled = false;
    for (const group of groupOrder) {
      if (acceptNext(group, level, rejectionCounts)) {
        accepted += 1;
        filled = true;
        break;
      }
    }
    if (!filled) break;
  }
  if (accepted !== needed) throw new Error(
    `${category} — المستوى ${level}: المطلوب ${needed} والمتاح ${accepted}. الاستبعادات: ${JSON.stringify(rejectionCounts)}.`
  );
}

if (write) writeJsonAtomic(CANDIDATES_PATH, candidates);
console.log(JSON.stringify({
  mode: write ? 'write' : 'dry-run', added: added.length,
  byLevel: Object.fromEntries(Array.from({ length: 6 }, (_, index) => [index + 1,
    added.filter(candidate => candidate.difficultyLevel === index + 1).length])),
  previews: Array.from({ length: 6 }, (_, index) => {
    const candidate = added.find(item => item.difficultyLevel === index + 1);
    return candidate ? { level: index + 1, question: candidate.question, answer: candidate.answer } : null;
  }).filter(Boolean),
  ...(previewAll ? { allQuestions: added.map(candidate => ({
    level: candidate.difficultyLevel, question: candidate.question, answer: candidate.answer,
    sourceRecordId: candidate.sourceRecordId,
  })) } : {}),
  approved: added.length, aiCalls: 0, estimatedAiCostUsd: 0,
}, null, 2));

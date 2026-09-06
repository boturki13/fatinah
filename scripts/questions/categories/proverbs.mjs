import fs from 'node:fs';
import path from 'node:path';
import {
  finalizeCategory,
  normalizeArabic,
  optionTooSimilar,
  sha256,
} from './common.mjs';
import { findLegacyFactMatch } from '../legacy-question-policy.mjs';

const ROOT = path.resolve(import.meta.dirname, '../../..');
export const PROVERBS_SOURCE_PATH = 'content/questions/structured-sources/common-arabic-proverbs.json';

const FUNCTION_WORDS = new Set([
  'من', 'في', 'على', 'إلى', 'عن', 'ما', 'لا', 'إن', 'إذا', 'ثم', 'أو',
  'هو', 'هي', 'هذا', 'هذه', 'الذي', 'التي', 'كل', 'قد', 'لم', 'لن',
].map(normalizeArabic));

function sourceDocument() {
  const document = JSON.parse(fs.readFileSync(path.join(ROOT, PROVERBS_SOURCE_PATH), 'utf8'));
  if (document.schemaVersion !== 2
      || document.sourceProfile !== 'curated_immutable_revision_v2'
      || document.distractorPolicy?.id !== 'editorial_contextual_completion_v1'
      || document.distractorPolicy?.maximumGlobalDistractorFrequency !== 2
      || document.distractorPolicy?.uniqueTripletsRequired !== true
      || !Array.isArray(document.records)
      || document.records.length !== 90) {
    throw new Error('مصدر الأمثال لا يطابق سياسة الإكمالات التحريرية المعتمدة.');
  }
  return document;
}

function optionSet(values) {
  return [...values].map(normalizeArabic).sort().join('|');
}

function validateRecord(record, index) {
  const words = String(record.proverb || '').trim().split(/\s+/u);
  const answer = words.at(-1) || '';
  const distractors = record.distractors;
  if (record.familiarityRank !== index + 1
      || !record.sourceRecordId
      || words.length < 3
      || !record.sourceExcerpt
      || record.distractorPolicy !== 'editorial_contextual_completion_v1'
      || !record.completionClass
      || !Array.isArray(distractors)
      || distractors.length !== 3) {
    throw new Error(`سجل مثل غير مكتمل: ${record.sourceRecordId || index + 1}`);
  }
  const options = [answer, ...distractors];
  if (new Set(options.map(normalizeArabic)).size !== 4
      || options.some(option => normalizeArabic(option).length < 3
        || FUNCTION_WORDS.has(normalizeArabic(option)))) {
    throw new Error(`خيارات غير صالحة للمثل: ${record.sourceRecordId}`);
  }
  for (let left = 0; left < options.length; left += 1) {
    for (let right = left + 1; right < options.length; right += 1) {
      if (optionTooSimilar(options[left], options[right])) {
        throw new Error(`خياران متشابهان للمثل ${record.sourceRecordId}: ${options[left]} / ${options[right]}`);
      }
    }
  }
  return { answer, prompt: words.slice(0, -1).join(' '), distractors };
}

function balancedAnswerSlots(records) {
  // Each 30-question difficulty band is balanced to within one occurrence per
  // slot. Rotating the quotas also balances the complete 90-question category.
  const quotaByBand = [
    [8, 8, 7, 7],
    [7, 7, 8, 8],
    [8, 7, 8, 7],
  ];
  const slots = new Map();
  for (let band = 0; band < 3; band += 1) {
    const ordered = records.slice(band * 30, band * 30 + 30)
      .sort((left, right) => sha256(`proverb-answer-slot-v1|${left.sourceRecordId}`)
        .localeCompare(sha256(`proverb-answer-slot-v1|${right.sourceRecordId}`)));
    const available = quotaByBand[band].flatMap((count, slot) => Array(count).fill(slot));
    ordered.forEach((record, index) => slots.set(record.sourceRecordId, available[index]));
  }
  return slots;
}

function arrangeOptions(answer, distractors, answerIndex, sourceRecordId) {
  const offset = Number.parseInt(sha256(`proverb-distractor-order-v1|${sourceRecordId}`).slice(0, 8), 16) % 3;
  const ordered = [...distractors.slice(offset), ...distractors.slice(0, offset)];
  ordered.splice(answerIndex, 0, answer);
  return ordered;
}

export function buildProverbCategory({ legacyRecords = [] } = {}) {
  const document = sourceDocument();
  const records = [...document.records].sort((left, right) => left.familiarityRank - right.familiarityRank);
  const answerSlots = balancedAnswerSlots(records);
  const questions = records.map((record, index) => {
    const { answer, prompt, distractors } = validateRecord(record, index);
    const answerIndex = answerSlots.get(record.sourceRecordId);
    return {
      q: `اكتشف الكلمة الناقصة من المثل: «${prompt} …»`,
      answer,
      o: arrangeOptions(answer, distractors, answerIndex, record.sourceRecordId),
      a: answerIndex,
      factKey: `proverb-missing-word:${record.sourceRecordId}`,
      sourceRecordId: record.sourceRecordId,
      templateId: 'arabic-proverb-last-word-v2',
      rank: 91 - record.familiarityRank,
      source: {
        title: document.sourceTitle,
        url: document.sourceUrl,
        publisher: 'ويكي الاقتباس العربي',
        license: document.license,
      },
      verification: {
        profile: 'source_record_fields_v1',
        artifact: PROVERBS_SOURCE_PATH,
        collection: 'records',
        recordIdField: 'sourceRecordId',
        recordId: record.sourceRecordId,
        fields: {
          proverb: record.proverb,
          familiarityRank: record.familiarityRank,
          sourceExcerpt: record.sourceExcerpt,
          distractors: record.distractors,
          completionClass: record.completionClass,
          distractorPolicy: record.distractorPolicy,
        },
        claim: {
          subject: record.sourceRecordId,
          predicate: 'last_word',
          object: answer,
        },
      },
      metadata: {
        answerSemanticType: 'arabic-word',
        optionSemanticGroup: `proverb-completion:${record.completionClass}`,
        completionClass: record.completionClass,
        distractorPolicy: record.distractorPolicy,
        legacyFact: { anchors: [record.proverb, answer], minAnchors: 2 },
      },
    };
  });
  const finalized = finalizeCategory('اكتشف الكلمة', questions);
  const legacyMatches = finalized
    .map(question => ({ question, match: findLegacyFactMatch(question, legacyRecords) }))
    .filter(item => item.match);
  if (legacyMatches.length) {
    throw new Error(`أُعيدت ${legacyMatches.length} أمثال من البنك القديم: ${legacyMatches[0].question.q}`);
  }
  if (!verifyProverbCategory(finalized)) {
    const recordsById = new Map(records.map(record => [record.sourceRecordId, record]));
    const invalid = finalized.find(question => !verifyProverbQuestion(
      question, recordsById.get(question.sourceRecordId),
    ));
    throw new Error(`فشلت بوابة جودة فئة اكتشف الكلمة${invalid ? ` عند ${invalid.sourceRecordId}` : ' في توازن المجموعة'}.`);
  }
  return finalized;
}

function normalizeSourceSpelling(value) {
  return normalizeArabic(value)
    .replace(/الشئ/gu, 'الشيء')
    .replace(/جعجه/gu, 'جعجعه');
}

export function verifyProverbQuestion(question, sourceRecord) {
  if (!question || !sourceRecord) return false;
  const document = sourceDocument();
  let parsed;
  try { parsed = validateRecord(sourceRecord, sourceRecord.familiarityRank - 1); }
  catch { return false; }
  const sourceText = normalizeSourceSpelling(sourceRecord.sourceExcerpt);
  const canonicalText = normalizeSourceSpelling(sourceRecord.proverb);
  const incorrect = question.o?.filter((_, index) => index !== question.a) || [];
  const expectedVerification = {
    profile: 'source_record_fields_v1',
    artifact: PROVERBS_SOURCE_PATH,
    collection: 'records',
    recordIdField: 'sourceRecordId',
    recordId: sourceRecord.sourceRecordId,
    fields: {
      proverb: sourceRecord.proverb,
      familiarityRank: sourceRecord.familiarityRank,
      sourceExcerpt: sourceRecord.sourceExcerpt,
      distractors: sourceRecord.distractors,
      completionClass: sourceRecord.completionClass,
      distractorPolicy: sourceRecord.distractorPolicy,
    },
    claim: { subject: sourceRecord.sourceRecordId, predicate: 'last_word', object: parsed.answer },
  };
  const expectedQuestion = `اكتشف الكلمة الناقصة من المثل: «${parsed.prompt} …»`;
  const position = sourceRecord.familiarityRank - 1;
  const expectedBandIndex = Math.floor(position / 30);
  if (question.templateId !== 'arabic-proverb-last-word-v2'
      || question.q !== expectedQuestion
      || question.id !== `gq-${sha256(`next-v2|اكتشف الكلمة|proverb-missing-word:${sourceRecord.sourceRecordId}|${expectedQuestion}`).slice(0, 20)}`
      || question.answer !== parsed.answer
      || question.o?.length !== 4
      || !Number.isInteger(question.a) || question.a < 0 || question.a > 3
      || question.o[question.a] !== parsed.answer
      || optionSet(incorrect) !== optionSet(parsed.distractors)
      || question.sourceRecordId !== sourceRecord.sourceRecordId
      || question.factKey !== `proverb-missing-word:${sourceRecord.sourceRecordId}`
      || question.rank !== 91 - sourceRecord.familiarityRank
      || question.band !== ['easy', 'medium', 'hard'][expectedBandIndex]
      || question.d !== expectedBandIndex * 2 + 1 + (position % 2)
      || question.completionClass !== sourceRecord.completionClass
      || question.distractorPolicy !== 'editorial_contextual_completion_v1'
      || JSON.stringify(question.verification) !== JSON.stringify(expectedVerification)
      || question.source?.title !== document.sourceTitle
      || question.source?.url !== document.sourceUrl
      || question.source?.publisher !== 'ويكي الاقتباس العربي'
      || question.source?.license !== document.license
      || !sourceText.includes(canonicalText)) return false;
  for (let left = 0; left < question.o.length; left += 1) {
    for (let right = left + 1; right < question.o.length; right += 1) {
      if (optionTooSimilar(question.o[left], question.o[right])) return false;
    }
  }
  return true;
}

export function verifyProverbCategory(questions, sourceRecord = null) {
  if (sourceRecord) return verifyProverbQuestion(questions, sourceRecord);
  if (!Array.isArray(questions) || questions.length !== 90) return false;
  const document = sourceDocument();
  const records = new Map(document.records.map(record => [record.sourceRecordId, record]));
  if (new Set(questions.map(question => question.id)).size !== 90
      || new Set(questions.map(question => question.q)).size !== 90
      || new Set(questions.map(question => question.factKey)).size !== 90
      || new Set(questions.map(question => question.sourceRecordId)).size !== 90
      || questions.some(question => !verifyProverbQuestion(question, records.get(question.sourceRecordId)))) return false;

  const expectedBands = ['easy', 'medium', 'hard'];
  for (const band of expectedBands) {
    const rows = questions.filter(question => question.band === band);
    const positions = Array.from({ length: 4 }, (_, slot) => rows.filter(question => question.a === slot).length);
    if (rows.length !== 30 || Math.max(...positions) - Math.min(...positions) > 1) return false;
  }
  for (let level = 1; level <= 6; level += 1) {
    if (questions.filter(question => question.d === level).length !== 15) return false;
  }
  const allPositions = Array.from({ length: 4 }, (_, slot) => questions.filter(question => question.a === slot).length);
  if (Math.max(...allPositions) - Math.min(...allPositions) > 1) return false;

  const distractorFrequency = new Map();
  const triplets = new Set();
  for (const question of questions) {
    const distractors = question.o.filter((_, index) => index !== question.a);
    const triplet = optionSet(distractors);
    if (triplets.has(triplet)) return false;
    triplets.add(triplet);
    for (const distractor of distractors) {
      const key = normalizeArabic(distractor);
      distractorFrequency.set(key, (distractorFrequency.get(key) || 0) + 1);
    }
  }
  return [...distractorFrequency.values()].every(count => count <= 2);
}

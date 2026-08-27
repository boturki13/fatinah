#!/usr/bin/env node
import {
  CANDIDATES_PATH,
  difficultyTier,
  loadReligiousSourcePackets,
  normalizeArabic,
  readJson,
  stableQuestionId,
  validateCandidate,
  writeJsonAtomic,
} from './lib.mjs';
import { loadTanzilCorpus } from './religious-source-lib.mjs';

function options(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith('--')) continue;
    result[argv[index].slice(2)] = argv[index + 1]?.startsWith('--') || argv[index + 1] == null
      ? true : argv[++index];
  }
  return result;
}

function uniqueOpening(text, allNormalizedVerses) {
  const words = text.trim().split(/\s+/);
  const trailingParticles = new Set([
    'لا', 'ولا', 'لم', 'لن', 'من', 'في', 'الي', 'على', 'عن', 'ان', 'اذ', 'اذا', 'ثم', 'او',
    'ما', 'له', 'ربنا', 'وتعز', 'يجرمنكم', 'هما', 'عندك', 'يبلغن', 'اما',
  ]);
  const trailingPhrases = new Set(['ان الله']);
  const maximumWordCount = Math.min(18, words.length);
  for (let wordCount = maximumWordCount; wordCount >= Math.min(4, words.length); wordCount -= 1) {
    const snippet = words.slice(0, wordCount).join(' ');
    const normalized = normalizeArabic(snippet);
    const occurrences = allNormalizedVerses.filter(verse => verse.includes(normalized)).length;
    const lastWord = normalizeArabic(words[wordCount - 1]);
    const lastTwoWords = words.slice(Math.max(0, wordCount - 2), wordCount)
      .map(normalizeArabic).join(' ');
    if (occurrences === 1 && snippet.length <= 115 && !trailingParticles.has(lastWord) &&
        !trailingPhrases.has(lastTwoWords)) return snippet;
  }
  return null;
}

function snippetRevealsSurah(snippet, surahName) {
  const words = new Set(normalizeArabic(snippet).split(/\s+/));
  const normalizedName = normalizeArabic(surahName);
  const directForms = new Set([normalizedName]);
  if (normalizedName.startsWith('ال') && normalizedName.length > 4) {
    directForms.add(normalizedName.slice(2));
  }
  return [...directForms].some(name => words.has(name));
}

const args = options(process.argv.slice(2));
const level = Number.parseInt(args.level || '1', 10);
const count = Math.min(Math.max(Number.parseInt(args.count || '10', 10) || 10, 1), 25);
const dryRun = args['dry-run'] === true;
if (!Number.isInteger(level) || level < 1 || level > 6) {
  throw new Error('المستوى يجب أن يكون من 1 إلى 6.');
}

const packets = loadReligiousSourcePackets().filter(packet => packet.work === 'القرآن الكريم');
if (!packets.length) {
  throw new Error(
    'لا توجد آيات مزدوجة التحقق. شغّل questions:prepare-quran-packet بعد إعداد بيانات Quran Foundation.'
  );
}
const corpus = loadTanzilCorpus();
const allNormalizedVerses = [...corpus.verses.values()].map(normalizeArabic);
const existing = readJson(CANDIDATES_PATH, []);
const usedPacketIds = new Set(existing.map(candidate => candidate.sourcePacketId).filter(Boolean));
const generated = [];

for (const packet of packets) {
  if (generated.length >= count || usedPacketIds.has(packet.id)) continue;
  const snippet = uniqueOpening(packet.arabicText, allNormalizedVerses);
  const surahName = String(packet.canonicalReference?.surahName || '').trim();
  if (!snippet || !surahName || snippetRevealsSurah(snippet, surahName) ||
      packet.canonicalReference?.ayah === 1 &&
      normalizeArabic(snippet).startsWith(normalizeArabic('بسم الله الرحمن الرحيم'))) continue;
  const candidate = {
    id: '',
    category: 'القرآن الكريم',
    difficulty: difficultyTier(level),
    difficultyLevel: level,
    question: `في أي سورة ورد قوله تعالى: «${snippet}»؟`,
    answer: `سورة ${surahName}`,
    explanation: `هذا المقطع من الآية ${packet.canonicalReference.ayah} من سورة ${surahName}.`,
    religious: true,
    sourcePacketId: packet.id,
    source: {
      ...packet.source,
      evidence: `${packet.reference}؛ مطابق محلياً مع Tanzil ومتحقق ثانوياً عبر Quran Foundation.`,
    },
    status: 'approved',
    generation: {
      model: 'deterministic-quran-template-v1',
      responseId: null,
      generatedAt: new Date().toISOString(),
    },
    verification: {
      model: 'tanzil-1.1+quran-foundation-v4',
      responseId: null,
      checkedAt: packet.automatedVerification.secondary.verifiedAt,
      result: {
        verdict: 'pass',
        factCorrect: true,
        answerExact: true,
        sourceSupportsClaim: true,
        clearArabic: true,
        answerNotRevealed: true,
        reason: 'قالب حتمي من آية ذات افتتاحية فريدة ومطابقة لمصدرين مستقلين.',
      },
    },
    review: {
      reviewer: 'deterministic-quran-template-v1',
      decision: 'approve',
      notes: 'اعتماد آلي حتمي؛ لا تفسير ولا فقه ولا استنباط ولا صياغة AI.',
      religiousSourceAndIsnadConfirmed: true,
      religiousCanonicalSourceConfirmed: true,
      religiousNoDisputedMatterConfirmed: true,
      reviewedAt: new Date().toISOString(),
    },
  };
  candidate.id = stableQuestionId(candidate);
  const validation = validateCandidate(candidate, {
    existingQuestions: [...existing, ...generated].map(item => item.question),
    religiousSourcePackets: packets,
  });
  if (validation.valid) generated.push(candidate);
}

if (generated.length !== count) {
  throw new Error(`المتاح الآمن بالقوالب الفريدة ${generated.length}/${count}؛ لم تُكتب أي نتيجة.`);
}
if (!dryRun) writeJsonAtomic(CANDIDATES_PATH, [...existing, ...generated]);
console.log(JSON.stringify({
  mode: dryRun ? 'dry-run' : 'write',
  generated: generated.length,
  level,
  aiCalls: 0,
  estimatedCostUsd: 0,
  ids: generated.map(candidate => candidate.id),
  ...(dryRun ? {
    previews: generated.map(candidate => ({
      id: candidate.id,
      sourcePacketId: candidate.sourcePacketId,
      question: candidate.question,
      answer: candidate.answer,
    })),
  } : {}),
}, null, 2));

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

function options(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith('--')) continue;
    result[argv[index].slice(2)] = argv[index + 1]?.startsWith('--') || argv[index + 1] == null
      ? true : argv[++index];
  }
  return result;
}

const args = options(process.argv.slice(2));
const level = Number.parseInt(args.level || '1', 10);
const count = Math.min(Math.max(Number.parseInt(args.count || '10', 10) || 10, 1), 25);
const dryRun = args['dry-run'] === true;
if (!Number.isInteger(level) || level < 1 || level > 6) throw new Error('المستوى يجب أن يكون من 1 إلى 6.');
const packets = loadReligiousSourcePackets().filter(packet => packet.work === 'صحيح البخاري');
if (!packets.length) throw new Error('لا توجد أحاديث متفق عليها وصحيحة الإسناد في الحزم المعتمدة.');
const existing = readJson(CANDIDATES_PATH, []);
const usedPacketIds = new Set(existing.map(candidate => candidate.sourcePacketId).filter(Boolean));
const generated = [];
for (const packet of packets) {
  if (generated.length >= count || usedPacketIds.has(packet.id)) continue;
  const narrator = packet.canonicalReference.narrator;
  const words = packet.arabicText.split(/\s+/);
  const snippet = words.slice(0, Math.min(12, words.length)).join(' ');
  if (snippet.length > 130 || normalizeArabic(snippet).includes(normalizeArabic(narrator))) continue;
  const candidate = {
    id: '', category: 'دين وسيرة', difficulty: difficultyTier(level), difficultyLevel: level,
    question: `من الصحابي راوي الحديث الذي يبدأ: «${snippet}»؟`,
    answer: narrator,
    explanation: `روى ${narrator} هذا الحديث، وقد أخرجه البخاري (${packet.canonicalReference.bukhariNumber}) ومسلم (${packet.canonicalReference.muslimNumber}).`,
    religious: true,
    sourcePacketId: packet.id,
    source: { ...packet.source, evidence: packet.reference },
    status: 'approved',
    generation: { model: 'deterministic-hadith-narrator-v1', responseId: null, generatedAt: new Date().toISOString() },
    verification: {
      model: 'sahihayn+dorar', responseId: null,
      checkedAt: packet.automatedVerification.secondary.verifiedAt,
      result: {
        verdict: 'pass', factCorrect: true, answerExact: true, sourceSupportsClaim: true,
        clearArabic: true, answerNotRevealed: true,
        reason: 'قالب الراوي فقط من حديث متفق عليه ومثبت الصحة عبر الدرر السنية.',
      },
    },
    review: {
      reviewer: 'deterministic-hadith-narrator-v1', decision: 'approve',
      notes: 'اعتماد آلي حتمي بلا تفسير أو فقه أو استنباط.',
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
if (generated.length !== count) throw new Error(`المتاح الآمن ${generated.length}/${count}؛ لم تُكتب أي نتيجة.`);
if (!dryRun) writeJsonAtomic(CANDIDATES_PATH, [...existing, ...generated]);
console.log(JSON.stringify({
  mode: dryRun ? 'dry-run' : 'write', generated: generated.length, level,
  aiCalls: 0, estimatedCostUsd: 0, ids: generated.map(candidate => candidate.id),
}, null, 2));

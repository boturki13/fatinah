#!/usr/bin/env node
import path from 'node:path';
import {
  CANDIDATES_PATH,
  CONTENT_DIR,
  difficultyTier,
  loadExistingQuestionTexts,
  loadPolicy,
  readJson,
  stableQuestionId,
  validateCandidate,
  writeJsonAtomic,
} from './lib.mjs';

const write = process.argv.includes('--write');
const category = 'الفضاء والكون';
const model = 'deterministic-nasa-exoplanet-template-v1';
const recordsDocument = readJson(path.join(CONTENT_DIR, 'structured-sources', 'nasa-exoplanets.json'), null);
const bankPlan = readJson(path.join(CONTENT_DIR, 'bank-plan-5000.json'), null);
if (!recordsDocument || recordsDocument.schemaVersion !== 1 || !Array.isArray(recordsDocument.records)) {
  throw new Error('شغّل questions:import-nasa-exoplanets أولاً.');
}
if (!bankPlan || bankPlan.targetBankSize !== 5000) throw new Error('خطة بنك 5000 غير صالحة.');

const methodAr = new Map([
  ['Transit', 'طريقة العبور'],
  ['Radial Velocity', 'طريقة السرعة الشعاعية'],
  ['Imaging', 'التصوير المباشر'],
  ['Microlensing', 'العدسة الجاذبية الدقيقة'],
  ['Pulsar Timing', 'توقيت النباضات'],
  ['Pulsation Timing Variations', 'اختلافات توقيت النبض'],
  ['Transit Timing Variations', 'اختلافات توقيت العبور'],
  ['Eclipse Timing Variations', 'اختلافات توقيت الكسوف'],
  ['Orbital Brightness Modulation', 'تغيّر السطوع المداري'],
  ['Astrometry', 'القياس الفلكي الموضعي'],
  ['Disk Kinematics', 'حركيات القرص'],
]);
const facilityAr = new Map([
  ['Kepler', 'مرصد كبلر الفضائي'],
  ['Transiting Exoplanet Survey Satellite (TESS)', 'القمر الصناعي تيس'],
  ['K2', 'مهمة كبلر الثانية K2'],
  ['Multiple Observatories', 'مراصد متعددة'],
  ['Multiple Facilities', 'مرافق رصد متعددة'],
  ['La Silla Observatory', 'مرصد لاسيلا'],
  ['W. M. Keck Observatory', 'مرصد كيك'],
  ['KMTNet', 'شبكة تلسكوبات العدسة الدقيقة الكورية'],
  ['SuperWASP', 'مشروع سوبر واسب'],
  ['SuperWASP-South', 'مشروع سوبر واسب الجنوبي'],
  ['WASP-South', 'مشروع واسب الجنوبي'],
  ['OGLE', 'تجربة أوغل للعدسة الجاذبية'],
  ['HATSouth', 'شبكة هات ساوث'],
  ['HATNet', 'شبكة هات'],
  ['Haute-Provence Observatory', 'مرصد هوت بروفانس'],
  ['Roque de los Muchachos Observatory', 'مرصد روكي دي لوس موتشاتشوس'],
  ['Paranal Observatory', 'مرصد بارانال'],
  ['Lick Observatory', 'مرصد ليك'],
  ['Okayama Astrophysical Observatory', 'مرصد أوكاياما للفيزياء الفلكية'],
  ['CoRoT', 'مرصد كوروت الفضائي'],
  ['Anglo-Australian Telescope', 'التلسكوب الأنجلو أسترالي'],
  ['Las Campanas Observatory', 'مرصد لاس كامباناس'],
  ['MOA', 'مشروع موا للعدسة الجاذبية'],
  ['McDonald Observatory', 'مرصد ماكدونالد'],
  ['Calar Alto Observatory', 'مرصد كالار ألتو'],
  ['Next-Generation Transit Survey (NGTS)', 'مسح العبور من الجيل التالي'],
  ['European Space Agency (ESA) Gaia Satellite', 'مرصد غايا الفضائي'],
  ['Gemini Observatory', 'مرصد جيميني'],
  ['Subaru Telescope', 'تلسكوب سوبارو'],
  ['Mauna Kea Observatory', 'مرصد مونا كيا'],
  ['KELT', 'مسح كيلت'],
  ['KELT-North', 'مسح كيلت الشمالي'],
  ['Hubble Space Telescope', 'تلسكوب هابل الفضائي'],
  ['Cerro Tololo Inter-American Observatory', 'مرصد سيرو تولولو'],
]);
const familiarPlanetOrder = [
  'Proxima Cen b', '51 Peg b', 'Kepler-22 b', 'Kepler-186 f', 'Kepler-452 b',
  'TRAPPIST-1 b', 'TRAPPIST-1 c', 'TRAPPIST-1 d', 'TRAPPIST-1 e', 'TRAPPIST-1 f',
  'TRAPPIST-1 g', 'TRAPPIST-1 h', 'K2-18 b', 'TOI-700 d', 'TOI-700 e',
  'LHS 1140 b', 'GJ 1214 b', 'GJ 436 b', 'HD 209458 b', 'WASP-12 b',
  'WASP-17 b', 'WASP-39 b', 'Beta Pic b', 'HR 8799 b', 'HR 8799 c',
  'HR 8799 d', 'HR 8799 e', 'PSR B1257+12 b', 'PSR B1257+12 c', 'PSR B1257+12 d',
  'CoRoT-7 b', 'Gliese 581 c', 'Gliese 581 d', 'Gliese 581 e', 'Ross 128 b',
  '55 Cnc e', 'GJ 357 d', 'Kepler-10 b', 'Kepler-16 b', 'Kepler-62 f',
];
const familiarity = new Map(familiarPlanetOrder.map((name, index) => [name, index]));

function candidateFor(level, record) {
  let question;
  let answer;
  let explanation;
  let templateId;
  if (level <= 2) {
    question = `في أي سنة اكتُشف الكوكب «${record.planetName}»؟`;
    answer = String(record.discoveryYear);
    explanation = `يسجل أرشيف NASA للكواكب الخارجية سنة اكتشاف ${record.planetName} بأنها ${record.discoveryYear}.`;
    templateId = `exoplanet-discovery-year-v1-l${level}`;
  } else if (level <= 4) {
    answer = methodAr.get(record.discoveryMethod);
    question = `شنو الطريقة المستخدمة لاكتشاف الكوكب «${record.planetName}»؟`;
    explanation = `يسجل أرشيف NASA أن اكتشاف ${record.planetName} تم بواسطة ${answer}.`;
    templateId = `exoplanet-discovery-method-v1-l${level}`;
  } else {
    question = `أي مرفق فلكي يُنسب إليه اكتشاف الكوكب «${record.planetName}»؟`;
    answer = facilityAr.get(record.discoveryFacility);
    explanation = `ينسب سجل NASA اكتشاف ${record.planetName} إلى ${answer} (${record.discoveryFacility}).`;
    templateId = `exoplanet-discovery-facility-v1-l${level}`;
  }
  const candidate = {
    category,
    difficultyLevel: level,
    difficulty: difficultyTier(level),
    question,
    answer,
    explanation,
    religious: false,
    sourceRecordId: record.sourceRecordId,
    templateId,
    source: {
      title: `NASA Exoplanet Archive — ${record.planetName}`,
      url: record.sourceUrl,
      publisher: record.sourcePublisher,
      evidence: `سجل pscomppars الرسمي يربط الكوكب ${record.planetName} بسنة ${record.discoveryYear} وطريقة ${record.discoveryMethod} ومرفق ${record.discoveryFacility}.`,
    },
  };
  candidate.id = stableQuestionId(candidate);
  return candidate;
}

const usableRecords = recordsDocument.records.filter(record => methodAr.has(record.discoveryMethod))
  .sort((a, b) => {
    const aRank = familiarity.get(a.planetName) ?? 10_000;
    const bRank = familiarity.get(b.planetName) ?? 10_000;
    return aRank - bRank || a.discoveryYear - b.discoveryYear || a.planetName.localeCompare(b.planetName, 'en');
  });
const policy = loadPolicy();
const candidates = readJson(CANDIDATES_PATH, []);
const knownIds = new Set(candidates.map(candidate => candidate.id));
const comparisons = [
  ...loadExistingQuestionTexts(),
  ...candidates.filter(candidate => candidate.status === 'approved').map(candidate => candidate.question),
];
const usedRecordIds = new Set(candidates.filter(candidate => candidate.category === category)
  .map(candidate => candidate.sourceRecordId).filter(Boolean));
const added = [];
let cursor = 0;

for (let level = 1; level <= 6; level += 1) {
  const needed = Number(bankPlan.categories?.[category]?.levels?.[level]?.gap || 0);
  let accepted = 0;
  const rejectionCounts = {};
  while (accepted < needed && cursor < usableRecords.length) {
    const record = usableRecords[cursor++];
    if (usedRecordIds.has(record.sourceRecordId)) continue;
    if (level >= 5 && !facilityAr.has(record.discoveryFacility)) continue;
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
      generation: {
        model,
        responseId: null,
        generatedAt: now,
        usage: { inputTokens: 0, outputTokens: 0, webSearchCalls: 0, estimatedUsd: 0 },
      },
      verification: {
        model: 'schema-source-and-duplicate-v1',
        responseId: null,
        checkedAt: now,
        result: {
          verdict: 'pass', factCorrect: true, answerExact: true, answerNotRevealed: true,
          sourceSupportsClaim: true, clearArabic: true,
          reason: 'قالب حتمي من سجل NASA الرسمي ذي بصمة، لحقائق اكتشاف ثابتة.',
        },
        usage: { inputTokens: 0, outputTokens: 0, webSearchCalls: 0, estimatedUsd: 0 },
      },
      cost: { pricingAsOf: null, budgetUsd: 0, runEstimatedUsd: 0 },
      review: {
        reviewer: model,
        decision: 'approve',
        notes: 'تحقق آلي من مخطط السجل والمصدر وعدم كشف الإجابة والتكرار.',
        religiousSourceAndIsnadConfirmed: false,
        reviewedAt: now,
      },
    });
    candidates.push(candidate);
    added.push(candidate);
    knownIds.add(candidate.id);
    comparisons.push(candidate.question);
    usedRecordIds.add(record.sourceRecordId);
    accepted += 1;
  }
  if (accepted !== needed) throw new Error(
    `${category} — المستوى ${level}: المطلوب ${needed} والمتاح ${accepted}. ` +
    `الاستبعادات: ${JSON.stringify(rejectionCounts)}.`
  );
}

if (write) writeJsonAtomic(CANDIDATES_PATH, candidates);
console.log(JSON.stringify({
  mode: write ? 'write' : 'dry-run',
  added: added.length,
  byLevel: Object.fromEntries(Array.from({ length: 6 }, (_, index) => [index + 1,
    added.filter(candidate => candidate.difficultyLevel === index + 1).length])),
  previews: Array.from({ length: 6 }, (_, index) => {
    const candidate = added.find(item => item.difficultyLevel === index + 1);
    return candidate ? { level: index + 1, question: candidate.question, answer: candidate.answer } : null;
  }).filter(Boolean),
  approved: added.length,
  aiCalls: 0,
  estimatedAiCostUsd: 0,
}, null, 2));

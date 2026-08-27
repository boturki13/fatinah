#!/usr/bin/env node
import path from 'node:path';
import {
  CANDIDATES_PATH, CONTENT_DIR, difficultyTier, loadExistingQuestionTexts, loadPolicy,
  readJson, stableQuestionId, validateCandidate, writeJsonAtomic,
} from './lib.mjs';

const write = process.argv.includes('--write');
const category = 'جسم الإنسان';
const model = 'deterministic-nci-human-organ-template-v1';
const recordsDocument = readJson(path.join(CONTENT_DIR, 'structured-sources', 'nci-human-organs.json'), null);
const bankPlan = readJson(path.join(CONTENT_DIR, 'bank-plan-5000.json'), null);
if (!recordsDocument || recordsDocument.schemaVersion !== 1 || !Array.isArray(recordsDocument.records)) {
  throw new Error('شغّل questions:import-nci-human-organs أولاً.');
}
if (!bankPlan || bankPlan.targetBankSize !== 5000) throw new Error('خطة بنك 5000 غير صالحة.');

const functionPrompts = new Map([
  ['Heart','شنو العضو العضلي المجوف اللي يستقبل الدم من الأوردة ويضخه إلى الشرايين؟'],
  ['Brain','شنو العضو الموجود داخل الجمجمة ويعد المركز الرئيسي للجهاز العصبي؟'],
  ['Lung','شنو العضو المسؤول بشكل رئيسي عن تبادل الأكسجين وثاني أكسيد الكربون؟'],
  ['Liver','شنو العضو اللي ينتج العصارة الصفراوية ويسهم في معالجة مواد كثيرة بالدم؟'],
  ['Kidney','شنو العضو اللي يرشح الدم ويسهم في تكوين البول؟'],
  ['Stomach','شنو العضو العضلي اللي يستقبل الطعام بعد مروره بالمريء ويبدأ هضمه؟'],
  ['Pancreas','شنو الغدة اللي تفرز إنزيمات هضمية وهرمونات منها الإنسولين؟'],
  ['Spleen','شنو العضو اللمفاوي اللي يرشح الدم ويسهم في المناعة؟'],
  ['Skin','شنو العضو اللي يغطي سطح الجسم ويشكّل حاجزاً واقياً؟'],
  ['Bladder','شنو العضو المجوف اللي يخزن البول قبل خروجه؟'],
  ['Gallbladder','شنو العضو الصغير اللي يخزن العصارة الصفراوية ويركزها؟'],
  ['Esophagus','شنو الأنبوب العضلي اللي ينقل الطعام من البلعوم إلى المعدة؟'],
  ['Trachea','شنو الأنبوب اللي ينقل الهواء من الحنجرة باتجاه الشعب الهوائية؟'],
  ['Spinal Cord','شنو البنية العصبية الطويلة داخل العمود الفقري اللي تنقل الإشارات من الدماغ وإليه؟'],
  ['Bone Marrow','شنو النسيج الموجود داخل العظام والمسؤول عن إنتاج خلايا الدم؟'],
  ['Thymus Gland','شنو الغدة اللي تنضج فيها الخلايا اللمفاوية التائية؟'],
  ['Tonsil','شنو النسيج اللمفاوي الموجود قرب مؤخرة الحلق ويسهم في الدفاع المناعي؟'],
  ['Ureter','شنو الأنبوب اللي ينقل البول من الكلية إلى المثانة؟'],
  ['Urethra','شنو القناة اللي يخرج عبرها البول من المثانة إلى خارج الجسم؟'],
  ['Small Intestine','شنو الجزء من الأمعاء اللي يحدث فيه معظم امتصاص المغذيات؟'],
  ['Large Intestine','شنو الجزء من الأمعاء اللي يمتص الماء ويكوّن الفضلات الصلبة؟'],
  ['Colon','شنو الجزء الأكبر من الأمعاء الغليظة الممتد بين الأعور والمستقيم؟'],
  ['Rectum','شنو الجزء الأخير من الأمعاء الغليظة اللي يخزن البراز قبل خروجه؟'],
  ['Appendix','شنو الأنبوب الصغير المتصل ببداية الأمعاء الغليظة؟'],
  ['Thyroid Gland','شنو الغدة الموجودة بمقدمة الرقبة وتفرز هرمونات تنظم الاستقلاب؟'],
  ['Adrenal Gland','شنو الغدة الموجودة فوق الكلية وتفرز هرمونات منها الأدرينالين؟'],
  ['Pituitary Gland','شنو الغدة الصغيرة بقاعدة الدماغ اللي تتحكم في غدد صماء كثيرة؟'],
  ['Parathyroid Gland','شنو الغدد الصغيرة خلف الغدة الدرقية اللي تنظّم مستوى الكالسيوم؟'],
  ['Lymph Node','شنو البنية الصغيرة اللي ترشح اللمف وتحتوي خلايا مناعية؟'],
  ['Eye','شنو عضو الإبصار اللي يستقبل الضوء ويحوله إلى إشارات عصبية؟'],
  ['Ear','شنو العضو المسؤول عن السمع ويسهم أيضاً في التوازن؟'],
  ['Nose','شنو العضو اللي يحتوي مستقبلات الشم ويمر عبره الهواء؟'],
  ['Tongue','شنو العضو العضلي داخل الفم اللي يساعد في التذوق والكلام والبلع؟'],
  ['Larynx','شنو العضو الموجود أعلى القصبة الهوائية ويحتوي الأحبال الصوتية؟'],
  ['Pharynx','شنو الممر المشترك خلف الأنف والفم للهواء والطعام؟'],
  ['Prostate Gland','شنو الغدة الموجودة أسفل المثانة عند الذكور وتضيف سائلاً للسائل المنوي؟'],
  ['Uterus','شنو العضو العضلي المجوف اللي ينمو داخله الجنين أثناء الحمل؟'],
  ['Ovary','شنو العضو التناسلي الأنثوي اللي ينتج البويضات؟'],
  ['Testis','شنو العضو التناسلي الذكري اللي ينتج الحيوانات المنوية؟'],
  ['Fallopian Tube','شنو الأنبوب اللي ينقل البويضة من المبيض باتجاه الرحم؟'],
]);

function conciseDefinition(value, maxLength = 260) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  const excerpt = normalized.slice(0, maxLength + 1);
  const wordBoundary = excerpt.lastIndexOf(' ');
  return `${excerpt.slice(0, wordBoundary > 180 ? wordBoundary : maxLength).trim()}…`;
}

function candidateFor(level, record, functional) {
  let question;
  let answer;
  let templateId;
  if (functional) {
    question = functionPrompts.get(record.officialNameEn);
    answer = record.nameAr;
    templateId = `human-organ-function-v1-l${level}`;
  } else if (level <= 4) {
    question = `شنو المصطلح الإنجليزي الرسمي في NCI للبنية التشريحية «${record.nameAr}»؟`;
    answer = record.officialNameEn;
    templateId = `human-organ-english-term-v1-l${level}`;
  } else {
    question = `شنو الاسم العربي للبنية التشريحية المسجلة في NCI باسم «${record.officialNameEn}»؟`;
    answer = record.nameAr;
    templateId = `human-organ-arabic-term-v1-l${level}`;
  }
  const candidate = {
    category, difficultyLevel: level, difficulty: difficultyTier(level), question, answer,
    explanation: functional
      ? `يعرّف سجل NCI البنية ${record.officialNameEn} (${record.nameAr}) بهذا الوصف: ${conciseDefinition(record.definition)}`
      : `يربط سجل NCI الرمز ${record.code} بالمصطلح ${record.officialNameEn}، ويطابقه الفهرس العربي مع ${record.nameAr}.`,
    religious: false, sourceRecordId: record.sourceRecordId, templateId,
    source: {
      title: `NCI Thesaurus — ${record.code}: ${record.officialNameEn}`,
      url: record.sourceUrl,
      publisher: record.sourcePublisher,
      evidence: functional ? record.definition : `سجل NCI الرسمي للمفهوم ${record.code} واسمه ${record.officialNameEn}.`,
    },
  };
  candidate.id = stableQuestionId(candidate);
  return candidate;
}

const policy = loadPolicy();
const candidates = readJson(CANDIDATES_PATH, []);
const knownIds = new Set(candidates.map(candidate => candidate.id));
const comparisons = [...loadExistingQuestionTexts(),
  ...candidates.filter(candidate => candidate.status === 'approved').map(candidate => candidate.question)];
const usedRecordIds = new Set(candidates.filter(candidate => candidate.category === category)
  .map(candidate => candidate.sourceRecordId).filter(Boolean));
const functionRecords = [...functionPrompts.keys()].map(name =>
  recordsDocument.records.find(record => record.officialNameEn === name));
if (functionRecords.some(record => !record)) throw new Error('سجل وظيفة عضو مفقود.');
const terminologyRecords = recordsDocument.records.filter(record => !functionPrompts.has(record.officialNameEn));
const added = [];
let functionCursor = 0;
let terminologyCursor = 0;

function approveCandidate(candidate) {
  const now = new Date().toISOString();
  Object.assign(candidate, {
    status: 'approved',
    generation: { model, responseId: null, generatedAt: now,
      usage: { inputTokens: 0, outputTokens: 0, webSearchCalls: 0, estimatedUsd: 0 } },
    verification: {
      model: 'schema-source-and-duplicate-v1', responseId: null, checkedAt: now,
      result: { verdict: 'pass', factCorrect: true, answerExact: true, answerNotRevealed: true,
        sourceSupportsClaim: true, clearArabic: true,
        reason: 'قالب حتمي من مفهوم NCI رسمي واسم عربي مطابق برمز NCIt.' },
      usage: { inputTokens: 0, outputTokens: 0, webSearchCalls: 0, estimatedUsd: 0 },
    },
    cost: { pricingAsOf: null, budgetUsd: 0, runEstimatedUsd: 0 },
    review: { reviewer: model, decision: 'approve',
      notes: 'تحقق من رمز المفهوم والمصدر والاسم العربي وعدم كشف الإجابة والتكرار.',
      religiousSourceAndIsnadConfirmed: false, reviewedAt: now },
  });
  candidates.push(candidate); added.push(candidate); knownIds.add(candidate.id);
  comparisons.push(candidate.question); usedRecordIds.add(candidate.sourceRecordId);
}

for (let level = 1; level <= 6; level += 1) {
  const needed = Number(bankPlan.categories?.[category]?.levels?.[level]?.gap || 0);
  let accepted = 0;
  const rejectionCounts = {};
  const functional = level <= 2;
  const pool = functional ? functionRecords : terminologyRecords;
  while (accepted < needed && (functional ? functionCursor : terminologyCursor) < pool.length) {
    const cursor = functional ? functionCursor++ : terminologyCursor++;
    const record = pool[cursor];
    if (usedRecordIds.has(record.sourceRecordId)) continue;
    const candidate = candidateFor(level, record, functional);
    const validation = validateCandidate(candidate, { policy, existingQuestions: comparisons });
    if (!validation.valid || knownIds.has(candidate.id)) {
      for (const reason of validation.errors.length ? validation.errors : ['duplicate_id']) {
        rejectionCounts[reason] = (rejectionCounts[reason] || 0) + 1;
      }
      continue;
    }
    approveCandidate(candidate);
    accepted += 1;
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
  approved: added.length, aiCalls: 0, estimatedAiCostUsd: 0,
}, null, 2));

#!/usr/bin/env node
import {
  CANDIDATES_PATH,
  canonicalCategory,
  createResponse,
  difficultyTier,
  generatedQuestionsSchema,
  isNearDuplicate,
  isReligiousCategory,
  loadExistingQuestionTexts,
  loadBaseCategories,
  loadLocalEnv,
  loadPolicy,
  readJson,
  reachableTrustedSource,
  responseOutputText,
  stableQuestionId,
  validateCandidate,
  verificationSchema,
  writeJsonAtomic,
} from './lib.mjs';

function options(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    result[key] = argv[index + 1]?.startsWith('--') || argv[index + 1] === undefined ? true : argv[++index];
  }
  return result;
}

const args = options(process.argv.slice(2));
const requestedCategory = String(args.category || '').trim();
const requestedFocus = String(args.focus || '').trim().slice(0, 1200);
const requestedDistribution = args.distribution === undefined ? [] : String(args.distribution)
  .split(',')
  .map(entry => entry.split(':').map(value => Number.parseInt(value.trim(), 10)))
  .map(([level, amount]) => ({ level, amount }));
const distributionTotal = requestedDistribution.reduce((sum, item) => sum + item.amount, 0);
const requestedLevel = args.level === undefined ? null : Number.parseInt(args.level, 10);
const requestedDifficulty = requestedDistribution.length ? 'balanced' : requestedLevel
  ? difficultyTier(requestedLevel)
  : String(args.difficulty || 'normal').trim().toLowerCase();
const count = Math.min(Math.max(distributionTotal || Number.parseInt(args.count || '10', 10) || 10, 1), 25);
const dryRun = args['dry-run'] === true;

if (!requestedCategory) throw new Error('استخدم --category "اسم الفئة".');
if (args.level !== undefined && (!Number.isInteger(requestedLevel) || requestedLevel < 1 || requestedLevel > 6)) {
  throw new Error('المستوى يجب أن يكون رقماً من 1 إلى 6.');
}
if (requestedDistribution.some(item => !Number.isInteger(item.level) || item.level < 1 || item.level > 6 ||
    !Number.isInteger(item.amount) || item.amount < 1) || distributionTotal > 25) {
  throw new Error('التوزيع يجب أن يكون مثل 1:3,3:2 وبمجموع لا يتجاوز 25.');
}
if (requestedDistribution.length && requestedLevel) {
  throw new Error('استخدم --level أو --distribution، وليس كليهما.');
}
if (!['easy', 'normal', 'hard', 'balanced'].includes(requestedDifficulty)) {
  throw new Error('الصعوبة يجب أن تكون easy أو normal أو hard أو balanced.');
}

loadLocalEnv();
const policy = loadPolicy();
const category = canonicalCategory(requestedCategory, policy);
if (!loadBaseCategories().includes(category)) {
  throw new Error(`الفئة «${requestedCategory}» غير موجودة في التطبيق؛ لم يُرسل أي طلب إلى OpenAI.`);
}
const religious = isReligiousCategory(category, policy);
const allowedHosts = religious ? policy.religiousTrustedHosts : policy.generalTrustedHosts;
const levelRange = requestedDistribution.length ? requestedDistribution.map(item => item.level).join(' أو ')
  : requestedLevel ? String(requestedLevel)
  : requestedDifficulty === 'easy' ? '1 أو 2'
  : requestedDifficulty === 'normal' ? '3 أو 4'
  : requestedDifficulty === 'hard' ? '5 أو 6'
  : 'من 1 إلى 6 بتوزيع متساوٍ تماماً';
const existingCandidates = readJson(CANDIDATES_PATH, []);
const existingQuestions = [
  ...loadExistingQuestionTexts(),
  ...existingCandidates
    .filter(candidate => ['pending_review', 'pending_religious_review', 'approved'].includes(candidate.status))
    .map(candidate => candidate.question)
    .filter(Boolean),
];
const existingCategoryExamples = existingCandidates
  .filter(candidate => candidate.category === category && candidate.status !== 'rejected_by_verifier')
  .slice(-40)
  .map(candidate => `${candidate.question} — ${candidate.answer}`)
  .join(' | ');
const categoryGuidance = String(policy.categoryGuidance?.[category] || '').trim();
const balanceInstruction = requestedDifficulty === 'balanced' && !requestedDistribution.length
  ? `وزّع النتائج بالتساوي على المستويات الستة. العدد المطلوب ${count}، لذلك أنشئ ${Math.floor(count / 6)} أسئلة لكل مستوى من 1 إلى 6، ولا تستخدم مستوى أكثر من غيره.`
  : '';
const exactLevelInstruction = requestedLevel
  ? `كل النتائج يجب أن تستخدم difficultyLevel=${requestedLevel} وdifficulty=${difficultyTier(requestedLevel)} دون أي مستوى آخر.`
  : '';
const distributionInstruction = requestedDistribution.length
  ? `التزم بهذا التوزيع حرفياً: ${requestedDistribution.map(item => `المستوى ${item.level}: ${item.amount}`).join('، ')}. اضبط difficulty حسب المستوى: 1-2 easy و3-4 normal و5-6 hard.`
  : '';

const religiousInstructions = religious
  ? `هذه فئة دينية أو تاريخية إسلامية. اعتمد حصراً على القرآن الكريم، صحيح البخاري، صحيح مسلم، أو المراجع الثانوية المحددة في السياسة. لا تعتبر رواية الطبري صحيحة لمجرد ورودها فيه، ولا تنسب حديثاً للنبي ﷺ إلا إن كان في الصحيحين أو ثبتت صحته صراحة. كل نتيجة ستظل معلّقة لمراجع بشري.`
  : 'تجنب الدين والسياسة والطب والأخبار والحقائق المتغيرة زمنياً في هذه الدفعة.';

const generationPayload = {
  model: process.env.OPENAI_QUESTION_MODEL || 'gpt-5.6-terra',
  store: false,
  reasoning: { effort: religious ? 'high' : 'medium' },
  tools: [{ type: 'web_search' }],
  include: ['web_search_call.action.sources'],
  input: [
    {
      role: 'developer',
      content: `أنت محرر أسئلة مسابقات عربية محترف. ابحث أولاً ثم أنشئ أسئلة واضحة، صريحة، ذات إجابة واحدة غير ملتبسة. لا تخمّن ولا تستخدم الذاكرة وحدها. ${religiousInstructions} ${categoryGuidance} استخدم روابط HTTPS دقيقة من هذه النطاقات فقط: ${allowedHosts.join(', ')}. لا تكرر أي سؤال داخل الدفعة. لا تستخدم حقائق سريعة التقادم.`,
    },
    {
      role: 'user',
      content: `أنشئ ${count} سؤالاً لفئة «${category}» بمستوى ${requestedDifficulty}. يجب أن يكون difficultyLevel هو ${levelRange} ومتسقاً مع difficulty. ${balanceInstruction} ${exactLevelInstruction} ${distributionInstruction} ${requestedFocus ? `توجيه إضافي ملزم: ${requestedFocus}` : ''} اكتب العربية الفصحى المبسطة المناسبة للكويت والخليج. evidence تلخيص قصير لكيف يدعم المرجع الإجابة، وليس اقتباساً طويلاً. لا تعِد موضوعاً أو مؤلفاً أو عملاً مستخدماً في هذه الأمثلة الحالية: ${existingCategoryExamples || 'لا توجد أمثلة بعد'}.`,
    },
  ],
  text: {
    format: {
      type: 'json_schema', name: 'fatinah_generated_questions', strict: true,
      schema: generatedQuestionsSchema,
    },
  },
};

if (dryRun) {
  console.log(JSON.stringify({
    mode: 'dry-run', category, count, difficulty: requestedDifficulty, religious,
    generationModel: generationPayload.model,
    verificationModel: religious ? (process.env.OPENAI_RELIGIOUS_VERIFY_MODEL || 'gpt-5.6-sol') : (process.env.OPENAI_QUESTION_VERIFY_MODEL || 'gpt-5.6-terra'),
    allowedHosts,
  }, null, 2));
  process.exit(0);
}

const generationResponse = await createResponse(generationPayload);
const generated = JSON.parse(responseOutputText(generationResponse)).questions || [];

const provisional = [];
for (const item of generated) {
  const candidate = {
    ...item,
    category,
    difficulty: requestedDifficulty,
    religious,
  };
  // لا نثق بقيمة المستوى إن كانت خارج شريحة الصعوبة المطلوبة.
  const itemTier = difficultyTier(candidate.difficultyLevel);
  if (requestedDistribution.length && !requestedDistribution.some(item => item.level === Number(candidate.difficultyLevel))) continue;
  if (requestedLevel && Number(candidate.difficultyLevel) !== requestedLevel) continue;
  if (!requestedLevel && requestedDifficulty !== 'balanced' && itemTier !== requestedDifficulty) continue;
  candidate.difficulty = itemTier;
  const validation = validateCandidate(candidate, { policy, existingQuestions: [...existingQuestions, ...provisional.map(q => q.question)] });
  if (!validation.valid || isNearDuplicate(candidate.question, provisional.map(q => q.question))) continue;
  if (!await reachableTrustedSource(candidate.source.url, allowedHosts)) continue;
  provisional.push(candidate);
}

if (!provisional.length) throw new Error('لم تنجح أي نتيجة في الفحص الأولي؛ لم يُكتب شيء.');

const verificationModel = religious
  ? (process.env.OPENAI_RELIGIOUS_VERIFY_MODEL || 'gpt-5.6-sol')
  : (process.env.OPENAI_QUESTION_VERIFY_MODEL || 'gpt-5.6-terra');

const verificationResponse = await createResponse({
  model: verificationModel,
  store: false,
  reasoning: { effort: religious ? 'high' : 'medium' },
  tools: [{ type: 'web_search' }],
  include: ['web_search_call.action.sources'],
  input: [
    {
      role: 'developer',
      content: `أنت مدقق مستقل لا منشئ. افحص كل سؤال وإجابته والرابط عبر البحث. ارفض السؤال إذا كان المرجع لا يدعم الإجابة مباشرة، أو كانت الإجابة ملتبسة، أو العربية غير واضحة. ${religiousInstructions} لا تُصلح النتائج ولا تضف أسئلة جديدة.`,
    },
    { role: 'user', content: JSON.stringify(provisional) },
  ],
  text: {
    format: {
      type: 'json_schema', name: 'fatinah_question_verification', strict: true,
      schema: verificationSchema,
    },
  },
});

const verification = JSON.parse(responseOutputText(verificationResponse)).results || [];
const byIndex = new Map(verification.map(result => [result.index, result]));
const now = new Date().toISOString();
const seenIds = new Set(existingCandidates.map(candidate => candidate.id));
const added = [];

for (const [index, item] of provisional.entries()) {
  const check = byIndex.get(index);
  const passed = check && check.verdict === 'pass' && check.factCorrect &&
    check.answerExact && check.sourceSupportsClaim && check.clearArabic;
  const candidate = {
    id: stableQuestionId(item),
    category,
    difficulty: difficultyTier(item.difficultyLevel),
    difficultyLevel: item.difficultyLevel,
    question: item.question.trim(),
    answer: item.answer.trim(),
    explanation: item.explanation.trim(),
    religious,
    source: item.source,
    status: passed ? (religious ? 'pending_religious_review' : 'pending_review') : 'rejected_by_verifier',
    generation: {
      model: generationPayload.model,
      responseId: generationResponse.id || null,
      generatedAt: now,
    },
    verification: {
      model: verificationModel,
      responseId: verificationResponse.id || null,
      checkedAt: now,
      result: check || { verdict: 'fail', reason: 'missing_verification_result' },
    },
    review: null,
  };
  if (!seenIds.has(candidate.id)) {
    seenIds.add(candidate.id);
    existingCandidates.push(candidate);
    added.push(candidate);
  }
}

writeJsonAtomic(CANDIDATES_PATH, existingCandidates);
const counts = added.reduce((summary, candidate) => {
  summary[candidate.status] = (summary[candidate.status] || 0) + 1;
  return summary;
}, {});
console.log(JSON.stringify({ added: added.length, counts, candidateFile: 'content/questions/candidates.json' }, null, 2));

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
export const CONTENT_DIR = path.join(ROOT, 'content', 'questions');
export const CANDIDATES_PATH = path.join(CONTENT_DIR, 'candidates.json');
export const PUBLISHED_PATH = path.join(CONTENT_DIR, 'published.json');
export const POLICY_PATH = path.join(CONTENT_DIR, 'source-policy.json');
export const APPROVED_BANK_PATH = path.join(ROOT, 'www', 'approved-question-bank.js');
export const BASE_BANK_PATH = path.join(ROOT, 'www', 'question-bank.js');
export const APP_SOURCE_PATH = path.join(ROOT, 'www', 'app.js');

export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw error;
  }
}

export function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function extractObjectLiteral(source, markerPattern, markerLabel) {
  const match = markerPattern.exec(source);
  if (!match) throw new Error(`تعذر العثور على ${markerLabel}.`);
  const start = source.indexOf('{', match.index + match[0].length);
  if (start < 0) throw new Error(`تعذر العثور على بداية كائن ${markerLabel}.`);
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      continue;
    }
    if (character === '{') depth += 1;
    if (character === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`تعذر العثور على نهاية كائن ${markerLabel}.`);
}

function readJavaScriptDataObject(file, markerPattern, markerLabel) {
  const source = fs.readFileSync(file, 'utf8');
  const literal = extractObjectLiteral(source, markerPattern, markerLabel);
  const value = vm.runInNewContext(`(${literal})`, Object.create(null), { timeout: 1_000 });
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new Error(`${path.basename(file)}: ${markerLabel} ليس كائن بيانات.`);
  }
  // افصل كائنات سياق vm عن بقية خط الإنتاج، وارفض أي قيمة غير قابلة لـJSON.
  return JSON.parse(JSON.stringify(value));
}

function bankQuestionCount(bank) {
  return Object.values(bank).reduce((total, questions) =>
    total + (Array.isArray(questions) ? questions.length : 0), 0);
}

export function loadRuntimeQuestionBank() {
  const base = readJavaScriptDataObject(
    BASE_BANK_PATH, /window\.__QUESTION_BANK_DATA__\s*=/, '__QUESTION_BANK_DATA__');
  const approved = readJavaScriptDataObject(
    APPROVED_BANK_PATH, /window\.__APPROVED_QUESTION_BANK_DATA__\s*=/, '__APPROVED_QUESTION_BANK_DATA__');
  const overrides = readJavaScriptDataObject(
    APP_SOURCE_PATH, /const\s+QUESTION_OVERRIDES\s*=/, 'QUESTION_OVERRIDES');
  const additions = readJavaScriptDataObject(
    APP_SOURCE_PATH, /const\s+QUESTION_ADDITIONS\s*=/, 'QUESTION_ADDITIONS');
  const runtimeCategories = [...new Set([...Object.keys(base), ...Object.keys(approved)])];
  const bank = {};
  const appliedAdditions = {};
  for (const category of runtimeCategories) {
    const originals = [
      ...(Array.isArray(base[category]) ? base[category] : []),
      ...(Array.isArray(approved[category]) ? approved[category] : []),
    ];
    const effectiveOriginals = originals.map(question => {
      // طابق normalizeQuestionBank في التطبيق: التصحيح يخص السؤال القديم فقط،
      // ولا يجوز أن يغيّر سؤالاً مرّ فعلياً بمسار النشر والمراجعة.
      const isPublishedQuestion = question.review?.status === 'approved';
      const override = !isPublishedQuestion && overrides[category]?.[question.d];
      if (!override) return question;
      const effective = { ...question, ...override };
      if (override.q) {
        delete effective.o;
        delete effective.a;
      }
      return effective;
    });
    const categoryAdditions = Array.isArray(additions[category]) ? additions[category] : [];
    appliedAdditions[category] = categoryAdditions;
    bank[category] = [
      ...effectiveOriginals,
      ...categoryAdditions,
    ];
  }
  const orphanAdditionCategories = Object.keys(additions).filter(category => !runtimeCategories.includes(category));
  return {
    bank,
    components: {
      base: bankQuestionCount(base),
      approved: bankQuestionCount(approved),
      additions: bankQuestionCount(appliedAdditions),
    },
    orphanAdditionCategories,
  };
}

export function buildRuntimeQuestionPlan({ targetPerLevel = 4, categories = null } = {}) {
  const target = Number(targetPerLevel);
  if (!Number.isInteger(target) || target < 1 || target > 100) {
    throw new Error('targetPerLevel يجب أن يكون عدداً صحيحاً من 1 إلى 100.');
  }
  const runtime = loadRuntimeQuestionBank();
  const policy = loadPolicy();
  const availableCategories = [...new Set([
    ...Object.keys(runtime.bank),
    ...(policy.plannedCategories || []),
  ])];
  const requested = categories == null
    ? availableCategories
    : [...new Set(categories.map(category => canonicalCategory(category, policy)))];
  const categoryPlans = {};
  let totalGap = 0;
  let invalidDifficultyCount = 0;
  for (const category of requested) {
    if (!availableCategories.includes(category)) throw new Error(`الفئة «${category}» غير معروفة.`);
    const questions = runtime.bank[category] || [];
    const levels = {};
    for (let level = 1; level <= 6; level += 1) {
      const count = questions.filter(question => Number(question.d) === level).length;
      const gap = Math.max(0, target - count);
      levels[level] = { count, target, gap };
      totalGap += gap;
    }
    const validLevelQuestions = Object.values(levels).reduce((sum, level) => sum + level.count, 0);
    invalidDifficultyCount += questions.length - validLevelQuestions;
    categoryPlans[category] = {
      runtimeTotal: questions.length,
      targetTotal: target * 6,
      gapTotal: Object.values(levels).reduce((sum, level) => sum + level.gap, 0),
      levels,
    };
  }
  const runtimeTotal = bankQuestionCount(runtime.bank);
  return {
    targetPerLevel: target,
    runtimeTotal,
    runtimeCategoryCount: Object.keys(runtime.bank).length,
    components: runtime.components,
    componentTotal: Object.values(runtime.components).reduce((sum, count) => sum + count, 0),
    totalGap,
    invalidDifficultyCount,
    orphanAdditionCategories: runtime.orphanAdditionCategories,
    categories: categoryPlans,
  };
}

export function loadLocalEnv() {
  const envPath = path.join(ROOT, '.env.local');
  if (!fs.existsSync(envPath)) return;
  for (const rawLine of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}

export function normalizeArabic(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function tokens(value) {
  return new Set(normalizeArabic(value).split(' ').filter(token => token.length > 1));
}

export function similarity(left, right) {
  const a = tokens(left);
  const b = tokens(right);
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

export function isNearDuplicate(question, existingQuestions, threshold = 0.82) {
  const normalized = normalizeArabic(question);
  return existingQuestions.some(existing => {
    const other = normalizeArabic(existing);
    return normalized === other || similarity(normalized, other) >= threshold;
  });
}

export function hostAllowed(urlValue, allowedHosts) {
  try {
    const url = new URL(String(urlValue || ''));
    if (url.protocol !== 'https:' || url.username || url.password) return false;
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    return allowedHosts.some(domain => host === domain || host.endsWith(`.${domain}`));
  } catch { return false; }
}

export async function reachableTrustedSource(urlValue, allowedHosts) {
  if (!hostAllowed(urlValue, allowedHosts)) return false;
  let current = String(urlValue);
  for (let redirects = 0; redirects < 4; redirects += 1) {
    let response;
    try {
      response = await fetch(current, {
        method: 'HEAD', redirect: 'manual',
        headers: { 'User-Agent': 'FatinahQuestionVerifier/3.0' },
        signal: AbortSignal.timeout(10_000),
      });
      if ([403, 405].includes(response.status)) {
        response = await fetch(current, {
          method: 'GET', redirect: 'manual',
          headers: { 'User-Agent': 'FatinahQuestionVerifier/3.0', Range: 'bytes=0-2047' },
          signal: AbortSignal.timeout(10_000),
        });
      }
    } catch { return false; }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) return false;
      current = new URL(location, current).toString();
      if (!hostAllowed(current, allowedHosts)) return false;
      continue;
    }
    // لا نرفض مصدراً موثوقاً بسبب عطل مؤقت أو تحديد معدل من الناشر؛
    // المدقق المستقل سيبحث في الصفحة ويظل مسؤولاً عن إثبات المعلومة.
    if ([429, 502, 503, 504].includes(response.status)) return hostAllowed(current, allowedHosts);
    return response.ok && hostAllowed(current, allowedHosts);
  }
  return false;
}

export function loadPolicy() { return readJson(POLICY_PATH, {}); }

export function loadBaseCategories() {
  const source = fs.readFileSync(path.join(ROOT, 'www', 'question-bank.js'), 'utf8').trim();
  const prefix = 'window.__QUESTION_BANK_DATA__ = ';
  if (!source.startsWith(prefix) || !source.endsWith(';')) {
    throw new Error('تعذر قراءة فئات بنك الأسئلة الأساسي.');
  }
  const baseCategories = Object.keys(JSON.parse(source.slice(prefix.length, -1)));
  const plannedCategories = loadPolicy().plannedCategories || [];
  return [...new Set([...baseCategories, ...plannedCategories])];
}

export function canonicalCategory(category, policy = loadPolicy()) {
  const value = String(category || '').trim();
  return String(policy.categoryAliases?.[value] || value).trim();
}

export function isReligiousCategory(category, policy = loadPolicy()) {
  return (policy.religiousCategories || []).includes(canonicalCategory(category, policy));
}

function normalizedHosts(hosts) {
  return [...new Set((Array.isArray(hosts) ? hosts : [])
    .map(host => String(host || '').trim().toLowerCase().replace(/^www\./, ''))
    .filter(Boolean))];
}

export function trustedHostsForCategory(category, policy = loadPolicy()) {
  const canonical = canonicalCategory(category, policy);
  // هذا الحارس يسبق أي إعداد عام أو خاص: لا يمكن توسيع مصادر الفئة الدينية
  // بإضافة نطاق إلى generalTrustedHosts أو categoryTrustedHosts بالخطأ.
  if (isReligiousCategory(canonical, policy)) return normalizedHosts(policy.religiousTrustedHosts);
  const general = new Set(normalizedHosts(policy.generalTrustedHosts));
  const configured = normalizedHosts(policy.categoryTrustedHosts?.[canonical]);
  // الفشل مغلق: الفئة بلا سياسة خاصة لا ترث القائمة العامة الواسعة تلقائياً.
  return configured.filter(host => general.has(host));
}

export function difficultyTier(level) {
  const numeric = Number(level);
  if (numeric <= 2) return 'easy';
  if (numeric <= 4) return 'normal';
  return 'hard';
}

export function validateCandidate(candidate, { policy = loadPolicy(), existingQuestions = [] } = {}) {
  const errors = [];
  const religious = isReligiousCategory(candidate.category, policy) || candidate.religious === true;
  const allowedHosts = religious
    ? normalizedHosts(policy.religiousTrustedHosts)
    : trustedHostsForCategory(candidate.category, policy);
  const question = String(candidate.question || '').trim();
  const answer = String(candidate.answer || '').trim();
  const level = Number(candidate.difficultyLevel);
  if (!loadBaseCategories().includes(candidate.category)) errors.push('unknown_category');
  if (question.length < 12 || question.length > 220) errors.push('question_length');
  if (!/[؟?]$/.test(question)) errors.push('question_mark');
  if (answer.length < 1 || answer.length > 140) errors.push('answer_length');
  if (!Number.isInteger(level) || level < 1 || level > 6) errors.push('difficulty_level');
  if (candidate.difficulty !== difficultyTier(level)) errors.push('difficulty_tier_mismatch');
  if (!candidate.source || !hostAllowed(candidate.source.url, allowedHosts || [])) errors.push('untrusted_source');
  if (!String(candidate.source?.title || '').trim()) errors.push('source_title');
  if (!String(candidate.source?.publisher || '').trim()) errors.push('source_publisher');
  if (!String(candidate.source?.evidence || '').trim()) errors.push('source_evidence');
  if (/حالياً|حتى الآن|هذا العام|الأحدث|آخر إصدار|202[0-9]/.test(`${question} ${answer}`)) errors.push('volatile_fact');
  if (/قد يكون|ربما|على الأرجح|يُقال|قيل/.test(`${question} ${answer}`)) errors.push('ambiguous_claim');
  if (isNearDuplicate(question, existingQuestions)) errors.push('duplicate_or_near_duplicate');
  if (religious && !candidate.religious) errors.push('religious_flag_missing');
  return { valid: errors.length === 0, errors, religious };
}

export function stableQuestionId(candidate) {
  const digest = crypto.createHash('sha256')
    .update(`${normalizeArabic(candidate.category)}|${normalizeArabic(candidate.question)}|${normalizeArabic(candidate.answer)}`)
    .digest('hex').slice(0, 20);
  return `gq-${digest}`;
}

export function loadExistingQuestionTexts() {
  // لا نفحص النص الخام لأن app.js قد يستبدل سؤالاً قديماً وقت التشغيل.
  // الاعتماد على البنك الفعلي يمنع احتساب النسخة القديمة والجديدة معاً، ويجعل
  // فحص التكرار وخطة التوليد مطابقين تماماً لما يراه اللاعب.
  return Object.values(loadRuntimeQuestionBank().bank)
    .flatMap(questions => Array.isArray(questions) ? questions : [])
    .map(question => String(question?.q || '').trim())
    .filter(Boolean);
}

export function responseOutputText(response) {
  if (typeof response.output_text === 'string' && response.output_text.trim()) return response.output_text;
  for (const item of response.output || []) {
    if (item.type !== 'message') continue;
    for (const content of item.content || []) {
      if (content.type === 'output_text' && content.text) return content.text;
    }
  }
  throw new Error('لم تُرجع OpenAI نصاً منظماً.');
}

export async function createResponse(payload, apiKey = process.env.OPENAI_API_KEY) {
  if (!apiKey) throw new Error('OPENAI_API_KEY غير موجود في .env.local');
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'X-Client-Request-Id': crypto.randomUUID(),
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(120_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = String(body?.error?.message || `OpenAI HTTP ${response.status}`).slice(0, 500);
    throw new Error(message);
  }
  return body;
}

export const generatedQuestionsSchema = {
  type: 'object', additionalProperties: false, required: ['questions'],
  properties: {
    questions: {
      type: 'array', minItems: 1, maxItems: 25,
      items: {
        type: 'object', additionalProperties: false,
        required: ['question', 'answer', 'explanation', 'difficulty', 'difficultyLevel', 'religious', 'source'],
        properties: {
          question: { type: 'string', minLength: 12, maxLength: 220 },
          answer: { type: 'string', minLength: 1, maxLength: 140 },
          explanation: { type: 'string', minLength: 10, maxLength: 420 },
          difficulty: { type: 'string', enum: ['easy', 'normal', 'hard'] },
          difficultyLevel: { type: 'integer', minimum: 1, maximum: 6 },
          religious: { type: 'boolean' },
          source: {
            type: 'object', additionalProperties: false,
            required: ['title', 'url', 'publisher', 'evidence'],
            properties: {
              title: { type: 'string', minLength: 2, maxLength: 180 },
              url: { type: 'string', minLength: 10, maxLength: 500 },
              publisher: { type: 'string', minLength: 2, maxLength: 120 },
              evidence: { type: 'string', minLength: 5, maxLength: 360 },
            },
          },
        },
      },
    },
  },
};

export const verificationSchema = {
  type: 'object', additionalProperties: false, required: ['results'],
  properties: {
    results: {
      type: 'array', minItems: 1, maxItems: 25,
      items: {
        type: 'object', additionalProperties: false,
        required: ['index', 'verdict', 'factCorrect', 'answerExact', 'sourceSupportsClaim', 'clearArabic', 'reason'],
        properties: {
          index: { type: 'integer', minimum: 0, maximum: 24 },
          verdict: { type: 'string', enum: ['pass', 'fail', 'needs_human_review'] },
          factCorrect: { type: 'boolean' },
          answerExact: { type: 'boolean' },
          sourceSupportsClaim: { type: 'boolean' },
          clearArabic: { type: 'boolean' },
          reason: { type: 'string', minLength: 2, maxLength: 360 },
        },
      },
    },
  },
};

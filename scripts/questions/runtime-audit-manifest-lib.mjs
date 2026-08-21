import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(SCRIPT_DIR, '../..');
export const MANIFEST_PATH = path.join(ROOT, 'content', 'questions', 'runtime-audit-manifest.json');

const BASE_BANK_PATH = path.join(ROOT, 'www', 'question-bank.js');
const APPROVED_BANK_PATH = path.join(ROOT, 'www', 'approved-question-bank.js');
const APP_PATH = path.join(ROOT, 'www', 'app.js');
const PUBLISHED_PATH = path.join(ROOT, 'content', 'questions', 'published.json');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function scanBalanced(source, start, openCharacter, closeCharacter, label) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (character === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      continue;
    }
    if (character === openCharacter) depth += 1;
    if (character === closeCharacter) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error(`تعذر العثور على نهاية ${label}.`);
}

function extractObject(source, marker, label) {
  const match = marker.exec(source);
  if (!match) throw new Error(`تعذر العثور على ${label}.`);
  const start = source.indexOf('{', match.index + match[0].length);
  if (start < 0) throw new Error(`تعذر العثور على بداية ${label}.`);
  const end = scanBalanced(source, start, '{', '}', label);
  const value = vm.runInNewContext(`(${source.slice(start, end + 1)})`, Object.create(null), {
    timeout: 1_000,
  });
  return JSON.parse(JSON.stringify(value));
}

function extractFunction(source, name) {
  const marker = new RegExp(`function\\s+${name}\\s*\\(`).exec(source);
  if (!marker) throw new Error(`تعذر العثور على الدالة ${name}.`);
  const start = marker.index;
  const bodyStart = source.indexOf('{', marker.index + marker[0].length);
  if (bodyStart < 0) throw new Error(`تعذر العثور على جسم الدالة ${name}.`);
  const end = scanBalanced(source, bodyStart, '{', '}', `الدالة ${name}`);
  return source.slice(start, end + 1);
}

function javascriptData(file, marker, label) {
  return extractObject(fs.readFileSync(file, 'utf8'), marker, label);
}

function sameCitation(left, right) {
  return String(left?.title || '') === String(right?.title || '')
    && String(left?.url || '') === String(right?.url || '')
    && String(left?.publisher || '') === String(right?.publisher || '');
}

function publishedRecordMatchesRuntime(record, runtime, category) {
  return record?.status === 'approved'
    && record.id === runtime.id
    && record.category === category
    && Number(record.difficultyLevel) === Number(runtime.d)
    && record.question === runtime.q
    && record.answer === runtime.answer
    && sameCitation(record.source, runtime.source);
}

function resolveSourceProvenance({ component, raw, override, fallback, effective }) {
  if (!effective?.url) return 'missing';
  if (override?.source && sameCitation(override.source, effective)) return 'question_override';
  if (raw?.source && sameCitation(raw.source, effective)) {
    return component === 'published' ? 'published_record' : 'embedded_question';
  }
  if (fallback && sameCitation(fallback, effective)) return 'category_fallback';
  return 'unknown_derived';
}

function runtimeBankFromApp({ base, approved, additions, overrides, fallbacks, appSource }) {
  const combined = {};
  const categories = [...new Set([...Object.keys(base), ...Object.keys(approved)])];
  for (const category of categories) {
    combined[category] = [
      ...(Array.isArray(base[category]) ? base[category] : []),
      ...(Array.isArray(approved[category]) ? approved[category] : []),
    ];
  }
  const context = {
    QUESTION_ADDITIONS: additions,
    QUESTION_OVERRIDES: overrides,
    QUESTION_SOURCE_BY_CATEGORY: fallbacks,
    combined,
    result: null,
  };
  const hashQuestion = extractFunction(appSource, 'hashQuestion');
  const normalizeQuestionBank = extractFunction(appSource, 'normalizeQuestionBank');
  vm.runInNewContext(
    `${hashQuestion}\n${normalizeQuestionBank}\nresult = normalizeQuestionBank(combined);`,
    context,
    { timeout: 2_000 },
  );
  return JSON.parse(JSON.stringify(context.result));
}

function canonicalFingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function buildRuntimeAuditManifest() {
  const appSource = fs.readFileSync(APP_PATH, 'utf8');
  const base = javascriptData(
    BASE_BANK_PATH,
    /window\.__QUESTION_BANK_DATA__\s*=/,
    '__QUESTION_BANK_DATA__',
  );
  const approved = javascriptData(
    APPROVED_BANK_PATH,
    /window\.__APPROVED_QUESTION_BANK_DATA__\s*=/,
    '__APPROVED_QUESTION_BANK_DATA__',
  );
  const additions = extractObject(appSource, /const\s+QUESTION_ADDITIONS\s*=/, 'QUESTION_ADDITIONS');
  const overrides = extractObject(appSource, /const\s+QUESTION_OVERRIDES\s*=/, 'QUESTION_OVERRIDES');
  const fallbacks = extractObject(
    appSource,
    /const\s+QUESTION_SOURCE_BY_CATEGORY\s*=/,
    'QUESTION_SOURCE_BY_CATEGORY',
  );
  const published = readJson(PUBLISHED_PATH);
  const publishedById = new Map();
  const duplicatePublishedIds = [];
  for (const record of published) {
    if (publishedById.has(record.id)) duplicatePublishedIds.push(record.id);
    publishedById.set(record.id, record);
  }

  const runtime = runtimeBankFromApp({ base, approved, additions, overrides, fallbacks, appSource });
  const runtimeCategories = [...new Set([...Object.keys(base), ...Object.keys(approved)])];
  const questions = [];
  const publishedRuntimeIds = new Set();

  for (const category of runtimeCategories) {
    const baseRows = Array.isArray(base[category]) ? base[category] : [];
    const publishedRows = Array.isArray(approved[category]) ? approved[category] : [];
    const additionRows = Array.isArray(additions[category]) ? additions[category] : [];
    const origins = [
      ...baseRows.map((raw, sourceIndex) => ({ component: 'base', sourceIndex, raw })),
      ...publishedRows.map((raw, sourceIndex) => ({ component: 'published', sourceIndex, raw })),
      ...additionRows.map((raw, sourceIndex) => ({ component: 'addition', sourceIndex, raw })),
    ];
    const runtimeRows = Array.isArray(runtime[category]) ? runtime[category] : [];
    if (runtimeRows.length !== origins.length) {
      throw new Error(`${category}: عدد سجلات التشغيل لا يطابق مصادرها (${runtimeRows.length}/${origins.length}).`);
    }

    for (let runtimeIndex = 0; runtimeIndex < runtimeRows.length; runtimeIndex += 1) {
      const runtimeQuestion = runtimeRows[runtimeIndex];
      const origin = origins[runtimeIndex];
      const originalCount = baseRows.length + publishedRows.length;
      const override = runtimeIndex < originalCount ? overrides[category]?.[origin.raw.d] : null;
      const fallback = fallbacks[category] || null;
      const sourceProvenance = resolveSourceProvenance({
        component: origin.component,
        raw: origin.raw,
        override,
        fallback,
        effective: runtimeQuestion.source,
      });
      const publishedRecord = publishedById.get(runtimeQuestion.id);
      const exactPublishedMatch = origin.component === 'published'
        && publishedRecordMatchesRuntime(publishedRecord, runtimeQuestion, category);
      const reviewStatus = exactPublishedMatch ? 'approved' : 'legacy_pending';
      if (exactPublishedMatch) publishedRuntimeIds.add(runtimeQuestion.id);
      const runtimeClaimsApproval = runtimeQuestion.review?.status === 'approved';
      const sourceFile = origin.component === 'base'
        ? 'www/question-bank.js'
        : origin.component === 'published'
          ? 'www/approved-question-bank.js'
          : 'www/app.js#QUESTION_ADDITIONS';

      questions.push({
        auditId: `${origin.component}:${category}:${origin.sourceIndex}`,
        runtimeId: String(runtimeQuestion.id || ''),
        previousIds: Array.isArray(runtimeQuestion.previousIds) ? runtimeQuestion.previousIds : [],
        category,
        difficultyLevel: Number(runtimeQuestion.d),
        question: String(runtimeQuestion.q || ''),
        answer: runtimeQuestion.answer == null ? null : String(runtimeQuestion.answer),
        choices: Array.isArray(runtimeQuestion.o) ? runtimeQuestion.o : null,
        correctChoiceIndex: Number.isInteger(runtimeQuestion.a) ? runtimeQuestion.a : null,
        origin: {
          component: origin.component,
          file: sourceFile,
          sourceIndex: origin.sourceIndex,
          runtimeIndex,
        },
        citation: {
          original: origin.raw.source || null,
          effective: runtimeQuestion.source || null,
          provenance: sourceProvenance,
          claimSpecific: ['published_record', 'embedded_question', 'question_override'].includes(sourceProvenance),
        },
        review: exactPublishedMatch
          ? {
              status: 'approved',
              basis: 'exact_published_record_match',
              publishedRecordId: publishedRecord.id,
              reviewer: publishedRecord.review?.reviewer || null,
              reviewedAt: publishedRecord.review?.reviewedAt || null,
            }
          : {
              status: 'legacy_pending',
              basis: origin.component === 'published'
                ? 'published_runtime_record_mismatch'
                : 'not_individually_published',
              publishedRecordId: publishedRecord?.id || null,
              reviewer: null,
              reviewedAt: null,
            },
        runtimeReviewClaim: runtimeQuestion.review || null,
        flags: {
          pending: reviewStatus === 'legacy_pending',
          runtimeClaimsUnpublishedApproval: reviewStatus !== 'approved' && runtimeClaimsApproval,
          autoApprovalDetected: reviewStatus !== 'approved'
            && origin.raw.review?.status !== 'approved'
            && runtimeClaimsApproval,
          categoryFallbackSource: sourceProvenance === 'category_fallback',
          missingOrUnknownSource: ['missing', 'unknown_derived'].includes(sourceProvenance),
          publishedContentMismatch: origin.component === 'published' && !exactPublishedMatch,
        },
      });
    }
  }

  const counts = {
    runtime: questions.length,
    approved: questions.filter(item => item.review.status === 'approved').length,
    legacyPending: questions.filter(item => item.flags.pending).length,
    runtimeClaimsUnpublishedApproval: questions.filter(item => item.flags.runtimeClaimsUnpublishedApproval).length,
    autoApprovalDetected: questions.filter(item => item.flags.autoApprovalDetected).length,
    categoryFallbackSource: questions.filter(item => item.flags.categoryFallbackSource).length,
    missingOrUnknownSource: questions.filter(item => item.flags.missingOrUnknownSource).length,
    publishedContentMismatch: questions.filter(item => item.flags.publishedContentMismatch).length,
    publishedRecordsMissingFromRuntime: published.filter(record => !publishedRuntimeIds.has(record.id)).length,
    duplicatePublishedIds: duplicatePublishedIds.length,
  };
  const components = Object.fromEntries(['base', 'published', 'addition'].map(component => [
    component,
    questions.filter(item => item.origin.component === component).length,
  ]));
  const orphanAdditionCategories = Object.keys(additions).filter(category => !runtimeCategories.includes(category));
  const manifest = {
    schemaVersion: 1,
    policy: {
      approvedDefinition: 'Only a runtime question that exactly matches an approved record in content/questions/published.json.',
      legacyDefinition: 'Every other base or addition question remains legacy_pending until individual claim/source review and publication.',
      categoryFallbackPolicy: 'A category-level URL is discovery context only and is not claim-specific evidence.',
    },
    inputs: {
      base: 'www/question-bank.js',
      publishedRuntime: 'www/approved-question-bank.js',
      additionsAndNormalization: 'www/app.js',
      publicationLedger: 'content/questions/published.json',
    },
    components,
    counts,
    orphanAdditionCategories,
    questions,
  };
  manifest.runtimeFingerprintSha256 = canonicalFingerprint({
    components,
    counts,
    orphanAdditionCategories,
    questions,
  });
  return manifest;
}

export function writeManifestAtomic(manifest, file = MANIFEST_PATH) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
  fs.renameSync(temporary, file);
}

export function compareManifest(checkedIn, actual) {
  const checkedFingerprint = String(checkedIn?.runtimeFingerprintSha256 || '');
  const actualFingerprint = String(actual?.runtimeFingerprintSha256 || '');
  return {
    matches: checkedIn?.schemaVersion === actual.schemaVersion
      && checkedFingerprint.length === 64
      && checkedFingerprint === actualFingerprint
      && JSON.stringify(checkedIn) === JSON.stringify(actual),
    checkedFingerprint,
    actualFingerprint,
  };
}

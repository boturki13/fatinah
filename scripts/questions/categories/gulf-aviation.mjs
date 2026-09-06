#!/usr/bin/env node

/**
 * Offline deterministic builder for Kuwait, GCC places, Gulf plays, and airports.
 *
 * Normal builds perform no network access. Refreshing the checked-in snapshot is
 * intentionally isolated in content/questions/structured-sources/
 * gulf-aviation-import.mjs.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertNoSimilarOptions,
  finalizeCategory,
  makeOptions,
  normalizeArabic,
  sha256,
} from './common.mjs';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const SOURCE_ARTIFACT = 'content/questions/structured-sources/gulf-aviation.json';
const SOURCE_FILE = path.join(ROOT, SOURCE_ARTIFACT);
const ARCHIVE_BANK_ARTIFACTS = Object.freeze([
  ...fs.readdirSync(path.join(ROOT, 'server-assets/question-bank/archive'))
    .filter(file => /-bank\.json$/u.test(file))
    .sort()
    .map(file => `server-assets/question-bank/archive/${file}`),
  'server-assets/question-bank/archive/gulf-pre-release-baseline-v3-next-f4c15f7a680882df-0726a0986da63b32-2070.json',
]);

export const SOURCE_PATHS = Object.freeze([SOURCE_ARTIFACT]);
export const GULF_AVIATION_CATEGORIES = Object.freeze([
  'الكويت',
  'دول الخليج',
  'مسرحيات خليجية',
  'طيران ومطارات',
]);

const COLLECTIONS = Object.freeze({
  'الكويت': 'kuwait',
  'دول الخليج': 'gulf',
  'مسرحيات خليجية': 'plays',
  'طيران ومطارات': 'airports',
});

const GCC_COUNTRIES = Object.freeze([
  'الكويت',
  'المملكة العربية السعودية',
  'الإمارات العربية المتحدة',
  'قطر',
  'البحرين',
  'سلطنة عمان',
]);

const KUWAIT_GOVERNORATES = Object.freeze([
  'محافظة العاصمة',
  'محافظة حولي',
  'محافظة الأحمدي',
  'محافظة الفروانية',
  'محافظة الجهراء',
  'محافظة مبارك الكبير',
]);

const BANNED = /(?:إسرائيل|اسرائيل|إسرائيلي|اسرائيلي|Israel|Israeli|Tel Aviv|تل أبيب|تل ابيب|إباحي|اباحي|إباحية|اباحية|جنسية مثلية|عارٍ|عارية)/iu;
const LETTER_ORDER = /(?:رتّ?ب|ترتيب الحروف|حروف مبعثرة|بعثرة)/iu;
const MUTABLE_TRIVIA = /(?:حالي(?:ًا|ا)?|الآن|الأحدث|آخر إحصاء|عدد السكان|الرئيس الحالي|المدير الحالي)/iu;
const AIRPORT_DIFFICULTY_METRIC = 'editorial_gulf_global_airport_familiarity_v1';
const EASY_GULF_AIRPORT_CODES = Object.freeze([
  'KWI', 'DXB', 'DOH', 'AUH', 'MCT', 'RUH', 'DMM', 'MED', 'DWC', 'SLL', 'AAN', 'AHB', 'TIF',
]);

let cachedSource = null;
function readSource() {
  if (!cachedSource) cachedSource = JSON.parse(fs.readFileSync(SOURCE_FILE, 'utf8'));
  return cachedSource;
}

function sourcePayloadHash(record) {
  return sha256(JSON.stringify({
    sourceRecordId: record.sourceRecordId,
    category: record.category,
    subject: record.subject,
    predicate: record.predicate,
    object: record.object,
    evidence: record.evidence,
  }));
}

function factKey(record) {
  return `gulf-aviation:${record.sourceRecordId}:${record.predicate.id}`;
}

function claimFor(record) {
  return {
    subject: record.subject.label,
    predicate: record.predicate.id,
    object: record.object.label,
  };
}

function verificationFields(record) {
  return {
    sourceRecordId: record.sourceRecordId,
    subject: record.subject,
    predicate: record.predicate,
    object: record.object,
    difficultyBand: record.difficultyBand,
    difficultyMetric: record.difficultyMetric,
    difficultyValue: record.difficultyValue,
    ...(record.difficultyOrdinal !== undefined ? { difficultyOrdinal: record.difficultyOrdinal } : {}),
    templateId: record.templateId,
    evidence: record.evidence,
    sourcePayloadHash: record.sourcePayloadHash,
    ...(record.corroboratingSource ? { corroboratingSource: record.corroboratingSource } : {}),
  };
}

function verificationFor(collection, record) {
  return {
    profile: 'source_record_fields_v1',
    artifact: SOURCE_ARTIFACT,
    collection: `collections.${collection}`,
    recordIdField: 'sourceRecordId',
    recordId: record.sourceRecordId,
    fields: verificationFields(record),
    claim: claimFor(record),
  };
}

function expectedQuestionContract(record) {
  if (record?.category === 'الكويت') return {
    collection: 'kuwait',
    q: `في أي محافظة كويتية تقع منطقة «${record.subject.label}»؟`,
    answerSemanticType: 'kuwait-governorate',
    optionSemanticGroup: 'kuwait-governorate',
  };
  if (record?.category === 'دول الخليج') return {
    collection: 'gulf',
    q: `في أي دولة من دول مجلس التعاون يقع «${record.subject.label}»؟`,
    answerSemanticType: 'gcc-country',
    optionSemanticGroup: 'gcc-country',
  };
  if (record?.category === 'مسرحيات خليجية') return {
    collection: 'plays',
    q: `إلى أي دولة خليجية تُنسب مسرحية «${record.subject.label}»؟`,
    answerSemanticType: 'gcc-country',
    optionSemanticGroup: 'gcc-country',
  };
  if (record?.category === 'طيران ومطارات') return {
    collection: 'airports',
    q: `ما رمز IATA الخاص بـ«${record.subject.label}»؟`,
    answerSemanticType: 'iata-code',
    optionSemanticGroup: 'iata-code',
  };
  return null;
}

function rawQuestion(category, collection, record, answerPool) {
  let q;
  let answerSemanticType;
  let optionSemanticGroup;
  if (category === 'الكويت') {
    q = `في أي محافظة كويتية تقع منطقة «${record.subject.label}»؟`;
    answerSemanticType = 'kuwait-governorate';
    optionSemanticGroup = 'kuwait-governorate';
  } else if (category === 'دول الخليج') {
    q = `في أي دولة من دول مجلس التعاون يقع «${record.subject.label}»؟`;
    answerSemanticType = 'gcc-country';
    optionSemanticGroup = 'gcc-country';
  } else if (category === 'مسرحيات خليجية') {
    q = `إلى أي دولة خليجية تُنسب مسرحية «${record.subject.label}»؟`;
    answerSemanticType = 'gcc-country';
    optionSemanticGroup = 'gcc-country';
  } else {
    q = `ما رمز IATA الخاص بـ«${record.subject.label}»؟`;
    answerSemanticType = 'iata-code';
    optionSemanticGroup = 'iata-code';
  }
  const key = factKey(record);
  return {
    q,
    answer: record.object.label,
    answerPool,
    factKey: key,
    sourceRecordId: record.sourceRecordId,
    templateId: record.templateId,
    rank: Number(record.difficultyValue || 0),
    source: record.source,
    verification: verificationFor(collection, record),
    metadata: {
      factKey: key,
      answerSemanticType,
      optionSemanticGroup,
      difficultyMetric: record.difficultyMetric,
      difficultyValue: record.difficultyValue,
      ...(record.difficultyOrdinal !== undefined
        ? { difficultyOrdinal: record.difficultyOrdinal }
        : {}),
      sourceClaimHash: record.sourcePayloadHash,
      ...(record.corroboratingSource ? { corroboratingSource: record.corroboratingSource } : {}),
    },
  };
}

function assertSourceDocument(source) {
  const errors = [];
  if (source?.schemaVersion !== 1) errors.push('source.schemaVersion must be 1');
  if (source?.sourceProfile !== 'gulf_aviation_offline_claims_v1') errors.push('unexpected sourceProfile');
  const ids = new Set();
  for (const [category, collection] of Object.entries(COLLECTIONS)) {
    const records = source?.collections?.[collection];
    if (!Array.isArray(records) || records.length !== 90) {
      errors.push(`${collection}: source count is ${records?.length || 0}/90`);
      continue;
    }
    let previousPopularity = Infinity;
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      if (!record.sourceRecordId || ids.has(record.sourceRecordId)) errors.push(`${collection}: duplicate/missing sourceRecordId`);
      ids.add(record.sourceRecordId);
      if (record.category !== category) errors.push(`${record.sourceRecordId}: category mismatch`);
      if (record.difficultyBand !== ['easy', 'medium', 'hard'][Math.floor(index / 30)]) errors.push(`${record.sourceRecordId}: source band mismatch`);
      if (sourcePayloadHash(record) !== record.sourcePayloadHash) errors.push(`${record.sourceRecordId}: source payload hash mismatch`);
      if (!String(record.source?.url || '').startsWith('https://')) errors.push(`${record.sourceRecordId}: invalid source URL`);
      if (BANNED.test(JSON.stringify(record))) errors.push(`${record.sourceRecordId}: banned source content`);
      if (collection === 'airports') {
        if (record.difficultyMetric !== AIRPORT_DIFFICULTY_METRIC) errors.push(`${record.sourceRecordId}: airport difficulty profile mismatch`);
        if (Number(record.difficultyValue) > previousPopularity) errors.push(`${record.sourceRecordId}: airport popularity order is not descending`);
        previousPopularity = Number(record.difficultyValue);
        if (record.evidence?.scheduledService !== 'yes'
          || !['large_airport', 'medium_airport'].includes(record.evidence?.airportType)
          || record.evidence?.ourAirportsIataCode !== record.object?.label
          || record.evidence?.wikidataIataCode !== record.object?.label
          || !/^[A-Z]{3}$/u.test(record.object?.label || '')) {
          errors.push(`${record.sourceRecordId}: airport is not an operating scheduled airport with a corroborated IATA code`);
        }
      }
    }
    for (const band of ['easy', 'medium', 'hard']) {
      if (records.filter(record => record.difficultyBand === band).length !== 30) errors.push(`${collection}: ${band} source count`);
    }
  }
  if (ids.size !== 360) errors.push(`source IDs: ${ids.size}/360 unique`);
  const airportCodes = (source?.collections?.airports || []).map(record => record.object?.label);
  if (airportCodes.slice(0, EASY_GULF_AIRPORT_CODES.length).join('|') !== EASY_GULF_AIRPORT_CODES.join('|')) {
    errors.push('easy airport tier does not begin with the curated Gulf familiarity order');
  }
  const archiveEntries = source?.provenance?.archiveExclusion?.artifacts;
  if (!Array.isArray(archiveEntries)
    || archiveEntries.map(entry => entry.artifact).join('|') !== ARCHIVE_BANK_ARTIFACTS.join('|')
    || archiveEntries.some(entry => path.isAbsolute(entry.artifact)
      || !fs.existsSync(path.join(ROOT, entry.artifact))
      || sha256(fs.readFileSync(path.join(ROOT, entry.artifact))) !== entry.artifactSha256)
    || source?.provenance?.archiveExclusion?.finalSemanticOverlap !== 0
    || source?.provenance?.archiveExclusion?.gccSemanticFactsReplaced !== 29
    || !Number.isInteger(source?.provenance?.archiveExclusion?.top90OverlapsReplaced)) {
    errors.push('archive semantic-exclusion provenance is missing or invalid');
  }
  if (source?.provenance?.kuwaitAdministrativeDivision?.sourceFileSha256
    !== '06e6510b97c16de9b581bd3e61e896abc9ec8ee61357c1cfd3f5ec19d17d5e62') {
    errors.push('official Kuwait PDF checksum is missing or changed');
  }
  return errors;
}

export function buildGulfAviationCategories() {
  const source = readSource();
  const sourceErrors = assertSourceDocument(source);
  if (sourceErrors.length) throw new Error(sourceErrors.join('\n'));
  const airportCodes = source.collections.airports.map(record => record.object.label);
  const result = {};
  for (const category of GULF_AVIATION_CATEGORIES) {
    const collection = COLLECTIONS[category];
    const answerPool = category === 'الكويت'
      ? KUWAIT_GOVERNORATES
      : category === 'طيران ومطارات'
        ? airportCodes
        : GCC_COUNTRIES;
    const raws = source.collections[collection]
      .map(record => rawQuestion(category, collection, record, answerPool));
    result[category] = finalizeCategory(category, raws);
  }
  return result;
}

function semanticPoolFor(category) {
  if (category === 'الكويت') return new Set(KUWAIT_GOVERNORATES.map(normalizeArabic));
  if (category === 'طيران ومطارات') return null;
  return new Set(GCC_COUNTRIES.map(normalizeArabic));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort()
    .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function normalizedPredicate(value) {
  const normalized = normalizeArabic(value);
  if (normalized === 'p238' || normalized.includes('iatacode') || normalized === 'iata') return 'iatacode';
  return normalized;
}

function semanticFactKey(identityType, subject, predicate, object) {
  const normalizedSubject = identityType === 'id'
    ? String(subject || '').trim().toUpperCase()
    : normalizeArabic(subject);
  const normalizedObject = normalizeArabic(object);
  const normalizedProperty = normalizedPredicate(predicate);
  if (!normalizedSubject || !normalizedProperty || !normalizedObject) return null;
  return `${identityType}:${normalizedSubject}|${normalizedProperty}|${normalizedObject}`;
}

function sourceRecordSemanticKeys(record) {
  const keys = new Set();
  const add = (type, subject) => {
    const key = semanticFactKey(type, subject, record?.predicate?.id, record?.object?.label);
    if (key) keys.add(key);
  };
  add('label', record?.subject?.label);
  add('id', record?.subject?.id);
  add('id', record?.subject?.wikidataId);
  return keys;
}

function quotedSubject(question) {
  return String(question || '').match(/[«"]([^ »"](?:.*?))[»"]/u)?.[1]?.trim() || null;
}

function archivedRecordSemanticKeys(record) {
  const keys = new Set();
  const add = (type, subject, predicate, object) => {
    const key = semanticFactKey(type, subject, predicate, object);
    if (key) keys.add(key);
  };
  const claim = record?.verification?.claim || record?.claim;
  if (claim?.subject && claim?.predicate && claim?.object !== undefined) {
    add('label', claim.subject, claim.predicate, claim.object);
  }
  const verifiedSubject = record?.verification?.fields?.subject;
  if (verifiedSubject && record?.verification?.fields?.predicate && record?.verification?.fields?.object) {
    const predicate = record.verification.fields.predicate.id || record.verification.fields.predicate;
    const object = record.verification.fields.object.label || record.verification.fields.object;
    add('label', verifiedSubject.label || verifiedSubject, predicate, object);
    add('id', verifiedSubject.id, predicate, object);
    add('id', verifiedSubject.wikidataId, predicate, object);
  }
  const isIataFact = /^[A-Z]{3}$/u.test(record?.answer || '') && /IATA/iu.test(record?.q || '');
  if (isIataFact) {
    const qid = `${record?.sourceRecordId || ''} ${record?.source?.url || ''}`.match(/Q\d+/u)?.[0];
    add('id', qid, 'iata_code', record.answer);
    add('label', quotedSubject(record.q), 'iata_code', record.answer);
  } else if (!keys.size) {
    const subject = quotedSubject(record?.q) || record?.sourceRecordId || record?.source?.title;
    const predicate = /التصنيف الأدق/u.test(record?.q || '') ? 'entity_classification'
      : LETTER_ORDER.test(record?.q || '') ? 'letter_order_title'
        : String(record?.sourceRecordId || '').split('-').at(-1) || 'archive_question_answer';
    add('label', subject, predicate, record?.answer);
  }
  return keys;
}

function archivedQuestionSupportsSameClaim(archived, sourceRecord) {
  if (normalizeArabic(archived?.answer) !== normalizeArabic(sourceRecord?.object?.label)) return false;
  const normalizedQuestion = normalizeArabic(archived?.q);
  const normalizedSubject = normalizeArabic(sourceRecord?.subject?.label);
  const quotedEntities = [...String(archived?.q || '').matchAll(/«([^»]+)»/gu)]
    .map(match => normalizeArabic(match[1]));
  const subjectAppears = quotedEntities.length
    ? quotedEntities.includes(normalizedSubject)
    : normalizedQuestion.includes(normalizedSubject);
  if (!normalizedQuestion || !normalizedSubject || !subjectAppears) return false;
  if (sourceRecord.predicate.id === 'administrative_governorate') {
    return /(?:محافظة|إداري|اداري)/iu.test(archived.q);
  }
  if (sourceRecord.predicate.id === 'P17') {
    return /(?:دولة|بلد|أين|يقع|تقع|يتبع|تتبع)/iu.test(archived.q);
  }
  if (sourceRecord.predicate.id === 'category_country') {
    return /(?:مسرحي|دولة|بلد|تُنسب|تنسب)/iu.test(archived.q);
  }
  return sourceRecord.predicate.id === 'iata_code' && /IATA/iu.test(archived.q);
}

function flattenOldRecords(input) {
  if (input instanceof Set) return [...input];
  if (Array.isArray(input)) return input.flat(Infinity).filter(value => value && typeof value === 'object');
  if (!input || typeof input !== 'object') return [];
  const categories = input.categories && typeof input.categories === 'object' ? input.categories : input;
  return Object.values(categories).flat(Infinity).filter(value => value && typeof value === 'object' && value.q);
}

function defaultArchivedRecords() {
  return ARCHIVE_BANK_ARTIFACTS.flatMap(artifact => {
    const archiveFile = path.join(ROOT, artifact);
    return fs.existsSync(archiveFile)
      ? flattenOldRecords(JSON.parse(fs.readFileSync(archiveFile, 'utf8')))
      : [];
  });
}

/**
 * Ledger-v2 verifier for a single rendered question and its offline record.
 * It is intentionally a boolean predicate so a resolver can try records safely.
 */
export function verifyGulfAviationQuestion(question, record) {
  try {
    const expected = expectedQuestionContract(record);
    if (!question || !record || !expected
      || question.sourceRecordId !== record.sourceRecordId
      || sourcePayloadHash(record) !== record.sourcePayloadHash) return false;
    const sourceDocument = readSource();
    const answerPool = record.category === 'الكويت' ? KUWAIT_GOVERNORATES
      : record.category === 'طيران ومطارات'
        ? sourceDocument.collections.airports.map(item => item.object.label)
        : GCC_COUNTRIES;
    const expectedRaw = rawQuestion(record.category, expected.collection, record, answerPool);
    const expectedOptions = makeOptions(expectedRaw.answer, expectedRaw.answerPool,
      `${record.category}|${expectedRaw.factKey}`).o.map(normalizeArabic).sort();
    const verification = question.verification;
    if (verification?.profile !== 'source_record_fields_v1'
      || verification.artifact !== SOURCE_ARTIFACT
      || path.isAbsolute(verification.artifact)
      || verification.collection !== `collections.${expected.collection}`
      || verification.recordIdField !== 'sourceRecordId'
      || verification.recordId !== record.sourceRecordId
      || canonicalJson(verification.fields) !== canonicalJson(verificationFields(record))
      || canonicalJson(verification.claim) !== canonicalJson(claimFor(record))) return false;
    if (question.q !== expected.q
      || question.id !== `gq-${sha256(`next-v2|${record.category}|${factKey(record)}|${expected.q}`).slice(0, 20)}`
      || question.answer !== record.object.label
      || question.templateId !== record.templateId
      || question.factKey !== factKey(record)
      || question.sourceClaimHash !== record.sourcePayloadHash
      || question.band !== record.difficultyBand
      || question.difficultyMetric !== record.difficultyMetric
      || Number(question.difficultyValue) !== Number(record.difficultyValue)
      || question.difficultyOrdinal !== record.difficultyOrdinal
      || question.answerSemanticType !== expected.answerSemanticType
      || question.optionSemanticGroup !== expected.optionSemanticGroup
      || canonicalJson(question.source) !== canonicalJson(record.source)) return false;
    const allowedD = record.difficultyBand === 'easy' ? [1, 2]
      : record.difficultyBand === 'medium' ? [3, 4]
        : [5, 6];
    if (!allowedD.includes(question.d)
      || !Array.isArray(question.o)
      || question.o.length !== 4
      || new Set(question.o.map(normalizeArabic)).size !== 4
      || !Number.isInteger(question.a)
      || question.a < 0
      || question.a > 3
      || question.o[question.a] !== record.object.label
      || question.o.filter(option => normalizeArabic(option) === normalizeArabic(record.object.label)).length !== 1) return false;
    if (canonicalJson(question.o.map(normalizeArabic).sort()) !== canonicalJson(expectedOptions)) return false;
    const semanticPool = semanticPoolFor(record.category);
    if (record.category === 'طيران ومطارات') {
      if (!question.o.every(option => /^[A-Z]{3}$/u.test(option))
        || record.difficultyMetric !== AIRPORT_DIFFICULTY_METRIC
        || record.evidence?.scheduledService !== 'yes'
        || !['large_airport', 'medium_airport'].includes(record.evidence?.airportType)
        || record.evidence?.ourAirportsIataCode !== record.object.label
        || record.evidence?.wikidataIataCode !== record.object.label) return false;
    } else if (!question.o.every(option => semanticPool.has(normalizeArabic(option)))) return false;
    return !BANNED.test(JSON.stringify({ q: question.q, o: question.o, answer: question.answer }))
      && !LETTER_ORDER.test(question.q)
      && !MUTABLE_TRIVIA.test(question.q);
  } catch {
    return false;
  }
}

export function verifyGulfAviationCategories(categories, { oldRecords = null } = {}) {
  const source = readSource();
  const errors = assertSourceDocument(source);
  const archivedRows = oldRecords === null ? defaultArchivedRecords() : flattenOldRecords(oldRecords);
  const archivedSemanticKeys = new Set(archivedRows.flatMap(record => [...archivedRecordSemanticKeys(record)]));
  const archivedQuestions = new Set(archivedRows.map(record => normalizeArabic(record.q)).filter(Boolean));
  const archivedByAnswer = new Map();
  for (const record of archivedRows) {
    const answer = normalizeArabic(record.answer);
    if (!answer) continue;
    if (!archivedByAnswer.has(answer)) archivedByAnswer.set(answer, []);
    archivedByAnswer.get(answer).push(record);
  }
  let archiveSemanticFactConflicts = 0;
  let archiveExactQuestionConflicts = 0;
  const sourceById = new Map(Object.values(source.collections || {}).flat()
    .map(record => [record.sourceRecordId, record]));
  const actualCategories = Object.keys(categories || {});
  if (actualCategories.length !== GULF_AVIATION_CATEGORIES.length
    || actualCategories.some(category => !GULF_AVIATION_CATEGORIES.includes(category))) {
    errors.push(`unexpected categories: ${actualCategories.join(', ')}`);
  }
  const questionsSeen = new Set();
  const factsSeen = new Set();
  const idsSeen = new Set();

  for (const category of GULF_AVIATION_CATEGORIES) {
    const rows = categories?.[category] || [];
    if (rows.length !== 90) errors.push(`${category}: ${rows.length}/90 questions`);
    const semanticPool = semanticPoolFor(category);
    for (let index = 0; index < rows.length; index += 1) {
      const question = rows[index];
      const sourceRecord = sourceById.get(question.sourceRecordId);
      const expectedBand = ['easy', 'medium', 'hard'][Math.floor(index / 30)];
      for (const field of ['q', 'o', 'a', 'answer', 'd', 'band', 'factKey', 'sourceRecordId', 'templateId', 'source', 'verification']) {
        if (question[field] === undefined || question[field] === null || question[field] === '') errors.push(`${question.id || category}: missing ${field}`);
      }
      if (!question.id || idsSeen.has(question.id)) errors.push(`${category}: duplicate/missing question id`);
      idsSeen.add(question.id);
      const normalizedQuestion = normalizeArabic(question.q);
      if (!normalizedQuestion || questionsSeen.has(normalizedQuestion)) errors.push(`${question.id}: duplicate/empty question`);
      questionsSeen.add(normalizedQuestion);
      if (archivedQuestions.has(normalizedQuestion)) {
        archiveExactQuestionConflicts += 1;
        errors.push(`${question.id}: exact archived question reused`);
      }
      if (!question.factKey || factsSeen.has(question.factKey)) errors.push(`${question.id}: duplicate/missing factKey`);
      factsSeen.add(question.factKey);
      if (question.band !== expectedBand || question.band !== sourceRecord?.difficultyBand) errors.push(`${question.id}: wrong difficulty band`);
      if (!Number.isInteger(question.d) || question.d < 1 || question.d > 6) errors.push(`${question.id}: invalid difficulty number`);
      if (!Array.isArray(question.o) || question.o.length !== 4
        || new Set(question.o.map(normalizeArabic)).size !== 4) errors.push(`${question.id}: options are not four unique values`);
      if (!Number.isInteger(question.a) || question.o?.[question.a] !== question.answer
        || question.o?.filter(option => normalizeArabic(option) === normalizeArabic(question.answer)).length !== 1) {
        errors.push(`${question.id}: answer is not uniquely indexed`);
      }
      try {
        assertNoSimilarOptions(question);
      } catch (error) {
        errors.push(error.message);
      }
      if (BANNED.test(JSON.stringify(question))) errors.push(`${question.id}: banned content`);
      if (LETTER_ORDER.test(question.q)) errors.push(`${question.id}: forbidden letter-order pattern`);
      if (MUTABLE_TRIVIA.test(question.q)) errors.push(`${question.id}: mutable trivia`);
      if (!String(question.source?.url || '').startsWith('https://')) errors.push(`${question.id}: invalid source`);
      if (!sourceRecord) {
        errors.push(`${question.id}: source record not found`);
        continue;
      }
      const archivedSemanticMatch = [...sourceRecordSemanticKeys(sourceRecord)]
        .find(key => archivedSemanticKeys.has(key));
      const archivedNaturalMatch = (archivedByAnswer.get(normalizeArabic(sourceRecord.object.label)) || [])
        .find(record => archivedQuestionSupportsSameClaim(record, sourceRecord));
      if (archivedSemanticMatch || archivedNaturalMatch) {
        archiveSemanticFactConflicts += 1;
        errors.push(`${question.id}: archived semantic fact reused (${archivedSemanticMatch || archivedNaturalMatch.sourceRecordId || 'natural claim'})`);
      }
      if (!verifyGulfAviationQuestion(question, sourceRecord)) {
        errors.push(`${question.id}: final question does not match its offline source claim`);
      }
      if (category === 'طيران ومطارات') {
        if (!question.o?.every(option => /^[A-Z]{3}$/u.test(option))
          || question.answerSemanticType !== 'iata-code'
          || question.optionSemanticGroup !== 'iata-code'
          || question.difficultyMetric !== AIRPORT_DIFFICULTY_METRIC) {
          errors.push(`${question.id}: invalid IATA option semantics or difficulty metric`);
        }
      } else if (!question.o?.every(option => semanticPool.has(normalizeArabic(option)))) {
        errors.push(`${question.id}: options mix semantic types`);
      }
    }
    for (const band of ['easy', 'medium', 'hard']) {
      if (rows.filter(question => question.band === band).length !== 30) errors.push(`${category}: ${band} question count`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    sourceArtifact: SOURCE_ARTIFACT,
    sourceProfile: source.sourceProfile,
    questionCount: GULF_AVIATION_CATEGORIES.reduce((sum, category) => sum + (categories?.[category]?.length || 0), 0),
    uniqueQuestionCount: questionsSeen.size,
    uniqueFactCount: factsSeen.size,
    distribution: Object.fromEntries(GULF_AVIATION_CATEGORIES.map(category => [category, {
      count: categories?.[category]?.length || 0,
      bands: Object.fromEntries(['easy', 'medium', 'hard'].map(band => [band,
        (categories?.[category] || []).filter(question => question.band === band).length])),
    }])),
    airportDifficulty: {
      metric: AIRPORT_DIFFICULTY_METRIC,
      easy: source.collections.airports.slice(0, 30).map(record => record.difficultyValue),
      medium: source.collections.airports.slice(30, 60).map(record => record.difficultyValue),
      hard: source.collections.airports.slice(60, 90).map(record => record.difficultyValue),
    },
    archiveSemanticCheck: {
      artifacts: ARCHIVE_BANK_ARTIFACTS,
      oldRecordCount: archivedRows.length,
      oldSemanticKeyCount: archivedSemanticKeys.size,
      semanticFactConflicts: archiveSemanticFactConflicts,
      exactQuestionConflicts: archiveExactQuestionConflicts,
      importerGccFactsReplaced: source.provenance.archiveExclusion.gccSemanticFactsReplaced,
      importerOperationalCandidatesExcluded: source.provenance.archiveExclusion.operationalCandidatesExcluded,
      importerTop90FactsReplaced: source.provenance.archiveExclusion.top90OverlapsReplaced,
      finalAirportSemanticOverlap: source.provenance.archiveExclusion.finalSemanticOverlap,
    },
  };
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const categories = buildGulfAviationCategories();
  const report = verifyGulfAviationCategories(categories);
  console.log(JSON.stringify(report, null, 2));
  if (!report.valid) process.exitCode = 1;
}

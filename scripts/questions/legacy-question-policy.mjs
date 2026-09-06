import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { normalizeArabic } from './categories/common.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function rowsFromDocument(document, origin) {
  return Object.entries(document?.categories || {}).flatMap(([category, rows]) =>
    (Array.isArray(rows) ? rows : []).map(question => ({
      origin,
      category,
      id: String(question?.id || ''),
      q: String(question?.q || question?.question || ''),
      answer: String(question?.answer || ''),
    })));
}

export function loadLegacyQuestionRecords() {
  const records = [];
  const archivePath = path.join(ROOT, 'server-assets/question-bank/archive');
  if (fs.existsSync(archivePath)) {
    for (const name of fs.readdirSync(archivePath).filter(value => value.endsWith('-bank.json')).sort()) {
      const document = JSON.parse(fs.readFileSync(path.join(archivePath, name), 'utf8'));
      records.push(...rowsFromDocument(document, `archive/${name}`));
    }
  }

  const approvedPath = path.join(ROOT, 'www/approved-question-bank.js');
  if (fs.existsSync(approvedPath)) {
    const context = { window: {} };
    vm.runInNewContext(fs.readFileSync(approvedPath, 'utf8'), context, {
      filename: approvedPath,
      timeout: 2_000,
      codeGeneration: { strings: false, wasm: false },
    });
    const document = { categories: context.window.__APPROVED_QUESTION_BANK_DATA__ || {} };
    records.push(...rowsFromDocument(document, 'www/approved-question-bank.js'));
  }

  const unique = new Map();
  for (const record of records) {
    if (!record.q) continue;
    const key = `${normalizeArabic(record.q)}|${normalizeArabic(record.answer)}`;
    if (!unique.has(key)) unique.set(key, record);
  }
  return [...unique.values()];
}

export function legacyQuestionTextSet(records = loadLegacyQuestionRecords()) {
  return new Set(records.map(record => record.q));
}

function quotedAnchors(question) {
  return [...String(question.q || '').matchAll(/«([^»]{2,})»/gu)].map(match => match[1]);
}

function scalarAnchors(value, key = '') {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.flatMap(item => scalarAnchors(item, key));
  if (typeof value === 'object') return Object.entries(value)
    .flatMap(([childKey, child]) => scalarAnchors(child, childKey));
  const text = String(value).trim();
  if (!text || /(?:hash|sha|statement|record|item|subjectid|valueid|matchid)/iu.test(key)) return [];
  if (/(?:label|name|country|capital|symbol|code|year|date|proverb|title|answer|object)/iu.test(key)) return [text];
  return [];
}

export function legacyFactAnchors(question) {
  const explicit = question.legacyFact?.anchors;
  // Builders may provide a reviewed set of semantic fact anchors. In that
  // case it is the complete identity of the fact, not an addition to every
  // descriptive field kept for source verification. This avoids conflating a
  // genuinely new relation (for example ISO-3 -> capital) with an older
  // country -> capital question merely because both source records contain the
  // country label.
  const candidates = Array.isArray(explicit) && explicit.length
    ? [...explicit, String(question.answer || '')]
    : [
      ...quotedAnchors(question),
      ...scalarAnchors(question.verification?.fields),
      String(question.answer || ''),
      ...(String(question.q || '').match(/\b(?:\d{4}|[A-Z]{3})\b/gu) || []),
    ];
  const unique = new Map();
  for (const raw of candidates) {
    const text = String(raw || '').trim();
    const normalized = normalizeArabic(text);
    if (normalized.length < 2 || /^(?:نعم|لا|صح|خطا)$/u.test(normalized)) continue;
    if (!unique.has(normalized)) unique.set(normalized, text);
  }
  return [...unique.values()];
}

function containsAnchor(text, anchor) {
  const normalized = normalizeArabic(anchor);
  return normalized.length >= 2 && text.includes(normalized);
}

export function findLegacyFactMatch(question, records) {
  const normalizedQuestion = normalizeArabic(question.q);
  const normalizedAnswer = normalizeArabic(question.answer);
  const anchors = legacyFactAnchors(question);
  const minAnchors = Math.max(2, Number(question.legacyFact?.minAnchors || 2));
  const bidirectional = question.legacyFact?.bidirectional === true;
  for (const record of records) {
    const oldQuestion = normalizeArabic(record.q);
    const oldAnswer = normalizeArabic(record.answer);
    if (oldQuestion === normalizedQuestion) return { record, reason: 'exact_question' };
    const oldCombined = `${oldQuestion}${oldAnswer}`;
    const matches = anchors.filter(anchor => containsAnchor(oldCombined, anchor));
    if (matches.length < minAnchors) continue;
    if (bidirectional || oldAnswer === normalizedAnswer || matches.length >= Math.max(3, minAnchors)) {
      return { record, reason: `semantic_fact:${matches.join('|')}` };
    }
  }
  return null;
}

export function assertNoLegacyFacts(categories, records = loadLegacyQuestionRecords()) {
  const matches = [];
  for (const [category, questions] of Object.entries(categories || {})) {
    for (const question of questions || []) {
      const match = findLegacyFactMatch(question, records);
      if (match) matches.push({ category, id: question.id, q: question.q, ...match });
    }
  }
  if (matches.length) {
    const sample = matches.slice(0, 8).map(item =>
      `${item.id}: ${item.q} ↔ ${item.record.q} (${item.reason})`).join('\n');
    throw new Error(`أُعيدت ${matches.length} حقيقة من البنك القديم:\n${sample}`);
  }
  return true;
}

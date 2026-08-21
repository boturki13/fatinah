#!/usr/bin/env node
import {
  CANDIDATES_PATH,
  PUBLISHED_PATH,
  isNearDuplicate,
  loadPolicy,
  readJson,
  validateCandidate,
} from './lib.mjs';

const candidates = readJson(CANDIDATES_PATH, []);
const published = readJson(PUBLISHED_PATH, []);
const policy = loadPolicy();
const errors = [];
const ids = new Set();
const texts = [];
for (const candidate of candidates) {
  if (!candidate.id || ids.has(candidate.id)) errors.push(`${candidate.id || 'missing-id'}: duplicate_id`);
  ids.add(candidate.id);
  if (isNearDuplicate(candidate.question, texts)) errors.push(`${candidate.id}: duplicate_or_near_duplicate`);
  texts.push(candidate.question);
  if (candidate.status === 'approved') {
    const check = validateCandidate(candidate, { policy, existingQuestions: texts.slice(0, -1) });
    if (!check.valid) errors.push(`${candidate.id}: ${check.errors.join(',')}`);
    if (candidate.religious && !candidate.review?.religiousSourceAndIsnadConfirmed) errors.push(`${candidate.id}: religious_review_missing`);
  }
}
for (const item of published) {
  if (item.status !== 'approved') errors.push(`${item.id}: published_without_approval`);
}
const statuses = candidates.reduce((result, candidate) => {
  result[candidate.status] = (result[candidate.status] || 0) + 1;
  return result;
}, {});
console.log(JSON.stringify({ candidates: candidates.length, published: published.length, statuses, errors }, null, 2));
if (errors.length) process.exitCode = 1;

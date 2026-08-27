#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, buildRuntimeAuditManifest } from './runtime-audit-manifest-lib.mjs';

const output = path.join(ROOT, 'www', 'reviewed-question-ledger.js');
const manifest = buildRuntimeAuditManifest();
const ledger = Object.fromEntries(manifest.questions
  .filter(item => item.review.basis === 'exact_individual_legacy_review')
  .map(item => [item.runtimeId, {
    status: 'approved',
    bankVersion: 3,
    reviewer: item.review.reviewer,
    reviewedAt: item.review.reviewedAt,
    religiousSourceAndIsnadConfirmed: Boolean(item.review.religiousSourceAndIsnadConfirmed),
  }]));
const source = `// Generated from content/questions/legacy-reviews.json; do not edit by hand.\nwindow.__LEGACY_QUESTION_REVIEWS__=${JSON.stringify(ledger, null, 2)};\n`;
const temporary = `${output}.${process.pid}.tmp`;
fs.writeFileSync(temporary, source, { mode: 0o644 });
fs.renameSync(temporary, output);
console.log(JSON.stringify({ output, reviews: Object.keys(ledger).length }, null, 2));

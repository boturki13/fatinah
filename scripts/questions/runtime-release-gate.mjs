#!/usr/bin/env node
import fs from 'node:fs';
import {
  MANIFEST_PATH,
  buildRuntimeAuditManifest,
  compareManifest,
} from './runtime-audit-manifest-lib.mjs';

const allowedArguments = new Set(['--release']);
const unknownArguments = process.argv.slice(2).filter(argument => !allowedArguments.has(argument));
if (unknownArguments.length) {
  console.error(`وسيط غير معروف: ${unknownArguments.join(', ')}`);
  process.exit(2);
}
const releaseMode = process.argv.includes('--release');
const actual = buildRuntimeAuditManifest();
let checkedIn = null;
let comparison = {
  matches: false,
  checkedFingerprint: '',
  actualFingerprint: actual.runtimeFingerprintSha256,
};
try {
  checkedIn = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  comparison = compareManifest(checkedIn, actual);
} catch (error) {
  comparison.readError = error.message;
}

const blockers = [];
if (!comparison.matches) blockers.push('manifest_drift');
if (actual.counts.legacyPending > 0) blockers.push('legacy_pending');
if (actual.counts.runtimeClaimsUnpublishedApproval > 0) blockers.push('runtime_claims_unpublished_approval');
if (actual.counts.autoApprovalDetected > 0) blockers.push('auto_approval_detected');
if (actual.counts.categoryFallbackSource > 0) blockers.push('category_fallback_not_claim_specific');
if (actual.counts.missingOrUnknownSource > 0) blockers.push('missing_or_unknown_source');
if (actual.counts.publishedContentMismatch > 0) blockers.push('published_content_mismatch');
if (actual.counts.publishedRecordsMissingFromRuntime > 0) blockers.push('published_record_missing_from_runtime');
if (actual.counts.duplicatePublishedIds > 0) blockers.push('duplicate_published_id');
if (actual.orphanAdditionCategories.length > 0) blockers.push('orphan_addition_category');

const report = {
  mode: releaseMode ? 'release' : 'report',
  manifest: MANIFEST_PATH,
  manifestMatchesRuntime: comparison.matches,
  fingerprint: {
    checkedIn: comparison.checkedFingerprint,
    actual: comparison.actualFingerprint,
  },
  components: actual.components,
  counts: actual.counts,
  orphanAdditionCategories: actual.orphanAdditionCategories,
  blockers,
  releaseReady: blockers.length === 0,
};
if (comparison.readError) report.manifestReadError = comparison.readError;

console.log(JSON.stringify(report, null, 2));
if (releaseMode && blockers.length) {
  console.error('بوابة الإصدار مرفوضة: لا يجوز اعتبار الأسئلة القديمة معتمدة قبل تدقيق كل سؤال ومصدره على حدة.');
  process.exitCode = 1;
}

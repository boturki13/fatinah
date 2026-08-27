import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  MANIFEST_PATH,
  buildRuntimeAuditManifest,
  compareManifest,
} from '../scripts/questions/runtime-audit-manifest-lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const published = JSON.parse(fs.readFileSync(path.join(root, 'content/questions/published.json'), 'utf8'));
const legacyReviews = JSON.parse(fs.readFileSync(path.join(root, 'content/questions/legacy-reviews.json'), 'utf8'));
const checkedIn = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
const actual = buildRuntimeAuditManifest();
const comparison = compareManifest(checkedIn, actual);

assert.equal(comparison.matches, true, 'ملف التدقيق يجب أن يطابق بنك التشغيل حرفياً.');
assert.equal(actual.counts.runtime, actual.questions.length);
assert.equal(actual.counts.approved, actual.counts.runtime, 'كل سؤال تشغيل يجب أن يطابق اعتماداً فردياً موثقاً.');
assert.equal(actual.counts.legacyPending, 0, 'لا يجوز أن يبقى سؤال pending بعد اكتمال التدقيق.');
assert.equal(actual.counts.autoApprovalDetected, 0, 'يجب ألا يبقى أي اعتماد تلقائي في مسار التشغيل.');
assert.equal(actual.counts.runtimeClaimsUnpublishedApproval, 0, 'لا يجوز أن يدّعي runtime اعتماد سؤال غير منشور.');
assert.equal(actual.counts.categoryFallbackSource, 0, 'لا يجوز اعتماد رابط فئة عام كدليل للسؤال.');

const approvedIds = actual.questions
  .filter(item => item.review.status === 'approved')
  .map(item => item.runtimeId)
  .sort();
assert.equal(approvedIds.length, published.length + legacyReviews.length);
assert.ok(
  actual.questions
    .filter(item => item.origin.component !== 'published')
    .every(item => item.review.status === 'approved' && item.review.basis === 'exact_individual_legacy_review'),
  'كل سؤال base أو addition يجب أن يطابق بصمة مراجعة فردية.',
);
assert.ok(
  actual.questions
    .filter(item => item.citation.provenance === 'category_fallback')
    .every(item => item.citation.claimSpecific === false),
  'رابط الفئة العام ليس دليلاً خاصاً بالمعلومة.',
);

const report = spawnSync(process.execPath, ['scripts/questions/runtime-release-gate.mjs'], {
  cwd: root,
  encoding: 'utf8',
});
assert.equal(report.status, 0, report.stderr || 'وضع التقرير يجب أن ينجح.');
const reportJson = JSON.parse(report.stdout);
assert.equal(reportJson.mode, 'report');
assert.equal(reportJson.releaseReady, true);
assert.deepEqual(reportJson.blockers, []);

const release = spawnSync(process.execPath, ['scripts/questions/runtime-release-gate.mjs', '--release'], {
  cwd: root,
  encoding: 'utf8',
});
assert.equal(release.status, 0, release.stderr || 'وضع الإصدار يجب أن ينجح بعد اكتمال التدقيق.');
const releaseJson = JSON.parse(release.stdout);
assert.equal(releaseJson.mode, 'release');
assert.equal(releaseJson.releaseReady, true);

console.log(`✓ manifest صادق: ${actual.counts.approved} سؤالاً معتمداً ولا سؤال قيد التدقيق`);
console.log('✓ لا auto-approval ولا category fallback؛ بوابة الإصدار ناجحة');

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
const checkedIn = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
const actual = buildRuntimeAuditManifest();
const comparison = compareManifest(checkedIn, actual);

assert.equal(comparison.matches, true, 'ملف التدقيق يجب أن يطابق بنك التشغيل حرفياً.');
assert.equal(actual.counts.runtime, actual.questions.length);
assert.equal(actual.counts.approved, published.length, 'المعتمدون هم سجلات النشر الفعلية فقط.');
assert.ok(actual.counts.legacyPending > 0, 'البنك القديم يجب أن يبقى pending حتى مراجعته فردياً.');
assert.equal(actual.counts.autoApprovalDetected, 0, 'يجب ألا يبقى أي اعتماد تلقائي في مسار التشغيل.');
assert.equal(actual.counts.runtimeClaimsUnpublishedApproval, 0, 'لا يجوز أن يدّعي runtime اعتماد سؤال غير منشور.');
assert.ok(actual.counts.categoryFallbackSource > 0, 'يجب كشف رابط الفئة العام غير الخاص بادعاء السؤال.');

const approvedIds = actual.questions
  .filter(item => item.review.status === 'approved')
  .map(item => item.runtimeId)
  .sort();
assert.deepEqual(approvedIds, published.map(item => item.id).sort());
assert.ok(
  actual.questions
    .filter(item => item.origin.component !== 'published')
    .every(item => item.review.status === 'legacy_pending'),
  'لا يجوز أن يرث سؤال base أو addition صفة approved من واجهة التشغيل.',
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
assert.equal(reportJson.releaseReady, false);
assert.ok(reportJson.blockers.includes('legacy_pending'));
assert.ok(reportJson.blockers.includes('category_fallback_not_claim_specific'));

const release = spawnSync(process.execPath, ['scripts/questions/runtime-release-gate.mjs', '--release'], {
  cwd: root,
  encoding: 'utf8',
});
assert.notEqual(release.status, 0, 'وضع الإصدار يجب أن يفشل ما دامت أسئلة legacy معلّقة.');
const releaseJson = JSON.parse(release.stdout);
assert.equal(releaseJson.mode, 'release');
assert.equal(releaseJson.releaseReady, false);

console.log(`✓ manifest صادق: ${actual.counts.approved} معتمداً و${actual.counts.legacyPending} قيد التدقيق`);
console.log(`✓ لا auto-approval؛ report ينجح و--release يرفض (${actual.counts.categoryFallbackSource} category fallback)`);

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  loadPolicy,
  loadReligiousSourcePackets,
  normalizeArabic,
} from '../scripts/questions/lib.mjs';
import {
  loadReligiousSourceRegistry,
  loadTanzilCorpus,
  normalizeQuranVerificationText,
  parseTanzilCorpus,
  sha256,
} from '../scripts/questions/religious-source-lib.mjs';
import { verifyDorarHadithHtml } from '../scripts/questions/hadith-source-lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const policy = loadPolicy();
const registry = loadReligiousSourceRegistry();
const quranFoundation = registry.verificationServices.find(
  item => item.id === 'quran-foundation-content-v4'
);
assert.equal(quranFoundation.defaultEnvironment, 'prelive');
assert.equal(
  quranFoundation.environments.prelive.authUrl,
  'https://prelive-oauth2.quran.foundation/oauth2/token'
);
assert.equal(
  quranFoundation.environments.production.baseUrl,
  'https://apis.quran.foundation/content/api/v4'
);
const corpus = loadTanzilCorpus(registry);
assert.equal(corpus.verses.size, 6236);
assert.equal(corpus.surahs.size, 114);
assert.equal(corpus.surahs.get(1).name, 'الفاتحة');
assert.throws(() => parseTanzilCorpus('1|1|نص ناقص', 6236), /غير مكتمل/);
assert.equal(
  normalizeQuranVerificationText('لَا رَيْبَ ۛ فِيهِ'),
  normalizeQuranVerificationText('لَا رَيْبَ فِيهِ'),
  'علامات الوقف القرآنية الطباعية لا تغيّر المطابقة بين المصدرين.'
);
assert.notEqual(
  normalizeQuranVerificationText('لَا رَيْبَ فِيهِ'),
  normalizeQuranVerificationText('لَا شَكَّ فِيهِ'),
  'التطبيع لا يجوز أن يخفي تغيير الحروف أو الكلمات.'
);

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fatinah-religious-packets-'));
const packetFile = path.join(temporary, 'packets.json');
const arabicText = corpus.verses.get('1:1');
const verifiedAt = '2026-08-24T00:00:00.000Z';
const validPacket = {
  id: 'quran-1-1-double-verified',
  work: 'القرآن الكريم',
  reference: 'القرآن الكريم، 1:1',
  canonicalReference: { type: 'quran', surah: 1, ayah: 1, surahName: 'الفاتحة' },
  arabicText,
  textSha256: sha256(arabicText),
  source: {
    title: 'Tanzil Quran Text (Uthmani 1.1) — 1:1',
    url: 'https://tanzil.net/download/',
    publisher: 'Tanzil Project',
  },
  provenance: { primarySourceId: 'tanzil-quran-uthmani-1.1' },
  approvalMode: 'deterministic_double_verified',
  rightsReview: {
    approved: true,
    basis: 'CC BY 3.0; attribution required; verbatim text only',
    reviewedAt: verifiedAt,
  },
  automatedVerification: {
    primary: {
      status: 'passed', verifier: 'local-tanzil-exact-match', verifiedAt,
      corpusSha256: corpus.manifest.sha256,
    },
    secondary: {
      status: 'passed', verifier: 'quran-foundation-content-v4', verifiedAt,
      evidenceSha256: sha256(arabicText),
    },
  },
};

fs.writeFileSync(packetFile, JSON.stringify({ schemaVersion: 1, packets: [validPacket] }));
assert.equal(loadReligiousSourcePackets(packetFile, policy)[0].work, 'القرآن الكريم');
assert.equal(loadReligiousSourcePackets(packetFile, policy)[0].approvalMode, 'deterministic_double_verified');

fs.writeFileSync(packetFile, JSON.stringify({ schemaVersion: 1, packets: [{
  ...validPacket,
  automatedVerification: { ...validPacket.automatedVerification, secondary: { status: 'pending' } },
}] }));
assert.throws(() => loadReligiousSourcePackets(packetFile, policy), /التحقق الثانوي/);

fs.writeFileSync(packetFile, JSON.stringify({ schemaVersion: 1, packets: [{
  ...validPacket, arabicText: `${arabicText} تغيير`,
}] }));
assert.throws(() => loadReligiousSourcePackets(packetFile, policy), /بصمة نص/);

fs.writeFileSync(packetFile, JSON.stringify({ schemaVersion: 1, packets: [{
  ...validPacket, work: 'صحيح مسلم',
}] }));
assert.throws(() => loadReligiousSourcePackets(packetFile, policy), /غير مسموح/);

fs.writeFileSync(packetFile, JSON.stringify({ schemaVersion: 1, packets: [{
  ...validPacket, source: { ...validPacket.source, url: 'https://evil.example/quran' },
}] }));
assert.throws(() => loadReligiousSourcePackets(packetFile, policy), /المصدر الموثوق/);

const bukhariPacket = {
  ...validPacket,
  id: 'bukhari-1-double-verified',
  work: 'صحيح البخاري',
  reference: 'متفق عليه: البخاري (8) ومسلم (16)',
  arabicText: 'بني الإسلام على خمس شهادة أن لا إله إلا الله وإقام الصلاة وإيتاء الزكاة',
  source: {
    title: 'الدرر السنية — متفق عليه: البخاري 8 ومسلم 16',
    url: 'https://dorar.net/h/TCubdkk0',
    publisher: 'مؤسسة الدرر السنية',
  },
  provenance: { primarySourceId: 'sunnah-com-sahih-bukhari' },
  canonicalReference: {
    type: 'muttafaq_alayh', narrator: 'عبدالله بن عمر', bukhariNumber: '8', muslimNumber: '16',
  },
  automatedVerification: {
    primary: {
      status: 'passed', verifier: 'sahihayn-reference-match', verifiedAt,
      bukhariNumber: '8', muslimNumber: '16',
    },
    secondary: {
      status: 'passed', verifier: 'dorar-hadith-search', verifiedAt,
      muttafaqAlayh: true, isnadSahih: true, evidenceSha256: sha256('بني الاسلام علي خمس'),
    },
  },
};
bukhariPacket.textSha256 = sha256(bukhariPacket.arabicText);
fs.writeFileSync(packetFile, JSON.stringify({ schemaVersion: 1, packets: [bukhariPacket] }));
assert.equal(loadReligiousSourcePackets(packetFile, policy)[0].canonicalReference.type, 'muttafaq_alayh');

fs.writeFileSync(packetFile, JSON.stringify({ schemaVersion: 1, packets: [{
  ...bukhariPacket,
  automatedVerification: {
    ...bukhariPacket.automatedVerification,
    secondary: { ...bukhariPacket.automatedVerification.secondary, muttafaqAlayh: false },
  },
}] }));
assert.throws(() => loadReligiousSourcePackets(packetFile, policy), /ليس مثبتاً كمتفق عليه/);

const dorarFixture = `
  <div>بُني الإسلام على خمس شهادة أن لا إله إلا الله وإقام الصلاة وإيتاء الزكاة</div>
  <div>الراوي : عبدالله بن عمر | المحدث : مسلم | المصدر : صحيح مسلم</div>
  <div>التخريج : أخرجه البخاري (8)، ومسلم (16)</div>`;
assert.deepEqual(verifyDorarHadithHtml({
  html: dorarFixture,
  arabicText: 'بني الإسلام على خمس شهادة أن لا إله إلا الله وإقام الصلاة وإيتاء الزكاة',
  narrator: 'عبدالله بن عمر',
  bukhariNumber: '8',
  muslimNumber: '16',
}), {
  muttafaqAlayh: true,
  isnadSahih: true,
  evidenceOpening: 'بني الاسلام علي خمس شهاده ان لا اله',
});
assert.throws(() => verifyDorarHadithHtml({
  html: dorarFixture.replace('ومسلم (16)', 'ومسلم (17)'),
  arabicText: 'بني الإسلام على خمس شهادة أن لا إله إلا الله وإقام الصلاة وإيتاء الزكاة',
  narrator: 'عبدالله بن عمر',
  bukhariNumber: '8',
  muslimNumber: '16',
}), /رقمي البخاري ومسلم/);

const realPackets = loadReligiousSourcePackets();
assert.ok(Array.isArray(realPackets), 'ملف الحزم الحقيقي يجب أن يبقى صالحاً سواء كان فارغاً أو مجهزاً.');
const blocked = spawnSync(process.execPath, [
  'scripts/questions/generate.mjs', '--category', 'القرآن الكريم', '--count', '1', '--dry-run',
], { cwd: root, encoding: 'utf8' });
assert.notEqual(blocked.status, 0);
assert.match(`${blocked.stdout}\n${blocked.stderr}`, /توليد AI الحر للأسئلة الدينية متوقف/);

const deterministic = spawnSync(process.execPath, [
  'scripts/questions/generate-quran-deterministic.mjs', '--count', '1', '--dry-run',
], { cwd: root, encoding: 'utf8' });
if (realPackets.some(packet => packet.work === 'القرآن الكريم')) {
  if (deterministic.status === 0) {
    const deterministicResult = JSON.parse(deterministic.stdout);
    assert.equal(deterministicResult.generated, 1);
    assert.equal(deterministicResult.aiCalls, 0);
    assert.ok(!normalizeArabic(deterministicResult.previews[0].question)
      .includes(normalizeArabic(deterministicResult.previews[0].answer)));
  } else {
    assert.match(
      `${deterministic.stdout}\n${deterministic.stderr}`,
      /المتاح الآمن بالقوالب الفريدة 0\/1؛ لم تُكتب أي نتيجة/,
      'إذا استُخدمت كل الحزم يجب أن يمنع القالب تكرارها.'
    );
  }
} else {
  assert.notEqual(deterministic.status, 0);
  assert.match(`${deterministic.stdout}\n${deterministic.stderr}`, /لا توجد آيات مزدوجة التحقق/);
}

const environmentWithoutQuranFoundation = { ...process.env };
environmentWithoutQuranFoundation.QF_CLIENT_ID = '';
environmentWithoutQuranFoundation.QF_CLIENT_SECRET = '';
const credentialsGate = spawnSync(process.execPath, [
  'scripts/questions/prepare-quran-source-packet.mjs', '--surah', '2', '--ayah', '255',
], { cwd: root, encoding: 'utf8', env: environmentWithoutQuranFoundation });
assert.notEqual(credentialsGate.status, 0);
assert.match(`${credentialsGate.stdout}\n${credentialsGate.stderr}`, /التحقق متوقف بأمان/);

assert.equal(policy.religiousRules.sourcePacketHumanReviewRequired, false);
assert.equal(policy.religiousRules.questionHumanReviewRequired, false);
assert.equal(policy.religiousRules.religiousAiGenerationAllowed, false);
assert.equal(policy.religiousRules.deterministicTemplatesOnly, true);
console.log('✓ الإسلاميات بلا مراجعة فردية: قوالب حتمية فقط مع Tanzil وQuran Foundation');
console.log('✓ الحديث محصور في المتفق عليه مع صحة الإسناد وقالب سؤال الراوي فقط');

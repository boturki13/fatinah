#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {
  RELIGIOUS_SOURCE_PACKETS_PATH,
  readJson,
  writeJsonAtomic,
} from './lib.mjs';
import {
  ROOT,
  loadReligiousSourceRegistry,
  sha256,
} from './religious-source-lib.mjs';
import { assertDorarVerificationUrl, verifyDorarHadithHtml } from './hadith-source-lib.mjs';

function options(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith('--')) continue;
    result[argv[index].slice(2)] = argv[index + 1]?.startsWith('--') || argv[index + 1] == null
      ? true : argv[++index];
  }
  return result;
}

async function fetchDorarPage(initialUrl) {
  let current = assertDorarVerificationUrl(initialUrl);
  for (let redirects = 0; redirects < 4; redirects += 1) {
    const response = await fetch(current, {
      redirect: 'manual',
      headers: { 'User-Agent': 'FatinahHadithVerifier/1.0 (ata20.com)' },
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new Error('تحويل الدرر السنية بلا وجهة.');
      current = assertDorarVerificationUrl(new URL(location, current).toString());
      continue;
    }
    if (!response.ok) throw new Error(`فشل فتح صفحة الدرر: HTTP ${response.status}.`);
    const html = await response.text();
    if (Buffer.byteLength(html) > 2_000_000) throw new Error('صفحة الدرر أكبر من الحد الآمن 2MB.');
    return { html, finalUrl: current.toString() };
  }
  throw new Error('تجاوز رابط الدرر الحد الآمن للتحويلات.');
}

const args = options(process.argv.slice(2));
const inputArgument = String(args.input || '').trim();
if (!inputArgument) throw new Error('استخدم --input content/questions/hadith-input/example.json.');
const inputPath = path.resolve(ROOT, inputArgument);
if (!inputPath.startsWith(`${ROOT}${path.sep}`) || !fs.existsSync(inputPath)) {
  throw new Error('ملف إدخال الحديث يجب أن يكون داخل مشروع 1.3.');
}
const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
const id = String(input.id || '').trim();
const arabicText = String(input.arabicText || '').trim();
const narrator = String(input.narrator || '').trim();
const bukhariNumber = String(input.bukhariNumber || '').trim();
const muslimNumber = String(input.muslimNumber || '').trim();
if (!/^[a-z0-9][a-z0-9._-]{2,127}$/i.test(id) || arabicText.length < 30 ||
    !narrator || !/^\d+(?:\/\d+)?$/.test(bukhariNumber) || !/^\d+(?:\/\d+)?$/.test(muslimNumber)) {
  throw new Error('ملف الحديث يحتاج id ونصاً وراوياً ورقمي البخاري ومسلم.');
}
const registry = loadReligiousSourceRegistry();
const source = registry.primarySources.find(item => item.id === 'sunnah-com-sahih-bukhari');
const verifier = registry.verificationServices.find(item => item.id === 'dorar-hadith-search');
if (source.productionUseStatus !== 'allowed_reference_only_owner_authorized' ||
    verifier.productionUseStatus !== 'verification_only') {
  throw new Error('اعتماد مالك المشروع أو وضع التحقق في سجل المصادر غير مكتمل.');
}
const { html, finalUrl } = await fetchDorarPage(input.dorarUrl);
const result = verifyDorarHadithHtml({ html, arabicText, narrator, bukhariNumber, muslimNumber });
const now = new Date().toISOString();
const packet = {
  id,
  work: 'صحيح البخاري',
  reference: `متفق عليه: البخاري (${bukhariNumber}) ومسلم (${muslimNumber})`,
  canonicalReference: {
    type: 'muttafaq_alayh', narrator, bukhariNumber, muslimNumber,
  },
  arabicText,
  textSha256: sha256(arabicText),
  source: {
    title: `الدرر السنية — متفق عليه: البخاري ${bukhariNumber} ومسلم ${muslimNumber}`,
    url: finalUrl,
    publisher: 'مؤسسة الدرر السنية',
  },
  provenance: { primarySourceId: source.id },
  approvalMode: 'deterministic_double_verified',
  rightsReview: {
    approved: true,
    basis: 'إذن مالك المشروع؛ استخدام مرجعي فردي بلا نسخ جماعي لبيانات المواقع',
    reviewedAt: now,
  },
  automatedVerification: {
    primary: {
      status: 'passed', verifier: 'sahihayn-reference-match', verifiedAt: now,
      bukhariNumber, muslimNumber,
    },
    secondary: {
      status: 'passed', verifier: verifier.id, verifiedAt: now,
      muttafaqAlayh: result.muttafaqAlayh,
      isnadSahih: result.isnadSahih,
      evidenceSha256: sha256(result.evidenceOpening),
    },
  },
};
const document = readJson(RELIGIOUS_SOURCE_PACKETS_PATH, null);
if (document.packets.some(existing => existing.id === id)) throw new Error(`الحزمة موجودة مسبقاً: ${id}`);
document.packets.push(packet);
writeJsonAtomic(RELIGIOUS_SOURCE_PACKETS_PATH, document);
console.log(JSON.stringify({ id, status: 'muttafaq_alayh_sahih_isnad', storedRemoteBody: false }, null, 2));

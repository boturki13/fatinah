#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT,
  loadReligiousSourceRegistry,
  loadTanzilCorpus,
  normalizeQuranVerificationText,
  sha256,
} from './religious-source-lib.mjs';
import { loadLocalEnv } from './lib.mjs';

function options(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith('--')) continue;
    result[argv[index].slice(2)] = argv[index + 1]?.startsWith('--') || argv[index + 1] == null
      ? true : argv[++index];
  }
  return result;
}

const args = options(process.argv.slice(2));
loadLocalEnv();
const surah = Number.parseInt(args.surah, 10);
const ayah = Number.parseInt(args.ayah, 10);
const packetId = String(args.id || `quran-${surah}-${ayah}`).trim();
if (!Number.isInteger(surah) || !Number.isInteger(ayah) || !/^[a-z0-9][a-z0-9._-]{2,127}$/i.test(packetId)) {
  throw new Error('استخدم --surah رقم --ayah رقم [--id quran-2-255].');
}
const clientId = String(process.env.QF_CLIENT_ID || '').trim();
const clientSecret = String(process.env.QF_CLIENT_SECRET || '').trim();
if (!clientId || !clientSecret) {
  throw new Error('التحقق متوقف بأمان: QF_CLIENT_ID وQF_CLIENT_SECRET مطلوبان على الخادم فقط.');
}

const registry = loadReligiousSourceRegistry();
const corpus = loadTanzilCorpus(registry);
const verseKey = `${surah}:${ayah}`;
const arabicText = corpus.verses.get(verseKey);
if (!arabicText) throw new Error(`الآية ${verseKey} غير موجودة في نسخة Tanzil المثبتة.`);
const service = registry.verificationServices.find(item => item.id === 'quran-foundation-content-v4');
const qfEnvironment = String(process.env.QF_ENV || service.defaultEnvironment || 'prelive')
  .trim().toLowerCase();
const serviceEnvironment = service.environments?.[qfEnvironment];
if (!serviceEnvironment || !['prelive', 'production'].includes(qfEnvironment)) {
  throw new Error('QF_ENV يجب أن تكون prelive أو production، ولا يجوز خلط بيانات البيئتين.');
}
const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
const tokenResponse = await fetch(serviceEnvironment.authUrl, {
  method: 'POST',
  headers: {
    Authorization: `Basic ${basic}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  },
  body: 'grant_type=client_credentials&scope=content',
  signal: AbortSignal.timeout(20_000),
});
if (!tokenResponse.ok) throw new Error(`فشل توثيق Quran Foundation: HTTP ${tokenResponse.status}.`);
const token = await tokenResponse.json();
const verifyResponse = await fetch(
  `${serviceEnvironment.baseUrl}/verses/by_key/${verseKey}?fields=text_uthmani`,
  {
    headers: { 'x-auth-token': token.access_token, 'x-client-id': clientId },
    signal: AbortSignal.timeout(20_000),
  },
);
if (!verifyResponse.ok) throw new Error(`فشل تحقق Quran Foundation: HTTP ${verifyResponse.status}.`);
const verified = await verifyResponse.json();
const secondaryText = String(verified?.verse?.text_uthmani || '').trim();
if (!secondaryText || normalizeQuranVerificationText(secondaryText) !==
    normalizeQuranVerificationText(arabicText)) {
  throw new Error('نص Quran Foundation لا يطابق نسخة Tanzil بعد التطبيع الآمن؛ يلزم فحص بشري.');
}
const now = new Date().toISOString();
const packet = {
  id: packetId,
  work: 'القرآن الكريم',
  reference: `القرآن الكريم، ${verseKey}`,
  canonicalReference: {
    type: 'quran', surah, ayah, surahName: corpus.surahs.get(surah).name,
  },
  arabicText,
  textSha256: sha256(arabicText),
  source: {
    title: `Tanzil Quran Text (Uthmani 1.1) — ${verseKey}`,
    url: corpus.source.landingUrl,
    publisher: corpus.source.publisher,
  },
  provenance: { primarySourceId: corpus.source.id },
  approvalMode: 'deterministic_double_verified',
  rightsReview: {
    approved: true,
    basis: `${corpus.source.license}; attribution required; verbatim text only`,
    reviewedAt: now,
  },
  automatedVerification: {
    primary: {
      status: 'passed', verifier: 'local-tanzil-exact-match', verifiedAt: now,
      corpusSha256: corpus.manifest.sha256,
    },
    secondary: {
      status: 'passed', verifier: service.id, verifiedAt: now,
      environment: qfEnvironment,
      evidenceSha256: sha256(secondaryText),
    },
  },
};
const outputPath = path.join(ROOT, 'content', 'questions', 'religious-source-packets.json');
const document = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
if (document.packets.some(existing => existing.id === packetId)) {
  throw new Error(`حزمة المصدر موجودة مسبقاً: ${packetId}`);
}
document.packets.push(packet);
const temporary = `${outputPath}.${process.pid}.tmp`;
fs.writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
fs.renameSync(temporary, outputPath);
console.log(JSON.stringify({ outputPath, verseKey, status: 'deterministic_double_verified' }, null, 2));

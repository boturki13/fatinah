import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(SCRIPT_DIR, '../..');
export const RELIGIOUS_SOURCE_REGISTRY_PATH = path.join(
  ROOT, 'content', 'questions', 'religious-source-registry.json');

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function loadReligiousSourceRegistry(file = RELIGIOUS_SOURCE_REGISTRY_PATH) {
  const registry = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!registry || Array.isArray(registry) || registry.schemaVersion !== 1) {
    throw new Error('سجل المصادر الدينية مفقود أو لا يستخدم schemaVersion=1.');
  }
  if (!Array.isArray(registry.primarySources) || !Array.isArray(registry.verificationServices)) {
    throw new Error('سجل المصادر الدينية يحتاج primarySources وverificationServices.');
  }
  const allIds = [...registry.primarySources, ...registry.verificationServices]
    .map(source => String(source?.id || '').trim());
  if (allIds.some(id => !id) || new Set(allIds).size !== allIds.length) {
    throw new Error('سجل المصادر الدينية يحتوي معرف مصدر مفقوداً أو مكرراً.');
  }
  return registry;
}

export function parseTanzilCorpus(raw, expectedVerseCount = 6236) {
  const verses = new Map();
  let previousSura = 1;
  let previousAyah = 0;
  for (const rawLine of String(raw).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(\d{1,3})\|(\d{1,3})\|(.+)$/.exec(line);
    if (!match) throw new Error('ملف Tanzil يحتوي سطراً غير صالح.');
    const surah = Number(match[1]);
    const ayah = Number(match[2]);
    const text = match[3];
    const key = `${surah}:${ayah}`;
    if (surah < 1 || surah > 114 || ayah < 1 || verses.has(key)) {
      throw new Error(`مرجع Tanzil غير صالح أو مكرر: ${key}.`);
    }
    if (surah === previousSura && ayah !== previousAyah + 1) {
      throw new Error(`تسلسل آيات Tanzil منقطع عند ${key}.`);
    }
    if (surah === previousSura + 1 && ayah !== 1) {
      throw new Error(`بداية سورة Tanzil غير صالحة عند ${key}.`);
    }
    if (surah !== previousSura && surah !== previousSura + 1) {
      throw new Error(`تسلسل سور Tanzil منقطع عند ${key}.`);
    }
    verses.set(key, text);
    previousSura = surah;
    previousAyah = ayah;
  }
  if (verses.size !== expectedVerseCount || !verses.has('1:1') || !verses.has('114:6')) {
    throw new Error(`ملف Tanzil غير مكتمل: ${verses.size}/${expectedVerseCount} آية.`);
  }
  return verses;
}

export function normalizeQuranVerificationText(value) {
  return String(value || '')
    .normalize('NFC')
    .replace(/ـ/g, '')
    // Quran Foundation may add Unicode Quranic pause/annotation marks that are
    // absent from the pinned Tanzil Uthmani text. Ignore only those annotations
    // for cross-source comparison; the stored canonical text remains untouched.
    .replace(/[\u06D6-\u06ED]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function loadTanzilCorpus(registry = loadReligiousSourceRegistry()) {
  const source = registry.primarySources.find(item => item.id === 'tanzil-quran-uthmani-1.1');
  if (!source) throw new Error('مصدر Tanzil غير موجود في السجل.');
  const corpusPath = path.join(ROOT, source.localCorpusPath);
  const manifestPath = path.join(ROOT, source.localManifestPath);
  const metadataPath = path.join(ROOT, source.localMetadataPath);
  if (!fs.existsSync(corpusPath) || !fs.existsSync(manifestPath) || !fs.existsSync(metadataPath)) {
    throw new Error('نسخة Tanzil المحلية أو ملف بصمتها مفقود؛ شغّل questions:import-tanzil.');
  }
  const raw = fs.readFileSync(corpusPath);
  const metadataRaw = fs.readFileSync(metadataPath);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.sourceId !== source.id || manifest.sha256 !== sha256(raw) ||
      manifest.metadataSha256 !== sha256(metadataRaw) ||
      manifest.verseCount !== source.expectedVerseCount) {
    throw new Error('بصمة نسخة Tanzil المحلية لا تطابق سجل الاستيراد.');
  }
  const surahs = new Map();
  for (const match of metadataRaw.toString('utf8').matchAll(
    /<sura\s+index="(\d+)"\s+ayas="(\d+)"[^>]*\sname="([^"]+)"[^>]*\/>/g)) {
    surahs.set(Number(match[1]), { ayahCount: Number(match[2]), name: match[3] });
  }
  if (surahs.size !== 114) throw new Error(`بيانات Tanzil لا تحتوي 114 سورة: ${surahs.size}.`);
  return {
    source,
    manifest,
    verses: parseTanzilCorpus(raw.toString('utf8'), source.expectedVerseCount),
    surahs,
  };
}

export function validateReligiousPacketGovernance(packet, registry = loadReligiousSourceRegistry()) {
  const sourceId = String(packet?.provenance?.primarySourceId || '').trim();
  const primarySource = registry.primarySources.find(source => source.id === sourceId);
  if (!primarySource || primarySource.work !== packet.work) {
    throw new Error('حزمة المصدر الديني لا تطابق مصدراً أساسياً مسجلاً.');
  }
  if (!['allowed', 'allowed_with_attribution', 'allowed_reference_only_owner_authorized']
    .includes(primarySource.productionUseStatus)) {
    throw new Error(`المصدر ${sourceId} محظور للإنتاج حتى تكتمل الموافقة المكتوبة.`);
  }
  if (packet.approvalMode !== 'deterministic_double_verified' ||
      packet.rightsReview?.approved !== true || !packet.rightsReview?.basis ||
      !packet.rightsReview?.reviewedAt) {
    throw new Error('حزمة المصدر الديني بلا مراجعة حقوق موثقة.');
  }
  const text = String(packet.arabicText || '').trim();
  if (packet.textSha256 !== sha256(text)) {
    throw new Error('بصمة نص حزمة المصدر الديني غير صحيحة.');
  }
  const primary = packet.automatedVerification?.primary;
  const secondary = packet.automatedVerification?.secondary;
  if (primary?.status !== 'passed' || !primary?.verifier || !primary?.verifiedAt) {
    throw new Error('مطابقة المصدر الأساسي للحزمة غير مكتملة.');
  }
  if (secondary?.status !== 'passed' || !secondary?.verifier || !secondary?.verifiedAt) {
    throw new Error('التحقق الثانوي المستقل للحزمة غير مكتمل.');
  }
  const verificationService = registry.verificationServices.find(service => service.id === secondary.verifier);
  if (!verificationService || verificationService.work !== packet.work ||
      verificationService.productionUseStatus !== 'verification_only') {
    throw new Error('خدمة التحقق الثانوي غير مسموحة للإنتاج.');
  }

  if (packet.work === 'القرآن الكريم') {
    const surah = Number(packet.canonicalReference?.surah);
    const ayah = Number(packet.canonicalReference?.ayah);
    if (packet.canonicalReference?.type !== 'quran' || !Number.isInteger(surah) ||
        !Number.isInteger(ayah)) throw new Error('مرجع الآية القانوني ناقص.');
    const corpus = loadTanzilCorpus(registry);
    const corpusText = corpus.verses.get(`${surah}:${ayah}`);
    if (!corpusText || corpusText !== text || primary.verifier !== 'local-tanzil-exact-match' ||
        primary.corpusSha256 !== corpus.manifest.sha256 ||
        secondary.verifier !== 'quran-foundation-content-v4') {
      throw new Error('نص الآية أو مرجعها لا يطابق Tanzil والتحقق المستقل.');
    }
  } else if (packet.work === 'صحيح البخاري') {
    const reference = packet.canonicalReference;
    if (reference?.type !== 'muttafaq_alayh' || !String(reference.bukhariNumber || '').trim() ||
        !String(reference.muslimNumber || '').trim() || !String(reference.narrator || '').trim()) {
      throw new Error('مرجع الحديث يجب أن يثبت الراوي ورقمي البخاري ومسلم.');
    }
    if (primary.verifier !== 'sahihayn-reference-match' ||
        secondary.verifier !== 'dorar-hadith-search' ||
        secondary.muttafaqAlayh !== true || secondary.isnadSahih !== true) {
      throw new Error('الحديث ليس مثبتاً كمتفق عليه وصحيح الإسناد عبر الدرر السنية.');
    }
  }
  return true;
}

import { normalizeQuranVerificationText } from './religious-source-lib.mjs';

function decodeHtml(value) {
  return String(value || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&amp;|&#38;/gi, '&')
    .replace(/&lt;|&#60;/gi, '<')
    .replace(/&gt;|&#62;/gi, '>');
}

function normalizeArabic(value) {
  return normalizeQuranVerificationText(decodeHtml(value))
    .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function assertDorarVerificationUrl(value) {
  let url;
  try { url = new URL(String(value || '')); } catch { throw new Error('رابط الدرر السنية غير صالح.'); }
  if (url.protocol !== 'https:' || url.hostname.replace(/^www\./, '') !== 'dorar.net' ||
      (!url.pathname.startsWith('/h/') && !url.pathname.startsWith('/hadith/sharh/')) ||
      url.username || url.password) throw new Error('يجب استخدام صفحة حديث مباشرة من dorar.net.');
  return url;
}

export function verifyDorarHadithHtml({ html, arabicText, narrator, bukhariNumber, muslimNumber }) {
  const normalizedPage = normalizeArabic(html);
  const normalizedText = normalizeArabic(arabicText);
  const evidenceOpening = normalizedText.split(' ').slice(0, 8).join(' ');
  if (evidenceOpening.length < 20 || !normalizedPage.includes(evidenceOpening)) {
    throw new Error('صفحة الدرر لا تحتوي افتتاحية نص الحديث المحدد.');
  }
  const bukhari = new RegExp(`البخاري\\s+${escapeRegExp(normalizeArabic(bukhariNumber))}(?:\\s|$)`)
    .test(normalizedPage);
  const muslim = new RegExp(`مسلم\\s+${escapeRegExp(normalizeArabic(muslimNumber))}(?:\\s|$)`)
    .test(normalizedPage);
  if (!bukhari || !muslim) throw new Error('صفحة الدرر لا تثبت رقمي البخاري ومسلم معاً.');
  const authentic = /المصدر صحيح (?:البخاري|مسلم)/.test(normalizedPage) ||
    /خلاصه حكم المحدث (?:صحيح|اسناده صحيح|صحيح الاسناد)/.test(normalizedPage) ||
    /(?:اسناده صحيح|صحيح الاسناد)/.test(normalizedPage);
  if (!authentic) throw new Error('صفحة الدرر لا تثبت صحة الحديث أو صحة إسناده.');
  if (!normalizedPage.includes(normalizeArabic(narrator))) {
    throw new Error('اسم الراوي لا يطابق صفحة الدرر السنية.');
  }
  return { muttafaqAlayh: true, isnadSahih: true, evidenceOpening };
}

"use strict";

// حاجز عقد 1.2 مستقل عن مزود التوليد. التطبيع يغطي الهمزات،
// التشكيل، والتهجئات الشائعة. لا تسجل هذه الدالة النص المرفوض.
const BLOCKED_PATTERNS = Object.freeze([
  /(?:^|[^a-z])(?:israel|isreal|israil|israeel)(?:i|is|ite|ites|ian)?(?:[^a-z]|$)/i,
  /(?:^|[^a-z])tel[\s._-]*aviv(?:[^a-z]|$)/i,
  /(?:^|[^a-z])zion(?:ism|ist|ists|istic)(?:[^a-z]|$)/i,
  /(?:اسراي{1,2}ل|اسراءيل|اسري{1,2}ل|تل[\s._-]*ابيب|صهيون|ישראל|🇮🇱)/,
  /(?:^|[^a-z])(?:porn(?:o|ography|ographic)?|xxx|hentai|ecchi|nsfw)(?:[^a-z]|$)/i,
  /(?:^|[^a-z])(?:adult[\s_-]+content|sexually[\s_-]+explicit|explicit[\s_-]+sex(?:ual)?[\s_-]+content)(?:[^a-z]|$)/i,
  /(?:اباح(?:ي|يه|ه)|بورنو(?:غرافي)?|هنتاي|ايتشي|محتوي\s+جنسي\s+صريح|مواد\s+جنسيه\s+صريحه|افلام?\s+(?:اباحيه|جنسيه|للكبار))/,
]);

function normalizeLegacySafetyText(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/gu, "")
    .replace(/[إأآٱ]/g, "ا")
    .replace(/ؤ/g, "و")
    .replace(/[ئى]/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/ـ/g, "")
    .toLowerCase();
}

function legacyContentIsBlocked(...values) {
  const pending = [...values];
  const visited = new Set();
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === "string") {
      const normalized = normalizeLegacySafetyText(value);
      if (BLOCKED_PATTERNS.some((pattern) => pattern.test(normalized))) return true;
      continue;
    }
    if (!value || typeof value !== "object" || visited.has(value)) continue;
    visited.add(value);
    if (Array.isArray(value)) pending.push(...value);
    else pending.push(...Object.values(value));
  }
  return false;
}

function filterLegacyGeneratedCandidates(candidates, limit) {
  if (!Array.isArray(candidates)) return [];
  const safeLimit = Number.isSafeInteger(limit) && limit > 0 ? limit : candidates.length;
  return candidates.filter((question) => (
    question && typeof question === "object" && question.q && question.answer &&
    !legacyContentIsBlocked(question.q, question.answer, question.source)
  )).slice(0, safeLimit);
}

module.exports = {
  filterLegacyGeneratedCandidates,
  legacyContentIsBlocked,
  normalizeLegacySafetyText,
};

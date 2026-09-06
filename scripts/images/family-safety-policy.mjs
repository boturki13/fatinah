export const FAMILY_SAFETY_BLOCKED_REASONS = Object.freeze({
  'object-crossbow': 'explicit_weapon_crossbow',
  'object-compass-flask': 'explicit_weapon_accessory_powder_flask',
  'objectx-q39397': 'explicit_weapon_axe',
  'civilization-mughal': 'explicit_weapon_dagger',
  'generalx-q32489': 'explicit_weapon_knife',
  'treasurex-q2002185': 'preserved_human_remains',
  // معرّف ثابت يمنع عودة السجل حتى لو تغيرت بيانات الحقوق في المصدر.
  'treasurex-q145780': 'prohibited_israel_reference',
});

export const FAMILY_SAFETY_BLOCKED_CATALOG_IDS = Object.freeze(
  Object.keys(FAMILY_SAFETY_BLOCKED_REASONS),
);

export const EVERYDAY_NONVIOLENT_CONTEXT = 'everyday_nonviolent_kitchen_tool';
export const EVERYDAY_CONTEXT_ALLOWED_IDS = Object.freeze(['objectx-q599312']);

const BLOCKED_TEXT_CONTENT = /(?:إسرائيل|اسرائيل|إسرائيلي|اسرائيلي|تل[\s_-]+أبيب|تل[\s_-]+ابيب|(?:^|[^\p{L}])israel(?:i)?(?=$|[^\p{L}])|tel[\s_-]+aviv|ישראל|إباحي|اباحي|علاقة\s+جنسية|sexual\s+(?:intercourse|act)|porn(?:o|ographic|ography)?)/iu;

export function catalogId(value) {
  return String(value?.id || value || '').replace(/^img-v2-/, '');
}

export function isOfficialCountryFlag(category, value) {
  return category === 'أعلام منو؟' && catalogId(value).startsWith('flag-');
}

function safetyContext(value) {
  return value?.familySafety?.context
    || value?.review?.familySafetyContext
    || value?.familySafetyContext
    || '';
}

export function familySafetyDecision(category, value) {
  const id = catalogId(value);
  if (BLOCKED_TEXT_CONTENT.test(JSON.stringify(value || ''))) {
    return { allowed: false, reason: 'blocked_text_content' };
  }
  if (isOfficialCountryFlag(category, id)) {
    return { allowed: true, reason: 'official_country_flag' };
  }
  if (EVERYDAY_CONTEXT_ALLOWED_IDS.includes(id)) {
    const allowed = safetyContext(value) === EVERYDAY_NONVIOLENT_CONTEXT;
    return { allowed, reason: allowed ? EVERYDAY_NONVIOLENT_CONTEXT : 'everyday_context_not_confirmed' };
  }
  const reason = FAMILY_SAFETY_BLOCKED_REASONS[id];
  return { allowed: !reason, reason: reason || 'not_blocked' };
}

export function isFamilySafetyBlocked(category, value) {
  return !familySafetyDecision(category, value).allowed;
}

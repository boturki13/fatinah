export const BASE_CATEGORY_ORDER = Object.freeze([
  'من أنا؟', 'كرتون وأنمي', 'تقنية وإنترنت', 'اختر العبارة الصحيحة', 'سينما وأفلام عربية',
  'كرة القدم', 'علوم وطبيعة', 'اختراعات واكتشافات', 'الكويت', 'دول الخليج',
  'شخصيات تاريخية', 'مدن وعواصم', 'عملات العالم', 'فيزياء وكيمياء',
  'شعراء وأدباء عرب', 'روايات عالمية', 'مسرحيات خليجية', 'طيران ومطارات',
  'أندية ومنتخبات', 'اكتشف الكلمة', 'أحداث غيرت العالم', 'منظمات دولية',
]);

export const EXPANDED_CATEGORY_ORDER = Object.freeze([
  'كرة القدم العالمية', 'معلومات عامة', 'تاريخ وتراث الخليج', 'الفن الخليجي والعربي',
  'ألعاب الفيديو', 'تاريخ وحضارات', 'جسم الإنسان والصحة', 'مطابخ العالم',
  'سيارات ومركبات', 'اللغة العربية والأمثال',
]);

export const SUPPLEMENTAL_CATEGORY_ORDER = Object.freeze(['القرآن الكريم']);
export const CATEGORY_ORDER = Object.freeze([
  ...BASE_CATEGORY_ORDER,
  ...EXPANDED_CATEGORY_ORDER,
  ...SUPPLEMENTAL_CATEGORY_ORDER,
]);

export const REGULAR_CATEGORY_QUESTION_COUNT = 90;
export const CATEGORY_QUESTION_COUNTS = Object.freeze(Object.fromEntries(
  CATEGORY_ORDER.map(category => [
    category,
    category === 'القرآن الكريم' ? 12 : REGULAR_CATEGORY_QUESTION_COUNT,
  ]),
));
export const EXPECTED_QUESTION_COUNT = Object.values(CATEGORY_QUESTION_COUNTS)
  .reduce((total, count) => total + count, 0);

export function expectedQuestionPlacement(category, position) {
  const level = category === 'القرآن الكريم'
    ? Math.floor(position / 2) + 1
    : Math.floor(position / 30) * 2 + 1 + (position % 2);
  return {
    level,
    band: level <= 2 ? 'easy' : level <= 4 ? 'medium' : 'hard',
  };
}

export function expectedBandCount(category) {
  return category === 'القرآن الكريم' ? 4 : 30;
}

export function expectedLevelCount(category) {
  return category === 'القرآن الكريم' ? 2 : 15;
}

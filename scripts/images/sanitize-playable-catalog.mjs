#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isFamilySafetyBlocked } from './family-safety-policy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const catalogPath = path.join(root, 'content/image-questions/curated-commons.json');
const catalog = JSON.parse(await fs.readFile(catalogPath, 'utf8'));
const addedDifficulty = index => Math.min(6, 1 + Math.floor(index / 19));

const exclusions = {
  'شنو هالشي؟': /هاتسوني ميكو|شاشة الموت الزرقاء|دوولينجو|لغة الصفير|فوكالويد|كيوبيز|ضحك شرير|15 أيه آي|مهمة كبلر|واجهة متعددة الوسائط|بحيرة |كارلسبيرغ|الكأس المقدسة|إكسكاليبر|ميولنير|نجم الموت|صندوق باندورا|أبحاث|نظرية|مبدأ|خوارزمية|مبرهنة|ماركسية|لاسلطوية/,
  'تعرف على الصورة': /هاتسوني ميكو|شاشة الموت الزرقاء|دوولينجو|لغة الصفير|فوكالويد|ضحك شرير|الكأس المقدسة|فاكهة محرمة|تفاحة_الشقاق|15 أيه آي|بحيرة /,
  'كنوز الحضارات': /الكأس المقدسة|عملاق رودس|تمثال زوس|صندوق باندورا|نصب تذكاري ويكيبيديا|^قران$|إكسكاليبر|ميولنير/,
  'منو هاللاعب؟': /^شون كونري$/,
};
const excludedIds = new Set([
  // محتوى بصري غير مناسب للعبة عائلية: عري صريح أو أجسام مكشوفة في تماثيل وقطع أثرية.
  'civilization-greece',
  'civilization-benin',
  'objectx-q3400387',
  'treasurex-q131397',
  'treasurex-q151952',
  'treasurex-q152072',
  'treasurex-q179900',
  'treasurex-q211062',
  'treasurex-q205259',
  'treasurex-q214619',
  'treasurex-q235242',
  'treasurex-q408623',
  'treasurex-q412',
  'treasurex-q465762',
  'treasurex-q516435',
  'treasurex-q552113',
  'treasurex-q609292',
  'landmarkx-q840812',
  'landmarkx-q794007',
  'landmarkx-q281521',
  'landmarkx-q2347389',
  'landmarkx-q1326237',
  'landmarkx-q1323820',
  'landmarkx-q2472804',
  'landmarkx-q2606188',
  'landmarkx-q579585',
  'landmarkx-q766332',
  'generalx-q191985',
  // عناصر عامة غامضة، أو تكشف واجهة برنامج، أو لا تطابق الصورة بما يكفي للعب العادل.
  'generalx-q862505',
  'generalx-q9369297',
  'generalx-q1144423',
  'generalx-q1569889',
  'generalx-q1777287',
  'generalx-q828419',
  'generalx-q3090479',
  'generalx-q3195296',
  'generalx-q12229493',
  'generalx-q1779386',
  'generalx-q1041962',
  'generalx-q3359049',
  'generalx-q171663',
  'generalx-q39252',
  'generalx-q168713',
  'generalx-q81231',
  'generalx-q35926',
  // معاينة «شنو هالشي؟»: صور مكتوب عليها الجواب، أو تمثل مفهوماً لا الشيء نفسه.
  'objectx-q56155',
  'objectx-q872',
  'objectx-q13049940',
  'objectx-q49013',
  'objectx-q2366864',
  'objectx-q47369',
  // «كنوز الحضارات»: استبعد العملات الحديثة والمعالم/الجوائز الحديثة غير الأثرية.
  'treasurex-q9202',
  'treasurex-q172524',
  'treasurex-q201871',
  'treasurex-q190699',
  'treasurex-q4602',
  'treasurex-q241214',
  'treasurex-q79961',
  'treasurex-q82425',
  'treasurex-q7604504',
  'treasurex-q185382',
  'treasurex-q1601986',
  'treasurex-q212867',
  'treasurex-q321697',
  'treasurex-q37049',
  'treasurex-q492724',
  'treasurex-q6888715',
  // تكرار للأسد والدب القطبي الموجودين ضمن الصور الأساسية.
  'animalx-q140',
  'animalx-q33609',
  // صورة مباراة بعيدة لا تُظهر اللاعب المطلوب بوضوح.
  'playerx-q1879',
  'space-nasa-pia04499',
  'space-nasa-pia12235',
  'space-nasa-pia13517',
  'space-nasa-pia19838',
  'space-nasa-moon-to-mars-multidisciplinary-science',
  'space-nasa-pia21072',
  'space-nasa-pia08216',
  'space-nasa-pia04220',
  'space-nasa-moon-to-mars-operations',
  'space-nasa-pia11494',
  'space-nasa-moon-to-mars-infrastructure',
  'space-nasa-pia18826',
  'space-nasa-pia26563',
  'space-nasa-pia06604',
  'space-nasa-moon-to-mars-transportation-and-habitation',
  'space-nasa-pia15656',
  'space-nasa-pia09259',
  'space-nasa-pia12228',
  'space-nasa-grc-2019-c-09204',
  'space-nasa-pia16823',
  'space-nasa-pia12229',
  'space-nasa-grc-2019-c-09212',
  'space-nasa-pia08646',
  'space-nasa-pia12233',
  'space-nasa-pia18596',
  'space-nasa-grc-2019-c-09509',
  'space-nasa-grc-2019-c-09196',
  'space-nasa-pia18403',
  'space-nasa-grc-2019-c-09225',
  'space-nasa-pia20695',
  'space-nasa-pia07695',
  'space-nasa-pia17693',
  'space-nasa-pia01282',
  'space-nasa-pia19042',
  'space-nasa-pia14090',
  'space-nasa-pia13515',
  'space-nasa-pia18460',
  'space-nasa-pia17409',
  'space-nasa-pia16621',
  'space-nasa-astronomers-set-a-new-galaxy-distance-record-17389972462-o',
  'space-nasa-pia12174',
  'space-nasa-pia22233',
  'space-nasa-pia11805',
  'space-nasa-pia16622',
  'space-nasa-pia13034',
  'space-nasa-pia17304',
  'space-nasa-pia18429',
  'space-nasa-pia10106',
  'space-nasa-pia00129',
  'space-nasa-pia16623',
  'space-nasa-gsfc-20171208-archive-e001454',
  'space-nasa-pia10376',
  'space-nasa-pia04264',
  'space-nasa-pia12232',
  'space-nasa-pia11390',
  'space-nasa-201103190001hq',
  'space-nasa-arc-2010-acd10-0054-007',
  'space-nasa-pia18877',
  'space-nasa-arc-2010-acd10-0054-011',
  'space-nasa-pia23870',
  'space-nasa-arc-2010-acd10-0054-004',
  'space-nasa-arc-1977-ac77-0359',
  'space-nasa-pia04221',
  'space-nasa-arc-2010-acd10-0054-002',
  'space-nasa-pia13690',
]);

const answerCorrections = new Map(Object.entries({
  'generalx-q80019': 'كونترباص',
  'generalx-q45757': 'فاكهة الجاك فروت',
  'generalx-q26886': 'حصّادة زراعية',
  'generalx-q101761': 'سحّاب (سوستة)',
  'generalx-q779650': 'آلة الهليكون النحاسية',
  'generalx-q173056': 'نول نسيج',
  'generalx-q6566344': 'عصا الطبل',
  'generalx-q203789': 'مدفأة',
  'generalx-q188669': 'موقد نار',
  'generalx-q1758965': 'أورغن',
  'generalx-q17057067': 'دف',
  'generalx-q175029': 'مقياس سرعة الرياح',
  'generalx-q1326621': 'مصباح كهربائي',
  'generalx-q184292': 'كابل HDMI',
  'generalx-q7649196': 'صنج',
  'generalx-q3127686': 'قيثارة',
  'generalx-q216530': 'سلة مهملات',
}));

for (const category of catalog.categories) {
  const pattern = exclusions[category.name];
  const baseCount = category.name === 'تعرف على الصورة' ? 0 : 12;
  const base = category.items.slice(0, baseCount)
    .filter(item => !excludedIds.has(item.id) && !isFamilySafetyBlocked(category.name, item));
  const additionCandidates = category.items.slice(baseCount)
    .filter(item => !excludedIds.has(item.id)
      && !isFamilySafetyBlocked(category.name, item)
      && !pattern?.test(String(item.answer || '')));
  const missingBaseDifficulties = category.items.slice(0, baseCount)
    .filter(item => excludedIds.has(item.id) || isFamilySafetyBlocked(category.name, item))
    .map(item => Number(item.difficulty));
  const promoted = additionCandidates.splice(0, missingBaseDifficulties.length)
    .map((item, index) => ({ ...item, difficulty: missingBaseDifficulties[index] }));
  const additions = additionCandidates
    .map((item, index) => ({
      ...item,
      answer: answerCorrections.get(item.id) || item.answer,
      difficulty: addedDifficulty(index),
    }));
  const minimum = Number(category.target) - base.length + 8;
  if (additions.length < minimum) {
    throw new Error(`${category.name}: بقي ${additions.length} مرشحاً بعد التنقية، والمطلوب ${minimum}`);
  }
  category.items = [...base, ...promoted, ...additions];
  console.log(`✓ ${category.name}: ${category.items.length} بعد التنقية`);
}

catalog.version = 4;
await fs.writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeArabic, optionTooSimilar } from './categories/common.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUTPUT_PATH = path.join(ROOT, 'content/questions/structured-sources/common-arabic-proverbs.json');
const REVISION_ID = 269349;
const PAGE_URL = `https://ar.wikiquote.org/w/index.php?title=${encodeURIComponent('أمثال عربية')}&oldid=${REVISION_ID}`;
const API_URL = `https://ar.wikiquote.org/w/api.php?action=parse&format=json&formatversion=2&prop=wikitext&oldid=${REVISION_ID}&origin=*`;

// Ordered editorially by expected familiarity. Every entry must be present in the
// immutable upstream revision. The importer refuses to write a partial snapshot.
const PROVERBS = `رحلة الألف ميل تبدأ بخطوة
الوقت كالسيف إن لم تقطعه قطعك
دوام الحال من المحال
لكل مقام مقال
رب ضارة نافعة
رب أخ لك لم تلده أمك
الطيور على أشكالها تقع
عصفور باليد ولا عشرة على الشجرة
القرد في عين أمه غزالة
لا تؤجل عمل اليوم إلى الغد
من طلب العلا سهر الليالي
إذا غاب القط العب يا فار
خير الكلام ما قل ودل
إرضاء الناس غاية لا تدرك
الكلاب تعوي والقافلة تسير
لسانك حصانك إن صنته صانك وإن خنته خانك
رجع بخفي حنين
سبق السيف العذل
عذر أقبح من ذنب
فاقد الشيء لا يعطي
في الصيف ضيعت اللبن
يوم لك ويوم عليك
الباب اللي يجيلك منه الريح سده واستريح
البعيد عن العين بعيد عن القلب
العلم عند الصغر كالنقش على الحجر
عدو عاقل خير من صديق جاهل
من يطارد عصفورين يفقدهما معا
يا جبل ما يهزك ريح
مصائب قوم عند قوم فوائد
ما حك جلدك مثل ظفرك
إذا أردت أن تطاع فأمر بما يستطاع
كفى المرء فضلا أن تعد معايبه
لا يلدغ المؤمن من جحر واحد مرتين
لكل داء دواء يستطب به إلا الحماقة أعيت من يداويها
إذا حضر الماء بطل التيمم
إذا لم تستح فاصنع ما شئت
من اغتاب الناس عندك اغتابك عندهم
أفضل الجود العطاء قبل الموعد
لا تشغل نفسك بما لا تستطيع أن تغيره
ليست العبرة بالكم ولكن بالكيف
من طلب العلا من غير كد أضاع العمر في طلب المحال
لا تكن صلبا فتكسر ولا لينا فتعصر
بعض الشك من حسن الفطن
إن اللبيب من الإشارة يفهم والعبد يقرع بالعصا
إنك لا تجني من الشوك العنب
خادم القوم سيدهم
خذ الحكمة من أفواه المجانين
خير البر عاجله
ذاب الثلج وبان المرج
رب صدفة خير من ألف ميعاد
رب رمية من غير رام
زرعوا فأكلنا نزرع فيأكلون
العصا لمن عصى
في الليلة الظلماء يفتقد البدر
تلك القشة التي قصمت ظهر البعير
بلغ السيل الزبى
عند جهينة الخبر اليقين
قطعت جهيزة قول كل خطيب
أسمع جعجعة ولا أرى طحنا
يداك أوكتا وفوك نفخ
سرك أسيرك فإن أفشيته صرت أسيره
إذا أنت أكرمت الكريم ملكته وإن أنت أكرمت اللئيم تمردا
أخوك من صدقك النصيحة
من قال لا أعلم فقد أفتى
وقعت الفأس في الرأس
أكل عليه الدهر وشرب
أكلت يوم أكل الثور الأبيض
من استعجل شيئا قبل أوانه عوقب بحرمانه
شق عصا الطاعة
زوبعة في فنجان
لا تبك على اللبن المسكوب
لا تقول فول حتى يصير في المكيول
ما خفي كان أعظم
ما طار طير وارتفع إلا كما طار وقع
كريشة في مهب الريح
أظلم من الليل
أعدل من الميزان
أَمَرُّ من العلقم
أسرع من البرق
أضيق من ثقب الإبرة
سمن على عسل
سمك في ماء
يخاف من ظله
يخبط خبط عشواء
يؤذن في مالطة
فخار يكسر بعضه
فسر الماء بعد الجهد بالماء
زمار الحي لا يطرب
لكل أناس في بعيرهم خبر
إن البغاث بأرضنا يستنسر`.split('\n');

// These alternatives are an editorial part of the question source, not words
// sampled from unrelated proverbs. Each row is aligned with PROVERBS and gives
// three grammatically compatible, contextually plausible completions followed
// by the completion's morphology/POS class. The canonical Wikiquote wording is
// still the only correct answer.
const DISTRACTOR_SPECS = `بفكرة|بقرار|بمحاولة|prepositional-action
سبقك|غلبك|فاتك|past-verb-second-person
الخيال|الزوال|الثبات|abstract-noun
جواب|أسلوب|قرار|singular-noun
عابرة|خافية|قادمة|feminine-adjective
خالتك|جارتك|مرضعتك|female-kin-noun
تجتمع|تحلق|تعود|present-verb-feminine
السور|السطح|الطريق|place-noun
كنز|بطل|جميل|predicate-noun-or-adjective
المساء|العطلة|الصباح|time-noun
الأيام|الساعات|الشتاء|time-duration
ولد|صغير|شاطر|vocative-masculine
وأفاد|وأوجز|وأبان|coordinated-past-verb
تنتهي|تتحقق|تكتمل|present-verb-feminine
تمضي|تتقدم|تبتعد|present-verb-feminine
أضرك|فضحك|أهلكك|past-verb-object-pronoun
صاحبه|ضيفه|عدوه|possessed-person-noun
الصلح|الحكم|الخبر|abstract-noun
قول|صمت|تأخير|indefinite-noun
يساعد|يهب|ينفع|present-verb
الثمر|الظل|الحصاد|concrete-noun
لغيرك|ضدك|معك|prepositional-pronoun
وتراجع|وابتعد|وانصرف|coordinated-imperative
البيت|الحديث|اللقاء|context-noun
الخشب|الورق|الجدار|material-noun
كسول|متردد|ضعيف|person-adjective
تباعا|أخيرا|غالبا|adverb
مطر|صوت|عابر|subject-noun
خسائر|عبر|أخبار|plural-result-noun
طبيبك|صديقك|غيرك|possessed-person-noun
تعرف|تملك|تريد|present-verb
مناقبه|خصاله|مآثره|possessed-plural-noun
أبدا|سهوا|سريعا|adverb
يصاحبها|يجادلها|يتحملها|present-verb-object-pronoun
الكلام|الانتظار|الاجتهاد|verbal-noun
رأيت|سمعت|عرفت|verb
غدا|سريعا|جهرا|adverb
الثناء|الرحيل|الندم|event-noun
تملكه|تدركه|تفهمه|present-verb-object-pronoun
بالبداية|بالظاهر|بالثمن|prepositional-abstract-noun
النجاح|الثراء|الجاه|goal-noun
فتنكسر|فتضعف|فتتعثر|coordinated-result-verb
التروي|التدبير|النظر|abstract-noun
بالسوط|بالتوبيخ|بالتهديد|prepositional-instrument
الورد|الثمر|التفاح|plant-product-noun
دليلهم|عونهم|حارسهم|possessed-role-noun
الحكماء|الغرباء|البسطاء|human-plural-noun
كثيره|خالصه|أيسره|possessed-adjective
الطريق|العشب|الوجه|revealed-noun
تفكير|تخطيط|اختيار|planning-noun
قصد|قوس|تدريب|means-or-intent-noun
فيحصدون|فيعيشون|فيشكرون|coordinated-present-plural
ظلم|أخطأ|تمرد|past-verb
النور|الدليل|الرفيق|missed-noun
الحصان|الحمار|الثور|back-bearing-animal
الوادي|الجسر|الركب|limit-or-place-noun
المؤكد|الكامل|العاجل|information-adjective
متحدث|حكيم|شاهد|person-role-noun
خبزا|حصادا|عملا|perceived-output-noun
صاح|سكت|اعترف|past-verb
ضحيته|خادمه|حارسه|possessed-role-noun
تكبر|تمادى|جفا|past-verb
الحقيقة|الخبر|الوعد|speech-object-noun
تعلم|سأل|توقف|past-verb
القدم|الأرض|الباب|body-or-place-noun
ومضى|وتقلب|وتغير|coordinated-past-verb
الكبير|الأخير|الوحيد|masculine-adjective
بإبعاده|بانتظاره|بتكليفه|prepositional-consequence
الجماعة|الوحدة|التحالف|collective-noun
مجلس|طريق|مكان|container-noun
الفاسد|الضائع|البارد|masculine-adjective
السوق|المخزن|الكيس|destination-noun
أبعد|أخطر|أقدم|comparative-adjective
عاد|هبط|استقر|past-verb
النسيم|الإعصار|العاصفة|wind-noun
الكهف|القبر|الغيم|dark-noun
القاضي|القانون|الحكم|justice-noun
السم|الصبر|الدواء|bitter-noun
الريح|الصوت|السهم|fast-noun
المفتاح|الجدار|المنخل|object-with-opening
خبز|تمر|قشطة|food-noun
شبكة|قارب|سوق|fish-context-noun
صوته|نفسه|مستقبله|possessed-noun
شديد|متواصل|مضطرب|masculine-adjective
الصحراء|السوق|الميناء|place-noun
الزجاج|الحجر|غيره|object-noun
بالشرح|بالقول|بالكلام|prepositional-explanation
يسمع|ينجح|يشتهر|present-verb
نصيب|أثر|شأن|abstract-noun
يتكبر|يتمرد|يتصدر|present-verb`.split('\n').map((row, index) => {
  const fields = row.split('|');
  if (fields.length !== 4) throw new Error(`Malformed distractor row ${index + 1}`);
  return { distractors: fields.slice(0, 3), completionClass: fields[3] };
});

const FUNCTION_WORDS = new Set([
  'من', 'في', 'علي', 'الي', 'عن', 'ما', 'لا', 'ان', 'اذا', 'ثم', 'او',
  'هو', 'هي', 'هذا', 'هذه', 'الذي', 'التي', 'كل', 'قد', 'لم', 'لن',
].map(normalizeArabic));

function validateEditorialDistractors() {
  if (PROVERBS.length !== 90 || DISTRACTOR_SPECS.length !== PROVERBS.length) {
    throw new Error(`Expected 90 aligned proverb rows; got ${PROVERBS.length}/${DISTRACTOR_SPECS.length}`);
  }
  const optionFrequency = new Map();
  const triplets = new Set();
  for (let index = 0; index < PROVERBS.length; index += 1) {
    const answer = PROVERBS[index].trim().split(/\s+/u).at(-1);
    const { distractors, completionClass } = DISTRACTOR_SPECS[index];
    if (!completionClass || distractors.length !== 3) throw new Error(`Incomplete editorial row ${index + 1}`);
    const options = [answer, ...distractors];
    if (new Set(options.map(normalizeArabic)).size !== 4) {
      throw new Error(`Repeated option in editorial row ${index + 1}`);
    }
    if (options.some(option => normalizeArabic(option).length < 3 || FUNCTION_WORDS.has(normalizeArabic(option)))) {
      throw new Error(`Function/short word used in editorial row ${index + 1}`);
    }
    for (let left = 0; left < options.length; left += 1) {
      for (let right = left + 1; right < options.length; right += 1) {
        if (optionTooSimilar(options[left], options[right])) {
          throw new Error(`Near-identical options in editorial row ${index + 1}: ${options[left]} / ${options[right]}`);
        }
      }
    }
    const triplet = distractors.map(normalizeArabic).sort().join('|');
    if (triplets.has(triplet)) throw new Error(`Repeated distractor triplet in editorial row ${index + 1}`);
    triplets.add(triplet);
    for (const distractor of distractors) {
      const key = normalizeArabic(distractor);
      optionFrequency.set(key, (optionFrequency.get(key) || 0) + 1);
    }
  }
  const overused = [...optionFrequency].filter(([, count]) => count > 2);
  if (overused.length) throw new Error(`Overused distractors: ${JSON.stringify(overused)}`);
}

validateEditorialDistractors();

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stripWikiMarkup(value) {
  return String(value)
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/gu, '$2')
    .replace(/\[\[([^\]]+)\]\]/gu, '$1')
    .replace(/\{\{[^}]+\}\}/gu, '')
    .replace(/<[^>]*>/gu, '')
    .replace(/'{2,}/gu, '')
    .replace(/^\*\s*/u, '')
    .trim();
}

function normalize(value) {
  return stripWikiMarkup(value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u064b-\u065f\u0670]/gu, '')
    .replace(/الشئ/gu, 'الشيء')
    .replace(/جعجة/gu, 'جعجعة')
    .replace(/[إأآٱ]/gu, 'ا')
    .replace(/ى/gu, 'ي')
    .replace(/ة/gu, 'ه')
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

function normalizeEvidence(value) {
  return normalize(value)
    .replace(/الشئ/gu, 'الشيء')
    .replace(/جعجه/gu, 'جعجعه');
}

let wikitext = null;
let sourceLines = null;
let cachedSnapshot = null;
try {
  const response = await fetch(API_URL, { headers: { 'user-agent': 'FatinahQuestionImporter/2.0' } });
  if (!response.ok) throw new Error(`Wikiquote HTTP ${response.status}`);
  const payload = await response.json();
  if (payload?.parse?.revid !== REVISION_ID || typeof payload?.parse?.wikitext !== 'string') {
    throw new Error('Wikiquote returned an unexpected revision payload.');
  }
  wikitext = payload.parse.wikitext;
  sourceLines = wikitext.split(/\r?\n/u).filter(line => /^\*\s/u.test(line));
} catch (error) {
  // The immutable revision cannot change. A previously generated snapshot is
  // therefore a safe retry cache when Wikiquote throttles the importer, as
  // long as its revision identity, digest, and all 90 excerpts validate.
  if (!fs.existsSync(OUTPUT_PATH)) throw error;
  cachedSnapshot = JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf8'));
  if (cachedSnapshot.sourceRevisionId !== REVISION_ID
      || cachedSnapshot.sourceUrl !== PAGE_URL
      || !/^[a-f0-9]{64}$/u.test(cachedSnapshot.sourceRevisionWikitextSha256 || '')
      || !Array.isArray(cachedSnapshot.records)
      || cachedSnapshot.records.length !== PROVERBS.length) throw error;
  console.warn(`Wikiquote unavailable (${error.message}); reused validated immutable revision ${REVISION_ID}.`);
}

const records = PROVERBS.map((proverb, index) => {
  let sourceLine;
  if (sourceLines) {
    const needle = normalize(proverb);
    const matches = sourceLines.filter(line => normalize(line).includes(needle));
    if (matches.length === 0) {
      throw new Error(`Source line not found for proverb ${index + 1}: ${proverb}`);
    }
    sourceLine = matches
      .map(stripWikiMarkup)
      .sort((left, right) => left.length - right.length || left.localeCompare(right, 'ar'))[0];
  } else {
    const cachedRecord = cachedSnapshot.records[index];
    if (cachedRecord?.sourceRecordId !== `arabic-proverb-${String(index + 1).padStart(3, '0')}`
        || cachedRecord.proverb !== proverb
        || !normalizeEvidence(cachedRecord.sourceExcerpt).includes(normalizeEvidence(proverb))) {
      throw new Error(`Cached source evidence failed for proverb ${index + 1}: ${proverb}`);
    }
    sourceLine = cachedRecord.sourceExcerpt;
  }
  return {
    sourceRecordId: `arabic-proverb-${String(index + 1).padStart(3, '0')}`,
    familiarityRank: index + 1,
    proverb,
    sourceExcerpt: sourceLine,
    distractors: DISTRACTOR_SPECS[index].distractors,
    completionClass: DISTRACTOR_SPECS[index].completionClass,
    distractorPolicy: 'editorial_contextual_completion_v1',
  };
});

const output = {
  schemaVersion: 2,
  sourceProfile: 'curated_immutable_revision_v2',
  sourceTitle: 'أمثال عربية شائعة — نسخة ثابتة قابلة للتحقق',
  sourceUrl: PAGE_URL,
  sourceRevisionId: REVISION_ID,
  sourceRevisionTimestamp: '2026-08-23T18:06:47Z',
  sourceRevisionWikitextSha256: wikitext
    ? sha256(wikitext) : cachedSnapshot.sourceRevisionWikitextSha256,
  license: 'CC BY-SA 4.0',
  selectionPolicy: '90 مثلاً واضحاً وآمناً، مرتبة تحريرياً من الأشهر إلى الأقل شيوعاً، ومطابقة آلياً مع نسخة المصدر الثابتة. لكل مثل ثلاثة مشتتات تحريرية تلائم تركيب الجملة ودلالتها العامة من دون أن تطابق الصيغة الموثقة.',
  distractorPolicy: {
    id: 'editorial_contextual_completion_v1',
    rule: 'ثلاثة إكمالات من الفئة النحوية/الصرفية نفسها تقريباً، سليمة في السياق، غير مطابقة أو شديدة الشبه، وليست كلمات وظيفية.',
    maximumGlobalDistractorFrequency: 2,
    uniqueTripletsRequired: true,
  },
  records,
};

fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`);
console.log(`Wrote ${records.length} verified proverb records to ${path.relative(ROOT, OUTPUT_PATH)}`);

# عزل API الإصدار 1.3

هذا العقد يسمح بتطوير واختبار 1.3 من دون تغيير سلوك تطبيق 1.2 المنشور. لا
يستبدل وجود `v2` فصل البنية التحتية: يجب أن يكون لـstaging مضيف ومشروع Firebase
وقاعدة Firestore وRevenueCat webhook مستقلة عن production.

## عقد المسارات

| طلب العميل | العقد الفعلي | الغرض |
|---|---:|---|
| `/api/...` بلا رأس إصدار | v1 | التوافق مع تطبيق 1.2 |
| `/api/v1/...` | v1 | اسم صريح لاختبارات التوافق والخدمات الداخلية |
| `/api/v2/...` | v2 | تطبيق 1.3 وstaging |
| `/api/...` مع `X-Fatinah-API-Version: 2` | v2 | انتقال 1.3 بإضافة رأس واحد |

المسار الصريح أعلى أولوية. إذا طلب المسار `/api/v1/...` والرأس `2`، يرفض
الخادم الطلب بـ`400 unsupported_api_version` بدلاً من تنفيذ عقد غير مقصود.
كما يرفض الرأس المكرر أو المركب (`1, 2`) لتجنب اختلاف تفسيره بين الوسطاء.
كل استجابة JSON تعلن `X-Fatinah-API-Version` و`X-Fatinah-Environment`، وتوجد
صفحة قدرات غير سرية في `GET /api/version` ونسختيها `/api/v1/version` و
`/api/v2/version`.

المسارات الحالية لا تُنسخ في ملفين: يزيل middleware بادئة الإصدار ثم يشغّل
المعالج الحالي. لذلك يحافظ v1 وv2 على مخطط الاستجابة نفسه ما لم يوثّق تغيير
متعمد لاحقاً. يجب إضافة اختبار عقد قبل أي اختلاف من هذا النوع.
وفي v2 تحديداً، أي مسار غير مسجل في `V2_ROUTE_FEATURES` يُرفض افتراضياً؛ إضافة
معالج جديد لا تجعله متاحاً في v2 قبل تسجيله واختباره صراحةً.

ميزات 1.3 الجديدة (`app-attest` و`free-round` و`questions/seen` و
`questions/report` و`metrics/event`) هي **v2 فقط**. يعيد
المسار غير المرقم أو `/api/v1/...` لها `404 v2_route_required`؛ فلا يستطيع
العميل خفض رقم العقد لتجاوز App Check أو App Attest أو DeviceCheck. تبقى فقط
المسارات التي استخدمها تطبيق 1.2 متاحة في v1 طوال نافذة دعمه.

## التوليد القديم

- Cloud Function باسم `generateQuestions` هو عقد v1 لتطبيق 1.2، ويبقى عاملاً
  خلف تحقق Firebase ID token، وفحص الاشتراك، وحد معدل موزع في Firestore.
- `POST /api/generate` و`POST /api/v1/generate` يمران إلى عقد v1 نفسه بعد
  تحقق الخادم، ولا يعيدان `410` أثناء نافذة الدعم.
- الاسم المنفصل `generateQuestionsV2` والمسار `/api/v2/generate` يعيدان `410`
  لأن 1.3 يستخدم بنك الأسئلة المراجع. هذا لا يغير الاسم الذي يستدعيه 1.2.
- إذا أُرسل الرأس `2` إلى اسم `generateQuestions` القديم، يرفضه قبل المصادقة
  أو أي اتصال بـClaude. وبالمثل يرفض اسم v2 رأس v1. غياب الرأس عن الاسم القديم
  يبقى v1 حفاظاً على 1.2.
- التوليد opt-in: يجب ضبط `FATINAH_V1_AI_GENERATION_ENABLED=true` صراحةً في
  production طوال دعم 1.2. غياب القيمة أو `false` يعيد
  `503 legacy_feature_disabled` ولا يشغّل تكلفة AI بالخطأ.

## البيئات وأعلام المزايا

اضبط `FATINAH_ENVIRONMENT` على واحدة فقط: `local` أو `staging` أو
`production`. الغياب يعلن `unconfigured` والقيمة غير المعروفة تعلن `invalid`؛
في الحالتين تبقى أعلام v2 مغلقة ولا تتفعّل أي وجهة production خارجية. يجب
تصحيح القيمة قبل النشر.

أعلام v2 مفعلة افتراضياً في local/staging، ومغلقة افتراضياً في production:

```text
FATINAH_V2_FEATURE_APP_ATTEST_ENABLED
FATINAH_V2_FEATURE_FREE_ROUND_ENABLED
FATINAH_V2_FEATURE_QUESTION_HISTORY_ENABLED
FATINAH_V2_FEATURE_QUESTION_BANK_ENABLED
FATINAH_V2_FEATURE_QUESTION_REPORTS_ENABLED
FATINAH_V2_FEATURE_METRICS_ENABLED
FATINAH_V2_FEATURE_IOS_DIAGNOSTICS_ENABLED
FATINAH_V2_FEATURE_REVENUECAT_WEBHOOK_ENABLED
```

لا تؤثر هذه الأعلام في v1. فعّل كل علم في production بعد نجاح اختبار staging
للمسار نفسه. `FIREBASE_APP_CHECK_ENFORCE` هو مفتاح v2 التوافقي؛ ويمكن ضبط
السياسة صراحةً لكل عقد عبر:

```text
FATINAH_V1_APP_CHECK_ENFORCE=false
FATINAH_V2_APP_CHECK_ENFORCE=true
```

يبقى v1 غير مفروض افتراضياً لأن تطبيق 1.2 لا يرسل App Check. لا تفعّل إنفاذ
v1 إلا بعد انتهاء نافذة دعمه.

## اختلافات v2 الأمنية المقصودة

- الجولة المجانية في v2 تتطلب أولاً تسجيل مفتاح App Attest مباشر عبر
  `status → challenge → attest`. كل استعلام/مطالبة لاحقة يأخذ تحدياً جديداً
  ويوقع `clientDataHash`؛ يربط الخادم الـassertion بهوية الحساب وبصمتي رمزي
  DeviceCheck ويحدّث عداد المفتاح ذرياً، لذلك يُرفض replay أو تبديل الرمز.
- يتطلب الإكمال رمزي DeviceCheck جديدين: واحداً للاستعلام وآخر للتحديث. يحيط
  الخادم `query_two_bits → update_two_bits → durable write` بـlease عالمي ذري
  في Firestore حتى لا تنجح مطالبتان متزامنتان على نسختين من خادم autoscale.
  غياب Firestore في production يفشل مغلقاً.
- `POST /api/v2/ios-diagnostics` يقبل فقط `schemaVersion=2` و
  `privacyScope=anonymous`، ويرفض حقلي `uid` و`idToken`. يحميه App Check
  إلزامياً، وتُخزن تقارير MetricKit في مجموعة مستقلة بلا معرّف حساب. يبقى عقد
  v1 الموثق بالحساب كما هو فقط للتوافق الخلفي.
- يسمح رد CORS في v2 برؤوس `X-DeviceCheck-Token` و`X-App-Attest-*` صراحةً لأن
  استعلام الأهلية من `capacitor://localhost` يسبقه preflight على الجهاز.

## فصل staging عن production

لا تشارك الموارد التالية بين البيئتين:

| المورد | staging | production |
|---|---|---|
| المضيف | نطاق staging مستقل | `ata20.com` |
| Firebase project / service account | مشروع اختبار | مشروع الإنتاج |
| Firestore database | قاعدة اختبار | قاعدة الإنتاج المحددة |
| RevenueCat app + webhook secret | Sandbox | Production |
| Secret Manager | أسرار staging | أسرار production |
| SQLite/volume/outbox | وحدة تخزين مستقلة | وحدة تخزين production |

لا تنسخ قيماً سرية إلى ملفات `.env` في Git. أنشئ الأسماء نفسها داخل مخزن أسرار
كل بيئة، واربط أقل صلاحيات لازمة. يشمل ذلك `ANTHROPIC_API_KEY` اللازم لعقد
v1 القديم فقط؛ اسم v2 لا يربط هذا السر. `FATINAH_V1_GENERATION_URL` و
`FATINAH_V1_SUBSCRIPTION_STATUS_URL` يجب أن يشيرا إلى خدمات البيئة نفسها؛ لا
تسمح لـstaging بالقراءة من اشتراكات production أو استدعاء دالتها.
لا توجد وجهة production افتراضية لهذين المتغيرين في staging/local؛ غيابهما
يعيد خطأ إعداد آمناً بدلاً من الاتصال ببيانات حقيقية.
كما يجب ضبط allowlist المضيف المقابل في staging؛ لا يكفي أن يكون الرابط HTTPS:
`FATINAH_V1_GENERATION_ALLOWED_HOSTS` و
`FATINAH_V1_SUBSCRIPTION_ALLOWED_HOSTS`. production يستخدم allowlist ثابتاً
للمضيفين الحاليين. تُرفض العناوين private/link-local وإعادة التوجيه تلقائياً.

مثال أسماء فقط، بلا قيم اعتماد:

```text
FATINAH_ENVIRONMENT=staging
FATINAH_DURABLE_STORAGE=required
FATINAH_V1_AI_GENERATION_ENABLED=true
FATINAH_V1_GENERATION_URL=https://staging.example.invalid/generateQuestions
FATINAH_V1_GENERATION_ALLOWED_HOSTS=staging.example.invalid
FATINAH_V1_SUBSCRIPTION_STATUS_URL=https://staging.example.invalid/api/v1/subscription/status
FATINAH_V1_SUBSCRIPTION_ALLOWED_HOSTS=staging.example.invalid
FATINAH_V1_APP_CHECK_ENFORCE=false
FATINAH_V2_APP_CHECK_ENFORCE=true
FATINAH_V2_APP_ATTEST_ENFORCE=true
FATINAH_APP_ATTEST_TTL_CONFIGURED=true
FATINAH_IOS_DIAGNOSTICS_TTL_CONFIGURED=true
FATINAH_DISTRIBUTED_RATE_LIMIT_CONFIGURED=true
FATINAH_DISTRIBUTED_RATE_LIMIT_TTL_CONFIGURED=true
FATINAH_V2_FEATURE_APP_ATTEST_ENABLED=true
FATINAH_V2_FEATURE_FREE_ROUND_ENABLED=true
FATINAH_V2_FEATURE_QUESTION_HISTORY_ENABLED=true
FATINAH_V2_FEATURE_QUESTION_BANK_ENABLED=true
FATINAH_V2_FEATURE_QUESTION_REPORTS_ENABLED=true
FATINAH_V2_FEATURE_METRICS_ENABLED=true
FATINAH_V2_FEATURE_IOS_DIAGNOSTICS_ENABLED=true
FATINAH_V2_FEATURE_REVENUECAT_WEBHOOK_ENABLED=true
APPLE_APP_ATTEST_APP_ID_PREFIX=<App-ID-Prefix>
APPLE_APP_ATTEST_BUNDLE_ID=com.fatinah.game
```

العلم الأول يفعّل حد Firestore، والثاني شهادة تشغيلية منفصلة بأن TTL مفعل على
`distributed_rate_limits.expire_at` في قاعدة `fatinah-native`. الخادم نفسه
ينفذ compare-and-set عبر `updateTime`؛ لذلك ترى نسخ Replit Autoscale نافذة
واحدة. إذا تعذرت القراءة/الكتابة أو غاب أي علم في production تُرفض العملية
(fail-closed)، ولا يستخدم العداد المحلي.

## ترتيب النشر الآمن لاحقاً

لا تنفّذ هذه الخطوات من جهاز تطوير قبل إنشاء موارد staging الخارجية:

1. شغّل هجرات additive فقط: جداول/حقول جديدة قابلة للـnull أو لها default.
   لا تحذف أو تعيد تسمية حقول يقرأها v1.
2. انشر الخادم المتوافق الذي يدعم unversioned وv1 وv2، مع أعلام v2 مغلقة في
   production. قبل نشر عقد v1 اضبط `FATINAH_ENVIRONMENT=production` و
   `FATINAH_V1_AI_GENERATION_ENABLED=true` صراحةً؛ وإلا يفشل التوليد مغلقاً.
3. اختبر 1.2 على المسارات غير المرقمة واختبر 1.3 على staging/v2.
4. انشر `generateQuestions` المتوافق قبل أي تغيير لتطبيق 1.2، ولا تستبدل
   الاسم بـ`generateQuestionsV2`.
5. فعّل أعلام v2 واحداً واحداً في production، ثم اطرح TestFlight 1.3.
6. التراجع يكون بإغلاق علم v2 أو إعادة 1.3 إلى v1؛ لا يحتاج تعطيل v1 أو عكس
   هجرة destructive.

احتفظ بقراءة وكتابة مزدوجة أو fallback لأي حقل جديد حتى تصبح أقل نسخة مدعومة
هي 1.3. بعد انتهاء نافذة دعم 1.2، اتخذ قرار تقاعد منفصلاً ومراقباً؛ لا تستخدم
`410` على الاسم القديم أثناء وجود مستخدمين عليه.

## تحقق محلي

```bash
python3 tests/test_api_version_contract.py
node tests/test_function_version_contract.mjs
npm run test:server
node --check functions/index.js
```

اختبار العقد يثبت تطابق unversioned مع v1، اختيار v2 بالمسار والرأس، عزل
الأعلام وApp Check، وبقاء اسم `generateQuestions` القديم بعيداً عن `410`،
ورفض وصول v2 إلى Claude أو إلى وجهة production غير مقصودة.

قبل أي نشر production، شغّل كذلك البوابة الموضحة في
`PRODUCTION_RELEASE_GATE.md` داخل بيئة النشر بعد حقن الأسرار من مخزنها. لا
يشغّل CI العام البوابة بقيم production؛ بل يختبر عقدها فقط كي لا تُنسخ الأسرار
إلى GitHub أو السجلات.

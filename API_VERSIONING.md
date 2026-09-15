# عزل API الإصدار 1.4

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

ميزات 1.4 الجديدة (`game/packs/*` و`game/questions/report` و`admin/*`) مع
`app-attest` و`free-round` و`metrics/event` هي **v2 فقط**. يعيد
المسار غير المرقم أو `/api/v1/...` لها `404 v2_route_required`؛ فلا يستطيع
العميل خفض رقم العقد لتجاوز App Check أو App Attest أو DeviceCheck. تبقى فقط
المسارات التي استخدمها تطبيق 1.2 متاحة في v1 طوال نافذة دعمه.

## البنك والتوليد القديمان

- حُذف البنك القديم وأدوات الاستيراد والتوليد من المستودع والخادم والعميل.
- كل نسخ `/api/questions/*` و`/api/generate` تعيد `410 question_content_removed`.
- لا يوجد fallback محلي أو مسار ذكاء اصطناعي يعيد تكوين محتوى قديم.
- البنك الجديد مستقل في `question_platform.py` ولا يُقرأ إلا عبر حزم اللعب.

## البيئات وأعلام المزايا

اضبط `FATINAH_ENVIRONMENT` على واحدة فقط: `local` أو `staging` أو
`production`. الغياب يعلن `unconfigured` والقيمة غير المعروفة تعلن `invalid`؛
في الحالتين تبقى أعلام v2 مغلقة ولا تتفعّل أي وجهة production خارجية. يجب
تصحيح القيمة قبل النشر.

أعلام v2 مفعلة افتراضياً في local/staging، ومغلقة افتراضياً في production:

```text
FATINAH_V2_FEATURE_APP_ATTEST_ENABLED
FATINAH_V2_FEATURE_FREE_ROUND_ENABLED
FATINAH_V2_FEATURE_GAME_PACKS_ENABLED
FATINAH_V2_FEATURE_QUESTION_ADMIN_ENABLED
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
كل بيئة، واربط أقل صلاحيات لازمة. لا يحتاج خادم 1.4 مفتاح OpenAI أو Anthropic؛
إدخالهما إلى عملية الإنتاج توسيع غير ضروري للصلاحيات. يجب فصل Firebase وSMTP
وRevenueCat في staging عن production.

مثال أسماء فقط، بلا قيم اعتماد:

```text
FATINAH_ENVIRONMENT=staging
FATINAH_DURABLE_STORAGE=required
FATINAH_V1_APP_CHECK_ENFORCE=false
FATINAH_V2_APP_CHECK_ENFORCE=true
FATINAH_V2_APP_ATTEST_ENFORCE=true
FATINAH_APP_ATTEST_TTL_CONFIGURED=true
FATINAH_IOS_DIAGNOSTICS_TTL_CONFIGURED=true
FATINAH_DISTRIBUTED_RATE_LIMIT_CONFIGURED=true
FATINAH_DISTRIBUTED_RATE_LIMIT_TTL_CONFIGURED=true
FATINAH_V2_FEATURE_APP_ATTEST_ENABLED=true
FATINAH_V2_FEATURE_FREE_ROUND_ENABLED=true
FATINAH_V2_FEATURE_GAME_PACKS_ENABLED=true
FATINAH_V2_FEATURE_QUESTION_ADMIN_ENABLED=true
FATINAH_V2_FEATURE_QUESTION_REPORTS_ENABLED=true
FATINAH_V2_FEATURE_METRICS_ENABLED=true
FATINAH_V2_FEATURE_IOS_DIAGNOSTICS_ENABLED=true
FATINAH_V2_FEATURE_REVENUECAT_WEBHOOK_ENABLED=true
APPLE_APP_ATTEST_APP_ID_PREFIX=<App-ID-Prefix>
APPLE_APP_ATTEST_BUNDLE_ID=com.fatinah.game
SMTP_HOST=smtp.staging.example.invalid
SMTP_PORT=587
SMTP_FROM=reports@staging.example.invalid
SMTP_USE_TLS=true
SMTP_USE_SSL=false
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
2. انشر الخادم المتوافق الذي يدعم unversioned وv1 وv2، مع أعلام منصة 1.4
   مغلقة في production، وتأكد أن المسارات القديمة تعيد 410.
3. اختبر النسخة المنشورة الحالية، ثم اختبر 1.4 على staging/v2.
4. فعّل `question_admin` للمشغل أولاً وأدخل الدفعات الموثقة حتى 600 سؤال.
5. فعّل `game_packs` و`question_reports` في production بعد smoke test، ثم اطرح TestFlight 1.4.
6. التراجع يكون بإغلاق علم v2؛ لا تعكس هجرة البيانات ولا تعيد البنك القديم.

احتفظ بالتوافق مع الحساب والاشتراك للنسخة المنشورة، لكن لا يوجد fallback
لمحتوى الأسئلة القديم بعد قرار حذفه من 1.4.

## تحقق محلي

```bash
python3 tests/test_production_release_gate.py
node tests/question_content_removal_test.mjs
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

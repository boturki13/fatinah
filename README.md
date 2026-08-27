# فطنة — مشروع Replit

## وش فيه
- `www/index.html` — واجهة اللعبة المضمّنة محلياً داخل تطبيق iOS. خادم
  `production` لا يوزع `app.js` أو بنوك الأسئلة للمتصفح العام؛ يعرض صفحة
  تعريف آمنة وروابط App Store والخصوصية والشروط فقط.
- `www/question-bank.js` — البنك الأساسي القديم الذي يعمل دون اتصال، وتبقى أسئلته معلّقة حتى المراجعة الفردية.
- `www/approved-question-bank.js` — الأسئلة الجديدة التي اجتازت التحقق المستقل والمراجعة الإدارية.
- `functions/index.js` — عقد `generateQuestions` المتوافق مع 1.2 واسم v2 المنفصل.
- `API_VERSIONING.md` — عقد v1/v2، أعلام المزايا، وفصل staging عن production.
- `CLAUDE.md` — ملخّص المشروع الكامل.
- `capacitor.config.ts` / `package.json` — إعدادات مرجعية لتغليف iOS.

## مصنع الأسئلة المراجع

مفتاح OpenAI يبقى في `.env.local` على جهاز الإدارة ولا يدخل تطبيق الآيفون أو Git. التوليد لا يحدث أثناء لعب المستخدم؛ بل ينتج مرشحين يمرون بتحقق مستقل ثم مراجعة إدارية قبل النشر. الأسئلة الدينية وحدها تتطلب مراجعة بشرية صريحة للمصدر والإسناد.

بنك الإصدار 1.3 يحتوي حالياً **385 سؤالاً في 38 فئة**. الفئات الجديدة هي: ألعاب الفيديو، اللغة العربية، كتب وروايات، اختراعات واكتشافات، مطابخ العالم، ووش الرابط؟. لكل فئة جديدة 24 سؤالاً بواقع أربعة أسئلة لكل مستوى من 1 إلى 6.

حالة التدقيق الحالية: **151 سؤالاً معتمداً** يطابق سجل النشر، و**234 سؤالاً قديماً قيد المراجعة**. لذلك إصدار 1.3 محظور حالياً: تستمر اختبارات الويب والخادم وSwift والبناء المحلي غير الموقّع لإعطاء تغذية راجعة مبكرة، لكن حاجز الإصدار يمنع الدمج والأرشفة والرفع إلى TestFlight حتى تُراجع الأسئلة القديمة سؤالاً ومصدراً على حدة، وتُستبدل روابط `category_fallback` بمصادر خاصة بادعاء كل سؤال.

```bash
# احسب بنك التشغيل الحقيقي والفجوة إلى أربعة أسئلة لكل مستوى، بلا أي API
npm run questions:plan -- --category "معلومات عامة,القرآن الكريم"

# معاينة الإعداد والمصادر الخاصة بالفئة دون أي تكلفة API
npm run questions:generate -- --category "معلومات عامة" --level 1 --count 3 --max-spend-usd 1.00 --dry-run

# إنشاء دفعة ضمن الفجوة الفعلية (OpenAI + بحث عن المصادر + تحقق مستقل)
npm run questions:generate -- --category "معلومات عامة" --level 1 --count 3 --max-spend-usd 1.00

# تعويض مستويات محددة فقط
npm run questions:generate -- --category "علوم" --distribution "1:2,3:1,4:2" --max-spend-usd 1.50

# تجاوز الفجوة يحتاج قراراً صريحاً لأنه قد يستهلك تكلفة لمرشحين زائدين
npm run questions:generate -- --category "علوم" --level 1 --count 10 --allow-oversample --max-spend-usd 2.50

# اعتماد سؤال عام بعد قراءته ومراجعة رابطه
npm run questions:review -- --id gq-... --decision approve --reviewer "اسم المراجع"

# السؤال الديني يحتاج تأكيداً بشرياً إضافياً للمصدر والإسناد
npm run questions:review -- --id gq-... --decision approve --reviewer "اسم المراجع" --religious-confirmed

# لا ينشر إلا الأسئلة المعتمدة
npm run questions:publish
npm run questions:audit

# تقرير صادق عن بنك التشغيل؛ ينجح حتى عندما توجد عناصر مانعة ويعرضها
npm run questions:runtime-audit

# بوابة الإصدار الإلزامية؛ تفشل حالياً إلى أن يكتمل الترحيل والمراجعة
npm run questions:release-gate
```

الخطة تقرأ `question-bank.js` و`approved-question-bank.js` و`QUESTION_ADDITIONS` نفسها التي يركّب منها التطبيق بنك التشغيل. المولد يرفض افتراضياً الطلب الذي يتجاوز الفجوة، ويستخدم فقط `categoryTrustedHosts` الخاصة بالفئة. الفئات الدينية تتجاهل أي توسعة عامة وتبقى محصورة في `religiousTrustedHosts`.

كل تشغيل غير `dry-run` يحتاج `--max-spend-usd`. قبل أول طلب يحسب المولد حداً أعلى محافظاً للاستدعاءين من حجم المدخل، و`max_output_tokens`، و`max_tool_calls` للبحث. بعد generation يسجل `usage` الفعلي وتكلفته، ثم يعيد حجز أسوأ تكلفة ممكنة لـverification؛ إذا لم تكفِ الميزانية لا يطلب verification ولا يكتب `candidates.json`. وبعد verification يعيد الفحص قبل الكتابة. لا تُطبع المفاتيح أو تدخل في metadata.

أسعار الحارس مؤرخة في 2026-08-21: Terra ‏$2/$12، وSol ‏$5/$30، وLuna ‏$0.20/$1.20 لكل مليون input/output tokens، إضافة إلى $0.01 لكل web search call. أي اسم نموذج آخر مرفوض افتراضياً. لإضافة سعر معلوم صراحةً استخدم متغيراً غير سري مثل:

```bash
FATINAH_OPENAI_MODEL_PRICING_JSON='{"my-model":{"inputUsdPerMillion":3,"outputUsdPerMillion":15}}'
```

الافتراضي هو `GPT-5.6 Terra` للتوليد والتحقق العام و`GPT-5.6 Sol` للتحقق الديني. كل الأسئلة الدينية تبقى في `pending_religious_review` مهما كانت نتيجة النموذج حتى يراجعها إنسان.

## قيد مهم
Replit بيئة سحابية للويب فقط. **بناء تطبيق iOS الفعلي (Xcode) لازم يصير على ماك** — هذا شرط من أبل نفسها، لا علاقة له بأي منصة تطوير. عدّل هنا، ثم انسخ `index.html` المحدَّث لمجلد `www/` في مشروع Capacitor على جهازك.

## الجولة المجانية والبلاغات والقياسات في 1.3

- Firestore هو مصدر الحقيقة الدائم للحسابات والاشتراكات والجولة المجانية وسجل الأسئلة والبلاغات والقياسات. SQLite كاش محلي للتوافق والاستجابة السريعة فقط؛ يضبط نشر Replit `FATINAH_DURABLE_STORAGE=required` حتى لا يعلن نجاح كتابة غير دائمة.
- حدود طلبات الكتابة والتوليد موزعة أيضاً: تحفظ نافذة صغيرة في
  `distributed_rate_limits` وتستخدم Firestore `updateTime` كـCAS بين نسخ
  Autoscale. لا تحفظ UID خاماً، وتفشل مغلقاً في الإنتاج إذا غاب Firestore.
  فعّل TTL على `expire_at` للمجموعة نفسها، ثم اضبط العلمين
  `FATINAH_DISTRIBUTED_RATE_LIMIT_CONFIGURED=true` و
  `FATINAH_DISTRIBUTED_RATE_LIMIT_TTL_CONFIGURED=true`.
- الجولة التعريفية تُستهلك مرة واحدة للتثبيت والجهاز: يسجّل الخادم مفتاح Apple App Attest بعد التحقق من سلسلة Apple، ثم يربط كل طلب بتحدٍ قصير العمر و`assertion` وعداد متزايد، ويستخدم DeviceCheck كحاجز الجهاز النهائي. لا يُخزَّن Firebase UID داخل سجل مفتاح App Attest؛ مطالبة التثبيت تستخدم بصمة مالك أحادية الاتجاه. قفل Firestore موزّع يسلّسل المطالبات بين نسخ خادم autoscale، مع فشل مغلق إذا تعذّر التحقق.
- أكواد الأصدقاء لا تُخزّن ولا تُتحقق داخل فطنة؛ زر العرض يفتح `presentCodeRedemptionSheet` الرسمي من StoreKit/RevenueCat. أنشئ العرض والأكواد من App Store Connect.
- بلاغ السؤال يُحفظ أولاً في `question_reports` ثم يُرسل إلى `ata@ata20.com`. لإرسال البريد فعلياً أضف أسرار الخادم: `SMTP_HOST` و`SMTP_PORT` و`SMTP_FROM`، وعند الحاجة `SMTP_USERNAME` و`SMTP_PASSWORD` و`SMTP_USE_TLS`/`SMTP_USE_SSL`. يمكن تغيير المستلم فقط عبر `REPORT_EMAIL_TO`.
- قياسات اللعب المقيدة تُحفظ في `game_events` بلا نصوص أسئلة أو بريد. الملخص الإداري متاح في `GET /api/admin/metrics?days=7` مع `X-Admin-Secret`.
- Crashlytics يظل مسؤولاً عن الأعطال غير القاتلة والتوقفات، بهوية مستخدم فارغة، ولا تُضمَّن أسراره في حزمة JavaScript.
- MetricKit يحفظ تقارير الأداء/التوقفات في outbox محلي محمي ثم يرفعها إلى عقد v2 الموثق بـApp Check من دون Firebase UID أو رمز دخول؛ فشل الشبكة لا يفقد التقرير، والتقارير القديمة المرتبطة بحساب لا تُرفع تحت حساب لاحق.
- تقارير MetricKit المجهولة لها احتفاظ 30 يوماً فقط: يقلّم التطبيق ملفات
  الانتظار و`Quarantine` المحلية، وينظف الخادم SQLite، وتحتاج مجموعة Firestore
  إلى TTL على `expire_at` قبل الإنتاج.
- RevenueCat webhook يستخدم صندوق وارد دائم حسب `event.id`، ويعيد معالجة الحدث بعد ربط الهوية، ويدعم `TRANSFER` والاستحقاقات المؤقتة بدلاً من إسقاطها.

## App Check وApp Attest

التطبيق 1.3 يرسل `X-Firebase-AppCheck` إلى واجهات الحساب والاشتراك واللعب،
ويستخدم App Attest المباشر أيضاً لتسجيل مفتاح التثبيت ثم توقيع طلبات الجولة
المجانية. يربط توقيع الطلب هوية الحساب وبصمتي رمزي DeviceCheck، فيمنع تبديل
أحد الرمزين أو إعادة تشغيل assertion قديم.
المسارات غير المرقمة تبقى v1، ولا يفرض الخادم App Check عليها افتراضياً حتى
لا تتعطل النسخة المنشورة 1.2. استخدم `FATINAH_V2_APP_CHECK_ENFORCE=true`
لـv2 فقط، واترك `FATINAH_V1_APP_CHECK_ENFORCE=false` أثناء نافذة التوافق.

قبل تحويل المتغير إلى `true`:

1. سجّل تطبيق iOS ذي المعرّف `com.fatinah.game` في Firebase App Check واختر App Attest.
2. تأكد أن ملف التوقيع يضم App Attest وأن تقارير المراقبة تُظهر نجاح رموز 1.3.
3. اضبط `FATINAH_V2_FEATURE_APP_ATTEST_ENABLED=true` و
   `FATINAH_V2_APP_ATTEST_ENFORCE=true`، مع
   `APPLE_APP_ATTEST_APP_ID_PREFIX=A787MTL6U4` و
   `APPLE_APP_ATTEST_BUNDLE_ID=com.fatinah.game` في بيئة 1.3 فقط.
4. فعّل سياسة Firestore TTL على الحقل `expire_at` في مجموعة
   `app_attest_challenges`، ثم اضبط
   `FATINAH_APP_ATTEST_TTL_CONFIGURED=true` بعد التحقق منها.
5. انشر الخادم وسياسة الخصوصية، ثم اختبر التسجيل والـassertion وDeviceCheck على
   TestFlight وجهاز حقيقي قبل إتاحة الإصدار.

يلزم نشر الخادم أيضاً بسر `FIREBASE_SERVICE_ACCOUNT_JSON` وبقاعدة `FIRESTORE_DATABASE_ID=fatinah-native`. من دون بيانات الاعتماد تعيد الكتابات الحساسة 503 في الإنتاج بدلاً من فقدها بصمت.

تفاصيل اختيار `/api/v1` و`/api/v2` أو الرأس، أعلام كل ميزة، وترتيب نشر
staging/production موجودة في [API_VERSIONING.md](API_VERSIONING.md).

## نشر خادم Firebase من هنا
`functions/index.js` كود مرجعي فقط — نشره الفعلي (`firebase deploy`) يحتاج Firebase CLI، تقدر تشغّله من طرفية Replit نفسها إذا ثبّتّه (`npm install -g firebase-tools`).

## إدارة الإصدارات

- الإصدار المعتمد وحالة App Store محفوظان في `release/current.json` وتتحقق الاختبارات من مطابقتهما لـ`package.json` ومشروع Xcode.
- خطوات الفروع، المراجعة، TestFlight، Replit، والرجوع موثقة في `docs/RELEASE_PROCESS.md`.
- قائمة التحقق العملية موجودة في `docs/RELEASE_CHECKLIST.md`، وخطة التحديث التالي في `docs/NEXT_RELEASE.md`.
- ملفات صور الإنتاج الثنائية لا تدخل سجل Git. يبقى manifest وبصمات SHA-256 في المستودع، ويمكن استعادتها والتحقق منها عبر `npm run images:fetch-release-assets`.

# بوابة إعداد إنتاج فطنة 1.3

هذه البوابة تفحص **إعدادات عملية خادم production فقط** قبل إتاحة 1.3، ولا تنشر
شيئاً ولا تتصل بـApple أو Firebase أو RevenueCat. لا تقرأ ملف `.env` ولا تقبل
الأسرار كوسائط سطر أوامر؛ تقرأ متغيرات البيئة المحقونة من مخزن أسرار منصة
النشر، وتطبع أسماء الفحوص وحالاتها فقط من دون القيم أو أطوالها أو نص الأخطاء.

خادم production يعامل فطنة كتطبيق iOS فقط: المسار العام يعرض صفحة تعريف،
وتُرفض ملفات اللعبة وبنوك الأسئلة (`app.js` و`question-bank*.js`) كي لا يصبح
متغير JavaScript محلي حاجز الاشتراك. ملفات الخصوصية والشروط تبقى عامة.

## مرحلتان إلزاميتان

1. يشغّل CI الاختبار الآمن `python3 tests/test_production_release_gate.py`.
   هذا يستخدم مفاتيح مؤقتة مولّدة للاختبار، ولا يحتاج أسرار الإنتاج.
2. انشر أولاً الخادم المتوافق مع v1/v2 وفق الطرح التدريجي في
   `API_VERSIONING.md`. بعد اكتمال تفعيل مسارات 1.3 وقبل إتاحته عبر
   TestFlight/App Store، افتح shell محمياً داخل **بيئة production نفسها**
   بعد حقن أسرارها وشغّل:

   ```bash
   python3 scripts/production_release_gate.py
   ```

   النتيجة المطلوبة هي `Fatinah production configuration: READY` مع رمز خروج
   `0`. أي `FAIL` يعطي رمز خروج `1` ويمنع إصدار العميل 1.3. ولتقرير آلي خالٍ
   من القيم:

   ```bash
   python3 scripts/production_release_gate.py --json
   ```

لا تنسخ أسرار production إلى مستودع Git أو سجلات CI لتشغيل المرحلة الثانية.
في الشركات التي تستخدم job نشر محمياً، اربط الأمر ببيئة GitHub Environment
تتطلب موافقة بشرية ولا تسمح بطباعة environment؛ وإلا شغّله داخل منصة الاستضافة.
البوابة ليست مانعاً لنشر الخادم المتوافق أول مرة وميزات v2 مغلقة؛ إنها مانع
الإتاحة النهائية للعميل بعد اكتمال الطرح التدريجي.

## ما الذي تمنعه البوابة؟

### التوافق بين 1.2 و1.3

- تتطلب `FATINAH_ENVIRONMENT=production` صراحةً؛ الاختصارات والأخطاء الإملائية
  مرفوضة.
- تتطلب استمرار عقد v1 عبر `FATINAH_V1_AI_GENERATION_ENABLED=true` ووجهة
  HTTPS الإنتاجية المعروفة فقط.
- تتطلب `FATINAH_V1_APP_CHECK_ENFORCE=false` طوال وجود تطبيق 1.2 المنشور، كي
  لا ينقطع عميل لا يرسل App Check.
- تتطلب تفعيل كل مسارات v2 المخطط طرحها: App Attest، الجولة المجانية، تاريخ الأسئلة،
  بنك الأسئلة المراجع، البلاغات، القياسات، تشخيصات iOS، وRevenueCat webhook.

### Firebase والتخزين الدائم

- تتطلب `FATINAH_DURABLE_STORAGE=required` حتى لا تصبح SQLite المحلية مصدراً
  وحيداً في حاوية قابلة لإعادة الإنشاء.
- تتحقق من اكتمال إعداد Firebase Web ومن أن مشروع الإنتاج هو `fatinah-game`
  وقاعدة Firestore هي `fatinah-native`.
- تحلل `FIREBASE_SERVICE_ACCOUNT_JSON` في الذاكرة، وتتحقق أن المشروع مطابق
  وأن المفتاح RSA صالح؛ لا تطبع أي حقل منه.
- تتطلب إنفاذ `FATINAH_V2_APP_CHECK_ENFORCE=true`. لا يكفي وجود SDK في التطبيق
  إذا كان الخادم في وضع المراقبة فقط.

### App Attest وDeviceCheck

- تتطلب إنفاذ App Attest وDeviceCheck لعقد v2، وبيئة Apple `production`،
  وKey ID وTeam ID وApp ID Prefix وBundle ID المطابقين لتوقيع التطبيق.
- يتحقق الخادم من شهادة App Attest المثبتة إلى جذر Apple الرسمي، ويربط كل
  assertion بتحدٍ أحادي الاستخدام وبيانات الطلب، ويحدّث العداد ذرياً في
  Firestore لمنع replay. لا يكفي Firebase App Check وحده لمنح الجولة.
- تقبل المفتاح الخاص كـPEM أو Base64 PEM، وتتحقق أنه مفتاح EC P-256 صالح من
  دون إنشاء token أو الاتصال بخوادم Apple.
- لا تغني هذه البوابة عن إنشاء مفتاح DeviceCheck وتهيئة App Attest في Apple
  Developer وربطهما بالحساب الصحيح واختبار جهاز حقيقي؛ هي تمنع فقط النشر
  بإعداد ناقص أو malformed.
- تعتمد المطالبة المتزامنة على lease ذري في قاعدة Firestore الإنتاجية نفسها؛
  لذلك لا يجوز تشغيل v2 على autoscale مع تخزين اختياري أو قاعدة محلية فقط.
- تخزن التحديات بصمة حساب أحادية الاتجاه وحقل `expire_at` من نوع Timestamp.
  ويجب تفعيل Firestore TTL على هذا الحقل ثم ضبط
  `FATINAH_APP_ATTEST_TTL_CONFIGURED=true`؛ وإلا ترفض البوابة الإصدار.

### تشخيصات iOS المجهولة

- عقد MetricKit في v2 لا يحمل Firebase UID أو ID token، ويتطلب App Check حتى
  لو كان بقية الخادم في وضع المراقبة. يخزن الخادم `schemaVersion=2` و
  `privacyScope=anonymous` في مجموعة مستقلة عن المستخدمين.
- تقارير outbox القديمة المرتبطة بحساب أو غير المعلّمة لا تُرفع تحت حساب لاحق؛
  يحذفها العميل fail-closed أثناء الترقية.
- يحدد الخادم احتفاظ تقارير التشخيص بـ30 يوماً وينظف SQLite. يجب تفعيل
  Firestore TTL على `expire_at` في `ios_diagnostics_anonymous` ومجموعة
  `ios_diagnostics` ثم ضبط `FATINAH_IOS_DIAGNOSTICS_TTL_CONFIGURED=true`.

### RevenueCat والبريد والتشغيل

- تتحقق من وجود مفتاح iOS العام بصيغة RevenueCat ومن سر webhook غير تجريبي.
- تتطلب `ADMIN_SECRET` قوياً كي تبقى نقاط القياسات الإدارية قابلة للإدارة
  وآمنة.
- لأن النشر autoscale، تستخدم مسارات الكتابة والتوليد مجموعة Firestore
  `distributed_rate_limits` في قاعدة `fatinah-native`. كل عداد sliding-window
  يُحدّث ذرياً بشرط `updateTime`، واسم الوثيقة بصمة لا تحتوي UID خاماً. فعّل
  Firestore TTL على الحقل `expire_at` لهذه المجموعة، ثم فقط اضبط العلمين
  `FATINAH_DISTRIBUTED_RATE_LIMIT_CONFIGURED=true` و
  `FATINAH_DISTRIBUTED_RATE_LIMIT_TTL_CONFIGURED=true`. في
  production/Replit لا يوجد رجوع إلى ذاكرة نسخة واحدة: غياب أي علم أو
  Firestore يفشل مغلقاً.
- عند تفعيل بلاغات الأسئلة تتطلب مضيف SMTP وعناوين صحيحة ومنفذاً صالحاً،
  وتمنع SMTP النصي: يجب أن يكون STARTTLS أو SSL فعالاً. كما تمنع وجود اسم
  مستخدم بلا كلمة مرور أو العكس.
- تحذّر إذا بقي `OPENAI_API_KEY` أو `ANTHROPIC_API_KEY` داخل **عملية خادم
  1.3** لأنها لا تحتاجهما. هذا تحذير least-privilege ولا يمنع النشر، لأن
  Cloud Function القديم الذي يخدم v1 يُنشر ويدار بأسراره بصورة مستقلة.

## أسماء الإعدادات التي تُراجع

هذه أسماء فقط، ولا تضع قيماً في هذا الملف أو في Git:

```text
FATINAH_ENVIRONMENT
FATINAH_DURABLE_STORAGE
FATINAH_V1_AI_GENERATION_ENABLED
FATINAH_V1_GENERATION_URL
FATINAH_V1_APP_CHECK_ENFORCE
FATINAH_V2_APP_CHECK_ENFORCE
FATINAH_V2_APP_ATTEST_ENFORCE
FATINAH_V2_DEVICECHECK_ENFORCE
FATINAH_APP_ATTEST_TTL_CONFIGURED
FATINAH_IOS_DIAGNOSTICS_TTL_CONFIGURED
FATINAH_DISTRIBUTED_RATE_LIMIT_CONFIGURED
FATINAH_DISTRIBUTED_RATE_LIMIT_TTL_CONFIGURED
FATINAH_V2_FEATURE_APP_ATTEST_ENABLED
FATINAH_V2_FEATURE_FREE_ROUND_ENABLED
FATINAH_V2_FEATURE_QUESTION_HISTORY_ENABLED
FATINAH_V2_FEATURE_QUESTION_BANK_ENABLED
FATINAH_V2_FEATURE_QUESTION_REPORTS_ENABLED
FATINAH_V2_FEATURE_METRICS_ENABLED
FATINAH_V2_FEATURE_IOS_DIAGNOSTICS_ENABLED
FATINAH_V2_FEATURE_REVENUECAT_WEBHOOK_ENABLED
GOOGLE_API_KEY
FIREBASE_AUTH_DOMAIN
FIREBASE_PROJECT_ID
FIREBASE_STORAGE_BUCKET
FIREBASE_APP_ID
FIREBASE_MESSAGING_SENDER_ID
FIREBASE_SERVICE_ACCOUNT_JSON
FIRESTORE_DATABASE_ID
APPLE_DEVICECHECK_ENVIRONMENT
APPLE_DEVICECHECK_KEY_ID
APPLE_DEVICECHECK_TEAM_ID
APPLE_DEVICECHECK_PRIVATE_KEY
APPLE_APP_ATTEST_APP_ID_PREFIX
APPLE_APP_ATTEST_BUNDLE_ID
REVENUECAT_IOS_API_KEY
REVENUECAT_WEBHOOK_SECRET
ADMIN_SECRET
SMTP_HOST
SMTP_PORT
SMTP_FROM
SMTP_USERNAME
SMTP_PASSWORD
SMTP_USE_TLS
SMTP_USE_SSL
REPORT_EMAIL_TO
```

## حدود الجاهزية

ظهور `READY` يعني أن **عقد إعداد الخادم** اجتاز الفحص فقط. لا يعني أن إصدار
1.3 جاهز للرفع. يجب أيضاً نجاح اختبارات المشروع والبناء، وظهور
`releaseReady: true` من `npm run questions:release-gate`، ثم اختبار الشراء
والاستعادة وApp Attest وDeviceCheck على TestFlight وجهاز حقيقي وفق
`TESTFLIGHT_CHECKLIST.md`.

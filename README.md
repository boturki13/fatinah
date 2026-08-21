# فطنة — مشروع Replit

## وش فيه
- `www/index.html` — واجهة اللعبة المستخدمة في الويب وتطبيق iOS.
- `www/question-bank.js` — البنك الأساسي المراجع الذي يعمل دون اتصال.
- `www/approved-question-bank.js` — الأسئلة الجديدة التي اجتازت التحقق المستقل والمراجعة الإدارية.
- `functions/index.js` — نقطة توافق للإصدارات القديمة؛ تمنع التوليد المباشر للمستخدم.
- `CLAUDE.md` — ملخّص المشروع الكامل.
- `capacitor.config.ts` / `package.json` — إعدادات مرجعية لتغليف iOS.

## مصنع الأسئلة المراجع

مفتاح OpenAI يبقى في `.env.local` على جهاز الإدارة ولا يدخل تطبيق الآيفون أو Git. التوليد لا يحدث أثناء لعب المستخدم؛ بل ينتج مرشحين يمرون بتحقق مستقل ثم مراجعة إدارية قبل النشر. الأسئلة الدينية وحدها تتطلب مراجعة بشرية صريحة للمصدر والإسناد.

بنك الإصدار 1.3 يحتوي **380 سؤالاً في 38 فئة**. الفئات الجديدة هي: ألعاب الفيديو، اللغة العربية، كتب وروايات، اختراعات واكتشافات، مطابخ العالم، ووش الرابط؟. لكل فئة جديدة 24 سؤالاً بواقع أربعة أسئلة لكل مستوى من 1 إلى 6.

```bash
# معاينة الإعداد دون أي تكلفة API
npm run questions:generate -- --category "علوم" --difficulty easy --count 10 --dry-run

# إنشاء دفعة مرشحة (OpenAI + بحث عن المصادر + تحقق مستقل)
npm run questions:generate -- --category "علوم" --difficulty easy --count 10

# دفعة متوازنة: أربعة أسئلة لكل مستوى من 1 إلى 6
npm run questions:generate -- --category "ألعاب الفيديو" --difficulty balanced --count 24

# تعويض مستويات محددة فقط
npm run questions:generate -- --category "كتب وروايات" --distribution "1:2,3:1,4:2"

# اعتماد سؤال عام بعد قراءته ومراجعة رابطه
npm run questions:review -- --id gq-... --decision approve --reviewer "اسم المراجع"

# السؤال الديني يحتاج تأكيداً بشرياً إضافياً للمصدر والإسناد
npm run questions:review -- --id gq-... --decision approve --reviewer "اسم المراجع" --religious-confirmed

# لا ينشر إلا الأسئلة المعتمدة
npm run questions:publish
npm run questions:audit
```

الافتراضي هو `GPT-5.6 Terra` للتوليد والتحقق العام و`GPT-5.6 Sol` للتحقق الديني. كل الأسئلة الدينية تبقى في `pending_religious_review` مهما كانت نتيجة النموذج حتى يراجعها إنسان.

## قيد مهم
Replit بيئة سحابية للويب فقط. **بناء تطبيق iOS الفعلي (Xcode) لازم يصير على ماك** — هذا شرط من أبل نفسها، لا علاقة له بأي منصة تطوير. عدّل هنا، ثم انسخ `index.html` المحدَّث لمجلد `www/` في مشروع Capacitor على جهازك.

## الجولة المجانية والبلاغات والقياسات في 1.3

- Firestore هو مصدر الحقيقة الدائم للحسابات والاشتراكات والجولة المجانية وسجل الأسئلة والبلاغات والقياسات. SQLite كاش محلي للتوافق والاستجابة السريعة فقط؛ يضبط نشر Replit `FATINAH_DURABLE_STORAGE=required` حتى لا يعلن نجاح كتابة غير دائمة.
- الجولة التعريفية تُستهلك مرة واحدة لكل Firebase UID، وتُسجّل في Firestore مع علم محلي للعمل دون اتصال.
- أكواد الأصدقاء لا تُخزّن ولا تُتحقق داخل فطنة؛ زر العرض يفتح `presentCodeRedemptionSheet` الرسمي من StoreKit/RevenueCat. أنشئ العرض والأكواد من App Store Connect.
- بلاغ السؤال يُحفظ أولاً في `question_reports` ثم يُرسل إلى `ata@ata20.com`. لإرسال البريد فعلياً أضف أسرار الخادم: `SMTP_HOST` و`SMTP_PORT` و`SMTP_FROM`، وعند الحاجة `SMTP_USERNAME` و`SMTP_PASSWORD` و`SMTP_USE_TLS`/`SMTP_USE_SSL`. يمكن تغيير المستلم فقط عبر `REPORT_EMAIL_TO`.
- قياسات اللعب المقيدة تُحفظ في `game_events` بلا نصوص أسئلة أو بريد. الملخص الإداري متاح في `GET /api/admin/metrics?days=7` مع `X-Admin-Secret`.
- Crashlytics يظل مسؤولاً عن الأعطال غير القاتلة والتوقفات، ولا تُضمَّن أسراره في حزمة JavaScript.
- MetricKit يحفظ تقارير الأداء/التوقفات في outbox محلي ثم يرفعها موثقة إلى `/api/ios-diagnostics`؛ فشل الشبكة لا يفقد التقرير.
- RevenueCat webhook يستخدم صندوق وارد دائم حسب `event.id`، ويعيد معالجة الحدث بعد ربط الهوية، ويدعم `TRANSFER` والاستحقاقات المؤقتة بدلاً من إسقاطها.

## App Check وApp Attest

التطبيق يرسل `X-Firebase-AppCheck` إلى واجهات الحساب والاشتراك واللعب. الخادم يبدأ بوضع المراقبة (`FIREBASE_APP_CHECK_ENFORCE=false`) حتى لا تتعطل النسخة المنشورة 1.2 أثناء طرح 1.3.

قبل تحويل المتغير إلى `true`:

1. سجّل تطبيق iOS ذي المعرّف `com.fatinah.game` في Firebase App Check واختر App Attest.
2. تأكد أن ملف التوقيع يضم App Attest وأن تقارير المراقبة تُظهر نجاح رموز 1.3.
3. انشر الخادم وسياسة الخصوصية، ثم اطرح 1.3 تدريجياً.
4. بعد وصول غالبية الأجهزة للإصدار الجديد وثبات نسبة التحقق، فعّل الإنفاذ.

يلزم نشر الخادم أيضاً بسر `FIREBASE_SERVICE_ACCOUNT_JSON` وبقاعدة `FIRESTORE_DATABASE_ID=fatinah-native`. من دون بيانات الاعتماد تعيد الكتابات الحساسة 503 في الإنتاج بدلاً من فقدها بصمت.

## نشر خادم Firebase من هنا
`functions/index.js` كود مرجعي فقط — نشره الفعلي (`firebase deploy`) يحتاج Firebase CLI، تقدر تشغّله من طرفية Replit نفسها إذا ثبّتّه (`npm install -g firebase-tools`).

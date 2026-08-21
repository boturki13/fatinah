# قائمة التحقق: دورة Apple الكاملة عبر TestFlight قبل الإطلاق

آخر تحديث: 21 أغسطس 2026

## حالة الجاهزية الخادمية (مُتحقَّق منها آلياً)

| البند | الحالة |
|---|---|
| اختبارات webhook المحلية (`python3 tests/test_revenuecat_webhook.py`) | ✅ 36/36 نجحت |
| عقد v1/v2 المحلي (`python3 tests/test_api_version_contract.py`) | ✅ نجح |
| عزل Cloud Functions (`node tests/test_function_version_contract.mjs`) | ✅ نجح |
| أسرار staging وproduction منفصلة | ⚠️ تحقق خارجي مطلوب قبل الرفع |
| `https://ata20.com/api/revenuecat/webhook` يستجيب | ✅ يعيد **401** عند إرسال طلب بلا سر — النسخة المنشورة تقرأ السر وتعمل كما هو متوقع |

تم التحقق بعد النشر من أن الاستجابة **401** (وليس 503) عند طلب بلا سر صحيح:

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST \
  https://ata20.com/api/revenuecat/webhook \
  -H "Content-Type: application/json" -d '{}'
# المتوقع: 401 — تم التحقق منه
```

## بوابة المحتوى — مانع حالي قبل TestFlight 1.3

بنك التشغيل الحالي يضم **385 سؤالاً**: منها **151 سؤالاً معتمداً** و**234 سؤالاً قديماً قيد المراجعة**. كما يكشف تقرير التشغيل روابط `category_fallback` العامة التي يجب استبدالها بمصدر خاص بادعاء السؤال. لذلك حالة الإصدار 1.3 الحالية **محظورة**. المزامنة والاختبارات والبناء المحلي غير الموقّع مسموحة ومطلوبة، لكن لا يجوز الأرشفة أو التوقيع أو الرفع إلى TestFlight قبل إغلاق هذه البنود.

```bash
# يعرض الحالة والموانع دون تعطيل دورة التدقيق
npm run questions:runtime-audit

# يجب أن ينجح قبل الأرشفة أو الرفع إلى TestFlight؛ يفشل حالياً عمداً
npm run questions:release-gate
```

لا تُرفع حالة الحظر إلا بعد مراجعة الأسئلة الـ234 فردياً ونشر المعتمد منها، واستبدال جميع مصادر الفئة العامة، ثم ظهور `releaseReady: true` من بوابة الإصدار. ينفذ CI الاختبارات ومزامنة iOS والبناء غير الموقّع أولاً حتى يظل كشف أخطاء الكود فعالاً، ثم يشغّل بوابة المحتوى النهائية التي تمنع دمج أو إصدار 1.3 غير المكتمل.

## الخطوة 0 — بوابة API قبل TestFlight 1.3

1. أنشئ مضيف staging ومشروع Firebase/Firestore وتطبيق RevenueCat Sandbox
   مستقلة كما في `API_VERSIONING.md`؛ لا تختبر 1.3 على بيانات production.
2. انشر الخادم المتوافق أولاً، ثم تحقق أن `/api/version` يعلن v1 وأن
   `/api/v2/version` يعلن v2 على staging.
3. يجب أن يختار build 1.3 العقد v2 عبر `/api/v2/...` أو الرأس
   `X-Fatinah-API-Version: 2`. من دون أحدهما سيبقى على v1 عمداً لحماية 1.2.
4. شغّل `npm run test:server` قبل الأرشفة، وفعّل أعلام v2 في staging فقط.
5. لا تفعّل `FATINAH_V1_APP_CHECK_ENFORCE` طوال دعم تطبيق 1.2.
6. اضبط `FATINAH_ENVIRONMENT` صراحةً في الخادم والدوال، وتحقق أن staging لا
   يستخدم `ata20.com` أو مشروع Firebase/سر Claude الخاص بالإنتاج.
7. بعد نشر الخادم المتوافق وتفعيل مسارات v2 تدريجياً، وقبل إتاحة build 1.3،
   شغّل `python3 scripts/production_release_gate.py` داخل بيئة production.
   يجب أن تكون النتيجة `READY`. لا تنسخ أسرار الإنتاج إلى CI؛ التفاصيل في
   `PRODUCTION_RELEASE_GATE.md`.

## الخطوة 1 — حفظ webhook الإنتاجي في RevenueCat

من **Integrations → Webhooks → New webhook** (التفاصيل الكاملة في `AUTH_SETUP.md` §6):

- URL: `https://ata20.com/api/revenuecat/webhook`
- Authorization header: نفس قيمة `REVENUECAT_WEBHOOK_SECRET`
- Environment: **Production فقط** (شراء TestFlight يُرسل كأحداث Production في RevenueCat)
- الأحداث: `INITIAL_PURCHASE`, `RENEWAL`, `CANCELLATION`, `EXPIRATION`, `BILLING_ISSUE`, `BILLING_ISSUE_RESOLVED`, `PRODUCT_CHANGE`, `UNCANCELLATION`

استخدم **Send test** وراقب استجابة 200 في سجل الـ webhook داخل RevenueCat.

> ملاحظة: حدث الاختبار (TEST) قد يعيد **202** إذا لم يكن `app_user_id` مربوطاً بحساب Firebase — هذا سلوك مقصود وليس خطأ.

## الخطوة 2 — بناء ورفع نسخة TestFlight من جهاز Mac

نفّذ هذه الأوامر من جذر المشروع على جهاز Mac يحتوي Xcode 26 أو أحدث وCocoaPods:

```bash
# يتجاهل package-lock الناتج داخل Replit، الذي قد يحتوي روابط Package Firewall داخلية
npm install --package-lock=false --registry=https://registry.npmjs.org --no-audit --no-fund
npx cap sync ios
cd ios/App
pod install --repo-update
open App.xcworkspace
```

استخدم ملف `App.xcworkspace` وليس `App.xcodeproj`. داخل Xcode:

1. اختر Target `App` ثم تأكد أن **Team** هو حساب Apple Developer الصحيح.
2. تأكد أن Bundle Identifier هو `com.fatinah.game`.
3. اختر جهازاً حقيقياً أو `Any iOS Device (arm64)`.
4. ارفع **Build** في كل محاولة جديدة، مثلاً `2` مع Version `1.0`.
5. من **Product → Archive**، ثم **Distribute App → App Store Connect → Upload**.
6. انتظر معالجة البناء في App Store Connect، ثم أضف مختبري TestFlight وأرسل لهم الدعوة.

قبل الأرشفة، راجع أن منتجات App Store Connect وRevenueCat تستخدم المعرّفات نفسها:

```text
com.fatinah.game.monthly
com.fatinah.game.annual
```

لا تعتمد على `Podfile.lock` الموجود في المستودع إذا كان قديماً؛ `pod install` بعد `npx cap sync ios` هو الذي يعيد توليده من الحزم الحالية.

## الخطوة 3 — الشراء الأولي من TestFlight

1. سجّل الدخول في التطبيق بحساب Firebase حقيقي (يضمن ربط UUID عبر `/api/revenuecat/identity`).
2. نفّذ الشراء من شاشة الاشتراك (اشتراكات TestFlight تتجدد بسرعة ولا تُحاسَب).
3. تحقق بعد دقيقة:
   - **RevenueCat → Customer → Events**: وصول `INITIAL_PURCHASE` وحالة الـ webhook = 200.
   - **SQLite** على الخادم المنشور:
     ```sql
     SELECT uid, status, updated_at FROM subscriptions ORDER BY updated_at DESC LIMIT 5;
     ```
     المتوقع: `status = 'active'` للـ uid المُختبَر.
   - **Firestore**: وثيقة الاشتراك للـ uid محدّثة بـ `active`.
   - التطبيق يفتح المزايا بعد إعادة فتح الشاشة (الصلاحية خادمية).

## الخطوة 4 — الاستعادة (Restore)

1. احذف التطبيق وأعد تثبيته من TestFlight، أو سجّل الدخول على جهاز آخر بنفس Apple ID وحساب Firebase.
2. اضغط "استعادة المشتريات".
3. تحقق أن المزايا فُتحت وأن أي حدث (`TRANSFER`/`INITIAL_PURCHASE`) وصل بنجاح 200 في سجل RevenueCat.

## الخطوة 4ب — الجولة المجانية وApp Attest وDeviceCheck على جهاز حقيقي

1. استخدم Apple ID وحساب Firebase لا يملكان اشتراكاً، وتأكد أن أول جولة تبدأ
   كاملة قبل ظهور شاشة الاشتراك.
2. أغلق التطبيق وافتحه؛ يجب ألا تظهر جولة مجانية ثانية.
3. راقب Firestore بعد أول فتح: يوجد مفتاح موثّق في `app_attest_keys`، ويزداد
   عداده مع assertions، ولا تبقى تحديات صالحة بعد استخدامها. لا تسجل أو تنسخ
   المفتاح أو receipt إلى تقارير الاختبار.
   وتأكد مسبقاً من تفعيل TTL على `app_attest_challenges.expire_at`، وأن وثيقة
   التحدي لا تحتوي UID خاماً ويُحذف التحدي غير المستخدم بعد انتهاء المهلة.
4. سجّل الخروج وأنشئ/استخدم Firebase UID آخر على **الجهاز نفسه**؛ يجب أن يرفض
   الخادم الجولة الثانية ويعرض الاشتراك. لا يكفي اختبار المحاكي لأن App Attest
   وDeviceCheck يحتاجان جهازاً حقيقياً وبيئة Apple المطابقة للبناء.
5. احذف التطبيق وثبته مجدداً، ثم تحقق أن تعافي مفتاح App Attest يتم بلا تعليق
   وأن DeviceCheck ما زال يمنع جولة ثانية إذا كانت الأولى قد استُهلكت.
6. راقب Firestore: لا يبقى `service_locks/devicecheck_free_round_claim` أكثر
   من مدة المطالبة الطبيعية، ووثيقة `free_rounds/{uid}` للفائز تحمل
   `completed=true`، ومطالبة التثبيت لا تحتوي Firebase UID خاماً.
7. افصل الشبكة قبل بدء الجولة؛ يجب أن يفشل التطبيق مغلقاً وألا يبدأ الجولة حتى
   يعود الاتصال والتحقق.

## الخطوة 4ج — خصوصية MetricKit

بعد وصول تقرير MetricKit فعلي (قد يتأخر تسليمه من iOS)، تحقق أن وثيقة
`ios_diagnostics_anonymous/{reportId}` تحتوي `schema_version=2` و
`privacy_scope=anonymous` و`expire_at` بعد 30 يوماً، ولا تحتوي `uid` أو
`idToken`. تأكد من تفعيل Firestore TTL على `expire_at`. جرّب تبديل الحساب قبل
إعادة فتح التطبيق؛ يجب ألا تُنسب التقارير المؤجلة إلى الحساب الجديد.

## الخطوة 5 — التجديد (RENEWAL)

اشتراك TestFlight الشهري يتجدد كل بضع دقائق (حتى 12 تجديداً ثم ينتهي تلقائياً).

- انتظر التجديد الأول وتحقق من وصول `RENEWAL` في RevenueCat بحالة 200.
- تحقق أن `updated_at` في SQLite تغيّر وأن الحالة بقيت `active`.

## الخطوة 6 — الإلغاء/الانتهاء

1. اترك الاشتراك ينتهي (بعد 12 تجديداً في TestFlight) أو ألغِه من إعدادات Sandbox/الاشتراكات.
2. تحقق من وصول `CANCELLATION` ثم `EXPIRATION` في RevenueCat.
3. تحقق أن:
   - بعد `CANCELLATION`: SQLite تبقى `active` حتى نهاية الفترة المدفوعة.
   - بعد `EXPIRATION`: SQLite تصبح `inactive`، وعندها فقط يعيد
     `/api/subscription/status` القيمة `active=false`.
   - Firestore محدّث.
   - التطبيق يغلق المزايا ويعرض شاشة الاشتراك.

## الخطوة 7 — التحقق النهائي من السجلات

بعد كل حدث راجع الثلاثية:

1. **RevenueCat** → Webhook delivery log: كلها 200 (أو 202 لهوية غير مربوطة فقط).
2. **SQLite** (`subscriptions` + `webhook_outbox`): لا سجلات outbox معلّقة.
3. **Firestore**: وثيقة الاشتراك مطابقة لحالة SQLite.

إن ظهر أي 401 في سجل RevenueCat فالسر غير متطابق؛ وإن ظهر 503 فالنسخة المنشورة لا تقرأ السر — أعد النشر.

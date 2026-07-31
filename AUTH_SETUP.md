# إعداد نظام الهوية الموحّد (Auth) — فَطِنة

هذا الملف يوثّق كل خطوة إعداد خارجية (Firebase Console / Xcode) لازمة كي يعمل
نظام الدخول الموحّد بالكامل: جلسة مجهولة أولى + ترقية لـ Apple/Google/بريد +
ربط تفاعلي عند تعارض المزوّدين + شاشة إدارة وسائل الدخول.

## 1. المتغيّرات البيئية المطلوبة

هذه موجودة بالفعل في بيئة Replit الحالية (Secrets):

| المتغيّر | الاستخدام |
|---|---|
| `GOOGLE_API_KEY` | يُستخدم كـ `apiKey` في تهيئة Firebase Web SDK، وأيضاً للتحقق من `idToken` عبر Identity Toolkit REST API من الخادم |
| `FIREBASE_AUTH_DOMAIN` | نطاق Firebase Auth |
| `FIREBASE_PROJECT_ID` | معرّف مشروع Firebase — وجوده هو ما يفعّل التحقق من الهوية في الخادم (`server.py`) |
| `FIRESTORE_DATABASE_ID` | معرّف قاعدة Firestore Native (حالياً `fatinah-native`) |
| `FIREBASE_APP_ID`, `FIREBASE_MESSAGING_SENDER_ID`, `FIREBASE_STORAGE_BUCKET` | بقية إعداد Firebase Web SDK |

إن لم تكن `FIREBASE_PROJECT_ID` موجودة، يتراجع الخادم تلقائياً لسلوك "الثقة
بالـ uid القادم من العميل" (بيئة تطوير محلية بلا Firebase حقيقي) — راجع
`firebase_is_configured()` في `server.py`.

## 2. Firebase Console — خطوات إلزامية

اذهب إلى **Firebase Console → Authentication → Sign-in method** وفعّل:

1. **Anonymous** — ⚠️ إلزامي لعمل الجلسة المجهولة الأولى. إن بقي معطّلاً،
   ستفشل `signInAnonymously()` برسالة `auth/admin-restricted-operation` وسيتراجع
   التطبيق تلقائياً لمعرّف جهاز محلي (device id) بدل uid حقيقي من Firebase —
   يعمل التطبيق لكن بلا مزامنة تقدّم عبر الأجهزة حتى يُفعَّل هذا الخيار.
2. **Apple** — أدخل Services ID + Team ID + Key ID + Private Key من Apple
   Developer (مطلوب لأي تسجيل دخول Apple من المتصفح؛ داخل تطبيق iOS يعمل عبر
   Capacitor بلا هذه الخطوة بفضل Sign in with Apple capability في Xcode).
3. **Google** — فعّله واحفظ الـ Web client ID.
4. **Email/Password** — فعّله. وتأكد أن **"One account per email address"**
   (وضع الربط الافتراضي في Firebase) مفعّل — هو الافتراضي وهو ما يجعل خطأ
   `auth/account-exists-with-different-credential` يظهر بدل السماح بحسابين
   منفصلين لنفس البريد.
5. **Phone** — فعّله لإرسال رمز SMS والتحقق من رقم الهاتف. في نسخة الويب
   يجب أيضاً إضافة نطاق المعاينة والنطاق المنشور إلى **Authorized domains**.
   يقبل التطبيق ٨ أرقام كويتية محلية مثل `50001234`، أو `+96550001234`،
   أو `0096550001234`، ثم يرسلها إلى Firebase بصيغة E.164.

بعد إنشاء حساب بالبريد، يرسل التطبيق رسالة تحقق تلقائياً. ويمكن إعادة إرسالها
أو تحديث حالة التحقق من شاشة **إحصاءاتي وإنجازاتي**. كما يمكن توثيق رقم الهاتف
من الشاشة نفسها بإرسال رمز SMS ثم إدخال الرمز.

من شاشة تسجيل الدخول بالبريد:
- **نسيت كلمة المرور؟** يرسل رابط إعادة تعيين رسمي من Firebase إلى البريد
  المدخل، ويمكن فتحه لإختيار كلمة مرور جديدة.
- **نسيت البريد الإلكتروني؟** يعرض البريد المرتبط بحساب Firebase الحالي أو
  البريد المحفوظ على الجهاز فقط. لا يبحث التطبيق عن بريد المستخدمين الآخرين
  حفاظاً على الخصوصية؛ عند عدم توفره يمكن الدخول عبر Apple أو Google أو الهاتف.

بعد التفعيل، أضف نطاق معاينة Replit (والنطاق المنشور) إلى
**Authentication → Settings → Authorized domains** حتى تعمل نوافذ signInWithPopup.

## 3. Xcode / iOS (Capacitor)

- **Sign in with Apple capability**: من Xcode → Signing & Capabilities → أضف
  "Sign in with Apple" لهدف التطبيق (بدونها سيفشل `signInWithApple` الأصلي).
- **GoogleService-Info.plist**: نزّله من Firebase Console وضَعه في مجلد iOS
  (`ios/App/App/`) حسب توثيق `@capacitor-firebase/authentication`.
- **مطابقة Bundle ID مع Firebase**: تم توحيد Bundle ID على `com.fatinah.game`
  في كل من مشروع Xcode (`project.pbxproj`) وملفات Capacitor، وهو يطابق الآن
  `BUNDLE_ID` الموجود في `GoogleService-Info.plist` (مشروع `fatinah-game`).
  إذا غيّرت Bundle ID مستقبلاً، نزّل ملف plist جديداً مطابقاً من Firebase Console.
- **Push Notifications / aps-environment**: التطبيق لا يستخدم Push Notifications
  حالياً، لذلك لا يحتوي `App.entitlements` على `aps-environment` غير الضروري.
  تحقق الهاتف يمكنه استخدام reCAPTCHA عندما لا يكون APNs مفعّلاً. إذا أضيفت
  إشعارات لاحقاً، أضف Capability وentitlement من Xcode ثم اختبر إعداد
  التوزيع `production` مع Provisioning Profile مناسب.
- **Privacy Manifest**: يحتوي هدف التطبيق على
  `ios/App/App/PrivacyInfo.xcprivacy` ويصرّح بعدم استخدام التتبع وباستخدام
  `NSUserDefaults` لحفظ تفضيلات وتقدّم اللاعب. راجع أي SDK جديد بعد
  `npx cap sync ios` وتأكد أن manifests المدمجة لا تضيف بيانات غير موصوفة.
- **اختبار مطلوب على جهاز حقيقي**: بعد `npx cap sync ios`، جرّب Phone
  Authentication على جهاز iOS فعلي (المحاكي لا يدعم APNs الصامت).
- **REVERSED_CLIENT_ID**: أضف الـ URL Scheme الموجود في GoogleService-Info.plist
  إلى Info.plist (URL Types) لتفعيل رجوع Google OAuth للتطبيق.
- بعد أي تغيير في `package.json` أو ملفات iOS، شغّل `npx cap sync ios`.

## 4. كيف يعمل النظام الآن (ملخّص معماري)

- **أول فتح بلا حساب محفوظ**: `ensureAnonymousSession()` في `index.html` تنشئ
  فوراً مستخدم Firebase Anonymous (أو تتراجع لمعرّف جهاز محلي إن تعذّر ذلك)
  ويُحفظ كـ `authUid` — بلا شاشة تسجيل إجبارية.
- **الترقية (Upgrade)**: عند الضغط على Apple/Google/البريد وحساب المستخدم
  الحالي مجهول (`authProvider==='anonymous'`)، يُستخدم `linkWithApple` /
  `linkWithGoogle` / `linkWithEmailAndPassword` (وليس `signInWith...`) — نفس
  الـ uid يبقى، فلا يضيع تقدّم اللاعب.
- **الربط التفاعلي**: أي خطأ `auth/account-exists-with-different-credential`
  يُعالَج في `handleAuthConflict()` — على **Web SDK** نستخرج بيانات الاعتماد
  المعلّقة عبر `OAuthProvider.credentialFromError` / `GoogleAuthProvider.credentialFromError`
  ونربطها تلقائياً بعد أن يسجّل المستخدم دخوله بطريقته الأصلية
  (`resolvePendingLinkWeb`). على **iOS الأصلي (Capacitor)**: حزمة
  `@capacitor-firebase/authentication` لا تعرض بيانات الاعتماد المعلّقة
  بنفس واجهة Web SDK، لذا يُحفَظ اسم المزوّد المحاوَل في
  `window._pendingLinkNativeProvider`، وبعد نجاح الدخول الأصلي تُستدعى
  `resolveNativePendingLink(FA)` تلقائياً من مسارَي Apple وGoogle وEmail.
  **المسار الهجين الرئيسي (بلا sheet ثانية — v8)**: `appleSignIn`/`googleSignIn`
  تستخدمان `FA.signInWithApple/Google({ skipNativeAuth: true })` لاسترداد
  بيانات الاعتماد في JS قبل أن يحاول Firebase تسجيل الدخول. ثم يتم تسجيل الدخول
  عبر Web SDK؛ إن وقع تعارض، `handleAuthConflict(e, provider, wb)` يحفظ
  `OAuthProvider/GoogleAuthProvider.credentialFromError(e)` في `_pendingLinkCred`.
  عند نجاح الدخول بالمزوّد الأصلي، `resolvePendingLinkWeb(wb, user)` يربط
  المزوّد المعلّق باستخدام `linkWithCredential` — **بلا OAuth sheet ثانية**.
  **المسار الأصلي (احتياطي)**: للمستخدمين المجهولين (الترقية) أو عند انعدام
  الاتصال بـ Web SDK؛ يستدعي `FA.linkWithApple/Google()` مع sheet ثانية.
  إن فشل الربط الثانوي لا يُوقف الدخول — المستخدم داخل حسابه بالفعل
  ويمكنه ربط الطريقة يدوياً من شاشة إدارة الحسابات.
- **شاشة إدارة الحسابات**: قسم "وسائل الدخول المرتبطة" في شاشة الإحصاءات
  (`renderAccountLinks`) يقرأ `user.providerData` مباشرة من Firebase (وليس من
  تخزين محلي) فيعكس الحالة الحقيقية، ويمنع فك آخر وسيلة متبقية.
- **بيانات Apple الدائمة**: عند أول نجاح دخول Apple، تُرسَل `savePermanentProfile()`
  فوراً إلى `POST /api/account/profile` وتُحفَظ في عمودي `display_name`/`email`
  بجدول `subscriptions` في SQLite (بما فيها عناوين `@privaterelay.appleid.com`)
  — لأن Apple لا ترسل هذه الحقول إلا في أول تفويض.
- **تحصين الخادم**: `verify_firebase_id_token()` في `server.py` يتحقق من صحة
  أي `idToken` عبر `identitytoolkit.googleapis.com/v1/accounts:lookup` (بدل
  Firestore Security Rules، بما أن القرار المعماري هو البقاء على SQLite) ويُطبَّق
  حالياً على `/api/account/delete` و`/api/account/profile`. تحصين بقية نقاط
  نقاط الاشتراك الحساسة تُدار عبر `/api/subscription/status` وRevenueCat
  Webhook الموثّق، ولا توجد نقاط دفع خارجية.

## 5. حذف الحساب

`confirmDeleteAccount()` يحذف بيانات الخادم أولاً (بينما جلسة Firebase لا تزال
صالحة لإثبات الهوية عبر idToken)، ثم يحذف مستخدم Firebase فعلياً (مع طلب
إعادة تسجيل دخول تلقائي عند `requires-recent-login`، بما فيها كلمة المرور لو
كان المزوّد `password`)، ثم يمسح كل التخزين المحلي.

## 6. Apple IAP وRevenueCat — إعداد الإنتاج والتحقق الخادمي

الاشتراكات الرقمية في iOS تُباع عبر Apple App Store، بينما يقرر الخادم فتح
المزايا بعد وصول webhook موثّق من RevenueCat. لا يعتمد التطبيق على
`CustomerInfo` أو cache محلي لفتح المزايا.

### إعداد RevenueCat Dashboard

من **Integrations → Webhooks → New webhook** استخدم:

| الحقل | القيمة |
|---|---|
| Webhook name | `Fatinah Apple IAP Production` |
| Webhook URL | `https://ata20.com/api/revenuecat/webhook` |
| Authorization header value | نفس قيمة السر `REVENUECAT_WEBHOOK_SECRET` المحفوظة في Replit Secrets |
| Environment | `Production` |
| App | تطبيق فَطِنة iOS |
| Event type | All، أو الأحداث الموضحة أدناه |

اترك **Paywall events** معطّلة؛ فهي أحداث واجهة وليست أحداث اشتراك. إذا لم
يتوفر خيار All، فعّل `INITIAL_PURCHASE` و`RENEWAL` و`CANCELLATION`
و`EXPIRATION` و`BILLING_ISSUE` و`BILLING_ISSUE_RESOLVED` و`PRODUCT_CHANGE`
و`UNCANCELLATION`.

بعد حفظ webhook، استخدم زر **Send test** إن ظهر، ثم راقب استجابة 200. يجب
نشر آخر نسخة من التطبيق بعد إضافة السر أو تعديل الخادم، لأن النطاق المنشور
لا يقرأ تغييرات بيئة التطوير قبل إعادة النشر.

### ضمان عدم فتح المزايا قبل التأكيد

- سر مفقود: `503` ولا تعديل لأي اشتراك.
- سر خاطئ: `401` ولا تعديل لأي اشتراك.
- `app_user_id` غير مربوط بهوية Firebase: `202` ولا يُنشأ اشتراك.
- شراء أو استعادة ناجحة: `INITIAL_PURCHASE` يجعل الحالة `active`.
- التجديد: `RENEWAL` يجعل الحالة `active`.
- الإلغاء أو الانتهاء أو مشكلة الفوترة: الحالة تصبح غير فعّالة.
- فشل Firestore لا يفتح صلاحية جديدة؛ تُحفظ المحاولة في outbox لإعادة الإرسال.

اختبار المسار المحلي:

```bash
python3 tests/test_revenuecat_webhook.py
```

اختبار دورة Apple الفعلية يحتاج شراء Sandbox/TestFlight ثم التحقق من وصول
`INITIAL_PURCHASE` و`RENEWAL` و`EXPIRATION` من سجل RevenueCat؛ لا تستخدم بيئة
Sandbox مع webhook مضبوط على Production.

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
   استخدم الرقم بصيغة دولية E.164 مثل `+9665xxxxxxxx`.

بعد إنشاء حساب بالبريد، يرسل التطبيق رسالة تحقق تلقائياً. ويمكن إعادة إرسالها
أو تحديث حالة التحقق من شاشة **إحصاءاتي وإنجازاتي**. كما يمكن توثيق رقم الهاتف
من الشاشة نفسها بإرسال رمز SMS ثم إدخال الرمز.

بعد التفعيل، أضف نطاق معاينة Replit (والنطاق المنشور) إلى
**Authentication → Settings → Authorized domains** حتى تعمل نوافذ signInWithPopup.

## 3. Xcode / iOS (Capacitor)

- **Sign in with Apple capability**: من Xcode → Signing & Capabilities → أضف
  "Sign in with Apple" لهدف التطبيق (بدونها سيفشل `signInWithApple` الأصلي).
- **GoogleService-Info.plist**: نزّله من Firebase Console وضَعه في مجلد iOS
  (`ios/App/App/`) حسب توثيق `@capacitor-firebase/authentication`.
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
  الـ API الحساسة (مثل `/api/stripe/create-checkout`) مهمة منفصلة متابَعة عبر
  مهام أخرى في المشروع.

## 5. حذف الحساب

`confirmDeleteAccount()` يحذف بيانات الخادم أولاً (بينما جلسة Firebase لا تزال
صالحة لإثبات الهوية عبر idToken)، ثم يحذف مستخدم Firebase فعلياً (مع طلب
إعادة تسجيل دخول تلقائي عند `requires-recent-login`، بما فيها كلمة المرور لو
كان المزوّد `password`)، ثم يمسح كل التخزين المحلي.

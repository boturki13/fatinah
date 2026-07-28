---
name: Fatinah server setup
description: كيف يشتغل خادم فَطِنة على Replit وأسباب الاختيارات
---

# خادم فَطِنة على Replit

## القرار
الخادم مكتوب بـ Python stdlib فقط (`http.server` + `ThreadingMixIn`) — لا Flask ولا حزم خارجية.

**Why:** Flask غير متوفّر في بيئة NixOS الافتراضية لـ Replit ولا يمكن تثبيته بـ pip بدون `--break-system-packages`. الـ stdlib كافية للمشروع.

**How to apply:** أي تعديل على الخادم يكون في `server.py`. لإضافة endpoint جديد، أضفه في `do_GET` أو `do_POST` حسب النوع.

## نقاط الـ API
- `GET /` → يخدم `index.html`
- `GET /firebase-config.js` → يقرأ env vars ويعيد JS object للمتصفح
- `POST /api/generate` → يستدعي Claude API (`claude-opus-4-5`) ويعيد `{questions:[{q,answer}]}`

## AI Backend URL في index.html
في المتصفح: `/api/generate` (الخادم المحلي)
في iOS native: `https://us-central1-fatinah-game.cloudfunctions.net/generateQuestions` (Firebase Cloud Function)
المنطق في `AI_BACKEND_URL` يتحقق من `Capacitor.isNativePlatform()`.

## Firebase Auth — نظام هوية موحّد (uid واحد لكل شخص)
طبقتان:
1. Capacitor plugin (iOS فقط) — يدعم linkWithApple/linkWithGoogle/linkWithEmailAndPassword/unlink/getIdToken
2. Firebase Web SDK dynamic import من CDN — يعمل في المتصفح إذا كانت env vars جاهزة

**القرار:** أول فتح ينشئ جلسة Anonymous تلقائياً (بلا شاشة دخول إجبارية)؛ الدخول لاحقاً بأي مزوّد يستخدم `linkWith*` (ترقية نفس الحساب) بدل `signInWith*` (حساب جديد) طالما `authProvider==='anonymous'`. التفاصيل الكاملة في `AUTH_SETUP.md` بجذر المشروع.

**قيد معروف:** حزمة `@capacitor-firebase/authentication` لا تعرض بيانات الاعتماد المعلّقة (pending credential) عند تعارض المزوّدين على iOS الأصلي كما يفعل Web SDK — الربط التلقائي الكامل بعد تعارض مضمون على المتصفح فقط، غير مؤكد على iOS بدون اختبار جهاز حقيقي.

**التحقق من الهوية في الخادم:** `server.py` يتحقق من `idToken` عبر `identitytoolkit.googleapis.com/v1/accounts:lookup` (باستخدام `GOOGLE_API_KEY`) بدل الثقة العمياء بـ uid القادم من العميل — بديل لـ Firestore Rules بما أن المشروع يبقى على SQLite عمداً (قرار معماري: لا Firestore).

**قيد بيئي:** إن كان مزوّد Anonymous معطّلاً في Firebase Console، `signInAnonymously()` تفشل بـ `auth/admin-restricted-operation` والتطبيق يتراجع تلقائياً لمعرّف جهاز محلي (device id) — يعمل التطبيق لكن بلا مزامنة حقيقية عبر الأجهزة حتى يُفعَّل.

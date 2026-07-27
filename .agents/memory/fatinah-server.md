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

## Firebase Auth
طبقتان:
1. Capacitor plugin (iOS فقط)
2. Firebase Web SDK dynamic import من CDN — يعمل في المتصفح إذا كانت env vars جاهزة

## المزامنة السحابية والتحقق من الهوية
- endpoints المزامنة (مثل /api/family/*) تتحقق من هوية Firebase عبر Identity Toolkit REST `accounts:lookup` مع GOOGLE_API_KEY وتستخرج uid من الخادم — لا تثق أبداً بـ uid يرسله العميل (مراجعة الأمان رفضت ذلك كـ IDOR).
- المستخدمون بالاسم فقط (anon device id) بلا idToken → لا مزامنة سحابية لهم؛ بياناتهم محلية.
- التسجيل بالبريد عبر identitytoolkit signUp يعمل في هذا المشروع — طريقة عملية للحصول على idToken حقيقي لاختبار endpoints الموثّقة.

# فَطِنة (Fatinah)

لعبة مسابقات جماعية عربية بلهجة خليجية، موجّهة للعائلات والمجالس.

## كيف تشغّل المشروع

```
python3 server.py
```

يشتغل على port 5000 — المعاينة تفتح مباشرة.

## البنية

- `index.html` — كل اللعبة في ملف واحد (HTML + CSS + JavaScript)
- `server.py` — خادم Python stdlib: يخدم index.html + `/api/generate` (AI) + `/firebase-config.js`
- `functions/index.js` — Firebase Cloud Function (نسخة احتياطية للـ AI في iOS app)
- `capacitor.config.ts` / `package.json` — إعدادات Capacitor لتغليف التطبيق كـ iOS app

## المتغيّرات البيئية

| المتغيّر | الاستخدام | إلزامي؟ |
|---|---|---|
| `ANTHROPIC_API_KEY` | توليد الأسئلة بالذكاء الاصطناعي (Claude) | ✅ للتوليد |
| `FIREBASE_API_KEY` | Google/Apple sign-in في المتصفح | لـ auth |
| `FIREBASE_AUTH_DOMAIN` | Google/Apple sign-in في المتصفح | لـ auth |
| `FIREBASE_PROJECT_ID` | Google/Apple sign-in في المتصفح | لـ auth |
| `FIRESTORE_DATABASE_ID` | معرّف قاعدة Firestore Native | `fatinah-native` |
| `FIREBASE_APP_ID` | Google/Apple sign-in في المتصفح | لـ auth |
| `FIREBASE_MESSAGING_SENDER_ID` | Google/Apple sign-in في المتصفح | لـ auth |

## Auth — نظام الهوية الموحّد

كل شخص = uid واحد ثابت بغض النظر عن وسيلة الدخول. أول فتح للتطبيق ينشئ جلسة
Firebase Anonymous تلقائياً بلا شاشة تسجيل إجبارية؛ التسجيل لاحقاً بـ
Apple/Google/بريد يرقّي (link) نفس الحساب بدل إنشاء حساب جديد. التفاصيل
الكاملة (إعداد Firebase Console، Xcode، حدود معروفة على iOS الأصلي) في
`AUTH_SETUP.md`.

- **داخل iOS app:** Capacitor FirebaseAuthentication plugin (Apple + Google + بريد)
- **في المتصفح مع Firebase config:** Firebase Web SDK (popup)
- **بدون Firebase config:** يتراجع لمعرّف جهاز محلي (device id) — يعمل التطبيق لكن بلا مزامنة عبر الأجهزة

## الاشتراكات — Apple IAP عبر RevenueCat

الاشتراكات الرقمية تُباع عبر Apple IAP فقط (لا Stripe ولا Tap). الخادم هو مصدر
الحقيقة: الصلاحية تُفتح فقط بعد وصول webhook موثّق من RevenueCat إلى
`POST /api/revenuecat/webhook`.

**إعداد الإنتاج (RevenueCat Dashboard → Integrations → Webhooks):**
1. Webhook URL: `https://<النطاق المنشور>/api/revenuecat/webhook`
2. Authorization header value: نفس قيمة السر `REVENUECAT_WEBHOOK_SECRET`
   في Replit Secrets (يُقبل خاماً أو بصيغة `Bearer <secret>`).
3. Environment: Production.

**سلوك fail-closed:** بدون السر يعيد الـ endpoint ‏503 ولا يُحدَّث أي اشتراك؛
سر خاطئ → 401؛ UUID غير مربوط بحساب Firebase → 202 بلا فتح صلاحية. عند فشل
كتابة Firestore يُحدَّث SQLite (المرجع) ويُعاد إرسال Firestore عبر outbox.
الاختبار: `python3 tests/test_revenuecat_webhook.py`.

## ملاحظات

- لا يحتاج npm install لتشغيل الخادم — Python stdlib فقط
- بناء iOS app يحتاج Xcode على ماك (شرط من أبل)
- التخزين يعتمد على `localStorage`

## User preferences

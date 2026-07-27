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
| `FIREBASE_APP_ID` | Google/Apple sign-in في المتصفح | لـ auth |
| `FIREBASE_MESSAGING_SENDER_ID` | Google/Apple sign-in في المتصفح | لـ auth |

## Auth — كيف يشتغل

- **داخل iOS app:** يستخدم Capacitor FirebaseAuthentication plugin (Apple + Google)
- **في المتصفح مع Firebase config:** يستخدم Firebase Web SDK (popup)
- **بدون config:** "متابعة بالاسم" تعمل دائماً

## مزامنة www/ (حزمة iOS)

- مجلد `www/` هو ما يشحنه Capacitor لتطبيق iOS — يجب أن يبقى مطابقاً للنسخة الرئيسية
- `bash scripts/sync-www.sh` (أو `npm run sync:www`) ينسخ `index.html` و`vendor/` إلى `www/` ويتحقق من وجود `www/firebase-config.js` و`www/server-config.js`
- يعمل تلقائياً قبل `npm run sync` و`npm run build:ios` (عبر `presync` و`prebuild:ios`)
- ملفا `www/firebase-config.js` و`www/server-config.js` خاصان بحزمة iOS ولا يُنسخان من الجذر (الخادم يولّدهما ديناميكياً للويب)
- السكربت يحذّر إذا كان `SERVER_BASE_URL` رابط تطوير مؤقت (`*.replit.dev`) — استبدله برابط الإنتاج قبل الشحن

## ملاحظات

- لا يحتاج npm install لتشغيل الخادم — Python stdlib فقط
- بناء iOS app يحتاج Xcode على ماك (شرط من أبل)
- التخزين يعتمد على `localStorage`

## User preferences

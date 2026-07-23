# فَطِنة — مشروع Replit

## وش فيه
- `index.html` — اللعبة كاملة (٣٠ فئة، ٩١٥ سؤالاً). اضغط Run ويفتح مباشرة.
- `functions/index.js` — كود خادم Firebase الوسيط (توليد الأسئلة بالذكاء الاصطناعي).
- `CLAUDE.md` — ملخّص المشروع الكامل.
- `capacitor.config.ts` / `package.json` — إعدادات مرجعية لتغليف iOS.

## قيد مهم
Replit بيئة سحابية للويب فقط. **بناء تطبيق iOS الفعلي (Xcode) لازم يصير على ماك** — هذا شرط من أبل نفسها، لا علاقة له بأي منصة تطوير. عدّل هنا، ثم انسخ `index.html` المحدَّث لمجلد `www/` في مشروع Capacitor على جهازك.

## نشر خادم Firebase من هنا
`functions/index.js` كود مرجعي فقط — نشره الفعلي (`firebase deploy`) يحتاج Firebase CLI، تقدر تشغّله من طرفية Replit نفسها إذا ثبّتّه (`npm install -g firebase-tools`).

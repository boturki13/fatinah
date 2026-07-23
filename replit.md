# فَطِنة (Fatinah)

لعبة مسابقات جماعية عربية بلهجة خليجية، موجّهة للعائلات والمجالس.

## كيف تشغّل المشروع

```
python3 -m http.server 5000
```

افتح المعاينة (Preview) وستظهر اللعبة مباشرة.

## البنية

- `index.html` — كل اللعبة في ملف واحد (HTML + CSS + JavaScript). هنا تُجري أي تعديلات.
- `functions/index.js` — كود Firebase Functions (توليد أسئلة بالذكاء الاصطناعي، للنشر على Firebase).
- `capacitor.config.ts` / `package.json` — إعدادات Capacitor لتغليف التطبيق كـ iOS app.

## ملاحظات

- لا يوجد backend مطلوب لتشغيل اللعبة — كل شيء في `index.html`.
- بناء iOS app الفعلي يحتاج Xcode على ماك (شرط من أبل).
- التخزين يعتمد على `localStorage`.

## User preferences

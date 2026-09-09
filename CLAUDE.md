# مشروع فطنة — دليل العمل

## الحالة الحالية

فطنة لعبة مسابقات عربية بلهجة خليجية، واجهتها RTL، وتعمل على الويب وداخل
iOS/iPadOS عبر Capacitor 8. التحديث الجاري هو `1.4.0`، Marketing Version
`1.4`، والبناء التالي `17`. المصدر الرسمي للحالة هو
`release/current.json`؛ البناء غير مرفوع ما لم يقل الملف ذلك صراحة وتوجد
بصمة مصدر وأثر بناء.

## البنية

- الواجهة: `www/`، JavaScript وHTML وCSS من دون framework.
- iOS: `ios/App/`، Swift وCapacitor، مع Firebase وRevenueCat وMetricKit.
- الخادم: `server.py`، API v2 وبنك أسئلة خادمي ومراجع.
- التوافق القديم: `functions/` يحافظ على Cloud Function v1؛ v2 يعلن
  إيقاف التوليد المباشر ويستخدم البنك المراجع.
- المحتوى النصي: `server-assets/question-bank/v1/`.
- محتوى الصور وبيان بصماته: `server-assets/question-images/`. الملفات
  الثنائية لا تُشحن داخل التطبيق ولا تُحفظ في Git.

## مبادئ لا تُكسر

- لا أسرار أو سجلات مصادقة/شراء خام أو قواعد بيانات تشغيلية في Git.
- لا يُعلن TestFlight أو tag أو Archive ما لم يكن له commit وبصمة موثقان.
- بنك الأسئلة المراجع على الخادم هو مصدر الحقيقة؛ لا بنك احتياطي داخل العميل.
- صور الأسئلة لا تُعرض قبل نجاح HTTPS والنوع والحجم وSHA-256 وفك الصورة.
- إذا غابت صور الخادم، يجب أن يستمر البنك النصي وألا تظهر فئات صور مكسورة.
- كل كتابة حساسة في production تستخدم Firebase/App Check/App Attest والحدود
  الموزعة بحسب عقد المسار.
- حافظ على RTL، VoiceOver، Dynamic Type، والوضعين العمودي والأفقي.

## أوامر التحقق اليومية

```bash
npm ci
npm ci --prefix functions
uv sync --locked
npm run security:scan-history
npm run test:ci
npm run images:verify-release-assets
npm run sync:ios
```

اختبارات iOS:

```bash
xcodebuild test \
  -workspace ios/App/App.xcworkspace \
  -scheme App \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -enableCodeCoverage YES \
  CODE_SIGNING_ALLOWED=NO
```

قبل الإصدار شغّل أيضًا:

```bash
npm run questions:release-gate
npm run questions:next-release-gate
npm run images:verify-curated-remote-assets
npm audit --omit=dev
npm audit --prefix functions --omit=dev
```

## سير الإصدار

1. التطوير على `codex/develop-1.4.0`.
2. نجاح CI واختبارات Xcode وفحص الأسرار.
3. نشر الخادم والأصول المتوافقة إلى staging والتحقق من البصمات.
4. إنشاء فرع الإصدار من commit نظيف وتسجيل `sourceCommit`.
5. إنشاء Archive، تسجيل `artifactSha256`، ثم TestFlight داخلي.
6. قبول على جهازين حقيقيين يشمل الشراء والاستعادة والحذف والصور والشبكة
   الضعيفة وVoiceOver وApp Attest.
7. إنشاء tag مطابق ثم طرح تدريجي مع مراقبة Crashlytics وMetricKit.

راجع `docs/RELEASE_PROCESS.md` و`docs/RELEASE_CHECKLIST.md` و
`PRODUCTION_RELEASE_GATE.md` للتفاصيل. لا تعدّل حالة خارجية أو تعيد كتابة
تاريخ Git أو ترفع إلى Apple من دون تفويض واضح.

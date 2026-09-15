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
- الخادم: `server.py`، للحساب والاشتراك وسلامة التطبيق وحزم اللعب الجديدة.
- `question_platform.py`: بنك 1.4 المستقل، التدرج، منع التكرار، البلاغات
  وبوابة اعتماد 600 سؤال. البنك القديم وفئاته وأدوات توليده محذوفة.
- `admin/`: لوحة جودة عربية بسيطة للكتابة والمراجعة والاعتماد ومعالجة البلاغات.
- مسارات `/api/questions/*` و`/api/generate` القديمة متوقفة ولا يعاد استخدامها؛
  تعمل المنظومة الجديدة فقط عبر `/api/v2/game/*`.

## مبادئ لا تُكسر

- لا أسرار أو سجلات مصادقة/شراء خام أو قواعد بيانات تشغيلية في Git.
- لا يُعلن TestFlight أو tag أو Archive ما لم يكن له commit وبصمة موثقان.
- لا تُعد الفئات أو البنك القديم. تضاف أسئلة 1.4 على دفعات موثقة من لوحة الجودة
  فقط، ولا يعتمد الإطلاق قبل 100 سؤال معتمد في كل مستوى من المستويات الستة.
- كل كتابة حساسة في production تستخدم Firebase/App Check/App Attest والحدود
  الموزعة بحسب عقد المسار.
- حافظ على RTL، VoiceOver، Dynamic Type، والوضعين العمودي والأفقي.

## أوامر التحقق اليومية

```bash
npm ci
uv sync --locked
npm run security:scan-history
npm run test:ci
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

قبل الإصدار شغّل أيضًا `npm audit --omit=dev`.

## سير الإصدار

1. التطوير على `codex/develop-1.4.0`.
2. نجاح CI واختبارات Xcode وفحص الأسرار.
3. نشر الخادم إلى staging والتحقق من الحزم المشفرة، منع التكرار، البلاغات،
   وبقاء مسارات الأسئلة القديمة متوقفة.
4. إنشاء فرع الإصدار من commit نظيف وتسجيل `sourceCommit`.
5. إنشاء Archive، تسجيل `artifactSha256`، ثم TestFlight داخلي.
6. قبول على جهازين حقيقيين يشمل الشراء والاستعادة والحذف والحزم المشفرة والشبكة
   الضعيفة وVoiceOver وApp Attest.
7. إنشاء tag مطابق ثم طرح تدريجي مع مراقبة Crashlytics وMetricKit.

راجع `docs/RELEASE_PROCESS.md` و`docs/RELEASE_CHECKLIST.md` و
`PRODUCTION_RELEASE_GATE.md` للتفاصيل. لا تعدّل حالة خارجية أو تعيد كتابة
تاريخ Git أو ترفع إلى Apple من دون تفويض واضح.

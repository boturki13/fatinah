# عملية الإصدار الاحترافية

## الهدف

فصل ما يستخدمه العملاء اليوم عن العمل الجاري، مع أثر تدقيق واضح من commit إلى Replit وXcode وApp Store Connect.

## نموذج الفروع

```text
main
└── codex/develop-1.4.0  ← التحديث الجاري
    ├── codex/feature-...
    ├── codex/fix-...
    └── codex/release-1.4.0  ← يُنشأ فقط بعد نجاح البوابات
```

- لا تُدفع ميزات إلى فرع الإصدار بعد إرساله إلى Apple.
- الإصلاح الحرج يبدأ من tag الإصدار، يرفع رقم البناء، ويمر بكل البوابات من جديد.
- التحديث القادم يبدأ من نقطة الإصدار المعتمدة في فرع مستقل.

## دورة التغيير

1. افتح Issue بمعايير قبول واضحة.
2. أنشئ فرع `codex/feature-*` من فرع التطوير القادم.
3. نفّذ تغييرًا صغيرًا مع اختبارات.
4. افتح Pull Request واستخدم القالب.
5. لا تدمج قبل نجاح CI ومراجعة CODEOWNER.
6. انشر إلى staging فقط، ثم نفّذ smoke test على جهاز حقيقي.
7. ادمج إلى فرع التطوير بعد التحقق.

## إنشاء Release Candidate

1. جمّد الميزات وحدّث `CHANGELOG.md`.
2. حدّث `release/current.json` و`package.json` و`MARKETING_VERSION` و`CURRENT_PROJECT_VERSION` معًا.
3. شغّل:

   ```bash
   npm ci
   npm run images:fetch-release-assets
   npm test
   npm run questions:release-gate
   npm run questions:next-release-gate -- --release
   npm run sync:ios
   ```

4. شغّل اختبارات Swift/Xcode وابنِ Archive موقّعًا.
5. انشر خادم staging وشغّل بوابة الإنتاج مع اعتمادات staging.
6. اختبر TestFlight: تسجيل الدخول، الشراء والاستعادة، الجولة المجانية وإعادة محاولة التحقق، استعادة جولة خادمية من دور الفريق الثاني، البلاغ، الصور، الحذف، الشبكة الضعيفة، اختفاء شريط QA، وVoiceOver.
7. بعد تجميد المصدر، سجّل SHA-1 الكامل في `sourceCommit` وبصمة الـArchive
   في `artifactSha256`، ثم أنشئ tag بصيغة `vX.Y.Z-build.N` من commit
   المرشح نفسه.

## ترتيب النشر

1. تغييرات الخادم المتوافقة خلف feature flags.
2. بوابة الإنتاج ثم نشر Replit.
3. تحقق صحي من الرابط والسجلات والقياسات.
4. رفع Xcode Archive إلى App Store Connect.
5. ربط البناء الصحيح وإرساله للمراجعة.
6. بعد الموافقة، طرح تدريجي مع مراقبة Crashlytics وMetricKit والبلاغات.

## الرجوع

- Replit: أعد نشر آخر deployment ناجح، ولا تعدّل البيانات يدويًا أثناء الحادث.
- iOS: لا يمكن سحب binary من أجهزة العملاء؛ عطّل الميزة المتأثرة عبر flags المتوافقة أو جهّز hotfix ببناء أعلى.
- البيانات: أي migration يجب أن تكون backward-compatible وقابلة للتشغيل أكثر من مرة.
- وثّق الحادث، الأثر، خط الزمن، والإجراء الوقائي بعد الاستعادة.

## ضوابط إلزامية

- لا أسرار في Git أو logs أو screenshots.
- لا نشر من worktree متسخ.
- لا استخدام للبناء نفسه مرتين.
- لا تغيير schema بلا خطة توافق ورجوع.
- لا تفعيل feature flag لعملاء الإنتاج قبل وصول نسخة التطبيق الداعمة.

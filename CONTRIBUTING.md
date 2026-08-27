# المساهمة في فطنة

## الفروع

- `main`: مصدر الحقيقة بعد اكتمال المراجعة والدمج.
- `codex/release-X.Y.Z`: فرع إصدار مجمّد. بعد الإرسال إلى Apple لا يستقبل إلا إصلاحًا حرجًا موثقًا.
- `codex/develop-X.Y.Z`: خط دمج التحديث القادم.
- `codex/feature-*` و`codex/fix-*`: تغييرات صغيرة تُدمج عبر Pull Request.

لا تعمل مباشرة على فرع إصدار موجود تحت مراجعة Apple.

## قبل Pull Request

1. حدّد معايير قبول قابلة للاختبار.
2. أضف أو حدّث الاختبارات مع الكود.
3. شغّل `npm run test:ci`.
4. عند تغيير صور الإنتاج، شغّل `npm run images:verify-release-assets` ثم `npm run test:images`.
5. عند تغيير الويب أو iOS، شغّل `npm run sync:ios` وابنِ التطبيق في Xcode.
6. لا تضف ملفات `.env` أو مفاتيح أو حسابات خدمة أو أسرار Replit.

## الدمج والإصدار

استخدم commits صغيرة برسائل Conventional Commits مثل `feat:`, `fix:`, `test:`, `docs:`, و`chore:`. يجب أن ينجح CI وأن يراجع CODEOWNER التغيير قبل الدمج. اتبع `docs/RELEASE_PROCESS.md` عند إنشاء Release Candidate.

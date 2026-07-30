---
name: Firebase contact verification
description: قرار وتنبيه تشغيل تحقق البريد ورقم الهاتف في تطبيق فَطِنة
---

## القرار
يستخدم التطبيق `sendEmailVerification` للتحقق من البريد، و`linkWithPhoneNumber` ثم تأكيد رمز SMS للتحقق من الهاتف. داخل iOS يمر المسار عبر إضافة Capacitor Firebase Authentication، وفي الويب عبر Firebase Web SDK مع reCAPTCHA غير مرئي.

**Why:** الحسابات تبدأ أحياناً كمستخدم Firebase مجهول، لذلك يجب ربط الهاتف بالحساب الحالي بدلاً من إنشاء مستخدم جديد حتى لا يضيع UID والتقدم.

**How to apply:** أرقام الهاتف الكويتية تُرسل إلى Firebase بصيغة E.164 مثل `+9655xxxxxxx`. يجب تفعيل Email/Password وPhone في Firebase Console، وإضافة نطاقات الويب المسموح بها قبل اختبار SMS من المتصفح.
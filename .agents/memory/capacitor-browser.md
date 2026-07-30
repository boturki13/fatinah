---
name: Capacitor Browser setup
description: قيد مزامنة إضافة Browser في مشروع Capacitor 8
---

# قيد مزامنة إضافة Browser

عند استخدام `@capacitor/browser` مع Capacitor CLI 8، يجب أن يكون TypeScript إصدار 5.x متوافقاً؛ TypeScript 7 قد يجعل CLI يفشل عند قراءة `capacitor.config.ts`.

**Why:** أداة Capacitor CLI 8 تعتمد على واجهات TypeScript القديمة (`ModuleKind.CommonJS`)، بينما الإصدارات الأحدث قد تزيلها أو تغيّرها.

**How to apply:** عند إضافة أي Capacitor plugin جديد، ثبّت الإضافة ثم نفّذ `npx cap sync ios`. إذا فشلت قراءة config، تحقق من إصدار TypeScript وثبّت إصدار 5.x متوافقاً قبل متابعة المزامنة.
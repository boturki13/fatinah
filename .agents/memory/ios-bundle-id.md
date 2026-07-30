---
name: iOS Bundle ID canonical value
description: The canonical iOS bundle ID and its Firebase/StoreKit alignment
---
- Bundle ID الرسمي هو `com.fatinah.game` — يطابق GoogleService-Info.plist (مشروع Firebase `fatinah-game`)، وبادئة منتجات StoreKit (`com.fatinah.game.monthly/annual`)، وcapacitor.config.ts.
- **Why:** كان pbxproj وcapacitor.config.json يحملان `com.fatinah.game.web` سابقاً مما كسر تحقق هاتف Firebase الصامت؛ وُحّدت القيمة.
- **How to apply:** أي تغيير مستقبلي في Bundle ID يتطلب plist جديداً من Firebase Console وتحديث كل ملفات Capacitor وpbxproj معاً. Entitlements في `ios/App/App/App.entitlements` مع `aps-environment=development` مربوطة عبر CODE_SIGN_ENTITLEMENTS.

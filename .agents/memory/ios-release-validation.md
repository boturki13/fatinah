---
name: iOS release validation
description: قيد بيئة التحقق النهائي لتطبيق فطنة على App Store
---

التحقق من أرشيف iOS و`Podfile.lock` النهائي لا يمكن إتمامه داخل بيئة Linux الحالية؛ يلزم جهاز macOS أو CI يحتوي Xcode 26 أو أحدث وiOS 26 SDK وCocoaPods.

**Why:** متطلبات Apple الحالية للرفع إلى App Store Connect تعتمد Xcode 26/iOS 26 SDK، كما أن CocoaPods يعيد توليد lockfile من إصدارات Capacitor وRevenueCat الموجودة فعلياً في `node_modules`. تعديل lockfile يدوياً قد ينتج ملفاً غير صالح.

**How to apply:** بعد أي تغيير في الحزم الأصلية، شغّل `pod install` و`xcodebuild archive` و`xcodebuild -exportArchive` على macOS، ثم اختبر تسجيل الدخول والشراء والاستعادة على جهاز iOS حقيقي قبل الرفع.
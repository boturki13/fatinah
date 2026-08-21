---
name: App Store readiness audit
description: القيود الخارجية المتغيرة التي يجب فحصها قبل رفع فطنة إلى App Store
---

لرفع تطبيق iOS إلى App Store بعد 28 أبريل 2026، يجب بناء الأرشيف باستخدام Xcode 26 أو أحدث وSDK iOS 26 أو أحدث، ولا يكفي نجاح `npx cap sync` داخل Linux.

**Why:** Apple حدّثت شرط الحد الأدنى للـSDK، بينما يتطلب Capacitor 8 وRevenueCat تثبيت CocoaPods وإعادة توليد `Podfile.lock` من الحزم الفعلية قبل الأرشفة.

**How to apply:** بعد أي ترقية لحزم iOS، نفّذ `pod install` ثم `xcodebuild archive` على macOS، واختبر Apple Sign-In والشراء والاستعادة وحذف الحساب على جهاز حقيقي. راجع أيضاً App Store Connect للخصوصية، العمر، الاتفاقيات، المنتجات، والمعلومات الخاصة بالمراجعة.
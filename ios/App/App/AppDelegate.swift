import UIKit
import Capacitor
import FirebaseCore
import FirebaseAuth
import FirebaseMessaging
import UserNotifications
import WebKit

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // في هذه النقطة يكون UIApplication.shared.delegate معيّنًا، وهذا مطلوب
        // لعمل Firebase AppDelegate Swizzler بطريقة صحيحة.
        if FirebaseApp.app() == nil {
            FirebaseApp.configure()
        }
        // تسجيل الإشعارات البعيدة — مطلوب لتفعيل Firebase Phone Auth على iOS
        UIApplication.shared.registerForRemoteNotifications()
        if pushDiagnosticsEnabled {
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
                UNUserNotificationCenter.current().getDeliveredNotifications { notifications in
                    let identifiers = notifications.map(\.request.identifier).joined(separator: ",")
                    print("✅ APNs delivered notifications: \(notifications.count) [\(identifiers)]")
                }
            }
        }
        return true
    }

    // APNs token → Firebase Auth (لازم لـ Phone Auth)
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let tokenString = deviceToken.map { String(format: "%02.2hhx", $0) }.joined()
        print("✅ APNs token received: \(tokenString.prefix(20))...")
        NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: deviceToken)
        Messaging.messaging().apnsToken = deviceToken
        if pushDiagnosticsEnabled {
            Messaging.messaging().token { token, error in
                if let error {
                    print("❌ FCM token fetch failed: \(error.localizedDescription)")
                    return
                }
                if let token {
                    print("✅ FCM token ready: \(token)")
                }
            }
        }
        #if DEBUG
        Auth.auth().setAPNSToken(deviceToken, type: .sandbox)
        #else
        Auth.auth().setAPNSToken(deviceToken, type: .prod)
        #endif
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        print("❌ APNs registration FAILED: \(error.localizedDescription)")
        NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)
    }

    // Silent push من Firebase لتحقق الهوية قبل SMS
    func application(_ application: UIApplication,
                     didReceiveRemoteNotification userInfo: [AnyHashable: Any],
                     fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void) {
        let messageID = userInfo["gcm.message_id"] as? String ?? "unknown"
        if pushDiagnosticsEnabled {
            print("✅ APNs notification received: \(messageID)")
        }
        if Auth.auth().canHandleNotification(userInfo) {
            completionHandler(.noData)
            return
        }
        NotificationCenter.default.post(
            name: Notification.Name("didReceiveRemoteNotification"),
            object: completionHandler,
            userInfo: userInfo
        )
    }

    // reCAPTCHA fallback عبر custom URL scheme
    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        if Auth.auth().canHandle(url) { return true }
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        if let rootVC = activeWindow?.rootViewController,
           let webView = findWKWebView(in: rootVC.view) {
            webView.scrollView.alwaysBounceHorizontal = false
            webView.scrollView.showsHorizontalScrollIndicator = false
        }
    }

    private func findWKWebView(in view: UIView) -> WKWebView? {
        if let wk = view as? WKWebView { return wk }
        for sub in view.subviews {
            if let found = findWKWebView(in: sub) { return found }
        }
        return nil
    }

    private var activeWindow: UIWindow? {
        let windows = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap { $0.windows }

        return windows.first(where: { $0.isKeyWindow }) ?? windows.first
    }

    private var pushDiagnosticsEnabled: Bool {
        CommandLine.arguments.contains("-FatinahPushDiagnostics")
    }

    func applicationWillResignActive(_ application: UIApplication) {}
    func applicationDidEnterBackground(_ application: UIApplication) {}
    func applicationWillEnterForeground(_ application: UIApplication) {}
    func applicationWillTerminate(_ application: UIApplication) {}

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

}

// Opt in to the modern UIKit scene lifecycle while retaining the existing
// storyboard-based Capacitor bridge.
final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
}

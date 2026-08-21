import UIKit
import Capacitor
import FirebaseCore
import FirebaseAuth
import FirebaseMessaging
import FirebaseAppCheck
import UserNotifications
import WebKit

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // في هذه النقطة يكون UIApplication.shared.delegate معيّنًا، وهذا مطلوب
        // لعمل Firebase AppDelegate Swizzler بطريقة صحيحة.
        if FirebaseApp.app() == nil {
            #if DEBUG
            AppCheck.setAppCheckProviderFactory(AppCheckDebugProviderFactory())
            #else
            AppCheck.setAppCheckProviderFactory(FatinahAppCheckProviderFactory())
            #endif
            FirebaseApp.configure()
        }
        FatinahMetricKitService.shared.start()
        // تسجيل الإشعارات البعيدة — مطلوب لتفعيل Firebase Phone Auth على iOS
        UIApplication.shared.registerForRemoteNotifications()
        if pushDiagnosticsEnabled {
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
                UNUserNotificationCenter.current().getDeliveredNotifications { notifications in
                    print("✅ APNs delivered notifications: \(notifications.count)")
                }
            }
        }
        return true
    }

    // APNs token → Firebase Auth (لازم لـ Phone Auth)
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        if pushDiagnosticsEnabled {
            print("✅ APNs token received")
        }
        NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: deviceToken)
        Messaging.messaging().apnsToken = deviceToken
        if pushDiagnosticsEnabled {
            Messaging.messaging().token { token, error in
                if let error {
                    print("❌ FCM token fetch failed: \(String(describing: type(of: error)))")
                    return
                }
                if token != nil {
                    print("✅ FCM token ready")
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
        print("❌ APNs registration FAILED: \(String(describing: type(of: error)))")
        NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)
    }

    // Silent push من Firebase لتحقق الهوية قبل SMS
    func application(_ application: UIApplication,
                     didReceiveRemoteNotification userInfo: [AnyHashable: Any],
                     fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void) {
        if pushDiagnosticsEnabled {
            print("✅ APNs notification received")
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
        FatinahMetricKitService.shared.drainOutbox()
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
    func applicationWillTerminate(_ application: UIApplication) {
        FatinahMetricKitService.shared.stop()
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

}

private final class FatinahAppCheckProviderFactory: NSObject, AppCheckProviderFactory {
    func createProvider(with app: FirebaseApp) -> AppCheckProvider? {
        AppAttestProvider(app: app)
    }
}

// Opt in to the modern UIKit scene lifecycle while retaining the existing
// storyboard-based Capacitor bridge.
final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
}

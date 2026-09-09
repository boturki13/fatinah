import Capacitor
import Security
import WebKit

struct FatinahKeychainError: Error, Equatable {
    let status: OSStatus
}

protocol FatinahSecItemServing {
    func copyMatching(_ query: [String: Any], result: inout CFTypeRef?) -> OSStatus
    func add(_ attributes: [String: Any]) -> OSStatus
    func update(_ query: [String: Any], attributes: [String: Any]) -> OSStatus
    func delete(_ query: [String: Any]) -> OSStatus
}

struct FatinahSystemSecItemService: FatinahSecItemServing {
    func copyMatching(_ query: [String: Any], result: inout CFTypeRef?) -> OSStatus {
        SecItemCopyMatching(query as CFDictionary, &result)
    }

    func add(_ attributes: [String: Any]) -> OSStatus {
        SecItemAdd(attributes as CFDictionary, nil)
    }

    func update(_ query: [String: Any], attributes: [String: Any]) -> OSStatus {
        SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
    }

    func delete(_ query: [String: Any]) -> OSStatus {
        SecItemDelete(query as CFDictionary)
    }
}

/// مخزن صغير قابل للاختبار. مفتاح RevenueCat عام، لكن إبقاء دورة حياته في
/// Keychain يمنع نسخه إلى Preferences ويعطي سلوكاً ثابتاً بعد تحديث التطبيق.
struct RevenueCatKeychainStore {
    let service: String
    let account: String
    private let security: any FatinahSecItemServing

    init(
        service: String = "com.fatinah.game.revenuecat",
        account: String = "public-api-key",
        security: any FatinahSecItemServing = FatinahSystemSecItemService()
    ) {
        self.service = service
        self.account = account
        self.security = security
    }

    func get() throws -> String? {
        var query = identityQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = security.copyMatching(query, result: &result)
        switch status {
        case errSecSuccess:
            guard let data = result as? Data,
                  let value = String(data: data, encoding: .utf8) else {
                throw FatinahKeychainError(status: errSecDecode)
            }
            return value
        case errSecItemNotFound:
            return nil
        default:
            throw FatinahKeychainError(status: status)
        }
    }

    func set(_ value: String) throws {
        var item = identityQuery
        item[kSecValueData as String] = Data(value.utf8)
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let addStatus = security.add(item)
        switch addStatus {
        case errSecSuccess:
            return
        case errSecDuplicateItem:
            let updateStatus = security.update(
                identityQuery,
                attributes: [kSecValueData as String: Data(value.utf8)]
            )
            guard updateStatus == errSecSuccess else {
                throw FatinahKeychainError(status: updateStatus)
            }
        default:
            throw FatinahKeychainError(status: addStatus)
        }
    }

    func clear() throws {
        let status = security.delete(identityQuery)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw FatinahKeychainError(status: status)
        }
    }

    private var identityQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }
}

@objc(RevenueCatKeyStorePlugin)
final class RevenueCatKeyStorePlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "RevenueCatKeyStorePlugin"
    let jsName = "RevenueCatKeyStore"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clear", returnType: CAPPluginReturnPromise),
    ]

    private let store = RevenueCatKeychainStore()
    private let keychainQueue = DispatchQueue(
        label: "com.fatinah.game.revenuecat-keychain",
        qos: .userInitiated
    )

    @objc func get(_ call: CAPPluginCall) {
        keychainQueue.async { [weak self] in
            guard let self else { return }
            do {
                let value = try self.store.get() ?? ""
                DispatchQueue.main.async { call.resolve(["value": value]) }
            } catch {
                DispatchQueue.main.async {
                    call.reject("تعذر قراءة مفتاح RevenueCat من Keychain")
                }
            }
        }
    }

    @objc func set(_ call: CAPPluginCall) {
        guard let value = call.getString("value"), value.hasPrefix("appl_") else {
            call.reject("مفتاح RevenueCat غير صالح"); return
        }
        keychainQueue.async { [weak self] in
            guard let self else { return }
            do {
                try self.store.set(value)
                DispatchQueue.main.async { call.resolve() }
            } catch {
                DispatchQueue.main.async {
                    call.reject("تعذر حفظ مفتاح RevenueCat في Keychain")
                }
            }
        }
    }

    @objc func clear(_ call: CAPPluginCall) {
        keychainQueue.async { [weak self] in
            guard let self else { return }
            do {
                try self.store.clear()
                DispatchQueue.main.async { call.resolve() }
            } catch {
                DispatchQueue.main.async {
                    call.reject("تعذر حذف مفتاح RevenueCat من Keychain")
                }
            }
        }
    }
}

/// Compatibility account-boundary bridge. MetricKit and Crashlytics remain
/// anonymous; these calls only trigger fail-closed cleanup of legacy telemetry
/// files so existing web logout/delete-account ordering stays safe.
@objc(FatinahTelemetryIdentityPlugin)
final class FatinahTelemetryIdentityPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "FatinahTelemetryIdentityPlugin"
    let jsName = "FatinahTelemetryIdentity"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setOwner", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearOwner", returnType: CAPPluginReturnPromise),
    ]

    @objc func setOwner(_ call: CAPPluginCall) {
        guard let uid = call.getString("uid"), !uid.isEmpty else {
            call.reject("معرّف المستخدم مطلوب")
            return
        }
        FatinahMetricKitService.shared.setOwnerUID(uid) { accepted in
            if accepted {
                call.resolve()
            } else {
                call.reject("معرّف المستخدم غير صالح")
            }
        }
    }

    @objc func clearOwner(_ call: CAPPluginCall) {
        FatinahMetricKitService.shared.clearOwnerAndPurge { removedCount in
            call.resolve(["removedCount": removedCount])
        }
    }
}

@objc(FatinahBridgeViewController)
final class FatinahBridgeViewController: CAPBridgeViewController {
    private var didReloadForGameFlowUITests = false
    private var didInstallGameFlowUITestBridge = false

    override func capacitorDidLoad() {
        #if DEBUG
        let environment = ProcessInfo.processInfo.environment
        let gameFlowUITest = CommandLine.arguments.contains("-FatinahGameFlowUITests")
            || environment["FATINAH_GAME_FLOW_UI_TEST"] == "1"
            || environment["FATINAH_IMAGE_FLOW_UI_TEST"] == "1"
        if gameFlowUITest && !didInstallGameFlowUITestBridge {
            didInstallGameFlowUITestBridge = true
            var source = "Object.defineProperty(window, '__FATINAH_GAME_FLOW_UI_TEST__', { value: true });"
            if CommandLine.arguments.contains("-FatinahImageFlowUITests")
                || environment["FATINAH_IMAGE_FLOW_UI_TEST"] == "1" {
                source += "Object.defineProperty(window, '__FATINAH_IMAGE_FLOW_UI_TEST__', { value: true });"
                let avifFixture = "AAAAHGZ0eXBhdmlmAAAAAG1pZjFhdmlmbWlhZgAAANZtZXRhAAAAAAAAACFoZGxyAAAAAAAAAABwaWN0AAAAAAAAAAAAAAAAAAAAAA5waXRtAAAAAAABAAAAImlsb2MAAAAAREAAAQABAAAAAAD6AAEAAAAAAAABMwAAACNpaW5mAAAAAAABAAAAFWluZmUCAAAAAAEAAGF2MDEAAAAAVmlwcnAAAAA4aXBjbwAAAAxhdjFDgSgCAAAAABRpc3BlAAAAAAAABQAAAAQAAAAAEHBpeGkAAAAAAwgICAAAABZpcG1hAAAAAAAAAAEAAQOBAgMAAAE7bWRhdBIACgo6Kmf//8oCGg0gMqICHWGgAAIAAUWAACUBx3uIvgpYN0qzl005T6g42+0JNvf3AYzPkgzWYYC+KizLnXz74CQMdaNcghmPBtBy3fxFAguWAMiMtzC4339BDZvibMfZ/jCpu/2uJQHHe4i+Clg3SrOXTTlPqDjb7Qk29/cBjM+SDNZhgL4qLMudfPvgHwx1o1yCGY8G0HLd/EeTd/zedtLMBOo7wZkdvk6LxTrIJuAnrwF+McBkaLNUvDwtRELA/n/NVUzdH4Hkq8/1idKu1w9soANEnCJx7tr6MF+k2Y3fP+J4d57JH55qqtTa3R+B5KvP55tZQRpxQCfgJ68LlfcAZGizVLw8LURCwP5/zVVM3R+B5KvP9Y032/rh7ZQAaJOAce7a+jBfpNmN3z8Y8UA="
                let webpFixture = "UklGRlACAABXRUJQVlA4IEQCAABQJQCdASqIAUkBPnk8m0skoyIlIHVYCKAPCWlu4XETCmLIs+rzQc+CGqpNlyyghqqS3lp63EOqrqwjlr0VbDCe+/LXoy8Ry16MvEcteyAoIaqdROyYh1VKYCBgCiOap7EEh2uqJHVUmy5ZQQ1Vm1JsmIdVSbJuFBDVUmyddvROOQQ1VJsmIv4o6qk2TEbaGqpNku1AZIo5OB6MIzfr+xBOPFrx7EMCDxtjRHOJxGZzg5XpfuEJk3XDr0ZeI7NI1c85zqZ8dAc2jzjkEL5ClSbM3ZyPOo3E4rW9biYgHWLeJkNVSbIQDr3cvEctejLfk1JsmIdVSbJiHVUmyYh1VJsmIdVSbJiHVUmyYh14OOObW4h1VJsmItrxHLXoy8Ry16M+etxDqqUMd6zgEd/9n9EE3aYAAP7/EyH5KhbgeJJUCaEcQlgFWrEEWH1wkLmmDbXoBFvs1gIDEtY/eecLdV+83I5wZXW9/MjfXGM+jC/SRZHUKYZyugqWZ4VV7VonHltWSRfPNYK9/mRQxJ0Kb4nih3N/LKgT98/yZR3sTvaVZjiXuxwbuqNch6paDyiI1COUWJloThB7HyW7hkrWFoQW/CK//+1u11jQ6A3GVLdl8h/7WobhUWNZpiu0n1dkfH2Pfh87263jsfgQeRezorpSIUBRuFusgB7SDjFZvGx2PHrlGF1FmiLOXFXIlf/6awvuXsLHlM28cl1KOEMUp1f88vXxNzLYAAAXFkqbcD2KgjvB15jMZiyr4tzfccpRfSPHAQAA"
                source += """
                Object.defineProperty(window, '__FATINAH_IMAGE_FLOW_UI_TEST_ASSETS__', {
                  value: Object.freeze({
                    'image/avif': '\(avifFixture)',
                    'image/webp': '\(webpFixture)'
                  }),
                  writable: false,
                  configurable: false
                });
                """
            }
            if CommandLine.arguments.contains("-FatinahDynamicTypeUITests") {
                source += "Object.defineProperty(window, '__FATINAH_DYNAMIC_TYPE_UI_TEST__', { value: true });"
            }
            webView?.configuration.userContentController.addUserScript(
                WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true)
            )
            // On physical devices the initial Capacitor document can begin before
            // capacitorDidLoad installs the test-only user script. Reload exactly
            // once so the fixture flags are present at document start.
            if !didReloadForGameFlowUITests {
                didReloadForGameFlowUITests = true
                webView?.reload()
            }
        }
        #endif
        installDynamicTypeBridge()
        bridge?.registerPluginInstance(RevenueCatKeyStorePlugin())
        bridge?.registerPluginInstance(FatinahTelemetryIdentityPlugin())
        bridge?.registerPluginInstance(FatinahDeviceIntegrityPlugin())
    }

    override func traitCollectionDidChange(_ previousTraitCollection: UITraitCollection?) {
        super.traitCollectionDidChange(previousTraitCollection)
        guard previousTraitCollection?.preferredContentSizeCategory != traitCollection.preferredContentSizeCategory else { return }
        applyDynamicTypeAdjustment()
    }

    private func installDynamicTypeBridge() {
        let percent = dynamicTypeAdjustmentPercent
        let source = """
        (() => {
          window.__setFatinahTextSizeAdjustment = (percent) => {
            document.documentElement.style.setProperty('--fatinah-text-size-adjust', `${percent}%`);
            document.documentElement.dataset.fatinahTextScale = String(percent);
          };
          window.__setFatinahTextSizeAdjustment(\(percent));
        })();
        """
        webView?.configuration.userContentController.addUserScript(
            WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        )
        applyDynamicTypeAdjustment()
    }

    private func applyDynamicTypeAdjustment() {
        let percent = dynamicTypeAdjustmentPercent
        webView?.evaluateJavaScript("window.__setFatinahTextSizeAdjustment && window.__setFatinahTextSizeAdjustment(\(percent));")
    }

    private var dynamicTypeAdjustmentPercent: Int {
        switch traitCollection.preferredContentSizeCategory {
        case .extraSmall: return 90
        case .small: return 95
        case .medium, .large: return 100
        case .extraLarge: return 110
        case .extraExtraLarge: return 120
        case .extraExtraExtraLarge: return 130
        case .accessibilityMedium: return 140
        case .accessibilityLarge: return 150
        case .accessibilityExtraLarge: return 160
        case .accessibilityExtraExtraLarge: return 170
        case .accessibilityExtraExtraExtraLarge: return 180
        default: return 100
        }
    }
}

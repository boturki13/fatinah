import Capacitor
import Security

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
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(RevenueCatKeyStorePlugin())
        bridge?.registerPluginInstance(FatinahTelemetryIdentityPlugin())
        bridge?.registerPluginInstance(FatinahDeviceIntegrityPlugin())
    }
}

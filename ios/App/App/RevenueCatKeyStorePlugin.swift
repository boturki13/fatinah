import Capacitor
import Security

@objc(RevenueCatKeyStorePlugin)
final class RevenueCatKeyStorePlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "RevenueCatKeyStorePlugin"
    let jsName = "RevenueCatKeyStore"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clear", returnType: CAPPluginReturnPromise),
    ]

    private let service = "com.fatinah.game.revenuecat"
    private let account = "public-api-key"

    @objc func get(_ call: CAPPluginCall) {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { call.resolve(["value": ""]); return }
        guard status == errSecSuccess, let data = result as? Data,
              let value = String(data: data, encoding: .utf8) else {
            call.reject("تعذر قراءة مفتاح RevenueCat من Keychain")
            return
        }
        call.resolve(["value": value])
    }

    @objc func set(_ call: CAPPluginCall) {
        guard let value = call.getString("value"), value.hasPrefix("appl_") else {
            call.reject("مفتاح RevenueCat غير صالح"); return
        }
        let data = Data(value.utf8)
        let status = SecItemUpdate(baseQuery as CFDictionary,
                                   [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var item = baseQuery
            item[kSecValueData as String] = data
            guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else {
                call.reject("تعذر حفظ مفتاح RevenueCat في Keychain"); return
            }
        } else if status != errSecSuccess {
            call.reject("تعذر تحديث مفتاح RevenueCat في Keychain"); return
        }
        call.resolve()
    }

    @objc func clear(_ call: CAPPluginCall) {
        let status = SecItemDelete(baseQuery as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            call.reject("تعذر حذف مفتاح RevenueCat من Keychain"); return
        }
        call.resolve()
    }

    private var baseQuery: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account,
         kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
    }
}

@objc(FatinahBridgeViewController)
final class FatinahBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(RevenueCatKeyStorePlugin())
    }
}

import Capacitor
import DeviceCheck
import Foundation
import Security

enum FatinahDeviceCheckError: Error, Equatable {
    case unsupported
    case emptyToken
}

/// غلاف صغير قابل للاختبار حول DCDevice. لا نخزن token لأن Apple تعتبره
/// مؤقتاً وأحادي الاستخدام؛ كل استدعاء من JavaScript يولد token جديداً.
final class FatinahDeviceCheckTokenService {
    typealias TokenGenerator = (@escaping (Data?, Error?) -> Void) -> Void

    private let isSupported: () -> Bool
    private let generateToken: TokenGenerator

    init(
        isSupported: @escaping () -> Bool = { DCDevice.current.isSupported },
        generateToken: @escaping TokenGenerator = { completion in
            DCDevice.current.generateToken(completionHandler: completion)
        }
    ) {
        self.isSupported = isSupported
        self.generateToken = generateToken
    }

    func generate(completion: @escaping (Result<String, Error>) -> Void) {
        guard isSupported() else {
            completion(.failure(FatinahDeviceCheckError.unsupported))
            return
        }
        generateToken { data, error in
            if let error {
                completion(.failure(error))
                return
            }
            guard let data, !data.isEmpty else {
                completion(.failure(FatinahDeviceCheckError.emptyToken))
                return
            }
            completion(.success(data.base64EncodedString()))
        }
    }
}

enum FatinahAppAttestError: Error, Equatable {
    case unsupported
    case missingKeyID
    case invalidKeyID
    case invalidClientDataHash
    case emptyGeneratedKeyID
    case emptyAttestation
    case emptyAssertion
    case keyReset
    case keychain(OSStatus)
    case appleServerUnavailable
    case appleInvalidKey
    case appleInvalidInput
    case appleFailure

    static func fromApple(_ error: Error) -> FatinahAppAttestError {
        let nsError = error as NSError
        guard nsError.domain == DCError.errorDomain else {
            return .appleFailure
        }

        switch nsError.code {
        case DCError.Code.featureUnsupported.rawValue:
            return .unsupported
        case DCError.Code.serverUnavailable.rawValue:
            return .appleServerUnavailable
        case DCError.Code.invalidKey.rawValue:
            return .appleInvalidKey
        case DCError.Code.invalidInput.rawValue:
            return .appleInvalidInput
        default:
            return .appleFailure
        }
    }
}

protocol FatinahAppAttestKeyIDStore {
    func load() throws -> String?
    func save(_ keyID: String) throws
    func delete() throws
}

/// App Attest يحفظ معرّف المفتاح فقط. المفتاح الخاص يبقى تحت إدارة Apple،
/// ولا نخزن كائنات attestation أو assertion في Keychain أو على القرص.
final class FatinahAppAttestKeyIDKeychainStore: FatinahAppAttestKeyIDStore {
    private let service: String
    private let account: String

    init(
        service: String = "\(Bundle.main.bundleIdentifier ?? "com.fatinah.game").app-attest",
        account: String = "installation-key-id"
    ) {
        self.service = service
        self.account = account
    }

    func load() throws -> String? {
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account,
            kSecMatchLimit: kSecMatchLimitOne,
            kSecReturnData: true,
        ]

        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        switch status {
        case errSecSuccess:
            guard
                let data = result as? Data,
                let keyID = String(data: data, encoding: .utf8),
                FatinahAppAttestService.isValidKeyID(keyID)
            else {
                throw FatinahAppAttestError.invalidKeyID
            }
            return keyID
        case errSecItemNotFound:
            return nil
        default:
            throw FatinahAppAttestError.keychain(status)
        }
    }

    func save(_ keyID: String) throws {
        guard FatinahAppAttestService.isValidKeyID(keyID) else {
            throw FatinahAppAttestError.invalidKeyID
        }

        let identity: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account,
        ]
        var add = identity
        add[kSecValueData] = Data(keyID.utf8)
        add[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly

        switch SecItemAdd(add as CFDictionary, nil) {
        case errSecSuccess:
            return
        case errSecDuplicateItem:
            let status = SecItemUpdate(
                identity as CFDictionary,
                [kSecValueData: Data(keyID.utf8)] as CFDictionary
            )
            guard status == errSecSuccess else {
                throw FatinahAppAttestError.keychain(status)
            }
        case let status:
            throw FatinahAppAttestError.keychain(status)
        }
    }

    func delete() throws {
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account,
        ]
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw FatinahAppAttestError.keychain(status)
        }
    }
}

/// غلاف قابل للاختبار حول DCAppAttestService. كل عمليات Keychain تتم على
/// serial queue مخصصة، كما ندمج طلبات generateKey المتزامنة حتى لا ننشئ
/// مفاتيح Secure Enclave إضافية بلا حاجة.
final class FatinahAppAttestService {
    typealias KeyGenerator = (@escaping (String?, Error?) -> Void) -> Void
    typealias ArtifactGenerator = (
        _ keyID: String,
        _ clientDataHash: Data,
        _ completion: @escaping (Data?, Error?) -> Void
    ) -> Void

    private let supportProvider: () -> Bool
    private let keyGenerator: KeyGenerator
    private let attestationGenerator: ArtifactGenerator
    private let assertionGenerator: ArtifactGenerator
    private let keyIDStore: FatinahAppAttestKeyIDStore
    private let stateQueue: DispatchQueue
    private var pendingKeyCompletions: [(Result<String, Error>) -> Void] = []
    private var activeGenerationID: UUID?

    init(
        supportProvider: @escaping () -> Bool = { DCAppAttestService.shared.isSupported },
        keyGenerator: @escaping KeyGenerator = { completion in
            DCAppAttestService.shared.generateKey(completionHandler: completion)
        },
        attestationGenerator: @escaping ArtifactGenerator = { keyID, hash, completion in
            DCAppAttestService.shared.attestKey(
                keyID,
                clientDataHash: hash,
                completionHandler: completion
            )
        },
        assertionGenerator: @escaping ArtifactGenerator = { keyID, hash, completion in
            DCAppAttestService.shared.generateAssertion(
                keyID,
                clientDataHash: hash,
                completionHandler: completion
            )
        },
        keyIDStore: FatinahAppAttestKeyIDStore = FatinahAppAttestKeyIDKeychainStore(),
        stateQueue: DispatchQueue = DispatchQueue(
            label: "com.fatinah.game.app-attest-state",
            qos: .userInitiated
        )
    ) {
        self.supportProvider = supportProvider
        self.keyGenerator = keyGenerator
        self.attestationGenerator = attestationGenerator
        self.assertionGenerator = assertionGenerator
        self.keyIDStore = keyIDStore
        self.stateQueue = stateQueue
    }

    var isSupported: Bool {
        supportProvider()
    }

    static func isValidKeyID(_ keyID: String) -> Bool {
        !keyID.isEmpty
            && keyID.count <= 1_024
            && keyID.trimmingCharacters(in: .whitespacesAndNewlines) == keyID
    }

    static func decodeClientDataHash(_ base64: String?) throws -> Data {
        guard
            let base64,
            !base64.isEmpty,
            let data = Data(base64Encoded: base64),
            data.count == 32
        else {
            throw FatinahAppAttestError.invalidClientDataHash
        }
        return data
    }

    func generateKey(completion: @escaping (Result<String, Error>) -> Void) {
        guard isSupported else {
            completion(.failure(FatinahAppAttestError.unsupported))
            return
        }

        stateQueue.async {
            do {
                if let existing = try self.keyIDStore.load() {
                    completion(.success(existing))
                    return
                }
            } catch {
                completion(.failure(error))
                return
            }

            self.pendingKeyCompletions.append(completion)
            guard self.activeGenerationID == nil else {
                return
            }
            let generationID = UUID()
            self.activeGenerationID = generationID

            self.keyGenerator { keyID, error in
                self.stateQueue.async {
                    guard self.activeGenerationID == generationID else {
                        return
                    }
                    self.activeGenerationID = nil
                    let result: Result<String, Error>
                    if let error {
                        result = .failure(FatinahAppAttestError.fromApple(error))
                    } else if let keyID, Self.isValidKeyID(keyID) {
                        do {
                            try self.keyIDStore.save(keyID)
                            result = .success(keyID)
                        } catch {
                            result = .failure(error)
                        }
                    } else {
                        result = .failure(FatinahAppAttestError.emptyGeneratedKeyID)
                    }

                    let completions = self.pendingKeyCompletions
                    self.pendingKeyCompletions.removeAll(keepingCapacity: true)
                    for completion in completions {
                        completion(result)
                    }
                }
            }
        }
    }

    func resetKey(completion: @escaping (Result<Void, Error>) -> Void) {
        stateQueue.async {
            do {
                try self.keyIDStore.delete()
            } catch {
                completion(.failure(error))
                return
            }

            // إذا وصل reset أثناء generateKey نلغي نتيجة الجيل القديم. لا
            // يمكنه إعادة حفظ keyId بعد الحذف، والطلب اللاحق يولد جيلاً جديداً.
            self.activeGenerationID = nil
            let canceled = self.pendingKeyCompletions
            self.pendingKeyCompletions.removeAll(keepingCapacity: true)
            for pending in canceled {
                pending(.failure(FatinahAppAttestError.keyReset))
            }
            completion(.success(()))
        }
    }

    func attestKey(
        keyID: String,
        clientDataHashBase64: String?,
        completion: @escaping (Result<String, Error>) -> Void
    ) {
        generateArtifact(
            keyID: keyID,
            clientDataHashBase64: clientDataHashBase64,
            emptyError: .emptyAttestation,
            generator: attestationGenerator,
            completion: completion
        )
    }

    func generateAssertion(
        keyID: String,
        clientDataHashBase64: String?,
        completion: @escaping (Result<String, Error>) -> Void
    ) {
        generateArtifact(
            keyID: keyID,
            clientDataHashBase64: clientDataHashBase64,
            emptyError: .emptyAssertion,
            generator: assertionGenerator,
            completion: completion
        )
    }

    private func generateArtifact(
        keyID: String,
        clientDataHashBase64: String?,
        emptyError: FatinahAppAttestError,
        generator: @escaping ArtifactGenerator,
        completion: @escaping (Result<String, Error>) -> Void
    ) {
        guard isSupported else {
            completion(.failure(FatinahAppAttestError.unsupported))
            return
        }
        guard Self.isValidKeyID(keyID) else {
            completion(.failure(FatinahAppAttestError.invalidKeyID))
            return
        }

        let hash: Data
        do {
            hash = try Self.decodeClientDataHash(clientDataHashBase64)
        } catch {
            completion(.failure(error))
            return
        }

        stateQueue.async {
            do {
                guard let storedKeyID = try self.keyIDStore.load() else {
                    completion(.failure(FatinahAppAttestError.missingKeyID))
                    return
                }
                guard storedKeyID == keyID else {
                    completion(.failure(FatinahAppAttestError.invalidKeyID))
                    return
                }
            } catch {
                completion(.failure(error))
                return
            }

            generator(keyID, hash) { data, error in
                if let error {
                    completion(.failure(FatinahAppAttestError.fromApple(error)))
                    return
                }
                guard let data, !data.isEmpty else {
                    completion(.failure(emptyError))
                    return
                }
                completion(.success(data.base64EncodedString()))
            }
        }
    }
}

@objc(FatinahDeviceIntegrityPlugin)
final class FatinahDeviceIntegrityPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "FatinahDeviceIntegrityPlugin"
    let jsName = "FatinahDeviceIntegrity"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "generateDeviceCheckToken", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "isSupported", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "generateKey", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "resetKey", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "attestKey", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "generateAssertion", returnType: CAPPluginReturnPromise),
    ]

    private let tokenService = FatinahDeviceCheckTokenService()
    private let appAttestService = FatinahAppAttestService()

    @objc func generateDeviceCheckToken(_ call: CAPPluginCall) {
        tokenService.generate { result in
            DispatchQueue.main.async {
                switch result {
                case .success(let token):
                    call.resolve(["token": token])
                case .failure(FatinahDeviceCheckError.unsupported):
                    call.reject("DeviceCheck غير مدعوم على هذا الجهاز", "DEVICE_CHECK_UNSUPPORTED")
                case .failure:
                    call.reject("تعذّر إنشاء رمز DeviceCheck", "DEVICE_CHECK_FAILED")
                }
            }
        }
    }

    @objc func isSupported(_ call: CAPPluginCall) {
        call.resolve(["isSupported": appAttestService.isSupported])
    }

    @objc func generateKey(_ call: CAPPluginCall) {
        appAttestService.generateKey { result in
            DispatchQueue.main.async {
                switch result {
                case .success(let keyID):
                    call.resolve(["keyId": keyID])
                case .failure(let error):
                    self.rejectAppAttest(call, error: error)
                }
            }
        }
    }

    @objc func resetKey(_ call: CAPPluginCall) {
        appAttestService.resetKey { result in
            DispatchQueue.main.async {
                switch result {
                case .success:
                    call.resolve(["reset": true])
                case .failure(let error):
                    self.rejectAppAttest(call, error: error)
                }
            }
        }
    }

    @objc func attestKey(_ call: CAPPluginCall) {
        guard let keyID = call.getString("keyId") else {
            call.reject("معرّف App Attest مطلوب", "APP_ATTEST_INVALID_KEY_ID")
            return
        }
        appAttestService.attestKey(
            keyID: keyID,
            clientDataHashBase64: call.getString("clientDataHash")
        ) { result in
            DispatchQueue.main.async {
                switch result {
                case .success(let attestationObject):
                    call.resolve(["attestationObject": attestationObject])
                case .failure(let error):
                    self.rejectAppAttest(call, error: error)
                }
            }
        }
    }

    @objc func generateAssertion(_ call: CAPPluginCall) {
        guard let keyID = call.getString("keyId") else {
            call.reject("معرّف App Attest مطلوب", "APP_ATTEST_INVALID_KEY_ID")
            return
        }
        appAttestService.generateAssertion(
            keyID: keyID,
            clientDataHashBase64: call.getString("clientDataHash")
        ) { result in
            DispatchQueue.main.async {
                switch result {
                case .success(let assertion):
                    call.resolve(["assertion": assertion])
                case .failure(let error):
                    self.rejectAppAttest(call, error: error)
                }
            }
        }
    }

    private func rejectAppAttest(_ call: CAPPluginCall, error: Error) {
        switch error as? FatinahAppAttestError {
        case .unsupported:
            call.reject("App Attest غير مدعوم على هذا الجهاز", "APP_ATTEST_UNSUPPORTED")
        case .missingKeyID:
            call.reject("لم يتم إنشاء مفتاح App Attest", "APP_ATTEST_KEY_NOT_GENERATED")
        case .invalidKeyID, .emptyGeneratedKeyID:
            call.reject("معرّف App Attest غير صالح", "APP_ATTEST_INVALID_KEY_ID")
        case .invalidClientDataHash:
            call.reject(
                "clientDataHash يجب أن يكون SHA-256 بصيغة Base64",
                "APP_ATTEST_INVALID_CLIENT_DATA_HASH"
            )
        case .keychain(let status) where status == errSecInteractionNotAllowed:
            call.reject("Keychain غير متاح قبل فتح الجهاز", "APP_ATTEST_KEYCHAIN_LOCKED")
        case .keychain:
            call.reject("تعذّر الوصول إلى معرّف App Attest", "APP_ATTEST_KEYCHAIN_FAILED")
        case .appleServerUnavailable:
            call.reject("خدمة App Attest غير متاحة مؤقتاً", "APP_ATTEST_SERVER_UNAVAILABLE")
        case .appleInvalidKey:
            call.reject("رفضت Apple مفتاح App Attest", "APP_ATTEST_INVALID_KEY")
        case .appleInvalidInput:
            call.reject("بيانات App Attest غير صالحة", "APP_ATTEST_INVALID_INPUT")
        case .emptyAttestation, .emptyAssertion, .appleFailure, .none:
            call.reject("تعذّرت عملية App Attest", "APP_ATTEST_FAILED")
        case .keyReset:
            call.reject("تمت إعادة تعيين مفتاح App Attest", "APP_ATTEST_KEY_RESET")
        }
    }
}

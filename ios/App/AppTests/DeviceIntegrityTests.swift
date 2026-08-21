import DeviceCheck
import Foundation
import Security
import Testing
@testable import App

@Suite("DeviceCheck token service")
struct DeviceIntegrityTests {
    @Test("Each request returns the freshly generated token as Base64")
    func encodesFreshToken() async {
        var calls = 0
        let service = FatinahDeviceCheckTokenService(
            isSupported: { true },
            generateToken: { completion in
                calls += 1
                completion(Data([0x01, UInt8(calls)]), nil)
            }
        )

        await confirmation("first token") { confirmed in
            service.generate { result in
                let token = try? result.get()
                #expect(token == "AQE=")
                confirmed()
            }
        }
        await confirmation("second token") { confirmed in
            service.generate { result in
                let token = try? result.get()
                #expect(token == "AQI=")
                confirmed()
            }
        }
        #expect(calls == 2)
    }

    @Test("Unsupported devices fail closed without asking Apple for a token")
    func unsupportedFailsClosed() async {
        var generatorCalled = false
        let service = FatinahDeviceCheckTokenService(
            isSupported: { false },
            generateToken: { completion in
                generatorCalled = true
                completion(Data([0x01]), nil)
            }
        )

        await confirmation("unsupported result") { confirmed in
            service.generate { result in
                #expect(throws: FatinahDeviceCheckError.unsupported) {
                    try result.get()
                }
                confirmed()
            }
        }
        #expect(!generatorCalled)
    }

    @Test("An empty Apple response is rejected")
    func emptyTokenFailsClosed() async {
        let service = FatinahDeviceCheckTokenService(
            isSupported: { true },
            generateToken: { completion in completion(Data(), nil) }
        )

        await confirmation("empty result") { confirmed in
            service.generate { result in
                #expect(throws: FatinahDeviceCheckError.emptyToken) {
                    try result.get()
                }
                confirmed()
            }
        }
    }
}

private final class InMemoryAppAttestKeyIDStore: FatinahAppAttestKeyIDStore {
    private let lock = NSLock()
    private var value: String?
    private(set) var saveCount = 0
    private(set) var deleteCount = 0
    var loadError: Error?
    var saveError: Error?
    var deleteError: Error?

    init(value: String? = nil) {
        self.value = value
    }

    func load() throws -> String? {
        lock.lock()
        defer { lock.unlock() }
        if let loadError { throw loadError }
        return value
    }

    func save(_ keyID: String) throws {
        lock.lock()
        defer { lock.unlock() }
        if let saveError { throw saveError }
        value = keyID
        saveCount += 1
    }

    func storedValue() -> String? {
        lock.lock()
        defer { lock.unlock() }
        return value
    }

    func delete() throws {
        lock.lock()
        defer { lock.unlock() }
        if let deleteError { throw deleteError }
        value = nil
        deleteCount += 1
    }
}

@Suite("App Attest service")
struct AppAttestServiceTests {
    private let validHash = Data(repeating: 0xA5, count: 32)

    private func generatedKey(
        from service: FatinahAppAttestService
    ) async -> Result<String, Error> {
        await withCheckedContinuation { continuation in
            service.generateKey { continuation.resume(returning: $0) }
        }
    }

    private func attestation(
        from service: FatinahAppAttestService,
        keyID: String,
        hash: String?
    ) async -> Result<String, Error> {
        await withCheckedContinuation { continuation in
            service.attestKey(keyID: keyID, clientDataHashBase64: hash) {
                continuation.resume(returning: $0)
            }
        }
    }

    private func assertion(
        from service: FatinahAppAttestService,
        keyID: String,
        hash: String?
    ) async -> Result<String, Error> {
        await withCheckedContinuation { continuation in
            service.generateAssertion(keyID: keyID, clientDataHashBase64: hash) {
                continuation.resume(returning: $0)
            }
        }
    }

    private func reset(
        _ service: FatinahAppAttestService
    ) async -> Result<Void, Error> {
        await withCheckedContinuation { continuation in
            service.resetKey { continuation.resume(returning: $0) }
        }
    }

    @Test("Unsupported devices fail closed before generating a key")
    func unsupportedFailsClosed() async {
        var generatorCalled = false
        let service = FatinahAppAttestService(
            supportProvider: { false },
            keyGenerator: { completion in
                generatorCalled = true
                completion("unexpected", nil)
            },
            keyIDStore: InMemoryAppAttestKeyIDStore()
        )

        let result = await generatedKey(from: service)
        #expect {
            try result.get()
        } throws: { error in
            error as? FatinahAppAttestError == .unsupported
        }
        #expect(!generatorCalled)
    }

    @Test("A persisted installation key is reused without generating another key")
    func persistedKeyIsReused() async throws {
        let store = InMemoryAppAttestKeyIDStore(value: "existing-key-id")
        var generationCount = 0
        let service = FatinahAppAttestService(
            supportProvider: { true },
            keyGenerator: { completion in
                generationCount += 1
                completion("new-key-id", nil)
            },
            keyIDStore: store
        )

        let first = try await generatedKey(from: service).get()
        let second = try await generatedKey(from: service).get()

        #expect(first == "existing-key-id")
        #expect(second == "existing-key-id")
        #expect(generationCount == 0)
        #expect(store.saveCount == 0)
    }

    @Test("A newly generated key is persisted before it is returned")
    func generatedKeyIsPersisted() async throws {
        let store = InMemoryAppAttestKeyIDStore()
        var generationCount = 0
        let service = FatinahAppAttestService(
            supportProvider: { true },
            keyGenerator: { completion in
                generationCount += 1
                completion("stable-installation-key", nil)
            },
            keyIDStore: store
        )

        let first = try await generatedKey(from: service).get()
        let second = try await generatedKey(from: service).get()

        #expect(first == "stable-installation-key")
        #expect(second == "stable-installation-key")
        #expect(store.storedValue() == "stable-installation-key")
        #expect(store.saveCount == 1)
        #expect(generationCount == 1)
    }

    @Test("Reset deletes only the persisted App Attest key identifier and is idempotent")
    func resetDeletesPersistedKeyID() async throws {
        let store = InMemoryAppAttestKeyIDStore(value: "stale-installation-key")
        let service = FatinahAppAttestService(
            supportProvider: { true },
            keyIDStore: store
        )

        try await reset(service).get()
        try await reset(service).get()

        #expect(store.storedValue() == nil)
        #expect(store.saveCount == 0)
        #expect(store.deleteCount == 2)
    }

    @Test("Reset failure is fail-closed and preserves the existing identifier")
    func resetFailurePreservesKeyID() async {
        let store = InMemoryAppAttestKeyIDStore(value: "existing-key")
        store.deleteError = FatinahAppAttestError.keychain(errSecInteractionNotAllowed)
        let service = FatinahAppAttestService(
            supportProvider: { true },
            keyIDStore: store
        )

        let result = await reset(service)
        #expect {
            try result.get()
        } throws: { error in
            error as? FatinahAppAttestError == .keychain(errSecInteractionNotAllowed)
        }
        #expect(store.storedValue() == "existing-key")
        #expect(store.deleteCount == 0)
    }

    @Test("An empty generated key is rejected and never persisted")
    func emptyGeneratedKeyFailsClosed() async {
        let store = InMemoryAppAttestKeyIDStore()
        let service = FatinahAppAttestService(
            supportProvider: { true },
            keyGenerator: { completion in completion("", nil) },
            keyIDStore: store
        )

        let result = await generatedKey(from: service)
        #expect {
            try result.get()
        } throws: { error in
            error as? FatinahAppAttestError == .emptyGeneratedKeyID
        }
        #expect(store.storedValue() == nil)
        #expect(store.saveCount == 0)
    }

    @Test("Keychain persistence failure never exposes an unpersisted key")
    func persistenceFailureFailsClosed() async {
        let store = InMemoryAppAttestKeyIDStore()
        store.saveError = FatinahAppAttestError.keychain(errSecInteractionNotAllowed)
        let service = FatinahAppAttestService(
            supportProvider: { true },
            keyGenerator: { completion in completion("orphaned-key", nil) },
            keyIDStore: store
        )

        let result = await generatedKey(from: service)
        #expect {
            try result.get()
        } throws: { error in
            error as? FatinahAppAttestError == .keychain(errSecInteractionNotAllowed)
        }
    }

    @Test(
        "Only a 32-byte SHA-256 clientDataHash in Base64 is accepted",
        arguments: [
            nil,
            "",
            "not-base64",
            Data(repeating: 0x01, count: 31).base64EncodedString(),
            Data(repeating: 0x01, count: 33).base64EncodedString(),
        ] as [String?]
    )
    func invalidHashIsRejected(hash: String?) {
        #expect {
            try FatinahAppAttestService.decodeClientDataHash(hash)
        } throws: { error in
            error as? FatinahAppAttestError == .invalidClientDataHash
        }
    }

    @Test("A valid SHA-256 clientDataHash round-trips exactly")
    func validHashDecodes() throws {
        let encoded = validHash.base64EncodedString()
        #expect(try FatinahAppAttestService.decodeClientDataHash(encoded) == validHash)
    }

    @Test("Attestation uses only the persisted key and returns Base64 without storing it")
    func attestationUsesPersistedKey() async throws {
        let store = InMemoryAppAttestKeyIDStore(value: "installation-key")
        var receivedKeyID: String?
        var receivedHash: Data?
        let service = FatinahAppAttestService(
            supportProvider: { true },
            attestationGenerator: { keyID, hash, completion in
                receivedKeyID = keyID
                receivedHash = hash
                completion(Data([0x01, 0x02, 0x03]), nil)
            },
            keyIDStore: store
        )

        let output = try await attestation(
            from: service,
            keyID: "installation-key",
            hash: validHash.base64EncodedString()
        ).get()

        #expect(output == "AQID")
        #expect(receivedKeyID == "installation-key")
        #expect(receivedHash == validHash)
        #expect(store.storedValue() == "installation-key")
        #expect(store.saveCount == 0)
    }

    @Test("A key that does not match Keychain is rejected before calling Apple")
    func mismatchedKeyFailsClosed() async {
        var generatorCalled = false
        let service = FatinahAppAttestService(
            supportProvider: { true },
            attestationGenerator: { _, _, completion in
                generatorCalled = true
                completion(Data([0x01]), nil)
            },
            keyIDStore: InMemoryAppAttestKeyIDStore(value: "stored-key")
        )

        let result = await attestation(
            from: service,
            keyID: "different-key",
            hash: validHash.base64EncodedString()
        )
        #expect {
            try result.get()
        } throws: { error in
            error as? FatinahAppAttestError == .invalidKeyID
        }
        #expect(!generatorCalled)
    }

    @Test("Assertion output is returned but never persisted")
    func assertionIsEphemeral() async throws {
        let store = InMemoryAppAttestKeyIDStore(value: "installation-key")
        let service = FatinahAppAttestService(
            supportProvider: { true },
            assertionGenerator: { _, _, completion in
                completion(Data([0xF0, 0x0D]), nil)
            },
            keyIDStore: store
        )

        let output = try await assertion(
            from: service,
            keyID: "installation-key",
            hash: validHash.base64EncodedString()
        ).get()

        #expect(output == "8A0=")
        #expect(store.storedValue() == "installation-key")
        #expect(store.saveCount == 0)
    }

    @Test("Empty attestation and assertion responses fail closed")
    func emptyArtifactsFailClosed() async {
        let store = InMemoryAppAttestKeyIDStore(value: "installation-key")
        let service = FatinahAppAttestService(
            supportProvider: { true },
            attestationGenerator: { _, _, completion in completion(Data(), nil) },
            assertionGenerator: { _, _, completion in completion(nil, nil) },
            keyIDStore: store
        )

        let attestResult = await attestation(
            from: service,
            keyID: "installation-key",
            hash: validHash.base64EncodedString()
        )
        #expect {
            try attestResult.get()
        } throws: { error in
            error as? FatinahAppAttestError == .emptyAttestation
        }

        let assertionResult = await assertion(
            from: service,
            keyID: "installation-key",
            hash: validHash.base64EncodedString()
        )
        #expect {
            try assertionResult.get()
        } throws: { error in
            error as? FatinahAppAttestError == .emptyAssertion
        }
    }

    @Test("Apple error codes are mapped without exposing raw details")
    func appleErrorsAreMapped() {
        let serverUnavailable = NSError(
            domain: DCError.errorDomain,
            code: DCError.Code.serverUnavailable.rawValue
        )
        let invalidKey = NSError(
            domain: DCError.errorDomain,
            code: DCError.Code.invalidKey.rawValue
        )
        let unrelated = NSError(domain: "test", code: 7)

        #expect(FatinahAppAttestError.fromApple(serverUnavailable) == .appleServerUnavailable)
        #expect(FatinahAppAttestError.fromApple(invalidKey) == .appleInvalidKey)
        #expect(FatinahAppAttestError.fromApple(unrelated) == .appleFailure)
    }
}

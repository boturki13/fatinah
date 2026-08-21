import Foundation
import Security
import Testing
@testable import App

@Suite("MetricKit durable envelope")
struct DiagnosticsEnvelopeTests {
    @Test("Current envelope survives JSON round-trip as explicitly anonymous")
    func roundTrip() throws {
        let source = FatinahDiagnosticEnvelope(
            reportId: "123e4567-e89b-42d3-a456-426614174000",
            reportType: "metric",
            payload: Data("تشخيص".utf8).base64EncodedString(),
            appVersion: "1.3",
            createdAt: "2026-08-20T15:00:00Z"
        )

        let encoded = try JSONEncoder().encode(source)
        let decoded = try JSONDecoder().decode(
            FatinahDiagnosticEnvelope.self,
            from: encoded
        )
        let object = try #require(
            JSONSerialization.jsonObject(with: encoded) as? [String: Any]
        )

        #expect(decoded == source)
        #expect(decoded.schemaVersion == FatinahDiagnosticEnvelope.currentSchemaVersion)
        #expect(decoded.privacyScope == FatinahDiagnosticEnvelope.anonymousPrivacyScope)
        #expect(decoded.legacyOwnerUID == nil)
        #expect(FatinahDiagnosticPrivacy.canUpload(decoded))
        #expect(object["ownerUID"] == nil)
        #expect(Data(base64Encoded: decoded.payload) == Data("تشخيص".utf8))
    }

    @Test("Past and delayed payload factory never accepts or emits account identity")
    func pastAndDelayedPayloadsStayAnonymous() throws {
        let payload = Data("past MetricKit payload".utf8)
        let first = try FatinahDiagnosticPayload.anonymousEnvelope(
            from: payload,
            type: "metric",
            appVersion: "1.3 (6)",
            createdAt: "2026-08-20T15:00:00Z"
        )
        let delayed = try FatinahDiagnosticPayload.anonymousEnvelope(
            from: payload,
            type: "metric",
            appVersion: "1.3 (6)",
            createdAt: "2026-08-21T15:00:00Z"
        )
        let body = try #require(FatinahDiagnosticUpload.body(for: delayed))

        #expect(first.reportId == delayed.reportId)
        #expect(first.isExplicitlyAnonymous)
        #expect(delayed.isExplicitlyAnonymous)
        #expect(body["privacyScope"] as? String == "anonymous")
        #expect(body["schemaVersion"] as? Int == 2)
        #expect(body["uid"] == nil)
        #expect(body["idToken"] == nil)
        #expect(Set(body.keys) == Set([
            "schemaVersion", "privacyScope", "reportId", "reportType",
            "payload", "appVersion", "createdAt",
        ]))
    }

    @Test("Unmarked and account-bound legacy envelopes fail closed")
    func legacyEnvelopesFailClosed() throws {
        let unmarkedData = Data(
            #"{"reportId":"legacy","reportType":"metric","payload":"e30=","appVersion":"1.2","createdAt":"2026-08-20T15:00:00Z"}"#.utf8
        )
        let ownerBoundData = Data(
            #"{"schemaVersion":2,"privacyScope":"anonymous","reportId":"legacy-owner","reportType":"diagnostic","payload":"e30=","appVersion":"1.2","createdAt":"2026-08-20T15:00:00Z","ownerUID":"user-a"}"#.utf8
        )
        let unmarked = try JSONDecoder().decode(
            FatinahDiagnosticEnvelope.self,
            from: unmarkedData
        )
        let ownerBound = try JSONDecoder().decode(
            FatinahDiagnosticEnvelope.self,
            from: ownerBoundData
        )

        #expect(unmarked.schemaVersion == 0)
        #expect(unmarked.privacyScope.isEmpty)
        #expect(!FatinahDiagnosticPrivacy.canUpload(unmarked))
        #expect(ownerBound.legacyOwnerUID == "user-a")
        #expect(!FatinahDiagnosticPrivacy.canUpload(ownerBound))
        #expect(FatinahDiagnosticUpload.body(for: unmarked) == nil)
        #expect(FatinahDiagnosticUpload.body(for: ownerBound) == nil)
    }

    @Test("Oversized diagnostics become a bounded metadata report")
    func boundedPayload() throws {
        let oversized = Data(
            repeating: 0x41,
            count: FatinahDiagnosticPayload.maximumRawBytes + 1
        )

        let safe = try FatinahDiagnosticPayload.safeData(from: oversized)
        let object = try #require(
            JSONSerialization.jsonObject(with: safe) as? [String: Any]
        )

        #expect(object["truncated"] as? Bool == true)
        #expect(object["originalByteCount"] as? Int == oversized.count)
        #expect(safe.count < 1_024)
    }

    @Test("Report identifier is stable and type-bound")
    func stableIdentifier() {
        let payload = Data("same payload".utf8)
        let first = FatinahDiagnosticPayload.reportIdentifier(for: payload, type: "metric")
        let second = FatinahDiagnosticPayload.reportIdentifier(for: payload, type: "metric")
        let diagnostic = FatinahDiagnosticPayload.reportIdentifier(for: payload, type: "diagnostic")

        #expect(first == second)
        #expect(first != diagnostic)
        #expect(first.count == 64)
    }

    @Test("Outbox purges legacy UID and unmarked files before selecting anonymous data")
    func legacyOutboxMigrationIsFailClosed() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("FatinahMetricKitTests-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let outbox = FatinahDiagnosticOutbox(directory: directory)
        let envelope = try FatinahDiagnosticPayload.anonymousEnvelope(
            from: Data("anonymous diagnostic".utf8),
            type: "diagnostic",
            appVersion: "1.3 (6)",
            createdAt: "2026-08-21T12:00:00Z"
        )
        let storedFile = try outbox.write(envelope)
        let ownerBoundFile = directory.appendingPathComponent("000-owner-bound.json")
        let unmarkedFile = directory.appendingPathComponent("001-unmarked.json")
        let malformedFile = directory.appendingPathComponent("002-malformed.json")
        try Data(
            #"{"schemaVersion":2,"privacyScope":"anonymous","reportId":"legacy-owner","reportType":"diagnostic","payload":"e30=","appVersion":"1.2","createdAt":"2026-08-20T15:00:00Z","ownerUID":"user-a"}"#.utf8
        ).write(to: ownerBoundFile, options: .atomic)
        try Data(
            #"{"reportId":"legacy-unmarked","reportType":"metric","payload":"e30=","appVersion":"1.2","createdAt":"2026-08-20T15:00:00Z"}"#.utf8
        ).write(to: unmarkedFile, options: .atomic)
        try Data("not-json".utf8).write(to: malformedFile, options: .atomic)

        #expect(try outbox.nextUploadableFile() == storedFile)
        #expect(!FileManager.default.fileExists(atPath: ownerBoundFile.path))
        #expect(!FileManager.default.fileExists(atPath: unmarkedFile.path))
        #expect(!FileManager.default.fileExists(atPath: malformedFile.path))
        #expect(FileManager.default.fileExists(atPath: storedFile.path))
    }

    @Test("An outbox containing only legacy account data has nothing uploadable")
    func legacyOnlyOutboxCannotUpload() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("FatinahMetricKitLegacyOnly-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        try FatinahDiagnosticStorageProtection.prepareDirectory(directory)
        let legacyFile = directory.appendingPathComponent("legacy.json")
        try Data(
            #"{"schemaVersion":2,"privacyScope":"anonymous","reportId":"legacy-owner","reportType":"metric","payload":"e30=","appVersion":"1.2","createdAt":"2026-08-20T15:00:00Z","ownerUID":"user-a"}"#.utf8
        ).write(to: legacyFile, options: .atomic)
        let outbox = FatinahDiagnosticOutbox(directory: directory)

        #expect(try outbox.nextUploadableFile() == nil)
        #expect(try outbox.files().isEmpty)
    }

    @Test("Legacy cleanup preserves current anonymous envelopes")
    func explicitLegacyCleanupPreservesAnonymousData() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("FatinahMetricKitCleanup-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let outbox = FatinahDiagnosticOutbox(directory: directory)
        let anonymous = FatinahDiagnosticEnvelope(
            reportId: "anonymous-report",
            reportType: "metric",
            payload: Data("{}".utf8).base64EncodedString(),
            appVersion: "1.3 (6)",
            createdAt: "2026-08-21T12:00:00Z"
        )
        let anonymousFile = try outbox.write(anonymous)
        let legacyFile = directory.appendingPathComponent("legacy.json")
        try Data(
            #"{"reportId":"legacy","reportType":"metric","payload":"e30=","appVersion":"1.2","createdAt":"2026-08-20T15:00:00Z"}"#.utf8
        ).write(to: legacyFile, options: .atomic)

        #expect(try outbox.purgeLegacyOrInvalid() == 1)
        #expect(try outbox.files() == [anonymousFile])
    }

    @Test("Quarantined diagnostics obey the same 30-day retention cutoff")
    func quarantineRetention() throws {
        let fileManager = FileManager.default
        let directory = fileManager.temporaryDirectory
            .appendingPathComponent(
                "FatinahMetricKitQuarantine-\(UUID().uuidString)",
                isDirectory: true
            )
        defer { try? fileManager.removeItem(at: directory) }
        let quarantine = FatinahDiagnosticOutbox(
            directory: directory,
            fileManager: fileManager
        )
        let oldEnvelope = FatinahDiagnosticEnvelope(
            reportId: "old-quarantined-report",
            reportType: "diagnostic",
            payload: Data("old".utf8).base64EncodedString(),
            appVersion: "1.3 (6)",
            createdAt: "2026-06-01T00:00:00Z"
        )
        let currentEnvelope = FatinahDiagnosticEnvelope(
            reportId: "current-quarantined-report",
            reportType: "diagnostic",
            payload: Data("current".utf8).base64EncodedString(),
            appVersion: "1.3 (6)",
            createdAt: "2026-08-21T12:00:00Z"
        )
        let oldFile = try quarantine.write(oldEnvelope)
        let currentFile = try quarantine.write(currentEnvelope)
        let now = Date(timeIntervalSince1970: 2_000_000_000)
        try fileManager.setAttributes(
            [.creationDate: now.addingTimeInterval(-31 * 24 * 60 * 60)],
            ofItemAtPath: oldFile.path
        )
        try fileManager.setAttributes(
            [.creationDate: now.addingTimeInterval(-1 * 24 * 60 * 60)],
            ofItemAtPath: currentFile.path
        )

        #expect(try quarantine.pruneFiles(
            createdBefore: now.addingTimeInterval(-30 * 24 * 60 * 60)
        ) == 1)
        #expect(!fileManager.fileExists(atPath: oldFile.path))
        #expect(fileManager.fileExists(atPath: currentFile.path))
    }

    @Test("Diagnostic files are protected and excluded from backup")
    func protectedAtRest() throws {
        let fileManager = FileManager.default
        let directory = fileManager.temporaryDirectory
            .appendingPathComponent("FatinahMetricKitProtection-\(UUID().uuidString)", isDirectory: true)
        defer { try? fileManager.removeItem(at: directory) }
        let outbox = FatinahDiagnosticOutbox(
            directory: directory,
            fileManager: fileManager
        )
        let envelope = FatinahDiagnosticEnvelope(
            reportId: "protected-report",
            reportType: "diagnostic",
            payload: Data("protected".utf8).base64EncodedString(),
            appVersion: "1.3 (6)",
            createdAt: "2026-08-21T12:00:00Z"
        )

        let file = try outbox.write(envelope)
        let directoryValues = try directory.resourceValues(
            forKeys: [.isExcludedFromBackupKey]
        )
        let fileValues = try file.resourceValues(
            forKeys: [.isExcludedFromBackupKey]
        )
        #expect(directoryValues.isExcludedFromBackup == true)
        #expect(fileValues.isExcludedFromBackup == true)
        #if targetEnvironment(simulator)
        // The simulator accepts NSFileProtection attributes but does not
        // report them back because its host filesystem has no Data Protection.
        #expect(
            FatinahDiagnosticStorageProtection.fileProtectionType
                == .completeUntilFirstUserAuthentication
        )
        #else
        let directoryAttributes = try fileManager.attributesOfItem(
            atPath: directory.path
        )
        let fileAttributes = try fileManager.attributesOfItem(atPath: file.path)
        #expect(
            directoryAttributes[.protectionKey] as? FileProtectionType
                == FatinahDiagnosticStorageProtection.fileProtectionType
        )
        #expect(
            fileAttributes[.protectionKey] as? FileProtectionType
                == FatinahDiagnosticStorageProtection.fileProtectionType
        )
        #endif
    }
}

@Suite("RevenueCat Keychain store", .serialized)
struct RevenueCatKeychainStoreTests {
    @Test("Add, update, read and idempotent clear")
    func roundTripAndUpdate() throws {
        let security = InMemorySecItemService()
        let store = RevenueCatKeychainStore(
            service: "com.fatinah.tests.revenuecat.\(UUID().uuidString)",
            account: "public-api-key",
            security: security
        )
        try store.clear()
        defer { try? store.clear() }

        #expect(try store.get() == nil)
        try store.set("appl_FIRST")
        #expect(try store.get() == "appl_FIRST")
        #expect(security.lastAdd?[kSecAttrAccessible as String] as? String == kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String)
        try store.set("appl_UPDATED")
        #expect(try store.get() == "appl_UPDATED")
        #expect(security.lastUpdateQuery?[kSecAttrAccessible as String] == nil)
        try store.clear()
        #expect(try store.get() == nil)
        try store.clear()
    }

    @Test("Security failures remain explicit")
    func propagatesSecurityFailure() {
        let security = InMemorySecItemService()
        security.forcedAddStatus = errSecInteractionNotAllowed
        let store = RevenueCatKeychainStore(security: security)

        #expect(throws: FatinahKeychainError(status: errSecInteractionNotAllowed)) {
            try store.set("appl_BLOCKED")
        }
    }
}

private final class InMemorySecItemService: FatinahSecItemServing {
    var forcedAddStatus: OSStatus?
    var lastAdd: [String: Any]?
    var lastUpdateQuery: [String: Any]?
    private var value: Data?

    func copyMatching(_ query: [String: Any], result: inout CFTypeRef?) -> OSStatus {
        guard let value else { return errSecItemNotFound }
        result = value as CFData
        return errSecSuccess
    }

    func add(_ attributes: [String: Any]) -> OSStatus {
        lastAdd = attributes
        if let forcedAddStatus { return forcedAddStatus }
        guard value == nil else { return errSecDuplicateItem }
        guard let newValue = attributes[kSecValueData as String] as? Data else {
            return errSecParam
        }
        value = newValue
        return errSecSuccess
    }

    func update(_ query: [String: Any], attributes: [String: Any]) -> OSStatus {
        lastUpdateQuery = query
        guard value != nil else { return errSecItemNotFound }
        guard let newValue = attributes[kSecValueData as String] as? Data else {
            return errSecParam
        }
        value = newValue
        return errSecSuccess
    }

    func delete(_ query: [String: Any]) -> OSStatus {
        guard value != nil else { return errSecItemNotFound }
        value = nil
        return errSecSuccess
    }
}

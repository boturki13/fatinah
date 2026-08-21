import Foundation
import Security
import Testing
@testable import App

@Suite("MetricKit durable envelope")
struct DiagnosticsEnvelopeTests {
    @Test("Envelope survives JSON round-trip")
    func roundTrip() throws {
        let source = FatinahDiagnosticEnvelope(
            reportId: "123e4567-e89b-42d3-a456-426614174000",
            reportType: "metric",
            payload: Data("تشخيص".utf8).base64EncodedString(),
            appVersion: "1.3",
            createdAt: "2026-08-20T15:00:00Z"
        )

        let decoded = try JSONDecoder().decode(
            FatinahDiagnosticEnvelope.self,
            from: JSONEncoder().encode(source)
        )

        #expect(decoded == source)
        #expect(Data(base64Encoded: decoded.payload) == Data("تشخيص".utf8))
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

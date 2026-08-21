import Foundation
import MetricKit
import CryptoKit
import FirebaseAppCheck
import FirebaseCrashlytics

struct FatinahDiagnosticEnvelope: Codable, Equatable {
    static let currentSchemaVersion = 2
    static let anonymousPrivacyScope = "anonymous"

    let schemaVersion: Int
    let privacyScope: String
    let reportId: String
    let reportType: String
    let payload: String
    let appVersion: String
    let createdAt: String

    /// Read-only migration sentinel. New envelopes never encode this field.
    /// Any old or tampered envelope that contains an account owner is rejected.
    let legacyOwnerUID: String?

    init(
        reportId: String,
        reportType: String,
        payload: String,
        appVersion: String,
        createdAt: String
    ) {
        self.schemaVersion = Self.currentSchemaVersion
        self.privacyScope = Self.anonymousPrivacyScope
        self.reportId = reportId
        self.reportType = reportType
        self.payload = payload
        self.appVersion = appVersion
        self.createdAt = createdAt
        self.legacyOwnerUID = nil
    }

    var isExplicitlyAnonymous: Bool {
        schemaVersion == Self.currentSchemaVersion
            && privacyScope == Self.anonymousPrivacyScope
            && legacyOwnerUID == nil
    }

    private enum CodingKeys: String, CodingKey {
        case schemaVersion
        case privacyScope
        case reportId
        case reportType
        case payload
        case appVersion
        case createdAt
        case ownerUID
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        schemaVersion = try container.decodeIfPresent(Int.self, forKey: .schemaVersion) ?? 0
        privacyScope = try container.decodeIfPresent(String.self, forKey: .privacyScope) ?? ""
        reportId = try container.decode(String.self, forKey: .reportId)
        reportType = try container.decode(String.self, forKey: .reportType)
        payload = try container.decode(String.self, forKey: .payload)
        appVersion = try container.decode(String.self, forKey: .appVersion)
        createdAt = try container.decode(String.self, forKey: .createdAt)
        legacyOwnerUID = try container.decodeIfPresent(String.self, forKey: .ownerUID)
    }

    func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(schemaVersion, forKey: .schemaVersion)
        try container.encode(privacyScope, forKey: .privacyScope)
        try container.encode(reportId, forKey: .reportId)
        try container.encode(reportType, forKey: .reportType)
        try container.encode(payload, forKey: .payload)
        try container.encode(appVersion, forKey: .appVersion)
        try container.encode(createdAt, forKey: .createdAt)
    }
}

enum FatinahDiagnosticPayload {
    static let maximumRawBytes = 360_000

    static func reportIdentifier(for data: Data, type: String) -> String {
        var fingerprint = Data(type.utf8)
        fingerprint.append(0)
        fingerprint.append(Data(String(FatinahDiagnosticEnvelope.currentSchemaVersion).utf8))
        fingerprint.append(0)
        fingerprint.append(Data(FatinahDiagnosticEnvelope.anonymousPrivacyScope.utf8))
        fingerprint.append(0)
        fingerprint.append(data)
        return SHA256.hash(data: fingerprint)
            .map { String(format: "%02x", $0) }
            .joined()
    }

    static func safeData(from data: Data) throws -> Data {
        guard data.count > maximumRawBytes else { return data }
        return try JSONSerialization.data(withJSONObject: [
            "truncated": true,
            "originalByteCount": data.count,
            "reason": "MetricKit payload exceeded safe upload limit",
        ])
    }

    static func anonymousEnvelope(
        from data: Data,
        type: String,
        appVersion: String,
        createdAt: String
    ) throws -> FatinahDiagnosticEnvelope {
        let safePayload = try safeData(from: data)
        return FatinahDiagnosticEnvelope(
            reportId: reportIdentifier(for: data, type: type),
            reportType: type,
            payload: safePayload.base64EncodedString(),
            appVersion: appVersion,
            createdAt: createdAt
        )
    }
}

enum FatinahDiagnosticPrivacy {
    static func canUpload(_ envelope: FatinahDiagnosticEnvelope) -> Bool {
        envelope.isExplicitlyAnonymous
    }
}

enum FatinahDiagnosticUpload {
    static func body(for envelope: FatinahDiagnosticEnvelope) -> [String: Any]? {
        guard FatinahDiagnosticPrivacy.canUpload(envelope) else { return nil }
        return [
            "schemaVersion": envelope.schemaVersion,
            "privacyScope": envelope.privacyScope,
            "reportId": envelope.reportId,
            "reportType": envelope.reportType,
            "payload": envelope.payload,
            "appVersion": envelope.appVersion,
            "createdAt": envelope.createdAt,
        ]
    }
}

/// MetricKit payloads can contain stack traces and device-level diagnostics.
/// Keep them out of iCloud/iTunes backups and encrypt them at rest while still
/// allowing the post-unlock background upload flow to drain the outbox.
enum FatinahDiagnosticStorageProtection {
    static let fileProtectionType = FileProtectionType.completeUntilFirstUserAuthentication

    static func prepareDirectory(
        _ directory: URL,
        fileManager: FileManager = .default
    ) throws {
        try fileManager.createDirectory(
            at: directory,
            withIntermediateDirectories: true,
            attributes: [.protectionKey: fileProtectionType]
        )
        try apply(to: directory, fileManager: fileManager)
    }

    static func protectFile(
        _ file: URL,
        fileManager: FileManager = .default
    ) throws {
        try apply(to: file, fileManager: fileManager)
    }

    private static func apply(
        to url: URL,
        fileManager: FileManager
    ) throws {
        try fileManager.setAttributes(
            [.protectionKey: fileProtectionType],
            ofItemAtPath: url.path
        )
        var protectedURL = url
        var resourceValues = URLResourceValues()
        resourceValues.isExcludedFromBackup = true
        try protectedURL.setResourceValues(resourceValues)
    }
}

/// File operations are separated from the service so privacy migration and
/// durable delivery can be tested without Firebase or the network.
struct FatinahDiagnosticOutbox {
    let directory: URL
    private let fileManager: FileManager

    init(directory: URL, fileManager: FileManager = .default) {
        self.directory = directory
        self.fileManager = fileManager
    }

    @discardableResult
    func write(_ envelope: FatinahDiagnosticEnvelope) throws -> URL {
        try FatinahDiagnosticStorageProtection.prepareDirectory(
            directory,
            fileManager: fileManager
        )
        let file = directory.appendingPathComponent("\(envelope.reportId).json")
        do {
            try JSONEncoder().encode(envelope).write(to: file, options: .atomic)
            try FatinahDiagnosticStorageProtection.protectFile(
                file,
                fileManager: fileManager
            )
        } catch {
            // Never retain a diagnostic payload when its at-rest policy could
            // not be established.
            try? fileManager.removeItem(at: file)
            throw error
        }
        return file
    }

    func files() throws -> [URL] {
        try FatinahDiagnosticStorageProtection.prepareDirectory(
            directory,
            fileManager: fileManager
        )
        let files = try fileManager.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: [.creationDateKey, .fileSizeKey],
            options: [.skipsHiddenFiles]
        )
        .filter { $0.pathExtension == "json" }
        .sorted {
            let left = (try? $0.resourceValues(forKeys: [.creationDateKey]).creationDate) ?? .distantPast
            let right = (try? $1.resourceValues(forKeys: [.creationDateKey]).creationDate) ?? .distantPast
            return left == right ? $0.lastPathComponent < $1.lastPathComponent : left < right
        }
        for file in files {
            try FatinahDiagnosticStorageProtection.protectFile(
                file,
                fileManager: fileManager
            )
        }
        return files
    }

    func envelope(at file: URL) throws -> FatinahDiagnosticEnvelope {
        try JSONDecoder().decode(
            FatinahDiagnosticEnvelope.self,
            from: Data(contentsOf: file)
        )
    }

    /// Returns the first current anonymous envelope. Legacy account-bound,
    /// unmarked, or malformed JSON is purged fail-closed before selection.
    func nextUploadableFile() throws -> URL? {
        var firstAnonymousFile: URL?
        for file in try files() {
            let data = try Data(contentsOf: file)
            guard let envelope = try? JSONDecoder().decode(
                FatinahDiagnosticEnvelope.self,
                from: data
            ), FatinahDiagnosticPrivacy.canUpload(envelope) else {
                try fileManager.removeItem(at: file)
                continue
            }
            if firstAnonymousFile == nil {
                firstAnonymousFile = file
            }
        }
        return firstAnonymousFile
    }

    @discardableResult
    func purgeLegacyOrInvalid() throws -> Int {
        var removed = 0
        for file in try files() {
            let data = try Data(contentsOf: file)
            let envelope = try? JSONDecoder().decode(
                FatinahDiagnosticEnvelope.self,
                from: data
            )
            guard let envelope, FatinahDiagnosticPrivacy.canUpload(envelope) else {
                try fileManager.removeItem(at: file)
                removed += 1
                continue
            }
        }
        return removed
    }

    /// Removes diagnostic files whose local creation date is older than the
    /// retention cutoff. This is shared by the upload outbox and quarantine so
    /// permanently rejected reports cannot outlive the declared policy.
    @discardableResult
    func pruneFiles(createdBefore cutoff: Date) throws -> Int {
        var removed = 0
        for file in try files() {
            let created = (try? file.resourceValues(
                forKeys: [.creationDateKey]
            ).creationDate) ?? .distantPast
            guard created < cutoff else { continue }
            try fileManager.removeItem(at: file)
            removed += 1
        }
        return removed
    }
}

/// يجمع تقارير النظام الإنتاجية ويحفظها محلياً قبل الرفع. عدم توفر الشبكة
/// لا يفقد التقرير؛ يبقى في outbox ويعاد إرساله عند نشاط التطبيق التالي.
final class FatinahMetricKitService: NSObject, MXMetricManagerSubscriber {
    static let shared = FatinahMetricKitService()

    private let queue = DispatchQueue(label: "com.fatinah.metrickit.outbox", qos: .utility)
    private let fileManager = FileManager.default
    private let maximumPendingReports = 120
    private let maximumPendingBytes: Int64 = 25 * 1024 * 1024
    private let maximumReportAge: TimeInterval = 30 * 24 * 60 * 60
    private var started = false
    private var retryAttempt = 0
    private var retryWorkItem: DispatchWorkItem?
    private var uploadInFlight = false
    private var activeUploadTask: URLSessionDataTask?
    private var uploadGeneration = 0

    private override init() {
        super.init()
    }

    func start() {
        guard !started else { return }
        started = true
        // Production diagnostics are intentionally account-agnostic. Keep the
        // companion Crashlytics channel anonymous as well.
        Crashlytics.crashlytics().setUserID("")
        let manager = MXMetricManager.shared
        manager.add(self)
        // قد تكون تقارير وصلت قبل تسجيل المشترك. المعرّف المبني من المحتوى
        // يجعل إعادة إدراج payload سابق عملية idempotent.
        manager.pastPayloads.forEach { persist($0.jsonRepresentation(), type: "metric") }
        manager.pastDiagnosticPayloads.forEach { persist($0.jsonRepresentation(), type: "diagnostic") }
        drainOutbox()
    }

    func stop() {
        guard started else { return }
        MXMetricManager.shared.remove(self)
        queue.async { [weak self] in
            self?.cancelActiveUpload()
        }
        started = false
    }

    /// Compatibility bridge for existing web authentication calls. The value
    /// is validated for shape but is never retained, compared, or attached to
    /// MetricKit/Crashlytics data.
    func setOwnerUID(_ uid: String, completion: @escaping (Bool) -> Void) {
        guard !uid.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            completion(false)
            return
        }
        queue.async { [weak self] in
            guard let self else { return }
            Crashlytics.crashlytics().setUserID("")
            _ = self.purgeLegacyOutbox()
            self.uploadNextFile()
            DispatchQueue.main.async { completion(true) }
        }
    }

    /// Compatibility account-boundary call. Anonymous current envelopes remain
    /// durable; only obsolete account-bound/unmarked files are removed.
    func clearOwnerAndPurge(completion: ((Int) -> Void)? = nil) {
        queue.async { [weak self] in
            guard let self else { return }
            Crashlytics.crashlytics().setUserID("")
            let removed = self.purgeLegacyOutbox()
            self.uploadNextFile()
            if let completion {
                DispatchQueue.main.async { completion(removed) }
            }
        }
    }

    func drainOutbox() {
        queue.async { [weak self] in
            guard let self else { return }
            self.retryWorkItem?.cancel()
            self.retryWorkItem = nil
            self.uploadNextFile()
        }
    }

    func didReceive(_ payloads: [MXMetricPayload]) {
        payloads.forEach { persist($0.jsonRepresentation(), type: "metric") }
    }

    func didReceive(_ payloads: [MXDiagnosticPayload]) {
        payloads.forEach { persist($0.jsonRepresentation(), type: "diagnostic") }
    }

    /// Must only be called on `queue`.
    private func cancelActiveUpload() {
        uploadGeneration += 1
        activeUploadTask?.cancel()
        activeUploadTask = nil
        uploadInFlight = false
    }

    private func persist(_ data: Data, type reportType: String) {
        queue.async { [weak self] in
            guard let self else { return }
            do {
                // حد الخادم 512KB. Base64 يضيف قرابة الثلث، لذلك نستبدل
                // التقارير النادرة الضخمة بملخص آمن بدلاً من قص JSON عشوائياً.
                let envelope = try FatinahDiagnosticPayload.anonymousEnvelope(
                    from: data,
                    type: reportType,
                    appVersion: self.currentAppVersion(),
                    createdAt: ISO8601DateFormatter().string(from: Date())
                )
                let directory = try self.outboxDirectory()
                try FatinahDiagnosticOutbox(
                    directory: directory,
                    fileManager: self.fileManager
                ).write(envelope)
                try self.pruneOutbox(in: directory)
                self.uploadNextFile()
            } catch {
                // لا نسجل محتوى التقرير في السجل؛ يكفي نوع خطأ التخزين.
                NSLog(
                    "MetricKit outbox persistence failed: %@",
                    String(describing: type(of: error))
                )
            }
        }
    }

    private func outboxDirectory() throws -> URL {
        let base = try fileManager.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
        let directory = base.appendingPathComponent("MetricKitOutbox", isDirectory: true)
        try FatinahDiagnosticStorageProtection.prepareDirectory(
            directory,
            fileManager: fileManager
        )
        return directory
    }

    private func currentAppVersion() -> String {
        let info = Bundle.main.infoDictionary ?? [:]
        let version = info["CFBundleShortVersionString"] as? String ?? "unknown"
        let build = info["CFBundleVersion"] as? String ?? "unknown"
        return "\(version) (\(build))"
    }

    private func outboxFiles(in directory: URL) throws -> [URL] {
        try FatinahDiagnosticOutbox(
            directory: directory,
            fileManager: fileManager
        ).files()
    }

    private func pruneOutbox(in directory: URL) throws {
        let cutoff = Date().addingTimeInterval(-maximumReportAge)
        let outbox = FatinahDiagnosticOutbox(
            directory: directory,
            fileManager: fileManager
        )
        _ = try outbox.pruneFiles(createdBefore: cutoff)
        var files = try outboxFiles(in: directory)
        var totalBytes = files.reduce(Int64(0)) { partial, file in
            let size = (try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
            return partial + Int64(size)
        }
        while files.count > maximumPendingReports || totalBytes > maximumPendingBytes {
            let oldest = files.removeFirst()
            let size = (try? oldest.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
            try? fileManager.removeItem(at: oldest)
            totalBytes -= Int64(size)
        }
        try pruneQuarantine(in: directory, cutoff: cutoff)
    }

    private func pruneQuarantine(in outboxDirectory: URL, cutoff: Date) throws {
        let directory = outboxDirectory
            .appendingPathComponent("Quarantine", isDirectory: true)
        guard fileManager.fileExists(atPath: directory.path) else { return }
        let quarantine = FatinahDiagnosticOutbox(
            directory: directory,
            fileManager: fileManager
        )
        _ = try quarantine.pruneFiles(createdBefore: cutoff)
        let files = try quarantine.files()
        for excess in files.dropLast(10) {
            try? fileManager.removeItem(at: excess)
        }
    }

    private func quarantine(_ file: URL) {
        var destination: URL?
        do {
            let directory = try outboxDirectory()
                .appendingPathComponent("Quarantine", isDirectory: true)
            try FatinahDiagnosticStorageProtection.prepareDirectory(
                directory,
                fileManager: fileManager
            )
            let protectedDestination = directory.appendingPathComponent(file.lastPathComponent)
            destination = protectedDestination
            try? fileManager.removeItem(at: protectedDestination)
            try fileManager.moveItem(at: file, to: protectedDestination)
            try FatinahDiagnosticStorageProtection.protectFile(
                protectedDestination,
                fileManager: fileManager
            )
            try pruneQuarantine(
                in: directory.deletingLastPathComponent(),
                cutoff: Date().addingTimeInterval(-maximumReportAge)
            )
        } catch {
            if let destination { try? fileManager.removeItem(at: destination) }
            try? fileManager.removeItem(at: file)
        }
    }

    /// Must only be called on `queue`.
    private func purgeLegacyOutbox() -> Int {
        do {
            let directory = try outboxDirectory()
            var removed = try FatinahDiagnosticOutbox(
                directory: directory,
                fileManager: fileManager
            ).purgeLegacyOrInvalid()

            let quarantineDirectory = directory
                .appendingPathComponent("Quarantine", isDirectory: true)
            if fileManager.fileExists(atPath: quarantineDirectory.path) {
                removed += try FatinahDiagnosticOutbox(
                    directory: quarantineDirectory,
                    fileManager: fileManager
                ).purgeLegacyOrInvalid()
            }
            return removed
        } catch {
            NSLog(
                "MetricKit legacy purge failed: %@",
                String(describing: type(of: error))
            )
            return 0
        }
    }

    private func scheduleRetry() {
        retryWorkItem?.cancel()
        let exponent = min(retryAttempt, 8)
        let delay = min(300.0, pow(2.0, Double(exponent)))
        retryAttempt += 1
        let work = DispatchWorkItem { [weak self] in self?.uploadNextFile() }
        retryWorkItem = work
        queue.asyncAfter(deadline: .now() + delay, execute: work)
    }

    private func uploadNextFile() {
        guard !uploadInFlight else { return }
        let file: URL
        do {
            let directory = try outboxDirectory()
            try pruneOutbox(in: directory)
            let outbox = FatinahDiagnosticOutbox(
                directory: directory,
                fileManager: fileManager
            )
            guard let anonymousFile = try outbox.nextUploadableFile() else {
                retryAttempt = 0
                return
            }
            file = anonymousFile
        } catch {
            scheduleRetry()
            return
        }
        let generation = uploadGeneration
        uploadInFlight = true

        AppCheck.appCheck().token(forcingRefresh: false) { [weak self] result, _ in
            guard let self else { return }
            self.queue.async {
                guard self.uploadGeneration == generation, self.uploadInFlight else {
                    return
                }
                guard let appCheckToken = result?.token, !appCheckToken.isEmpty else {
                    self.uploadInFlight = false
                    self.scheduleRetry()
                    return
                }
                self.upload(
                    file: file,
                    appCheckToken: appCheckToken,
                    generation: generation
                )
            }
        }
    }

    private func upload(
        file: URL,
        appCheckToken: String,
        generation: Int
    ) {
        guard uploadGeneration == generation, uploadInFlight else { return }
        guard let endpoint = URL(string: "https://ata20.com/api/v2/ios-diagnostics") else {
            uploadInFlight = false
            quarantine(file)
            uploadNextFile()
            return
        }
        guard let envelopeData = try? Data(contentsOf: file),
              let envelope = try? JSONDecoder().decode(FatinahDiagnosticEnvelope.self, from: envelopeData) else {
            uploadInFlight = false
            quarantine(file)
            uploadNextFile()
            return
        }
        guard FatinahDiagnosticPrivacy.canUpload(envelope),
              let body = FatinahDiagnosticUpload.body(for: envelope) else {
            uploadInFlight = false
            try? fileManager.removeItem(at: file)
            uploadNextFile()
            return
        }

        guard let bodyData = try? JSONSerialization.data(withJSONObject: body) else {
            uploadInFlight = false
            quarantine(file)
            uploadNextFile()
            return
        }

        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.httpBody = bodyData
        request.timeoutInterval = 30
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("2", forHTTPHeaderField: "X-Fatinah-API-Version")
        request.setValue(appCheckToken, forHTTPHeaderField: "X-Firebase-AppCheck")

        let task = URLSession.shared.dataTask(with: request) { [weak self] _, response, _ in
            guard let self else { return }
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            self.queue.async {
                guard self.uploadGeneration == generation else { return }
                self.activeUploadTask = nil
                self.uploadInFlight = false
                if (200..<300).contains(status) {
                    do {
                        try self.fileManager.removeItem(at: file)
                        self.retryAttempt = 0
                        self.uploadNextFile()
                    } catch {
                        self.scheduleRetry()
                    }
                } else if status == 400 || status == 413 || status == 422 {
                    self.quarantine(file)
                    self.retryAttempt = 0
                    self.uploadNextFile()
                } else {
                    self.scheduleRetry()
                }
            }
        }
        activeUploadTask = task
        task.resume()
    }
}

import Foundation
import MetricKit
import CryptoKit
import FirebaseAuth
import FirebaseAppCheck

struct FatinahDiagnosticEnvelope: Codable, Equatable {
    let reportId: String
    let reportType: String
    let payload: String
    let appVersion: String
    let createdAt: String
}

enum FatinahDiagnosticPayload {
    static let maximumRawBytes = 360_000

    static func reportIdentifier(for data: Data, type: String) -> String {
        var fingerprint = Data(type.utf8)
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

    private override init() {
        super.init()
    }

    func start() {
        guard !started else { return }
        started = true
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
        started = false
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

    private func persist(_ data: Data, type: String) {
        queue.async { [weak self] in
            guard let self else { return }
            do {
                let reportId = FatinahDiagnosticPayload.reportIdentifier(for: data, type: type)
                // حد الخادم 512KB. Base64 يضيف قرابة الثلث، لذلك نستبدل
                // التقارير النادرة الضخمة بملخص آمن بدلاً من قص JSON عشوائياً.
                let payloadData = try FatinahDiagnosticPayload.safeData(from: data)
                let envelope = FatinahDiagnosticEnvelope(
                    reportId: reportId,
                    reportType: type,
                    payload: payloadData.base64EncodedString(),
                    appVersion: self.currentAppVersion(),
                    createdAt: ISO8601DateFormatter().string(from: Date())
                )
                let directory = try self.outboxDirectory()
                let file = directory.appendingPathComponent("\(reportId).json")
                try JSONEncoder().encode(envelope).write(to: file, options: .atomic)
                try self.pruneOutbox(in: directory)
                self.uploadNextFile()
            } catch {
                // لا نسجل محتوى التقرير في السجل؛ يكفي نوع خطأ التخزين.
                NSLog("MetricKit outbox persistence failed: %@", error.localizedDescription)
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
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }

    private func currentAppVersion() -> String {
        let info = Bundle.main.infoDictionary ?? [:]
        let version = info["CFBundleShortVersionString"] as? String ?? "unknown"
        let build = info["CFBundleVersion"] as? String ?? "unknown"
        return "\(version) (\(build))"
    }

    private func outboxFiles(in directory: URL) throws -> [URL] {
        try fileManager.contentsOfDirectory(
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
    }

    private func pruneOutbox(in directory: URL) throws {
        let cutoff = Date().addingTimeInterval(-maximumReportAge)
        var files = try outboxFiles(in: directory)
        for file in files {
            let created = (try? file.resourceValues(forKeys: [.creationDateKey]).creationDate) ?? .distantPast
            if created < cutoff { try? fileManager.removeItem(at: file) }
        }
        files = try outboxFiles(in: directory)
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
    }

    private func quarantine(_ file: URL) {
        do {
            let directory = try outboxDirectory()
                .appendingPathComponent("Quarantine", isDirectory: true)
            try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
            let destination = directory.appendingPathComponent(file.lastPathComponent)
            try? fileManager.removeItem(at: destination)
            try fileManager.moveItem(at: file, to: destination)
            let quarantined = try fileManager.contentsOfDirectory(
                at: directory,
                includingPropertiesForKeys: [.creationDateKey],
                options: [.skipsHiddenFiles]
            ).sorted { $0.lastPathComponent < $1.lastPathComponent }
            for excess in quarantined.dropLast(10) { try? fileManager.removeItem(at: excess) }
        } catch {
            try? fileManager.removeItem(at: file)
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
        guard let user = Auth.auth().currentUser else {
            scheduleRetry()
            return
        }
        let files: [URL]
        do {
            let directory = try outboxDirectory()
            try pruneOutbox(in: directory)
            files = try outboxFiles(in: directory)
        } catch {
            scheduleRetry()
            return
        }
        guard let file = files.first else {
            retryAttempt = 0
            return
        }
        uploadInFlight = true

        user.getIDToken { [weak self] idToken, tokenError in
            guard let self else { return }
            guard let idToken, tokenError == nil else {
                self.queue.async {
                    self.uploadInFlight = false
                    self.scheduleRetry()
                }
                return
            }
            AppCheck.appCheck().token(forcingRefresh: false) { result, _ in
                self.queue.async {
                    self.upload(file: file, uid: user.uid, idToken: idToken,
                                appCheckToken: result?.token)
                }
            }
        }
    }

    private func upload(file: URL, uid: String, idToken: String, appCheckToken: String?) {
        guard let endpoint = URL(string: "https://ata20.com/api/ios-diagnostics") else {
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

        let body: [String: Any] = [
            "uid": uid,
            "idToken": idToken,
            "reportId": envelope.reportId,
            "reportType": envelope.reportType,
            "payload": envelope.payload,
            "appVersion": envelope.appVersion,
            "createdAt": envelope.createdAt,
        ]
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
        request.setValue("Bearer \(idToken)", forHTTPHeaderField: "Authorization")
        if let appCheckToken, !appCheckToken.isEmpty {
            request.setValue(appCheckToken, forHTTPHeaderField: "X-Firebase-AppCheck")
        }

        URLSession.shared.dataTask(with: request) { [weak self] _, response, _ in
            guard let self else { return }
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            self.queue.async {
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
        }.resume()
    }
}

import Foundation

/// One forwarded message in the 03 §B.17 wire shape (`POST …/ingest` body `messages[]`). Optional
/// fields are omitted from the JSON when nil (the intent never sends empty strings).
public struct IngestMessage: Codable, Equatable, Sendable {
  public let fp: String
  public let channel: String
  public let sourceApp: String?
  public let sender: String?
  public let title: String?
  public let subtitle: String?
  public let body: String
  public let receivedAt: String
  public let test: Bool

  public init(fp: String, channel: String, sourceApp: String?, sender: String?, title: String?,
              subtitle: String?, body: String, receivedAt: String, test: Bool) {
    self.fp = fp
    self.channel = channel
    self.sourceApp = sourceApp
    self.sender = sender
    self.title = title
    self.subtitle = subtitle
    self.body = body
    self.receivedAt = receivedAt
    self.test = test
  }
}

/// The module's folder: `Application Support/CollectionsIngest/` (queue/, state.json, config.json).
/// Every file is written with `.completeFileProtectionUntilFirstUserAuthentication` (class C:
/// readable by the intent on a locked phone after one unlock since boot) and the folder is
/// excluded from backups (doc 15 spec 10 §4.10, §8 "Queue holds message text on disk").
public struct IngestStorage: Sendable {
  public let root: URL

  public init(root: URL) {
    self.root = root
  }

  public static func defaultRoot() -> URL {
    let base = (try? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                             appropriateFor: nil, create: true))
      ?? URL(fileURLWithPath: NSTemporaryDirectory())
    return base.appendingPathComponent("CollectionsIngest", isDirectory: true)
  }

  public var queueDir: URL { root.appendingPathComponent("queue", isDirectory: true) }

  @discardableResult
  public func ensureDirs() -> Bool {
    let fm = FileManager.default
    do {
      for d in [root, queueDir] where !fm.fileExists(atPath: d.path) {
        try fm.createDirectory(at: d, withIntermediateDirectories: true,
                               attributes: [FileAttributeKey.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
      }
      var r = root
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      try? r.setResourceValues(values)
      return true
    } catch {
      return false
    }
  }

  public func write(_ data: Data, to url: URL) throws {
    ensureDirs()
    #if os(iOS)
    try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    #else
    try data.write(to: url, options: [.atomic])
    #endif
    var u = url
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try? u.setResourceValues(values)
  }

  public func readJSON<T: Decodable>(_ type: T.Type, _ name: String) -> T? {
    guard let data = try? Data(contentsOf: root.appendingPathComponent(name)) else { return nil }
    return try? JSONDecoder().decode(type, from: data)
  }

  public func writeJSON<T: Encodable>(_ value: T, _ name: String) {
    guard let data = try? JSONEncoder().encode(value) else { return }
    try? write(data, to: root.appendingPathComponent(name))
  }

  public func remove(_ name: String) {
    try? FileManager.default.removeItem(at: root.appendingPathComponent(name))
  }
}

/// A queued file: `queue/<receivedAtMs, 13 digits>-<fp>.json`, so a name sort is receive order.
public struct QueuedMessage: Sendable {
  public let file: URL
  public let receivedAtMs: Int64
  public let message: IngestMessage
}

/// Crash-safe forward queue (doc 15 spec 10 §4.10): the intent ENQUEUES FIRST and then drains, and
/// a file is deleted only when the server answered for its `fp`. Cap 200 files (oldest dropped);
/// entries whose `receivedAt` is older than 47 h are dropped (07 rejects > 48 h as `too_old`).
public struct IngestQueue: Sendable {
  public static let maxFiles = 200
  public static let maxAgeMs: Int64 = 47 * 3600 * 1000

  public let storage: IngestStorage

  public init(storage: IngestStorage) {
    self.storage = storage
  }

  static func fileName(receivedAtMs: Int64, fp: String) -> String {
    String(format: "%013lld", max(0, receivedAtMs)) + "-" + fp + ".json"
  }

  @discardableResult
  public func enqueue(_ m: IngestMessage, receivedAtMs: Int64, now: Date = Date()) -> Bool {
    guard let data = try? JSONEncoder().encode(m) else { return false }
    let url = storage.queueDir.appendingPathComponent(IngestQueue.fileName(receivedAtMs: receivedAtMs, fp: m.fp))
    do {
      try storage.write(data, to: url)
    } catch {
      return false
    }
    _ = list(now: now) // enforce the cap and the age limit right away
    return true
  }

  /// Oldest first. Prunes expired, unreadable and over-cap files as a side effect.
  public func list(now: Date = Date()) -> [QueuedMessage] {
    let fm = FileManager.default
    guard let names = try? fm.contentsOfDirectory(atPath: storage.queueDir.path) else { return [] }
    let nowMs = Int64(now.timeIntervalSince1970 * 1000)
    var out: [QueuedMessage] = []
    for name in names.sorted() where name.hasSuffix(".json") {
      let url = storage.queueDir.appendingPathComponent(name)
      guard let dash = name.firstIndex(of: "-"), let ms = Int64(name[name.startIndex..<dash]),
            let data = try? Data(contentsOf: url),
            let m = try? JSONDecoder().decode(IngestMessage.self, from: data) else {
        try? fm.removeItem(at: url)
        continue
      }
      if nowMs - ms > IngestQueue.maxAgeMs {
        try? fm.removeItem(at: url)
        continue
      }
      out.append(QueuedMessage(file: url, receivedAtMs: ms, message: m))
    }
    if out.count > IngestQueue.maxFiles {
      for q in out.prefix(out.count - IngestQueue.maxFiles) { try? fm.removeItem(at: q.file) }
      out = Array(out.suffix(IngestQueue.maxFiles))
    }
    return out
  }

  public func count(now: Date = Date()) -> Int { list(now: now).count }

  public func contains(fp: String) -> Bool {
    guard let names = try? FileManager.default.contentsOfDirectory(atPath: storage.queueDir.path) else { return false }
    return names.contains { $0.hasSuffix("-\(fp).json") }
  }

  public func remove(_ items: [QueuedMessage]) {
    for q in items { try? FileManager.default.removeItem(at: q.file) }
  }

  public func clear() {
    try? FileManager.default.removeItem(at: storage.queueDir)
  }
}

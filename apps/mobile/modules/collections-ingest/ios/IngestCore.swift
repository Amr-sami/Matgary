import Foundation

/// What the intent (or `forwardForTesting`) hands the core (doc 15 spec 10 §4.10).
public struct IngestInput: Sendable {
  public let text: String
  public let title: String?
  public let subtitle: String?
  public let sender: String?
  /// `"sms"` (Message trigger → `ios_sms`), a notification label, or `"ios.unknown"` (03 §B.10).
  public let source: String
  public let receivedAt: Date

  public init(text: String, title: String? = nil, subtitle: String? = nil, sender: String? = nil,
              source: String = "sms", receivedAt: Date = Date()) {
    self.text = text
    self.title = title
    self.subtitle = subtitle
    self.sender = sender
    self.source = source
    self.receivedAt = receivedAt
  }
}

/// The result of one forward. The intent maps each case to a `collections_intent_dialog_*` string
/// (`mobile.collections.ios.intent.dialog*`); the dialog never contains an amount.
public enum IngestOutcome: String, Sendable, CaseIterable {
  case sent
  case queued
  case test
  case testFailed
  case skipped
  case notLinked

  /// `collections_intent_dialog_<snake>` — the Localizable.strings key the config plugin writes.
  public var dialogKey: String {
    switch self {
    case .sent: return "collections_intent_dialog_sent"
    case .queued: return "collections_intent_dialog_queued"
    case .test: return "collections_intent_dialog_test"
    case .testFailed: return "collections_intent_dialog_test_failed"
    case .skipped: return "collections_intent_dialog_skipped"
    case .notLinked: return "collections_intent_dialog_not_linked"
    }
  }
}

/// `getIngestStatus()` — no message text, no token.
public struct IngestStatusSnapshot: Equatable, Sendable {
  public let hasCredential: Bool
  public let queued: Int
  public let lastUploadAt: String?
  public let lastError: String?
  public let configVersion: String?

  public func asDictionary() -> [String: Any] {
    [
      "hasCredential": hasCredential,
      "queued": queued,
      "lastUploadAt": lastUploadAt as Any,
      "lastError": lastError as Any,
      "configVersion": configVersion as Any,
    ]
  }
}

/// Persistent bookkeeping (`state.json`). Error CODES only, never message text.
struct IngestState: Codable, Equatable {
  var lastUploadAt: String?
  var lastError: String?
  var lastHeartbeatAt: Date?
  var retryNotBefore: Date?
}

struct CachedConfig: Codable, Equatable {
  let fetchedAt: Date
  let config: IngestRemoteConfig
}

/// The native core shared by the Expo module and `ForwardPaymentMessageIntent` (same app process,
/// option B — no App Group). An actor, so a burst of intent runs (T6) is serialised: enqueue,
/// then one drain loop at a time that re-lists the queue until it is empty or the server says
/// stop.
public actor IngestCore {
  public static let testMarker = "THESTORO-SETUP-TEST" // 09 COLLECTIONS_SETUP_TEST_MARKER
  public static let testBody = "THESTORO-SETUP-TEST تم استلام مبلغ 1.00 جنيه" // D10-8
  public static let testSender = "TheStoro"
  public static let configMaxAge: TimeInterval = 24 * 3600
  public static let heartbeatEvery: TimeInterval = 6 * 3600
  /// Wire caps that keep one message valid for 07's zod (`body` ≤ 8000, `sender` ≤ 64 after its
  /// own slice, `sourceApp` ≤ 200); the server truncates the body to 2000 anyway.
  static let maxBody = 8000
  static let maxSourceApp = 200

  public static let shared = IngestCore(
    store: IngestKeychain(),
    storage: IngestStorage(root: IngestStorage.defaultRoot()),
    transport: URLSessionTransport()
  )

  private let store: IngestCredentialStore
  private let storage: IngestStorage
  private let queue: IngestQueue
  private let uploader: IngestUploader
  private let now: @Sendable () -> Date
  private let timeZone: TimeZone
  private let allowHttp: Bool
  private var state: IngestState
  private var drainTask: Task<Void, Never>?

  public init(store: IngestCredentialStore, storage: IngestStorage, transport: IngestTransport,
              now: @escaping @Sendable () -> Date = { Date() }, timeZone: TimeZone = .current,
              allowHttp: Bool? = nil) {
    self.store = store
    self.storage = storage
    self.queue = IngestQueue(storage: storage)
    self.uploader = IngestUploader(transport: transport)
    self.now = now
    self.timeZone = timeZone
    #if DEBUG
    self.allowHttp = allowHttp ?? true
    #else
    self.allowHttp = allowHttp ?? false
    #endif
    self.state = storage.readJSON(IngestState.self, "state.json") ?? IngestState()
  }

  // MARK: credential

  public func setCredential(url: String, token: String) -> Bool {
    guard IngestCredentialValue.isValidToken(token), IngestCredentialValue.isValidUrl(url, allowHttp: allowHttp) else {
      return false
    }
    guard store.save(IngestCredentialValue(url: url, token: token)) else { return false }
    // A new device: forget the old one's config, errors, back-off and heartbeat clock. Queued
    // messages stay (they are this phone's real credits; the new token delivers them).
    storage.remove("config.json")
    state = IngestState()
    saveState()
    return true
  }

  public func hasCredential() -> Bool {
    if case .found = store.load() { return true }
    return false
  }

  /// Revoke / replace / re-setup: credential, queue, cached config and state all go.
  @discardableResult
  public func clear() -> Bool {
    let ok = store.delete()
    queue.clear()
    storage.remove("config.json")
    storage.remove("state.json")
    state = IngestState()
    return ok
  }

  public func status() -> IngestStatusSnapshot {
    IngestStatusSnapshot(
      hasCredential: hasCredential(),
      queued: queue.count(now: now()),
      lastUploadAt: state.lastUploadAt,
      lastError: state.lastError,
      configVersion: cachedConfig()?.config.configVersion
    )
  }

  // MARK: forward (10 §4.10 steps 1–7)

  public func forward(_ input: IngestInput) async -> IngestOutcome {
    let test = input.text.trimmingCharacters(in: .whitespacesAndNewlines) == IngestCore.testMarker
    // 1. filter (server config ≤ 24 h, else the built-in copies of 06)
    if !test {
      let cfg = freshConfig()
      let keywords = cfg?.allKeywords ?? IngestFilter.DEFAULT_KEYWORDS
      let patterns = cfg?.otpPatterns ?? IngestFilter.DEFAULT_OTP_PATTERNS
      if !IngestFilter.shouldForward(title: input.title, subtitle: input.subtitle, body: input.text,
                                     sender: input.sender, keywords: keywords, patterns: patterns) {
        return .skipped
      }
    }
    // 2. linked?
    switch store.load() {
    case .found:
      break
    case .missing:
      return test ? .testFailed : .notLinked
    case .locked:
      recordError("KEYCHAIN_LOCKED")
      return test ? .testFailed : .notLinked
    }
    // 3. the §4.4 message
    let message = buildMessage(input, test: test)
    // 4. enqueue first, then drain
    let receivedAtMs = test ? Int64(now().timeIntervalSince1970 * 1000) : Int64(input.receivedAt.timeIntervalSince1970 * 1000)
    guard queue.enqueue(message, receivedAtMs: receivedAtMs, now: now()) else {
      recordError("QUEUE_WRITE")
      return test ? .testFailed : .queued
    }
    await drain()
    // 7. outcome
    if !hasCredential() { return test ? .testFailed : .notLinked } // 401 during the drain
    let stillQueued = queue.contains(fp: message.fp)
    if test {
      if stillQueued {
        // A test is about now: never deliver it later (09's verify waits ≤ 120 s).
        queue.remove(queue.list(now: now()).filter { $0.message.fp == message.fp })
        return .testFailed
      }
      return .test
    }
    return stillQueued ? .queued : .sent
  }

  func buildMessage(_ input: IngestInput, test: Bool) -> IngestMessage {
    let iso = ISO8601DateFormatter() // UTC `…Z`, no fractional seconds (07's isoInstant accepts it)
    iso.timeZone = TimeZone(identifier: "UTC")
    if test {
      return IngestMessage(fp: IngestFingerprint.testFingerprint(), channel: "ios_sms", sourceApp: nil,
                           sender: IngestCore.testSender, title: nil, subtitle: nil, body: IngestCore.testBody,
                           receivedAt: iso.string(from: now()), test: true)
    }
    let sms = input.source == "sms"
    let channel = sms ? "ios_sms" : "ios_notification"
    let sender = sms ? nonEmpty(input.sender) : nil
    let body = String(input.text.prefix(IngestCore.maxBody))
    let minute = IngestFingerprint.minute(input.receivedAt, timeZone)
    let fp = IngestFingerprint.fingerprint(channel: channel, sender: sender ?? "", body: body, minute: minute)
    return IngestMessage(
      fp: fp, channel: channel,
      sourceApp: sms ? nil : nonEmpty(String(input.source.prefix(IngestCore.maxSourceApp))),
      sender: sender, title: nonEmpty(input.title), subtitle: nonEmpty(input.subtitle),
      body: body, receivedAt: iso.string(from: input.receivedAt), test: false)
  }

  private func nonEmpty(_ s: String?) -> String? {
    guard let s = s?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty else { return nil }
    return s
  }

  // MARK: drain (10 §4.10 steps 5–6)

  /// One drain at a time; a second caller waits for the running loop, which re-lists the queue
  /// after every batch, so a message enqueued meanwhile is sent by the same loop.
  public func drain() async {
    if let running = drainTask {
      await running.value
      return
    }
    let task = Task { await self.drainLoop() }
    drainTask = task
    await task.value
  }

  private func drainLoop() async {
    defer { drainTask = nil }
    guard case let .found(cred) = store.load() else { return }
    var deliveredAny = false
    while true {
      let files = queue.list(now: now())
      if files.isEmpty { break }
      if let notBefore = state.retryNotBefore, now() < notBefore {
        recordError("RATE_LIMITED")
        return
      }
      let batch = Array(files.prefix(IngestUploader.maxPerRequest))
      let result = await uploader.post(cred, batch.map(\.message))
      switch result {
      case let .ok(answered):
        let done = batch.filter { answered.contains($0.message.fp) }
        queue.remove(done)
        markUploaded()
        deliveredAny = true
        if done.isEmpty { // the server answered for none of them: never loop forever
          recordError("NO_RESULTS")
          return
        }
      case .rejected:
        // Poison pill: resend one by one and drop only the offender(s).
        if !(await resendOneByOne(cred, batch)) { return }
        deliveredAny = true
      default:
        if !handleStop(result) { return }
      }
    }
    if deliveredAny || state.lastError == nil { await refreshConfigIfStale(cred) }
  }

  /// false = stop the loop.
  private func resendOneByOne(_ cred: IngestCredentialValue, _ batch: [QueuedMessage]) async -> Bool {
    for item in batch {
      let r = await uploader.post(cred, [item.message])
      switch r {
      case .ok:
        queue.remove([item])
        markUploaded()
      case .rejected:
        queue.remove([item]) // the offender
        recordError("INVALID_MESSAGE_DROPPED")
      default:
        if !handleStop(r) { return false }
      }
    }
    return true
  }

  /// The non-200, non-400 answers. Returns false (stop) for every one of them.
  private func handleStop(_ r: UploadResult) -> Bool {
    switch r {
    case let .unauthorized(code):
      clear() // INGEST_TOKEN_INVALID / INGEST_DEVICE_REVOKED: credential, queue, config
      recordError(code)
    case let .disabled(code):
      recordError(code)
    case let .rateLimited(after):
      state.retryNotBefore = now().addingTimeInterval(min(max(after ?? 60, 1), 3600))
      recordError("RATE_LIMITED")
    case let .failed(code):
      recordError(code)
    case .ok, .rejected:
      return true
    }
    return false
  }

  // MARK: heartbeat + config

  /// ≤ 1 per 6 h while a credential exists (03 §B.10); runs on app active.
  public func heartbeatIfDue(appVersion: String? = nil, osVersion: String? = nil) async {
    guard case let .found(cred) = store.load() else { return }
    if let last = state.lastHeartbeatAt, now().timeIntervalSince(last) < IngestCore.heartbeatEvery { return }
    let body = IngestUploader.HeartbeatBody(
      appVersion: appVersion ?? (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String),
      osVersion: osVersion ?? IngestCore.osVersionString(),
      queued: queue.count(now: now()), lastUploadAt: state.lastUploadAt)
    switch await uploader.heartbeat(cred, body) {
    case let .ok(configVersion):
      state.lastHeartbeatAt = now()
      saveState()
      if let v = configVersion, v != cachedConfig()?.config.configVersion { await refreshConfig(cred) }
    case let .unauthorized(code):
      clear()
      recordError(code)
    case let .failed(code):
      recordError(code)
    }
  }

  static func osVersionString() -> String {
    let v = ProcessInfo.processInfo.operatingSystemVersion
    return "\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)"
  }

  private func cachedConfig() -> CachedConfig? {
    storage.readJSON(CachedConfig.self, "config.json")
  }

  /// The server's filter when fetched ≤ 24 h ago, else nil (→ the built-in defaults).
  private func freshConfig() -> IngestRemoteConfig? {
    guard let c = cachedConfig(), now().timeIntervalSince(c.fetchedAt) <= IngestCore.configMaxAge,
          !c.config.allKeywords.isEmpty else { return nil }
    return c.config
  }

  private func refreshConfigIfStale(_ cred: IngestCredentialValue) async {
    if freshConfig() != nil { return }
    await refreshConfig(cred)
  }

  private func refreshConfig(_ cred: IngestCredentialValue) async {
    guard let cfg = await uploader.fetchConfig(cred) else { return }
    storage.writeJSON(CachedConfig(fetchedAt: now(), config: cfg), "config.json")
  }

  // MARK: state

  private func markUploaded() {
    let iso = ISO8601DateFormatter()
    iso.timeZone = TimeZone(identifier: "UTC")
    state.lastUploadAt = iso.string(from: now())
    state.lastError = nil
    state.retryNotBefore = nil
    saveState()
  }

  private func recordError(_ code: String) {
    state.lastError = code
    saveState()
  }

  private func saveState() {
    storage.writeJSON(state, "state.json")
  }
}

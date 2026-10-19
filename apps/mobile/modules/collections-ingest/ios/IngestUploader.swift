import Foundation

/// Network seam: `URLSessionTransport` in the app, a scripted fake in `ios-tests/`.
public protocol IngestTransport: Sendable {
  func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

/// `URLSession` ephemeral (no cookies, no URL cache on disk), 10 s per request.
public final class URLSessionTransport: IngestTransport, @unchecked Sendable {
  private let session: URLSession

  public init() {
    let c = URLSessionConfiguration.ephemeral
    c.timeoutIntervalForRequest = 10
    c.timeoutIntervalForResource = 30
    c.waitsForConnectivity = false
    c.httpCookieStorage = nil
    c.urlCache = nil
    session = URLSession(configuration: c)
  }

  public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
    let (data, response) = try await session.data(for: request)
    guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
    return (data, http)
  }
}

/// `GET …/ingest/config` (07 §4.8): the device-side filter the server serves, so a keyword or OTP
/// fix reaches intent users without an app release. Unknown fields are ignored.
public struct IngestRemoteConfig: Codable, Equatable, Sendable {
  public struct Keywords: Codable, Equatable, Sendable {
    public let ar: [String]
    public let en: [String]
  }

  public let configVersion: String
  public let filterVersion: String?
  public let keywords: Keywords
  public let otpPatterns: [String]
  public let maxAgeHours: Int?

  public var allKeywords: [String] { keywords.ar + keywords.en }
}

/// One answer of `POST …/ingest`, reduced to what the drain loop needs (spec 10 §4.10 step 5;
/// the route's own comment: 401 → stop and set up again, 403 → keep, 413/400 → drop the batch,
/// 429/5xx → back off and retry).
public enum UploadResult: Equatable, Sendable {
  /// 200 — the `fp`s the server answered for (accepted, duplicate and dropped alike).
  case ok(answered: Set<String>)
  /// 400 (07 answers `INVALID_REQUEST`) or 413 `INGEST_PAYLOAD_TOO_LARGE`.
  case rejected
  /// 401 `INGEST_TOKEN_INVALID` / `INGEST_DEVICE_REVOKED`.
  case unauthorized(code: String)
  /// 403 (`INGEST_DISABLED`, `TENANT_SUSPENDED`): keep the queue, stop.
  case disabled(code: String)
  /// 429: keep, honour `Retry-After` (seconds).
  case rateLimited(retryAfter: TimeInterval?)
  /// 5xx, network, timeout, unreadable answer: keep.
  case failed(code: String)
}

public struct IngestUploader: Sendable {
  public static let maxPerRequest = 50 // 03 §B.17

  public let transport: IngestTransport

  public init(transport: IngestTransport) {
    self.transport = transport
  }

  /// `<ingest url>/<suffix>`; the ingest URL is 07's `ingest.ingestUrl`.
  static func url(_ base: String, _ suffix: String?) -> URL? {
    var s = base
    while s.hasSuffix("/") { s.removeLast() }
    if let suffix = suffix { s += "/" + suffix }
    return URL(string: s)
  }

  private func request(_ cred: IngestCredentialValue, _ suffix: String?, method: String, body: Data?) -> URLRequest? {
    guard let url = IngestUploader.url(cred.url, suffix) else { return nil }
    var r = URLRequest(url: url)
    r.httpMethod = method
    r.setValue("Bearer \(cred.token)", forHTTPHeaderField: "Authorization")
    r.setValue("application/json", forHTTPHeaderField: "Accept")
    if let body = body {
      r.httpBody = body
      r.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }
    return r
  }

  private struct Envelope: Encodable {
    let v = 1
    let messages: [IngestMessage]
  }

  private struct Answer: Decodable {
    struct Row: Decodable { let fp: String }
    let results: [Row]
  }

  private struct ErrorBody: Decodable { let error: String? }

  static func errorCode(_ data: Data, fallback: String) -> String {
    let code = (try? JSONDecoder().decode(ErrorBody.self, from: data))?.error ?? fallback
    // Codes only, never text: keep [A-Z0-9_], ≤ 64 chars.
    let clean = String(code.unicodeScalars.filter { CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_").contains($0) })
    return clean.isEmpty ? fallback : String(clean.prefix(64))
  }

  public func post(_ cred: IngestCredentialValue, _ messages: [IngestMessage]) async -> UploadResult {
    guard let body = try? JSONEncoder().encode(Envelope(messages: messages)),
          let req = request(cred, nil, method: "POST", body: body) else { return .rejected }
    let data: Data
    let http: HTTPURLResponse
    do {
      (data, http) = try await transport.send(req)
    } catch {
      return .failed(code: (error as? URLError).map { "NETWORK_\(abs($0.code.rawValue))" } ?? "NETWORK")
    }
    switch http.statusCode {
    case 200:
      guard let a = try? JSONDecoder().decode(Answer.self, from: data) else { return .failed(code: "BAD_ANSWER") }
      return .ok(answered: Set(a.results.map(\.fp)))
    case 400, 413:
      return .rejected
    case 401:
      return .unauthorized(code: IngestUploader.errorCode(data, fallback: "INGEST_TOKEN_INVALID"))
    case 403:
      return .disabled(code: IngestUploader.errorCode(data, fallback: "INGEST_DISABLED"))
    case 429:
      let after = (http.value(forHTTPHeaderField: "Retry-After")).flatMap(TimeInterval.init)
      return .rateLimited(retryAfter: after)
    default:
      return .failed(code: "HTTP_\(http.statusCode)")
    }
  }

  public struct HeartbeatBody: Encodable, Sendable {
    let v = 1
    let platform = "ios_app_intent"
    public let appVersion: String?
    public let osVersion: String?
    public let queued: Int
    public let lastUploadAt: String?

    public init(appVersion: String?, osVersion: String?, queued: Int, lastUploadAt: String?) {
      self.appVersion = appVersion
      self.osVersion = osVersion
      self.queued = queued
      self.lastUploadAt = lastUploadAt
    }
  }

  public enum HeartbeatResult: Equatable, Sendable {
    case ok(configVersion: String?)
    case unauthorized(code: String)
    case failed(code: String)
  }

  /// `POST <url>/heartbeat` (07 bucket 12/h). Moves `last_seen_at`, so a set-up phone is not
  /// `never_seen`; answers `{configVersion}` so the phone refetches the config only on a change.
  public func heartbeat(_ cred: IngestCredentialValue, _ body: HeartbeatBody) async -> HeartbeatResult {
    guard let data = try? JSONEncoder().encode(body),
          let req = request(cred, "heartbeat", method: "POST", body: data) else { return .failed(code: "ENCODE") }
    do {
      let (d, http) = try await transport.send(req)
      switch http.statusCode {
      case 200:
        struct A: Decodable { let configVersion: String? }
        return .ok(configVersion: (try? JSONDecoder().decode(A.self, from: d))?.configVersion)
      case 401:
        return .unauthorized(code: IngestUploader.errorCode(d, fallback: "INGEST_TOKEN_INVALID"))
      default:
        return .failed(code: "HTTP_\(http.statusCode)")
      }
    } catch {
      return .failed(code: "NETWORK")
    }
  }

  /// `GET <url>/config` (07 bucket 60/h). nil on any failure (the defaults stay in force).
  public func fetchConfig(_ cred: IngestCredentialValue) async -> IngestRemoteConfig? {
    guard let req = request(cred, "config", method: "GET", body: nil),
          let (d, http) = try? await transport.send(req), http.statusCode == 200 else { return nil }
    return try? JSONDecoder().decode(IngestRemoteConfig.self, from: d)
  }
}

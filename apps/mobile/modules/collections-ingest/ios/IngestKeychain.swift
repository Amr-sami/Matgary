import Foundation
import Security

/// The phone's ingest credential (doc 15 spec 10 §4.10; 03 §E.1–E.2): a post-only, revocable
/// `mgi_…` token minted by 07 for THIS device, plus the ingest URL it posts to. Stored as JSON
/// `{"v":1,"url":…,"token":…}`.
public struct IngestCredentialValue: Codable, Equatable, Sendable {
  public let v: Int
  public let url: String
  public let token: String

  public init(url: String, token: String) {
    self.v = 1
    self.url = url
    self.token = token
  }

  /// 07's token shape: `mgi_` + 43 base64url characters.
  public static func isValidToken(_ token: String) -> Bool {
    token.range(of: #"^mgi_[A-Za-z0-9_-]{43}$"#, options: .regularExpression) != nil
  }

  /// `https://` always; `http://` only in DEBUG builds (a LAN dev backend). The JS face enforces the
  /// same rule before it calls native; this is the second gate.
  public static func isValidUrl(_ s: String, allowHttp: Bool) -> Bool {
    guard s.count <= 2048, let u = URLComponents(string: s), let host = u.host, !host.isEmpty,
          u.user == nil, u.password == nil, u.query == nil, u.fragment == nil else { return false }
    return u.scheme == "https" || (allowHttp && u.scheme == "http")
  }
}

public enum CredentialLoad: Equatable, Sendable {
  case found(IngestCredentialValue)
  case missing
  /// `errSecInteractionNotAllowed`: the phone has not been unlocked once since boot.
  case locked
}

/// Storage seam: the Keychain in the app, an in-memory fake in `ios-tests/`.
public protocol IngestCredentialStore: Sendable {
  func load() -> CredentialLoad
  func save(_ value: IngestCredentialValue) -> Bool
  @discardableResult func delete() -> Bool
}

/// Generic-password item, service `com.thestoro.app.collections-ingest`, account `credential`,
/// `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` (readable by the intent on a locked phone after
/// one unlock since boot; never in a backup or iCloud Keychain, so a restore to a new iPhone has no
/// credential, T9), `kSecAttrSynchronizable = false`. A distinct service from expo-secure-store's
/// items (`src/auth/tokenStore.ts`), so the two never collide.
public struct IngestKeychain: IngestCredentialStore {
  public static let service = "com.thestoro.app.collections-ingest"
  public static let account = "credential"

  public init() {}

  private func baseQuery() -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: IngestKeychain.service,
      kSecAttrAccount as String: IngestKeychain.account,
      kSecAttrSynchronizable as String: kCFBooleanFalse as Any,
    ]
  }

  public func load() -> CredentialLoad {
    var q = baseQuery()
    q[kSecReturnData as String] = kCFBooleanTrue
    q[kSecMatchLimit as String] = kSecMatchLimitOne
    var out: CFTypeRef?
    let status = SecItemCopyMatching(q as CFDictionary, &out)
    switch status {
    case errSecSuccess:
      guard let data = out as? Data,
            let value = try? JSONDecoder().decode(IngestCredentialValue.self, from: data),
            value.v == 1, IngestCredentialValue.isValidToken(value.token) else { return .missing }
      return .found(value)
    case errSecInteractionNotAllowed:
      return .locked
    default:
      return .missing
    }
  }

  /// delete + add (no update path to get wrong: the accessibility class is always the one above).
  public func save(_ value: IngestCredentialValue) -> Bool {
    guard let data = try? JSONEncoder().encode(value) else { return false }
    delete()
    var q = baseQuery()
    q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    q[kSecValueData as String] = data
    return SecItemAdd(q as CFDictionary, nil) == errSecSuccess
  }

  @discardableResult
  public func delete() -> Bool {
    let status = SecItemDelete(baseQuery() as CFDictionary)
    return status == errSecSuccess || status == errSecItemNotFound
  }
}

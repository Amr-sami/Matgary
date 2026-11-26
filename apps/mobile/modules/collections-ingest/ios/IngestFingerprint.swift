import CryptoKit
import Foundation

/// Client fingerprint of a forwarded message (doc 15 spec 10 §4.4; 06 §4.12 `FingerprintInput` kind
/// `ios`). Pure: Foundation + CryptoKit only, so `ios-tests/main.swift` compiles it with plain
/// `xcrun swiftc` (no Expo, no pods).
///
/// Pre-image: `"<channel>|<sender>|<body>|<minute>"`, `sender` = "" when unknown, `minute` = local
/// `yyyy-MM-dd'T'HH:mm` (Gregorian, `en_US_POSIX`, so Arabic-Indic digits or a Buddhist calendar on
/// the phone never change it). The server never recomputes it; it only has to be deterministic per
/// phone (the shortcut produces the same pre-image).
public enum IngestFingerprint {
  public static func minute(_ date: Date, _ tz: TimeZone) -> String {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.calendar = Calendar(identifier: .gregorian)
    f.timeZone = tz
    f.dateFormat = "yyyy-MM-dd'T'HH:mm"
    return f.string(from: date)
  }

  /// Lower-case hex SHA-256 of the UTF-8 bytes (64 characters).
  public static func sha256Hex(_ s: String) -> String {
    SHA256.hash(data: Data(s.utf8)).map { String(format: "%02x", $0) }.joined()
  }

  public static func fingerprint(channel: String, sender: String, body: String, minute: String) -> String {
    sha256Hex("\(channel)|\(sender)|\(body)|\(minute)")
  }

  /// Test messages: `sha256Hex("test|" + random)`, unique per run (§4.4 "Test" column).
  public static func testFingerprint() -> String {
    sha256Hex("test|" + UUID().uuidString)
  }
}

import Foundation

/// The on-device pre-filter of the App Intent (doc 15 spec 10 §4.10; 06 §4.9). Pure: Foundation only.
///
/// - `DEFAULT_KEYWORDS` / `DEFAULT_OTP_PATTERNS` are COPIES of 06's `CANDIDATE_KEYWORDS` (ar + en)
///   and `OTP_PATTERNS` (`packages/domain/src/collections/filter.ts`, FILTER_CONFIG_VERSION
///   2026-10-18-1). `__tests__/filter-parity.test.ts` reads this file as text and fails on any
///   drift, so keep one string literal per line inside each array. They are only the fallback: the
///   core prefers the server's `GET …/ingest/config` lists (≤ 24 h old), so a keyword fix reaches
///   intent users without an app release.
/// - `PERSONAL_SENDER` is D10-3 (equals `shortcuts/filter.lock.json` `personalSenderRegex`).
///
/// Keywords match as case-insensitive substrings of the RAW text (06 lists every Arabic spelling
/// raw); OTP patterns are ICU-portable and applied case-insensitively with NSRegularExpression.
public enum IngestFilter {
  public static let DEFAULT_KEYWORDS: [String] = [
    "استلام",
    "إستلام",
    "استقبال",
    "إستقبال",
    "إضافة",
    "اضافة",
    "إيداع",
    "ايداع",
    "تحويل لحظي",
    "تم تحويل",
    "received",
    "credited",
    "IPN",
    "cash-in",
  ]

  public static let DEFAULT_OTP_PATTERNS: [String] = [
    #"(^|[^a-z])otp([^a-z]|$)"#,
    #"one[ -]?time (pass|code|pin)"#,
    #"verification code"#,
    #"passcode"#,
    #"do not share"#,
    #"don'?t share"#,
    #"[كق]ود (ال)?(تحقق|تفعيل|سري)"#,
    #"رمز (ال)?(تحقق|تفعيل|سري|المرور)"#,
    #"كلم[ةه] (ال)?(مرور|سر)"#,
    #"الرقم السري"#,
    #"لا تشارك"#,
    #"لا تفصح"#,
    #"لمر[ةه] واحد[ةه]"#,
  ]

  public static let PERSONAL_SENDER: String = #"^(\+?20|0020|0)?1[0125][0-9]{8}$"#

  /// Zero-width and bidi controls, the Arabic letter mark, the BOM and tatweel (06 `INVISIBLES_RE`).
  private static let invisibles: Set<UInt32> = {
    var s = Set<UInt32>([0x061C, 0xFEFF, 0x0640])
    for v in UInt32(0x200B)...UInt32(0x200F) { s.insert(v) }
    for v in UInt32(0x202A)...UInt32(0x202E) { s.insert(v) }
    for v in UInt32(0x2066)...UInt32(0x2069) { s.insert(v) }
    return s
  }()

  /// Arabic-Indic (U+0660…) and extended Arabic-Indic (U+06F0…) digits → ASCII; invisible marks
  /// dropped; white space collapsed (06 `liteNormalize`).
  static func lite(_ text: String) -> String {
    var out = String.UnicodeScalarView()
    for u in text.unicodeScalars {
      if invisibles.contains(u.value) { continue }
      if (0x0660...0x0669).contains(u.value), let d = Unicode.Scalar(u.value - 0x0660 + 0x30) {
        out.append(d)
      } else if (0x06F0...0x06F9).contains(u.value), let d = Unicode.Scalar(u.value - 0x06F0 + 0x30) {
        out.append(d)
      } else {
        out.append(u)
      }
    }
    return String(out)
      .components(separatedBy: .whitespacesAndNewlines)
      .filter { !$0.isEmpty }
      .joined(separator: " ")
  }

  /// Title, subtitle and body joined with "\n", empty parts skipped (06 `joinParts`).
  public static func joined(title: String?, subtitle: String?, body: String) -> String {
    [title, subtitle, body].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: "\n")
  }

  public static func isCandidate(title: String?, subtitle: String?, body: String, keywords: [String] = DEFAULT_KEYWORDS) -> Bool {
    let text = lite(joined(title: title, subtitle: subtitle, body: body))
    for k in keywords where !k.isEmpty {
      if text.range(of: k, options: [.caseInsensitive]) != nil { return true }
    }
    return false
  }

  public static func isOtp(title: String?, subtitle: String?, body: String, patterns: [String] = DEFAULT_OTP_PATTERNS) -> Bool {
    let text = lite(joined(title: title, subtitle: subtitle, body: body))
    let range = NSRange(text.startIndex..<text.endIndex, in: text)
    for p in patterns {
      // A pattern the server sends that ICU cannot compile is skipped, never fatal.
      guard let re = try? NSRegularExpression(pattern: p, options: [.caseInsensitive]) else { continue }
      if re.firstMatch(in: text, options: [], range: range) != nil { return true }
    }
    return false
  }

  /// D10-3: an Egyptian personal mobile number (spaces removed) is a person, not a bank or wallet.
  public static func isPersonalSender(_ sender: String?) -> Bool {
    guard let sender = sender else { return false }
    let s = lite(sender).replacingOccurrences(of: " ", with: "")
    if s.isEmpty { return false }
    return s.range(of: PERSONAL_SENDER, options: [.regularExpression]) != nil
  }

  /// The whole gate: forward only a candidate that is neither an OTP nor from a personal number.
  public static func shouldForward(title: String?, subtitle: String?, body: String, sender: String?,
                                   keywords: [String] = DEFAULT_KEYWORDS,
                                   patterns: [String] = DEFAULT_OTP_PATTERNS) -> Bool {
    if isPersonalSender(sender) { return false }
    if isOtp(title: title, subtitle: subtitle, body: body, patterns: patterns) { return false }
    return isCandidate(title: title, subtitle: subtitle, body: body, keywords: keywords)
  }
}

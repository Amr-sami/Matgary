// Behaviour harness for IngestCore / IngestQueue / IngestUploader with a fake transport, a fake
// credential store and a temp folder (doc 15 spec 10 §4.10 steps 1–7, heartbeat, config cache).
// Not part of the pod (outside `ios/`). The Keychain itself is device-only (IngestKeychain is
// exercised by the M3 device tests T2/T9); everything else runs on this Mac:
//
//   cd apps/mobile/modules/collections-ingest && M=ios && xcrun swiftc -O $M/IngestFingerprint.swift \
//     $M/IngestFilter.swift $M/IngestKeychain.swift $M/IngestQueue.swift $M/IngestUploader.swift \
//     $M/IngestCore.swift ios-tests/core/main.swift -o "$TMPDIR/ingest-core-check" && "$TMPDIR/ingest-core-check"
//
// → "OK core <n> checks", exit 0.

import Foundation

final class Box<T>: @unchecked Sendable {
  private let lock = NSLock()
  private var v: T
  init(_ v: T) { self.v = v }
  var value: T {
    get { lock.lock(); defer { lock.unlock() }; return v }
    set { lock.lock(); v = newValue; lock.unlock() }
  }
  func mutate(_ f: (inout T) -> Void) { lock.lock(); f(&v); lock.unlock() }
}

final class FakeStore: IngestCredentialStore, @unchecked Sendable {
  let cred = Box<IngestCredentialValue?>(nil)
  let locked = Box(false)
  func load() -> CredentialLoad {
    if locked.value { return .locked }
    return cred.value.map { .found($0) } ?? .missing
  }
  func save(_ value: IngestCredentialValue) -> Bool { cred.value = value; return true }
  func delete() -> Bool { cred.value = nil; return true }
}

struct Reply { var status: Int; var body: String; var headers: [String: String] = [:] }
enum Net: Error { case down }

final class FakeTransport: IngestTransport, @unchecked Sendable {
  let requests = Box<[URLRequest]>([])
  /// nil reply = network failure. Default: answer every fp `accepted`.
  let handler = Box<(@Sendable (URLRequest) -> Reply?)>({ FakeTransport.acceptAll($0) })

  static func acceptAll(_ r: URLRequest) -> Reply? {
    if r.url?.path.hasSuffix("/heartbeat") == true { return Reply(status: 200, body: #"{"configVersion":"cv1"}"#) }
    if r.url?.path.hasSuffix("/config") == true {
      return Reply(status: 200, body: #"{"configVersion":"cv1","filterVersion":"x","packages":[],"senders":[],"keywords":{"ar":["استلام","إضافة","تحويل لحظي"],"en":["XYZPAID"]},"otpPatterns":["otp"],"maxAgeHours":48}"#)
    }
    let fps = messages(r).map { "{\"fp\":\"\($0["fp"] as! String)\",\"status\":\"accepted\"}" }
    return Reply(status: 200, body: "{\"results\":[\(fps.joined(separator: ","))]}")
  }

  static func messages(_ r: URLRequest) -> [[String: Any]] {
    guard let b = r.httpBody, let o = try? JSONSerialization.jsonObject(with: b) as? [String: Any] else { return [] }
    return o["messages"] as? [[String: Any]] ?? []
  }

  func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
    requests.mutate { $0.append(request) }
    guard let reply = handler.value(request) else { throw Net.down }
    let http = HTTPURLResponse(url: request.url!, statusCode: reply.status, httpVersion: "HTTP/1.1", headerFields: reply.headers)!
    return (Data(reply.body.utf8), http)
  }

  var posts: [URLRequest] { requests.value.filter { $0.httpMethod == "POST" && $0.url?.path.hasSuffix("/ingest") == true } }
}

var failures: [String] = []
var checks = 0
func check(_ ok: Bool, _ label: String) {
  checks += 1
  if !ok { failures.append(label) }
}

let TOKEN = "mgi_" + String(repeating: "Ab3_-", count: 8) + "xyz" // 4 + 43
let URL_OK = "https://thestoro.test/api/v1/collections/ingest"
let NBE = "تم إضافة تحويل لحظي لحسابكم رقم 0150 بمبلغ 5000.00 جم من AHMED MOHAMED ABDELRAHMAN رقم مرجعي 125073164743 يوم 05-04 الساعة 12:25 للمزيد اتصل بـ 19623"
let VF = "تم استلام مبلغ 2700.00 جنيه من رقم 01127777705 المسجل بإسم محمد احمد علي"
let T0 = Date(timeIntervalSince1970: 1_790_000_000) // 2026-09-21T14:13:20Z

struct Rig {
  let core: IngestCore
  let store: FakeStore
  let net: FakeTransport
  let clock: Box<Date>
  let root: URL
}

func rig(linked: Bool = true) async -> Rig {
  let root = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("ingest-core-\(UUID().uuidString)")
  let store = FakeStore()
  let net = FakeTransport()
  let clock = Box(T0)
  let core = IngestCore(store: store, storage: IngestStorage(root: root), transport: net,
                        now: { clock.value }, timeZone: TimeZone(identifier: "Africa/Cairo")!, allowHttp: false)
  if linked { _ = await core.setCredential(url: URL_OK, token: TOKEN) }
  return Rig(core: core, store: store, net: net, clock: clock, root: root)
}

// 1. credential rules
do {
  let r = await rig(linked: false)
  check(await r.core.setCredential(url: URL_OK, token: "mgi_short") == false, "bad token refused")
  check(await r.core.setCredential(url: "http://thestoro.test/api/v1/collections/ingest", token: TOKEN) == false, "http refused in release mode")
  check(await r.core.hasCredential() == false, "nothing stored")
  check(await r.core.forward(IngestInput(text: NBE, sender: "AHLY", receivedAt: T0)) == .notLinked, "not linked")
  check(r.net.requests.value.isEmpty, "no network when not linked")
  check(await r.core.status().queued == 0, "nothing queued when not linked")
  check(await r.core.setCredential(url: URL_OK, token: TOKEN), "good credential stored")
  check(await r.core.hasCredential(), "hasCredential")
  r.store.locked.value = true
  check(await r.core.forward(IngestInput(text: NBE, sender: "AHLY", receivedAt: T0)) == .notLinked, "locked keychain → notLinked")
  check(await r.core.status().lastError == "KEYCHAIN_LOCKED", "locked recorded as a code")
}

// 2. the filter gates before anything else
do {
  let r = await rig()
  check(await r.core.forward(IngestInput(text: "Your OTP is 482910. Do not share this code.", sender: "CIB")) == .skipped, "OTP skipped")
  check(await r.core.forward(IngestInput(text: VF, sender: "01012345678")) == .skipped, "personal sender skipped")
  check(await r.core.forward(IngestInput(text: "أراك غدا", sender: "AHLY")) == .skipped, "no money word skipped")
  let q2 = await r.core.status().queued
  check(r.net.requests.value.isEmpty && q2 == 0, "skips touch neither disk nor network")
}

// 3. happy path: the §4.4 wire shape
do {
  let r = await rig()
  let out = await r.core.forward(IngestInput(text: NBE, sender: "AHLY", source: "sms", receivedAt: T0))
  check(out == .sent, "sent (got \(out))")
  check(r.net.posts.count == 1, "one POST")
  if let req = r.net.posts.first, let m = FakeTransport.messages(req).first {
    check(req.url?.absoluteString == URL_OK, "posts to the ingest URL")
    check(req.value(forHTTPHeaderField: "Authorization") == "Bearer \(TOKEN)", "bearer header")
    let o = try! JSONSerialization.jsonObject(with: req.httpBody!) as! [String: Any]
    check(o["v"] as? Int == 1, "v 1")
    check(m["channel"] as? String == "ios_sms", "channel ios_sms")
    check(m["sender"] as? String == "AHLY", "sender")
    check(m["sourceApp"] == nil && m["title"] == nil && m["subtitle"] == nil, "absent fields omitted")
    check(m["test"] as? Bool == false, "test false")
    check(m["receivedAt"] as? String == "2026-09-21T14:13:20Z", "receivedAt UTC Z (got \(m["receivedAt"] ?? "nil"))")
    // Cairo is UTC+3 on 2026-09-21 (summer time): minute 17:13 local.
    let fp = IngestFingerprint.fingerprint(channel: "ios_sms", sender: "AHLY", body: NBE, minute: "2026-09-21T17:13")
    check(m["fp"] as? String == fp, "fp = sha256(ios_sms|AHLY|body|local minute)")
  } else {
    check(false, "no message posted")
  }
  let s = await r.core.status()
  check(s.queued == 0 && s.lastUploadAt == "2026-09-21T14:13:20Z" && s.lastError == nil, "status after send")
  check(s.configVersion == "cv1", "config fetched after the first good drain")
  // A notification
  _ = await r.core.forward(IngestInput(text: NBE, title: "InstaPay", source: "ios.unknown", receivedAt: T0))
  if let m = r.net.posts.last.flatMap({ FakeTransport.messages($0).first }) {
    check(m["channel"] as? String == "ios_notification" && m["sourceApp"] as? String == "ios.unknown"
          && m["sender"] == nil && m["title"] as? String == "InstaPay", "notification shape")
  } else { check(false, "notification not posted") }
}

// 4. offline: enqueue, then three in receive order, one POST, no duplicates
do {
  let r = await rig()
  r.net.handler.value = { _ in nil }
  for i in 0..<3 {
    let out = await r.core.forward(IngestInput(text: VF + " #\(i)", sender: "vf-cash", receivedAt: T0.addingTimeInterval(Double(i * 60))))
    check(out == .queued, "offline \(i) → queued")
  }
  check(await r.core.status().queued == 3, "3 on disk")
  check(await r.core.status().lastError?.hasPrefix("NETWORK") == true, "network code recorded")
  r.net.requests.value = []
  r.net.handler.value = { FakeTransport.acceptAll($0) }
  await r.core.drain()
  check(r.net.posts.count == 1, "one batch POST")
  let bodies = r.net.posts.first.map(FakeTransport.messages)?.compactMap { $0["body"] as? String } ?? []
  check(bodies == [VF + " #0", VF + " #1", VF + " #2"], "receive order")
  check(await r.core.status().queued == 0, "queue drained")
}

// 5. 400 → one by one, only the offender dropped
do {
  let r = await rig()
  r.net.handler.value = { _ in nil }
  _ = await r.core.forward(IngestInput(text: VF + " good", sender: "vf-cash", receivedAt: T0))
  _ = await r.core.forward(IngestInput(text: VF + " poison", sender: "vf-cash", receivedAt: T0.addingTimeInterval(1)))
  r.net.requests.value = []
  r.net.handler.value = { req in
    let ms = FakeTransport.messages(req)
    if ms.contains(where: { ($0["body"] as? String)?.hasSuffix("poison") == true }) {
      return Reply(status: 400, body: #"{"error":"INVALID_REQUEST"}"#)
    }
    return FakeTransport.acceptAll(req)
  }
  await r.core.drain()
  check(r.net.posts.count == 3, "batch + 2 singles (got \(r.net.posts.count))")
  check(await r.core.status().queued == 0, "good delivered, poison dropped")
}

// 6. 403 keeps; 429 keeps and honours Retry-After; 5xx keeps
do {
  let r = await rig()
  r.net.handler.value = { _ in Reply(status: 403, body: #"{"error":"INGEST_DISABLED"}"#) }
  check(await r.core.forward(IngestInput(text: NBE, sender: "AHLY", receivedAt: T0)) == .queued, "403 → queued")
  check(await r.core.status().lastError == "INGEST_DISABLED", "403 code")
  r.net.handler.value = { _ in Reply(status: 429, body: "{}", headers: ["Retry-After": "120"]) }
  await r.core.drain()
  let before = r.net.posts.count
  _ = await r.core.forward(IngestInput(text: VF, sender: "vf-cash", receivedAt: T0))
  check(r.net.posts.count == before, "inside Retry-After: no POST")
  check(await r.core.status().queued == 2, "both kept")
  r.clock.value = T0.addingTimeInterval(121)
  r.net.handler.value = { _ in Reply(status: 503, body: "") }
  await r.core.drain()
  let e6 = await r.core.status().lastError
  check(r.net.posts.count == before + 1 && e6 == "HTTP_503", "after Retry-After: retried, 5xx kept (\(r.net.posts.count - before), \(e6 ?? "nil"))")
  check(await r.core.status().queued == 2, "5xx kept")
}

// 7. 401 → credential, queue and config cleared
do {
  let r = await rig()
  _ = await r.core.forward(IngestInput(text: NBE, sender: "AHLY", receivedAt: T0)) // config cached
  r.net.handler.value = { _ in nil }
  _ = await r.core.forward(IngestInput(text: VF, sender: "vf-cash", receivedAt: T0))
  r.net.handler.value = { _ in Reply(status: 401, body: #"{"error":"INGEST_DEVICE_REVOKED"}"#) }
  let out = await r.core.forward(IngestInput(text: VF + " 2", sender: "vf-cash", receivedAt: T0))
  check(out == .notLinked, "revoked → notLinked (got \(out))")
  let s = await r.core.status()
  check(!s.hasCredential && s.queued == 0 && s.configVersion == nil, "credential, queue, config gone")
  check(s.lastError == "INGEST_DEVICE_REVOKED", "revocation code")
}

// 8. the test marker
do {
  let r = await rig()
  check(await r.core.forward(IngestInput(text: "  THESTORO-SETUP-TEST ")) == .test, "test sent")
  if let m = r.net.posts.last.flatMap({ FakeTransport.messages($0).first }) {
    check(m["test"] as? Bool == true && m["channel"] as? String == "ios_sms" && m["sender"] as? String == "TheStoro"
          && m["body"] as? String == "THESTORO-SETUP-TEST تم استلام مبلغ 1.00 جنيه"
          && (m["fp"] as? String)?.count == 64, "test shape (D10-8)")
  } else { check(false, "test not posted") }
  r.net.handler.value = { _ in nil }
  check(await r.core.forward(IngestInput(text: "THESTORO-SETUP-TEST")) == .testFailed, "offline test → testFailed")
  check(await r.core.status().queued == 0, "a failed test is never delivered later")
  let lone = await rig(linked: false)
  check(await lone.core.forward(IngestInput(text: "THESTORO-SETUP-TEST")) == .testFailed, "unlinked test → testFailed")
}

// 9. heartbeat ≤ 1 per 6 h; a new configVersion refetches; the server's keywords are used
do {
  let r = await rig()
  await r.core.heartbeatIfDue(appVersion: "1.1.0", osVersion: "26.3.0")
  let beats = r.net.requests.value.filter { $0.url?.path.hasSuffix("/heartbeat") == true }
  check(beats.count == 1, "one heartbeat")
  if let b = beats.first?.httpBody, let o = try? JSONSerialization.jsonObject(with: b) as? [String: Any] {
    check(o["platform"] as? String == "ios_app_intent" && o["v"] as? Int == 1 && o["queued"] as? Int == 0
          && o["appVersion"] as? String == "1.1.0", "heartbeat body")
  } else { check(false, "heartbeat body unreadable") }
  check(r.net.requests.value.contains { $0.url?.path.hasSuffix("/config") == true }, "new configVersion → GET /config")
  await r.core.heartbeatIfDue()
  check(r.net.requests.value.filter { $0.url?.path.hasSuffix("/heartbeat") == true }.count == 1, "not again within 6 h")
  r.clock.value = T0.addingTimeInterval(6 * 3600 + 1)
  await r.core.heartbeatIfDue()
  check(r.net.requests.value.filter { $0.url?.path.hasSuffix("/heartbeat") == true }.count == 2, "again after 6 h")
  // server keyword "XYZPAID" (cached ≤ 24 h) makes an English message a candidate
  r.clock.value = T0.addingTimeInterval(7 * 3600)
  check(await r.core.forward(IngestInput(text: "XYZPAID 50", sender: "BANK", receivedAt: r.clock.value)) == .sent, "server keyword used")
  r.clock.value = T0.addingTimeInterval(31 * 3600)
  r.net.handler.value = { _ in nil }
  check(await r.core.forward(IngestInput(text: "XYZPAID 50 again", sender: "BANK", receivedAt: r.clock.value)) == .skipped,
        "config older than 24 h → defaults (no XYZPAID)")
}

// 10. queue: 47 h age limit, 200 cap
do {
  let root = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("ingest-q-\(UUID().uuidString)")
  let q = IngestQueue(storage: IngestStorage(root: root))
  let msg = { (i: Int) in IngestMessage(fp: String(format: "%064d", i), channel: "ios_sms", sourceApp: nil, sender: nil,
                                        title: nil, subtitle: nil, body: "b\(i)", receivedAt: "x", test: false) }
  let nowMs = Int64(T0.timeIntervalSince1970 * 1000)
  q.enqueue(msg(1), receivedAtMs: nowMs - 48 * 3600 * 1000, now: T0)
  check(q.count(now: T0) == 0, "older than 47 h dropped")
  for i in 0..<205 { q.enqueue(msg(1000 + i), receivedAtMs: nowMs - Int64(205 - i), now: T0) }
  let l = q.list(now: T0)
  check(l.count == 200 && l.first?.message.body == "b1005" && l.last?.message.body == "b1204", "cap 200, oldest dropped")
  try? FileManager.default.removeItem(at: root)
}

// 11. burst: 20 concurrent forwards, all delivered once
do {
  let r = await rig()
  await withTaskGroup(of: IngestOutcome.self) { g in
    for i in 0..<20 {
      g.addTask { await r.core.forward(IngestInput(text: VF + " burst \(i)", sender: "vf-cash", receivedAt: T0.addingTimeInterval(Double(i)))) }
    }
    var sent = 0
    for await o in g where o == .sent { sent += 1 }
    check(sent == 20, "20/20 sent (got \(sent))")
  }
  let delivered = r.net.posts.flatMap(FakeTransport.messages).compactMap { $0["body"] as? String }
  check(delivered.count == 20 && Set(delivered).count == 20, "no duplicate POSTs (\(delivered.count))")
  check(await r.core.status().queued == 0, "burst queue 0")
}

if failures.isEmpty {
  print("OK core \(checks) checks")
  exit(0)
}
for f in failures { print("FAIL \(f)") }
exit(1)

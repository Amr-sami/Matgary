// swiftc harness for the pure half of the CollectionsIngest module (doc 15 spec 10 §7.2; test plan
// §B.1 step 1f). Outside `ios/`, so the pod never compiles it. Run:
//
//   cd apps/mobile/modules/collections-ingest && xcrun swiftc -O ios/IngestFingerprint.swift \
//     ios/IngestFilter.swift ios-tests/main.swift -o "$TMPDIR/ingest-check" && "$TMPDIR/ingest-check"
//
// → "OK 2 vectors, 15 filter cases", exit 0. Any failure prints FAIL lines and exits 1.

import Foundation

var failures: [String] = []
func check(_ ok: Bool, _ label: String) {
  if !ok { failures.append(label) }
}

// ---- fingerprint (2 vectors, 06 §4.12 + spec 10 §4.4) ----
let utc = TimeZone(identifier: "UTC")!
let m = IngestFingerprint.minute(Date(timeIntervalSince1970: 1_790_000_000), utc)
check(m == "2026-09-21T14:13", "minute(1790000000, UTC) = \(m)")

let vectors: [(channel: String, sender: String, body: String, minute: String, hex: String)] = [
  ("ios_sms", "AHLY", "تم إضافة تحويل لحظي", "2026-09-27T12:03",
   "b06dfa4e509f0886e843e8bf9e30b391c04c7f962b1fb670a56b8dbcbe7fcad1"),
  ("ios_notification", "", "Test", m,
   "7237cbb161167c5da913b830b462e39bd4c22f836e3da9505d1908aeed39d5ab"),
]
for v in vectors {
  let got = IngestFingerprint.fingerprint(channel: v.channel, sender: v.sender, body: v.body, minute: v.minute)
  check(got == v.hex, "fingerprint \(v.channel)|\(v.sender)|…|\(v.minute) = \(got)")
}
let t1 = IngestFingerprint.testFingerprint(), t2 = IngestFingerprint.testFingerprint()
check(t1.count == 64 && t1 != t2 && t1.allSatisfy { "0123456789abcdef".contains($0) }, "test fingerprint shape/uniqueness")

// ---- filter (15 cases, §7.2) ----
// Published samples (06 __fixtures__/samples.ts, with its fills): candidates, not OTP.
let credits: [(String, String)] = [
  ("VF-1", "تم استلام مبلغ 2700.00 جنيه من رقم 01127777705 المسجل بإسم محمد احمد علي على رقم محفظتك  01007777765.\nرصيدك الحالي: 2724.51 جنيه\nتاريخ العملية: 17:36 26-07-27\nرقم العملية: 022177777777\nتابع كل مصروفاتك من تاريخ المعاملات على أبلكيشن أنا فودافون http://vf.eg/vfcash"),
  ("EM-1", "تم إستلام مبلغ 200.00 ج.م من رقم 01067777746 المسجل باسممحمد احمد علي بنجاح. رصيد محفظتك الحالى 429.90 ج.م.استخدم e& money هتكسب و العب هتكسب هدايا تانية كتير http://spr.ly/Spin_The_Wheel وكمان تقدر تستمتع بخصم %30على وجبة كومبو من Buffalo Burger ب 160 جنيه بدل225 لما تدفع ب http://spr.ly/BuffaloBurger2 e& money"),
  ("IP-NBE-1", "تم إضافة تحويل لحظي لحسابكم رقم 0150 بمبلغ 5000.00 جم من AHMED MOHAMED ABDELRAHMAN رقم مرجعي 125073164743 يوم 05-04 الساعة 12:25 للمزيد اتصل بـ 19623"),
  ("IP-CIB-1", "يرجى العلم انه تم تنفيذ تحويل لحظي بمبلغ 64500.00 جم إلى حسابك المنتهي بـ ********0018 من AHMED MOHAMED ABDELRAHM برقم مرجعي 9951576c بتاريخ 15-06-2025 22:49 للمزيد، برجاء الاتصال بـ 19666"),
  ("IP-QNB-1", "IPN transfer received with amount of EGP 500.00 on 5597 on 06/05 at 08:34 PM. Ref# ff961e35. For more details call 19700."),
  ("IP-BDC-1", "تم إستقبال تحويل لحظي إلى حسابكم 4113 بمبلغ 350.00 جم من MOHAMED AHMED ABDELRAHMAN SAID في 07:32 يوم 9/18/26 رقم المعاملة 43f3ef2a للمزيد أتصل ب 16990"),
]
var cases = 0
for (id, body) in credits {
  cases += 1
  check(IngestFilter.isCandidate(title: nil, subtitle: nil, body: body), "\(id) is a candidate")
  check(!IngestFilter.isOtp(title: nil, subtitle: nil, body: body), "\(id) is not OTP")
}
for otp in ["Your OTP is 482910. Do not share this code.", "كود التحقق 1234"] {
  cases += 1
  check(IngestFilter.isOtp(title: nil, subtitle: nil, body: otp), "OTP: \(otp)")
}
for p in ["+20 101 234 5678", "01012345678", "00201012345678"] {
  cases += 1
  check(IngestFilter.isPersonalSender(p), "personal sender: \(p)")
}
for s in ["AHLY", "vf-cash", "1234", "QNB EGYPT"] {
  cases += 1
  check(!IngestFilter.isPersonalSender(s), "not a personal sender: \(s)")
}

// Extra guards (not counted in the 15): the D10-8 test body is a candidate; a stretched (tatweel)
// OTP is still an OTP; the whole gate drops a candidate from a personal number.
check(IngestFilter.isCandidate(title: nil, subtitle: nil, body: "THESTORO-SETUP-TEST تم استلام مبلغ 1.00 جنيه"), "D10-8 body")
check(IngestFilter.isOtp(title: nil, subtitle: nil, body: "رمـز التحقق ٤٨٢٩"), "tatweel OTP")
check(!IngestFilter.shouldForward(title: nil, subtitle: nil, body: credits[0].1, sender: "01012345678"), "personal sender gate")
check(IngestFilter.shouldForward(title: nil, subtitle: nil, body: credits[0].1, sender: "vf-cash"), "VF-1 from vf-cash forwards")
check(!IngestFilter.shouldForward(title: nil, subtitle: nil, body: "مرحبا، أراك غدا", sender: "AHLY"), "no money word")

if failures.isEmpty && cases == 15 {
  print("OK \(vectors.count) vectors, \(cases) filter cases")
  exit(0)
}
for f in failures { print("FAIL \(f)") }
if cases != 15 { print("FAIL expected 15 filter cases, ran \(cases)") }
exit(1)

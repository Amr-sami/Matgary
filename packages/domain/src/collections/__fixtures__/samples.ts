// Digital collections — the message corpus (spec 06 §4.14). Read
// __fixtures__/README.md first: NEVER invent a message format. Only
// `published` samples (with a source URL) and `pilot` samples (redacted
// through spec 15's export script) may back a template; `illustrative`
// samples are negatives only.
//
// `published` is VERBATIM from the research notes (_research/wallets.md §5.1,
// _research/instapay.md §4.3, _research/ios.md "Published message examples"):
// the research masks are kept, research annotations such as "(12 digits)" are
// dropped. `fills` replace each research mask with a FIXED synthetic value
// (phone / reference masks: x → 7; names: the synthetic names below), so no
// third-party personal data is ever copied. The bank's own masks are kept as
// published (CIB "********0018", IP-UNK-1 "xxx6201").
//
// Expected results come from 06 §4.14 (verified against the 2026-09-27
// prototype). `receivedAt` is synthetic: one minute after the message time
// when the text carries one, otherwise a time consistent with the sample date.

import type { CreditDirection, IngestChannel, ParseStatus } from "../types";

export interface SampleFixture {
  /** Research id, e.g. "VF-1", "IP-NBE-2a"; pilot ids "PILOT-<provider>-<n>". */
  id: string;
  /** illustrative = never a template sample. */
  kind: "published" | "pilot" | "illustrative";
  /** Research tag, e.g. "TAHWEEL-S". */
  source: string;
  sourceUrl: string;
  /** e.g. "wallets.md §5.1". */
  researchRef: string;
  channel: IngestChannel;
  sender: string | null;
  sourceApp: string | null;
  /** Verbatim as in the research note (masks included, annotations removed). */
  published: string;
  /** Exact replacements, applied in order. */
  fills: ReadonlyArray<readonly [placeholder: string, replacement: string]>;
  /** = applyFills(published, fills), computed at module load. */
  text: string;
  /** Synthetic, consistent with the sample date. */
  receivedAt: string;
  expect: {
    status: ParseStatus;
    templateId: string | null;
    direction?: CreditDirection;
    amount?: string;
    balanceAfter?: string | null;
    reference?: string | null;
    receivingHint?: string | null;
    payerPhone?: string | null;
    payerNameMasked?: string | null;
    occurredAt?: string;
  };
  pilot?: { phoneId: string; observedSender: string | null; observedPackage: string | null; capturedAt: string };
}

/**
 * Replaces every occurrence of each placeholder, in order. Throws when a
 * placeholder is absent (a fill that no longer matches its text is a bug).
 */
export function applyFills(published: string, fills: SampleFixture["fills"]): string {
  let out = published;
  for (const [placeholder, replacement] of fills) {
    if (placeholder === "" || out.indexOf(placeholder) === -1) {
      throw new Error(`applyFills: placeholder ${JSON.stringify(placeholder)} is absent`);
    }
    out = out.split(placeholder).join(replacement);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Synthetic fill values (06 §4.14 "Masking")
// ---------------------------------------------------------------------------

/** `<NAME>` (wallet samples). */
export const FILL_NAME_AR = "محمد احمد علي";
/** The 25-character Latin name (IP-NBE-1). */
export const FILL_NAME_LATIN_25 = "AHMED MOHAMED ABDELRAHMAN";
/** The "38-character" Latin name (IP-NBE-2a). */
export const FILL_NAME_LATIN_38 = "MOHAMED AHMED ABDELRAHMAN MAHMOUD SAYED";
/** The Arabic 6-word name (IP-NBE-2b). */
export const FILL_NAME_AR_6 = "محمد احمد عبد الرحمن محمود علي";
/** The CIB 23-character name (IP-CIB-1). */
export const FILL_NAME_LATIN_23 = "AHMED MOHAMED ABDELRAHM";
/** The BDC 30-character name (IP-BDC-1). */
export const FILL_NAME_LATIN_30 = "MOHAMED AHMED ABDELRAHMAN SAID";
/** IP-NBE-3's receiver, already masked by the bank. */
export const FILL_RECEIVER_MASKED = "ABDELAZEEZ M****";

// ---------------------------------------------------------------------------
// Sources (full table in README.md)
// ---------------------------------------------------------------------------

const TAHWEEL_S = "https://github.com/ashrafeldawody/Tahweel/tree/main/packages/server/src/parsers";
const DABBARHA = "https://github.com/ziadismael/dabbarha";
const SPENDWISE = "https://github.com/yshams-03/spendwise";
const MATTIYA = "https://github.com/Muhammadattiya/Expenses-Tracking-PWA";
const ZEN = "https://github.com/zenmoney/sms-formats/tree/master/src/CIB-eg_15670";
const FINFAST = "https://github.com/CyberDemon73/FinFast";
const ESLAM = "https://github.com/eslammohamedr/WalletTracker";
const ZYNK = "https://zynkapp.dev";

type Draft = Omit<SampleFixture, "text">;

const DRAFTS: readonly Draft[] = [
  // ---------------------------------------------------------------- wallets
  {
    id: "VF-1",
    kind: "published",
    source: "TAHWEEL-S",
    sourceUrl: TAHWEEL_S,
    researchRef: "wallets.md §5.1",
    channel: "android_sms",
    sender: "vf-cash",
    sourceApp: null,
    published:
      "تم استلام مبلغ 2700.00 جنيه من رقم 0112xxxxx05 المسجل بإسم <NAME> على رقم محفظتك  0100xxxxx65.\n" +
      "رصيدك الحالي: 2724.51 جنيه\n" +
      "تاريخ العملية: 17:36 26-07-27\n" +
      "رقم العملية: 0221xxxxxxxx\n" +
      "تابع كل مصروفاتك من تاريخ المعاملات على أبلكيشن أنا فودافون http://vf.eg/vfcash",
    fills: [
      ["0112xxxxx05", "01127777705"],
      ["<NAME>", FILL_NAME_AR],
      ["0100xxxxx65", "01007777765"],
      ["0221xxxxxxxx", "022177777777"],
    ],
    receivedAt: "2026-07-27T14:37:00.000Z",
    expect: {
      status: "parsed",
      templateId: "vodafone_cash.sms.credit.v1",
      direction: "credit",
      amount: "2700.00",
      balanceAfter: "2724.51",
      reference: "022177777777",
      receivingHint: "7765",
      payerPhone: "01127777705",
      payerNameMasked: "محمد ا****",
      occurredAt: "2026-07-27T14:36:00.000Z",
    },
  },
  {
    id: "VF-2",
    kind: "published",
    source: "TAHWEEL-S",
    sourceUrl: TAHWEEL_S,
    researchRef: "wallets.md §5.1",
    channel: "android_sms",
    sender: null,
    sourceApp: null,
    published: "تم تحويل مبلغ 500.00 جنيه الى رقم 0106xxxxx46 بنجاح. رصيدك الحالي: 10.00 جنيه",
    fills: [["0106xxxxx46", "01067777746"]],
    receivedAt: "2026-09-24T10:00:00.000Z",
    expect: {
      status: "parsed",
      templateId: "vodafone_cash.sms.debit.v1",
      direction: "debit",
      amount: "500.00",
      balanceAfter: "10.00",
      reference: null,
      receivingHint: null,
      payerPhone: null,
      payerNameMasked: null,
      occurredAt: "2026-09-24T10:00:00.000Z",
    },
  },
  {
    id: "EM-1",
    kind: "published",
    source: "TAHWEEL-S",
    sourceUrl: TAHWEEL_S,
    researchRef: "wallets.md §5.1",
    channel: "android_sms",
    sender: "e& money",
    sourceApp: null,
    published:
      "تم إستلام مبلغ 200.00 ج.م من رقم 0106xxxxx46 المسجل باسم<NAME> بنجاح. رصيد محفظتك الحالى 429.90 ج.م.استخدم e& money هتكسب و العب هتكسب هدايا تانية كتير http://spr.ly/Spin_The_Wheel وكمان تقدر تستمتع بخصم %30على وجبة كومبو من Buffalo Burger ب 160 جنيه بدل225 لما تدفع ب http://spr.ly/BuffaloBurger2 e& money",
    fills: [
      ["0106xxxxx46", "01067777746"],
      ["<NAME>", FILL_NAME_AR],
    ],
    receivedAt: "2026-09-24T10:05:00.000Z",
    expect: {
      status: "parsed",
      templateId: "etisalat_money.sms.credit.v1",
      direction: "credit",
      amount: "200.00",
      balanceAfter: "429.90",
      reference: null,
      receivingHint: null,
      payerPhone: "01067777746",
      payerNameMasked: "محمد ا****",
      occurredAt: "2026-09-24T10:05:00.000Z",
    },
  },
  {
    id: "EM-2",
    kind: "published",
    source: "TAHWEEL-S",
    sourceUrl: TAHWEEL_S,
    researchRef: "wallets.md §5.1",
    channel: "android_sms",
    sender: null,
    sourceApp: null,
    published:
      "تم إيداع مبلغ 1.00  في حسابك بنجاح من رقم حساب 00201000xxxxx المسجل باسم <NAME>\n" +
      " استخدم e& money هتكسب و العب هتكسب هدايا تانية كتير http://spr.ly/Spin_The_Wheel",
    fills: [
      ["00201000xxxxx", "0020100077777"],
      ["<NAME>", FILL_NAME_AR],
    ],
    receivedAt: "2026-09-24T10:10:00.000Z",
    expect: {
      status: "parsed",
      templateId: "etisalat_money.sms.deposit.v1",
      direction: "credit",
      amount: "1.00",
      balanceAfter: null,
      reference: null,
      receivingHint: null,
      payerPhone: null,
      payerNameMasked: "محمد ا****",
      occurredAt: "2026-09-24T10:10:00.000Z",
    },
  },
  {
    id: "OC-1",
    kind: "published",
    source: "TAHWEEL-S",
    sourceUrl: TAHWEEL_S,
    researchRef: "wallets.md §5.1",
    channel: "android_sms",
    sender: "Orange Cash",
    sourceApp: null,
    published:
      "تم إستلام عملية تحويل أموال بمبلغ 150.00 جنيه من <NAME>، رصيدك الحالي 366.22 جنيه. رقم المعاملة 19082xxxxx\n" +
      "100 جنيه كاش باك لما تحول، تدفع او تودع فلوس في محفظة اورنچ كاش",
    fills: [
      ["<NAME>", FILL_NAME_AR],
      ["19082xxxxx", "1908277777"],
    ],
    receivedAt: "2026-09-24T10:15:00.000Z",
    expect: {
      status: "parsed",
      templateId: "orange_cash.sms.credit.v2",
      direction: "credit",
      amount: "150.00",
      balanceAfter: "366.22",
      reference: "1908277777",
      receivingHint: null,
      payerPhone: null,
      payerNameMasked: "محمد ا****",
      occurredAt: "2026-09-24T10:15:00.000Z",
    },
  },
  {
    id: "OC-2",
    kind: "published",
    source: "TAHWEEL-S",
    sourceUrl: TAHWEEL_S,
    researchRef: "wallets.md §5.1",
    channel: "android_sms",
    sender: "OrangeCash",
    sourceApp: null,
    published:
      "تم إستلام عملية تحويل اموال بمبلغ ٢٠٠٠.٠٠ جنيه من <NAME> ، رقم المعاملة ٢٠٥٢٧xxxxx\n" +
      "كاش باك أو دقائق أو ميجابايتس كل ما تستعلم ...",
    fills: [
      ["<NAME>", FILL_NAME_AR],
      ["٢٠٥٢٧xxxxx", "٢٠٥٢٧٧٧٧٧٧"],
    ],
    receivedAt: "2026-09-24T10:20:00.000Z",
    expect: {
      status: "parsed",
      templateId: "orange_cash.sms.credit.v1",
      direction: "credit",
      amount: "2000.00",
      balanceAfter: null,
      reference: "2052777777",
      receivingHint: null,
      payerPhone: null,
      payerNameMasked: "محمد ا****",
      occurredAt: "2026-09-24T10:20:00.000Z",
    },
  },
  {
    id: "OC-3",
    kind: "published",
    source: "TAHWEEL-S",
    sourceUrl: TAHWEEL_S,
    researchRef: "wallets.md §5.1",
    channel: "android_sms",
    sender: "اورنج كاش",
    sourceApp: null,
    published:
      "Successful cash-in with amount EGP 6.43.\n" +
      "Your current balance is EGP 6.43\n" +
      "… Dial #71# to join the gold Competition … https://myo.orange.eg/OC-IN",
    fills: [],
    receivedAt: "2026-09-24T10:25:00.000Z",
    expect: {
      status: "parsed",
      templateId: "orange_cash.sms.cash_in.v1",
      direction: "cash_in",
      amount: "6.43",
      balanceAfter: "6.43",
      reference: null,
      receivingHint: null,
      payerPhone: null,
      payerNameMasked: null,
      occurredAt: "2026-09-24T10:25:00.000Z",
    },
  },

  // ------------------------------------------------------- InstaPay banks
  {
    id: "IP-NBE-1",
    kind: "published",
    source: "DABBARHA",
    sourceUrl: DABBARHA,
    researchRef: "instapay.md §4.3",
    channel: "android_sms",
    sender: "AHLY",
    sourceApp: null,
    published:
      "تم إضافة تحويل لحظي لحسابكم رقم 0150 بمبلغ 5000.00 جم من <SENDER NAME, Latin caps, cut: 25 chars> رقم مرجعي 125073164743 يوم 05-04 الساعة 12:25 للمزيد اتصل بـ 19623",
    fills: [["<SENDER NAME, Latin caps, cut: 25 chars>", FILL_NAME_LATIN_25]],
    receivedAt: "2026-05-04T09:26:00.000Z",
    expect: {
      status: "parsed",
      templateId: "nbe.sms.credit.v1",
      direction: "credit",
      amount: "5000.00",
      balanceAfter: null,
      reference: "125073164743",
      receivingHint: "0150",
      payerPhone: null,
      payerNameMasked: "AHMED M****",
      occurredAt: "2026-05-04T09:25:00.000Z",
    },
  },
  {
    id: "IP-NBE-2a",
    kind: "published",
    source: "SPENDWISE",
    sourceUrl: SPENDWISE,
    researchRef: "instapay.md §4.3",
    channel: "android_sms",
    sender: "AHLY",
    sourceApp: null,
    published:
      "تم إضافة تحويل لحظي لبطاقتكم مسبقة الدفع بمبلغ 10000.00 جم من <SENDER NAME, Latin caps, 38 chars> رقم مرجعي 937478492117 يوم 07-02 الساعة 15:59 للمزيد اتصل بـ 19623",
    fills: [["<SENDER NAME, Latin caps, 38 chars>", FILL_NAME_LATIN_38]],
    receivedAt: "2026-07-02T13:00:00.000Z",
    expect: {
      status: "parsed",
      templateId: "nbe.sms.prepaid_credit.v1",
      direction: "credit",
      amount: "10000.00",
      balanceAfter: null,
      reference: "937478492117",
      receivingHint: null,
      payerPhone: null,
      payerNameMasked: "MOHAMED A****",
      occurredAt: "2026-07-02T12:59:00.000Z",
    },
  },
  {
    id: "IP-NBE-2b",
    kind: "published",
    source: "MATTIYA",
    sourceUrl: MATTIYA,
    researchRef: "instapay.md §4.3",
    channel: "android_sms",
    sender: "AHLY",
    sourceApp: null,
    published:
      "تم إضافة تحويل لحظي لبطاقتكم مسبقة الدفع بمبلغ 300.00 جم من <SENDER NAME, Arabic, 6 words> رقم مرجعي 509818302771 يوم 08-12 الساعة 23:27 للمزيد اتصل بـ 19623",
    fills: [["<SENDER NAME, Arabic, 6 words>", FILL_NAME_AR_6]],
    receivedAt: "2026-08-12T20:28:00.000Z",
    expect: {
      status: "parsed",
      templateId: "nbe.sms.prepaid_credit.v1",
      direction: "credit",
      amount: "300.00",
      balanceAfter: null,
      reference: "509818302771",
      receivingHint: null,
      payerPhone: null,
      payerNameMasked: "محمد ا****",
      occurredAt: "2026-08-12T20:27:00.000Z",
    },
  },
  {
    id: "IP-NBE-3",
    kind: "published",
    source: "DABBARHA",
    sourceUrl: DABBARHA,
    researchRef: "instapay.md §4.3",
    channel: "android_sms",
    sender: "AHLY",
    sourceApp: null,
    published:
      'تم تنفيذ تحويل لحظي من حسابكم رقم 0150 بمبلغ 150.00 جم إلى <RECEIVER NAME MASKED BY BANK, e.g. "ABDELAZEEZ M****"> رقم مرجعي 885841387872 يوم 05-13 الساعة 23:17 للمزيد اتصل بـ 19623',
    fills: [['<RECEIVER NAME MASKED BY BANK, e.g. "ABDELAZEEZ M****">', FILL_RECEIVER_MASKED]],
    receivedAt: "2026-05-13T20:18:00.000Z",
    expect: {
      status: "parsed",
      templateId: "nbe.sms.debit.v1",
      direction: "debit",
      amount: "150.00",
      balanceAfter: null,
      reference: "885841387872",
      receivingHint: "0150",
      payerPhone: null,
      payerNameMasked: null,
      occurredAt: "2026-05-13T20:17:00.000Z",
    },
  },
  {
    id: "IP-NBE-4",
    kind: "published",
    source: "DABBARHA",
    sourceUrl: DABBARHA,
    researchRef: "instapay.md §4.3",
    channel: "android_sms",
    sender: "AHLY",
    sourceApp: null,
    published:
      "تم خصم مبلغ 433.80 جم لحظيا باستخدام (شبكة المدفوعات اللحظية) من حسابكم رقم 0150 عند Home Internet يوم 05-02 الساعة11:42 مرجع التاجر 1215624709 للمزيد اتصل بـ 19623.",
    fills: [],
    receivedAt: "2026-05-02T08:43:00.000Z",
    expect: {
      status: "parsed",
      templateId: "nbe.sms.merchant_debit.v1",
      direction: "debit",
      amount: "433.80",
      balanceAfter: null,
      reference: "1215624709",
      receivingHint: "0150",
      payerPhone: null,
      payerNameMasked: null,
      occurredAt: "2026-05-02T08:42:00.000Z",
    },
  },
  {
    id: "IP-CIB-1",
    kind: "published",
    source: "ZEN",
    sourceUrl: ZEN,
    researchRef: "instapay.md §4.3",
    channel: "android_sms",
    sender: "cib",
    sourceApp: null,
    published:
      "يرجى العلم انه تم تنفيذ تحويل لحظي بمبلغ 64500.00 جم إلى حسابك المنتهي بـ ********0018 من <SENDER NAME, Latin caps, cut: 23 chars> برقم مرجعي 9951576c بتاريخ 15-06-2025 22:49 للمزيد، برجاء الاتصال بـ 19666",
    fills: [["<SENDER NAME, Latin caps, cut: 23 chars>", FILL_NAME_LATIN_23]],
    receivedAt: "2025-06-15T19:50:00.000Z",
    expect: {
      status: "parsed",
      templateId: "cib.sms.credit.v1",
      direction: "credit",
      amount: "64500.00",
      balanceAfter: null,
      reference: "9951576c",
      receivingHint: "0018",
      payerPhone: null,
      payerNameMasked: "AHMED M****",
      occurredAt: "2025-06-15T19:49:00.000Z",
    },
  },
  {
    id: "IP-CIB-1-D",
    kind: "published",
    source: "FINFAST",
    sourceUrl: FINFAST,
    researchRef: "instapay.md §4.3",
    channel: "android_sms",
    sender: "cib",
    sourceApp: null,
    published:
      "يرجى العلم انه تم تنفيذ تحويل لحظي بمبلغ 1000.00 جم من حسابك المنتهي بـ ****1065 برقم مرجعي 819a53fa بتاريخ 26-05-2026 19:35 للمزيد، برجاء الاتصال بـ 19666",
    fills: [],
    receivedAt: "2026-05-26T16:36:00.000Z",
    expect: {
      status: "parsed",
      templateId: "cib.sms.debit.v1",
      direction: "debit",
      amount: "1000.00",
      balanceAfter: null,
      reference: "819a53fa",
      receivingHint: "1065",
      payerPhone: null,
      payerNameMasked: null,
      occurredAt: "2026-05-26T16:35:00.000Z",
    },
  },
  {
    id: "IP-QNB-1",
    kind: "published",
    source: "ESLAM",
    sourceUrl: ESLAM,
    researchRef: "instapay.md §4.3",
    channel: "android_sms",
    sender: "QNB EGYPT",
    sourceApp: null,
    published:
      "IPN transfer received with amount of EGP 500.00 on 5597 on 06/05 at 08:34 PM. Ref# ff961e35. For more details call 19700.",
    fills: [],
    receivedAt: "2026-05-06T17:35:00.000Z",
    expect: {
      status: "parsed",
      templateId: "qnb.sms.credit.v1",
      direction: "credit",
      amount: "500.00",
      balanceAfter: null,
      reference: "ff961e35",
      receivingHint: "5597",
      payerPhone: null,
      payerNameMasked: null,
      occurredAt: "2026-05-06T17:34:00.000Z",
    },
  },
  {
    id: "IP-QNB-1-D",
    kind: "published",
    source: "ESLAM",
    sourceUrl: ESLAM,
    researchRef: "instapay.md §4.3",
    channel: "android_sms",
    sender: "QNB EGYPT",
    sourceApp: null,
    published:
      "IPN transfer sent with amount of EGP 100.00 from 5597 on 07/05 at 09:16 PM. Ref# e8819e2c. For more details call 19700.",
    fills: [],
    receivedAt: "2026-05-07T18:17:00.000Z",
    expect: {
      status: "parsed",
      templateId: "qnb.sms.debit.v1",
      direction: "debit",
      amount: "100.00",
      balanceAfter: null,
      reference: "e8819e2c",
      receivingHint: "5597",
      payerPhone: null,
      payerNameMasked: null,
      occurredAt: "2026-05-07T18:16:00.000Z",
    },
  },
  {
    id: "IP-QNB-PAIR-D",
    kind: "published",
    source: "MATTIYA",
    sourceUrl: MATTIYA,
    researchRef: "instapay.md §4.3",
    channel: "android_sms",
    sender: "QNB EGYPT",
    sourceApp: null,
    published:
      "IPN transfer sent with amount of EGP 350.00 from 0694 on 18/09 at 07:32 AM. Ref# 43f3ef2a. For more details call 19700",
    fills: [],
    receivedAt: "2026-09-18T04:33:00.000Z",
    expect: {
      status: "parsed",
      templateId: "qnb.sms.debit.v1",
      direction: "debit",
      amount: "350.00",
      balanceAfter: null,
      reference: "43f3ef2a",
      receivingHint: "0694",
      payerPhone: null,
      payerNameMasked: null,
      occurredAt: "2026-09-18T04:32:00.000Z",
    },
  },
  {
    id: "IP-BDC-1",
    kind: "published",
    source: "MATTIYA",
    sourceUrl: MATTIYA,
    researchRef: "instapay.md §4.3",
    channel: "android_sms",
    sender: null,
    sourceApp: null,
    published:
      "تم إستقبال تحويل لحظي إلى حسابكم 4113 بمبلغ 350.00 جم من <SENDER NAME, Latin caps, 30 chars> في 07:32 يوم 9/18/26 رقم المعاملة 43f3ef2a للمزيد أتصل ب 16990",
    fills: [["<SENDER NAME, Latin caps, 30 chars>", FILL_NAME_LATIN_30]],
    receivedAt: "2026-09-18T04:33:00.000Z",
    expect: {
      status: "parsed",
      templateId: "bdc.sms.credit.v1",
      direction: "credit",
      amount: "350.00",
      balanceAfter: null,
      reference: "43f3ef2a",
      receivingHint: "4113",
      payerPhone: null,
      payerNameMasked: "MOHAMED A****",
      occurredAt: "2026-09-18T04:32:00.000Z",
    },
  },
  {
    id: "IP-UNK-1",
    kind: "published",
    source: "MATTIYA",
    sourceUrl: MATTIYA,
    researchRef: "instapay.md §4.3",
    channel: "android_sms",
    sender: null,
    sourceApp: null,
    published: "تم اضافة مبلغ 20000EGP الى حساب رقم xxx6201 فى 19-AUG-2026 عن طريق التحويل اللحظي",
    fills: [],
    receivedAt: "2026-08-19T09:00:00.000Z",
    expect: {
      status: "parsed",
      templateId: "generic_ipn.sms.credit.v1",
      direction: "credit",
      amount: "20000.00",
      balanceAfter: null,
      reference: null,
      receivingHint: "6201",
      payerPhone: null,
      payerNameMasked: null,
      occurredAt: "2026-08-19T09:00:00.000Z",
    },
  },
  {
    id: "IP-ADIB-1",
    kind: "published",
    source: "MATTIYA",
    sourceUrl: MATTIYA,
    researchRef: "instapay.md §4.3",
    channel: "android_sms",
    sender: null,
    sourceApp: null,
    published:
      "Your account ending in 9596 has been charged the amount of 500.5 for an IPN transfer on 2026-08-18 17:56 Txn Ref: 1be731da For further details please call 19951",
    fills: [],
    receivedAt: "2026-08-18T14:57:00.000Z",
    expect: {
      status: "parsed",
      templateId: "adib.sms.debit.v1",
      direction: "debit",
      amount: "500.50",
      balanceAfter: null,
      reference: "1be731da",
      receivingHint: "9596",
      payerPhone: null,
      payerNameMasked: null,
      occurredAt: "2026-08-18T14:56:00.000Z",
    },
  },

  // ------------------------------------- illustrative negatives (Zynk demo)
  {
    id: "ZYNK-OTP",
    kind: "illustrative",
    source: "ZYNK",
    sourceUrl: ZYNK,
    researchRef: "ios.md Published message examples",
    channel: "ios_sms",
    sender: null,
    sourceApp: null,
    published: "Your OTP is 482910. Do not share this code.",
    fills: [],
    receivedAt: "2026-01-20T10:00:00.000Z",
    expect: { status: "otp", templateId: null },
  },
  {
    id: "ZYNK-CARD",
    kind: "illustrative",
    source: "ZYNK",
    sourceUrl: ZYNK,
    researchRef: "ios.md Published message examples",
    channel: "ios_sms",
    sender: null,
    sourceApp: null,
    published: "Your card ending 4532 was charged EGP 450.00 at Mashhour on 01/15/2026",
    fills: [],
    receivedAt: "2026-01-15T10:00:00.000Z",
    expect: { status: "not_credit", templateId: null },
  },
  {
    id: "ZYNK-PAY",
    kind: "illustrative",
    source: "ZYNK",
    sourceUrl: ZYNK,
    researchRef: "ios.md Published message examples",
    channel: "ios_sms",
    sender: null,
    sourceApp: null,
    published: "Payment of EGP 1270.50 to IKEA completed successfully on 2026-01-20",
    fills: [],
    receivedAt: "2026-01-20T10:00:00.000Z",
    expect: { status: "not_credit", templateId: null },
  },
  {
    id: "ZYNK-ATM",
    kind: "illustrative",
    source: "ZYNK",
    sourceUrl: ZYNK,
    researchRef: "ios.md Published message examples",
    channel: "ios_sms",
    sender: null,
    sourceApp: null,
    published: "ATM withdrawal of EGP 2,000.00 from your account on 18-01-2026",
    fills: [],
    receivedAt: "2026-01-18T10:00:00.000Z",
    expect: { status: "not_credit", templateId: null },
  },
];

/** 20 published + 4 illustrative (06 §4.14). Pilot samples are appended by a promotion (§4.15). */
export const SAMPLES: readonly SampleFixture[] = DRAFTS.map((d) => ({ ...d, text: applyFills(d.published, d.fills) }));

/** The sample with this id, or null. */
export function sampleById(id: string): SampleFixture | null {
  for (const s of SAMPLES) if (s.id === id) return s;
  return null;
}

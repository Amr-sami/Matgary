// EAS Metadata store config — `eas metadata:push` (App Store Connect), wired via
// eas.json → submit.production.ios.metadataPath. Single source of truth for the
// iOS listing texts: edit here, never in the console. Limits: title 30 ·
// subtitle 30 · promo 170 · description 4000 · keywords 100 comma-joined ·
// review notes 4000 (store/README.md).
//
// This is a JS config (not JSON) for one reason: the App Review demo login
// must never sit in a tracked file. The `review` block reads it from the
// environment at push time — see mobile-dev-docs/12-release-runbook.md §7.4:
//
//   ASC_REVIEW_FIRST_NAME / ASC_REVIEW_LAST_NAME / ASC_REVIEW_PHONE
//   ASC_REVIEW_DEMO_USERNAME / ASC_REVIEW_DEMO_PASSWORD
//
// Unset values fall back to REPLACE_ME_* placeholders and a warning is printed
// on stderr, so a push from a shell without them is visible, not silent.
// (`eas metadata:pull` can only write JSON — it refuses a .js metadataPath;
// treat App Store Connect as downstream of this file, not the other way.)

/** @param {string} name @param {string} fallback */
function env(name, fallback) {
  const v = process.env[name];
  if (v && v.trim()) return v.trim();
  process.stderr.write(`[store.config.js] ${name} is not set — using placeholder ${fallback}\n`);
  return fallback;
}

// Shape: https://docs.expo.dev/eas/metadata/schema/ (configVersion 0).
module.exports = {
  configVersion: 0,
  apple: {
    version: "1.0.0",
    copyright: "2026 TheStoro",
    categories: [
      "BUSINESS",
      "PRODUCTIVITY"
    ],
    info: {
      "ar-SA": {
        "title": "ستورو — نقاط البيع",
        "subtitle": "كاشير ومخزون وعملاء في جيبك",
        "promoText": "كاشير سريع يشتغل من غير نت، مخزون بيتحدّث لحظياً، وفواتير على طابعة بلوتوث. جرّب ستورو مجاناً.",
        "description": "ستورو هو نظام نقاط البيع اللي بيشتغل معاك في أي محل: سوبر ماركت، محل ملابس، صيدلية، كافيه، أو مخزن جملة. كل اللي محتاجه لتشغيل المحل من موبايلك، وبيتزامن مع لوحة التحكم على thestoro.com في نفس اللحظة.\n\nالكاشير\n• بيع بالباركود من كاميرا الموبايل — امسح المنتج وهو ينزل في السلة على طول.\n• خصومات على المنتج أو على الفاتورة، وأكثر من طريقة دفع.\n• الفاتورة تتطبع على طابعة حرارية بلوتوث أو تتشارك كصورة/PDF على واتساب.\n• شغّال من غير إنترنت: البيع بيتسجّل محلياً وبيترفع لوحده أول ما النت يرجع.\n\nالمخزون\n• أرصدة لحظية لكل منتج وكل فرع، مع تنبيه لما الكمية تقرب تخلص.\n• إضافة منتج بالباركود والصورة والسعر في ثواني.\n• جرد سريع، وتحويلات بين الفروع، ومرتجعات بتعدّل الرصيد تلقائياً.\n\nالمشتريات والموردين\n• سجّل فواتير الشراء وربطها بالمورد، وتابع المستحقات.\n\nالعملاء\n• ملف لكل عميل برقم موبايله وتاريخ مشترياته وحسابه.\n• رسائل واتساب مباشرة من ملف العميل.\n\nالمصروفات والتقارير\n• سجّل مصروفات اليوم، وشوف صافي المبيعات والربح والأكثر مبيعاً في لمحة.\n• ملخّص يومي بيوصلك إشعار.\n\nالفريق\n• حسابات للموظفين بصلاحيات محدّدة لكل واحد.\n• تسجيل حضور وانصراف من داخل نطاق المحل، وطلبات إجازة، ومهام يومية.\n\nالأمان\n• قفل التطبيق ببصمة الوجه أو الإصبع.\n• بياناتك مشفّرة ومتزامنة مع حسابك على الويب — لو الموبايل ضاع، البيانات مش هتضيع.\n\nستورو مصمّم بالعربي من الأول: واجهة يمين-لشمال حقيقية، أرقام وعملة بالجنيه المصري، وكل حاجة بتظهر بلغتك. متاح كمان بالإنجليزي.\n\nمحتاج حساب ستورو للاستخدام. افتح التطبيق وسجّل محلك في دقيقة، أو ادخل بحسابك الحالي من الويب.\n\nللمساعدة: support@thestoro.com — thestoro.com/ar/help",
        "keywords": [
          "كاشير",
          "نقاط البيع",
          "مخزون",
          "محل",
          "فواتير",
          "باركود",
          "مبيعات",
          "عملاء",
          "سوبر ماركت",
          "POS"
        ],
        "releaseNotes": "الإصدار الأول من ستورو على iOS: كاشير بالباركود، مخزون لحظي، فواتير بلوتوث، عملاء، مصروفات، فريق وحضور — كله متزامن مع حسابك على thestoro.com.",
        "marketingUrl": "https://thestoro.com/ar",
        "supportUrl": "https://thestoro.com/ar/help",
        "privacyPolicyUrl": "https://thestoro.com/ar/privacy"
      },
      "en-US": {
        "title": "TheStoro POS",
        "subtitle": "Register, stock & customers",
        "promoText": "A fast register that works offline, live stock levels, and Bluetooth receipts. Try TheStoro free.",
        "description": "TheStoro is the point-of-sale system that runs your shop from your phone — supermarket, clothing store, pharmacy, café or wholesale stockroom — and stays in sync with the web dashboard at thestoro.com in real time.\n\nREGISTER\n• Scan barcodes with the phone camera; items drop straight into the cart.\n• Line and receipt discounts, multiple payment methods.\n• Print receipts on a Bluetooth thermal printer, or share them as an image/PDF over WhatsApp.\n• Works offline: sales are recorded locally and upload themselves the moment the connection returns.\n\nINVENTORY\n• Live stock per product and per branch, with low-stock alerts.\n• Add a product with barcode, photo and price in seconds.\n• Quick counts, branch transfers, and returns that adjust stock automatically.\n\nPURCHASES & SUPPLIERS\n• Record purchase invoices against a supplier and track what you owe.\n\nCUSTOMERS\n• A profile per customer with phone number, purchase history and balance.\n• Message customers on WhatsApp straight from their profile.\n\nEXPENSES & REPORTS\n• Log the day's expenses; see net sales, profit and best-sellers at a glance.\n• A daily summary arrives as a push notification.\n\nTEAM\n• Staff accounts with per-person permissions.\n• Check-in/check-out from within the shop's radius, leave requests, daily tasks.\n\nSECURITY\n• Lock the app with Face ID / Touch ID.\n• Your data is encrypted and synced with your web account — a lost phone is not lost data.\n\nTheStoro is Arabic-first by design: true right-to-left layout, Egyptian pound formatting, and every screen in your language. Also available in English.\n\nA TheStoro account is required. Open the app and register your shop in a minute, or sign in with your existing web account.\n\nSupport: support@thestoro.com — thestoro.com/en/help",
        "keywords": [
          "pos",
          "point of sale",
          "cash register",
          "inventory",
          "stock",
          "barcode",
          "receipt",
          "retail",
          "shop",
          "invoice",
          "egypt"
        ],
        "releaseNotes": "First release of TheStoro on iOS: barcode register, live inventory, Bluetooth receipts, customers, expenses, team and attendance — all synced with your account on thestoro.com.",
        "marketingUrl": "https://thestoro.com/en",
        "supportUrl": "https://thestoro.com/en/help",
        "privacyPolicyUrl": "https://thestoro.com/en/privacy"
      }
    },
    advisory: {
      "alcoholTobaccoOrDrugUseOrReferences": "NONE",
      "contests": "NONE",
      "gamblingSimulated": "NONE",
      "horrorOrFearThemes": "NONE",
      "matureOrSuggestiveThemes": "NONE",
      "medicalOrTreatmentInformation": "NONE",
      "profanityOrCrudeHumor": "NONE",
      "sexualContentGraphicAndNudity": "NONE",
      "sexualContentOrNudity": "NONE",
      "violenceCartoonOrFantasy": "NONE",
      "violenceRealistic": "NONE",
      "violenceRealisticProlongedGraphicOrSadistic": "NONE",
      "gambling": false,
      "unrestrictedWebAccess": false,
      "kidsAgeBand": null,
      "seventeenPlus": false
    },
    release: {
      "automaticRelease": false,
      "phasedRelease": true
    },
    // App Review contact + demo login (a seeded demo-tenant OWNER). Filled from
    // the environment — see the header.
    review: {
      firstName: env("ASC_REVIEW_FIRST_NAME", "REPLACE_ME"),
      lastName: env("ASC_REVIEW_LAST_NAME", "REPLACE_ME"),
      email: "support@thestoro.com",
      phone: env("ASC_REVIEW_PHONE", "+20REPLACE_ME"),
      demoUsername: env("ASC_REVIEW_DEMO_USERNAME", "REPLACE_ME_demo_owner_email"),
      demoPassword: env("ASC_REVIEW_DEMO_PASSWORD", "REPLACE_ME_demo_password"),
      demoRequired: true,
      notes:
        "TheStoro is a B2B point-of-sale for shops. Sign in with the demo credentials above: the account is an OWNER of a seeded demo shop, so every screen (sales, inventory, customers, team, insights, settings) is reachable. Camera: barcode scanning only. Location (When In Use): staff check-in is a one-shot foreground check against the shop's radius (Team → Attendance). Bluetooth: pairing a thermal receipt printer (Settings → Printers) — optional, the app works without one. Face ID: optional app lock (Settings → App lock). Account deletion: Settings → Security → Delete account. Subscriptions are sold on the web only; the iOS app contains no purchase UI. Push notifications carry the daily sales digest and low-stock alerts.",
    },
  },
};

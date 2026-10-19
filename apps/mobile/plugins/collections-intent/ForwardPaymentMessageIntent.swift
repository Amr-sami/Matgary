// ForwardPaymentMessageIntent — doc 15 spec 10 §4.11 (M3); 03 §B.10.
//
// Compiled into the APP TARGET (App Intents metadata extraction only sees the app target), copied to
// ios/<project>/CollectionsIntent/ by plugins/with-collections-intent.js at prebuild. Never edit the
// generated copy under ios/ (it is gitignored and regenerated).
//
// FROZEN NAME: the action's identity in every published intent shortcut is this Swift type name in
// bundle com.thestoro.app. Renaming it breaks every installed shortcut (spec 10 §8).
//
// The strings are `collections_intent_*` keys of Localizable.strings (ar + en), written by the
// plugin from packages/i18n `mobile.collections.ios.intent.*`; the English defaults below are the
// fallback. No dialog ever contains an amount.

import AppIntents
import CollectionsIngest
import Foundation

struct ForwardPaymentMessageIntent: AppIntent {
  static let title = LocalizedStringResource("collections_intent_title", defaultValue: "Send payment message to TheStoro")
  static let description = IntentDescription(LocalizedStringResource(
    "collections_intent_description",
    defaultValue: "Sends a bank or wallet message to TheStoro to confirm a transfer. Never sends verification codes."))

  /// Runs while the phone is locked (the Keychain item is AfterFirstUnlockThisDeviceOnly).
  static let authenticationPolicy: IntentAuthenticationPolicy = .alwaysAllowed
  /// < iOS 26: never bring the app to the foreground (deprecated on 26+, where supportedModes rules).
  static let openAppWhenRun: Bool = false

  @Parameter(title: LocalizedStringResource("collections_intent_param_text", defaultValue: "Message text"))
  var text: String

  @Parameter(title: LocalizedStringResource("collections_intent_param_title", defaultValue: "Title"))
  var title: String?

  @Parameter(title: LocalizedStringResource("collections_intent_param_subtitle", defaultValue: "Subtitle"))
  var subtitle: String?

  @Parameter(title: LocalizedStringResource("collections_intent_param_sender", defaultValue: "Sender"))
  var sender: String?

  /// "sms" (Message trigger → ios_sms), "ios.unknown" or a notification label (→ ios_notification).
  @Parameter(title: LocalizedStringResource("collections_intent_param_source", defaultValue: "Source"), default: "sms")
  var source: String

  @Parameter(title: LocalizedStringResource("collections_intent_param_received_at", defaultValue: "Received at"))
  var receivedAt: Date?

  func perform() async throws -> some IntentResult & ProvidesDialog {
    let outcome = await IngestCore.shared.forward(IngestInput(
      text: text, title: title, subtitle: subtitle, sender: sender, source: source,
      receivedAt: receivedAt ?? Date()))
    return .result(dialog: IntentDialog(Self.dialog(outcome)))
  }

  /// Literal keys (not built from `outcome.dialogKey`) so Xcode's string extraction sees each one.
  static func dialog(_ outcome: IngestOutcome) -> LocalizedStringResource {
    switch outcome {
    case .sent:
      return LocalizedStringResource("collections_intent_dialog_sent", defaultValue: "Sent to TheStoro.")
    case .queued:
      return LocalizedStringResource("collections_intent_dialog_queued",
                                     defaultValue: "Saved on this phone. It will be sent when you're back online.")
    case .notLinked:
      return LocalizedStringResource("collections_intent_dialog_not_linked",
                                     defaultValue: "TheStoro isn't linked on this iPhone. Open TheStoro and set it up again.")
    case .test:
      return LocalizedStringResource("collections_intent_dialog_test", defaultValue: "The test reached TheStoro.")
    case .testFailed:
      return LocalizedStringResource("collections_intent_dialog_test_failed",
                                     defaultValue: "The test didn't arrive. Check you're online and try again.")
    case .skipped:
      return LocalizedStringResource("collections_intent_dialog_skipped",
                                     defaultValue: "Not a payment message. Nothing was sent.")
    }
  }
}

@available(iOS 26.0, *)
extension ForwardPaymentMessageIntent {
  /// iOS 26+: run in the background, never open the app.
  static var supportedModes: IntentModes { .background }
}

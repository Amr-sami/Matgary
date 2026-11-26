import ExpoModulesCore

/// Expo face of the collections ingest core (doc 15 spec 10 §4.10; 03 §B.10). The JS wrapper is
/// `modules/collections-ingest/index.ts`; the App Intent `ForwardPaymentMessageIntent` (app
/// target, copied by `plugins/with-collections-intent.js`) talks to `IngestCore.shared` directly.
///
/// Every function answers a plain value and never throws to JS: a Keychain or disk failure is a
/// `false` / `nil` the wizard already handles.
public class CollectionsIngestModule: Module {
  public func definition() -> ModuleDefinition {
    Name("CollectionsIngest")

    AsyncFunction("setCredential") { (url: String, token: String) async -> Bool in
      await IngestCore.shared.setCredential(url: url, token: token)
    }

    AsyncFunction("hasCredential") { () async -> Bool in
      await IngestCore.shared.hasCredential()
    }

    AsyncFunction("clearCredential") { () async -> Bool in
      await IngestCore.shared.clear()
    }

    AsyncFunction("getStatus") { () async -> [String: Any] in
      await IngestCore.shared.status().asDictionary()
    }

    #if DEBUG
    // Dev-only knob (doc 14 §6.3): never compiled into a Release binary.
    AsyncFunction("forwardForTesting") { (text: String, source: String, sender: String?) async -> String in
      let outcome = await IngestCore.shared.forward(IngestInput(text: text, sender: sender, source: source))
      return outcome.rawValue
    }
    #endif

    OnAppBecomesActive {
      Task {
        await IngestCore.shared.drain()
        await IngestCore.shared.heartbeatIfDue()
      }
    }
  }
}

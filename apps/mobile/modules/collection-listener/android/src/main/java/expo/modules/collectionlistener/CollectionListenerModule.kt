package expo.modules.collectionlistener

import android.content.Context
import expo.modules.collectionlistener.core.ConfigRules
import expo.modules.collectionlistener.core.Iso
import expo.modules.collectionlistener.store.AppInfo
import expo.modules.collectionlistener.store.CredentialStore
import expo.modules.collectionlistener.store.KeystoreFailure
import expo.modules.collectionlistener.store.Queue
import expo.modules.collectionlistener.store.State
import expo.modules.collectionlistener.work.Scheduler
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

/** 03 §B.17 `config.keywords`. */
class KeywordsRecord : Record {
  @Field var ar: List<String> = emptyList()
  @Field var en: List<String> = emptyList()
}

/** `configure({ingestUrl, token, packages, keywords, otpPatterns, configVersion})` (11 §4.2). */
class ConfigureOptions : Record {
  @Field var ingestUrl: String = ""
  @Field var token: String = ""
  @Field var packages: List<String> = emptyList()
  @Field var keywords: KeywordsRecord = KeywordsRecord()
  @Field var otpPatterns: List<String> = emptyList()
  @Field var configVersion: String = ""
  @Field var maxAgeHours: Int? = null
}

/**
 * The Expo module `CollectionListener` (doc 15 spec 11 §4.2 = 03 §B.10): eight functions, status
 * only — the token is never returned. Error codes travel in `error.code`: `NOT_CONFIGURED`,
 * `INVALID_CONFIG`, `UNAVAILABLE`, `KEYSTORE_FAILED`. A failed `configure()` leaves the previous
 * state untouched.
 *
 * `OnCreate` (every app start): the rebind check and, when configured, the idempotent periodic worker
 * (the mitigation for "listener stops after reboot / update", A7).
 *
 * Signing out of TheStoro never reaches here (02 US-M4-04): only a 401, 09's reconcile finding the
 * device absent, or 09's revoke button for this phone calls `clearCredentials()`.
 */
class CollectionListenerModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  private fun coded(code: String, message: String) = CodedException(code, message, null)

  override fun definition() = ModuleDefinition {
    Name("CollectionListener")

    OnCreate {
      try {
        val ctx = appContext.reactContext ?: return@OnCreate
        val state = State(ctx)
        if (state.configured) {
          Scheduler.periodic(ctx)
          Rebind.check(ctx)
        }
      } catch (_: Throwable) {
        // Never break app start.
      }
    }

    Function("isSupported") {
      val ctx = appContext.reactContext ?: return@Function false
      Rebind.isSupported(ctx)
    }

    AsyncFunction("isAccessGranted") {
      Rebind.isAccessGranted(context)
    }

    AsyncFunction("openAccessSettings") {
      val ctx = context
      // "The in-app disclosure (09 consent → device creation → configure) immediately precedes the OS
      // screen" is a code property: no configure, no settings screen (Play User Data policy).
      if (!State(ctx).configured) throw coded("NOT_CONFIGURED", "configure() has not run")
      Rebind.openAccessSettings(ctx, appContext.currentActivity)
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("configure") { c: ConfigureOptions ->
      val ctx = context
      val debuggable = AppInfo.isDebuggable(ctx)
      val bad = ConfigRules.validate(
        c.ingestUrl,
        c.token,
        c.packages,
        c.keywords.ar,
        c.keywords.en,
        c.otpPatterns,
        c.configVersion,
        debuggable,
      )
      if (bad != null) throw coded("INVALID_CONFIG", "invalid $bad")
      val state = State(ctx)
      val creds = CredentialStore(ctx)
      // Encrypt first: on a Keystore failure nothing else has changed.
      try {
        creds.encrypt(ByteArray(1))
      } catch (e: KeystoreFailure) {
        throw CodedException("KEYSTORE_FAILED", "keystore unavailable", e)
      }
      // A configure that replaces an earlier one (09's "Set up again"): the old device's queue,
      // seen table and works go first.
      if (state.configured || creds.hasCredential()) {
        Scheduler.cancelAll(ctx)
        Queue.get(ctx).wipe()
      }
      try {
        creds.save(c.token, ConfigRules.normalizeUrl(c.ingestUrl))
      } catch (e: KeystoreFailure) {
        throw CodedException("KEYSTORE_FAILED", "keystore unavailable", e)
      }
      state.clearAll()
      state.saveConfig(c.packages, c.keywords.ar, c.keywords.en, c.otpPatterns, c.configVersion, c.maxAgeHours, debuggable)
      state.configured = true
      Pipeline.reset()
      // 09 §4.6.7 / 09 ARCH CR 9: one immediate heartbeat (expedited on API ≥ 31), then every 15 min.
      Scheduler.heartbeatNow(ctx)
      Scheduler.periodic(ctx)
      AppInfo.debug(ctx, "configured packages=${state.packages.size}")
      Unit
    }

    AsyncFunction("getStatus") {
      val ctx = context
      val state = State(ctx)
      val configured = state.configured
      mapOf(
        "configured" to configured,
        "connected" to (configured && Rebind.connected(ctx, state)),
        "lastNotificationAt" to Iso.formatOrNull(state.lastNotificationAt),
        "lastUploadAt" to Iso.formatOrNull(state.lastUploadAt),
        "queued" to if (configured) Queue.get(ctx).count() else 0,
        "packagesInstalled" to if (configured) Rebind.packagesInstalled(ctx, state.packages) else emptyList<String>(),
      )
    }

    AsyncFunction("requestRebind") {
      val ctx = context
      if (!State(ctx).configured) return@AsyncFunction false
      Rebind.request(ctx)
    }

    AsyncFunction("clearCredentials") {
      val ctx = context
      Scheduler.clearEverything(ctx, authFailed = false)
      Pipeline.reset()
      Unit
    }

    AsyncFunction("openBatterySettings") {
      Rebind.openBatterySettings(context, appContext.currentActivity)
    }.runOnQueue(Queues.MAIN)
  }
}

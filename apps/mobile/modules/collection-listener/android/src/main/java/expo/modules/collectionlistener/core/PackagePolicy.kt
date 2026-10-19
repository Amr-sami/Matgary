package expo.modules.collectionlistener.core

/**
 * Which app packages the listener may read (doc 15 spec 11 §4.5.1). Pure Kotlin: no Android or Expo
 * import, so the JVM tests run it and the M5 Collector can reuse it (11 appendix).
 *
 * The server sends the allowlist (`GET …/ingest/config` `packages`), but the hard-coded SMS-app
 * denylist below ALWAYS wins (D11-f): a server bug or a compromised config can never make the Play
 * build read SMS through an SMS app's notifications (Play SMS/Call Log policy).
 */
object PackagePolicy {
  /** 11 §4.5.1: the two well-known SMS apps + the two AOSP messaging packages (A13 re-checks per phone). */
  val SMS_APP_DENYLIST: Set<String> = setOf(
    "com.google.android.apps.messaging",
    "com.samsung.android.messaging",
    "com.android.mms",
    "com.android.messaging",
  )

  /** Our own package: the app never forwards its own notifications. */
  const val OWN_PACKAGE = "com.thestoro.app"

  /** D11-g: debuggable builds only, so `adb shell cmd notification post …` can drive tests. */
  const val DEBUG_SHELL_PACKAGE = "com.android.shell"

  /** 07's heartbeat cap (`packagesInstalled` ≤ 50) — the same bound for the allowlist. */
  const val MAX_PACKAGES = 50
  const val MAX_PACKAGE_LENGTH = 200

  private val PACKAGE_RE = Regex("^[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z0-9_]+)+$")

  fun isDenied(pkg: String): Boolean = pkg in SMS_APP_DENYLIST || pkg == OWN_PACKAGE

  /**
   * Trim, keep well-formed ids ≤ 200 chars, drop the denylist and our own package, dedupe (first
   * occurrence wins), cap at 50. `debuggable` (the APP's FLAG_DEBUGGABLE, never the library
   * BuildConfig) adds `com.android.shell`. An empty result is valid: the service then reads nothing.
   */
  fun sanitize(packages: List<String?>?, debuggable: Boolean): List<String> {
    val out = LinkedHashSet<String>()
    for (raw in packages.orEmpty()) {
      val p = raw?.trim() ?: continue
      if (p.isEmpty() || p.length > MAX_PACKAGE_LENGTH) continue
      if (!PACKAGE_RE.matches(p)) continue
      if (isDenied(p)) continue
      if (p == DEBUG_SHELL_PACKAGE && !debuggable) continue
      if (out.size >= MAX_PACKAGES) break
      out.add(p)
    }
    if (debuggable && DEBUG_SHELL_PACKAGE !in out) {
      if (out.size >= MAX_PACKAGES) out.remove(out.last())
      out.add(DEBUG_SHELL_PACKAGE)
    }
    return out.toList()
  }
}

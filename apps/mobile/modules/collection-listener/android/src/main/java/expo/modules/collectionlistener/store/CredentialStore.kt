package expo.modules.collectionlistener.store

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Any Keystore / AES-GCM failure (an OEM keystore bug, `AEADBadTagException`, a wiped key). */
class KeystoreFailure(cause: Throwable) : Exception(cause.javaClass.simpleName, cause)

/**
 * The ingest credential, encrypted at rest (doc 15 spec 11 §4.5.5, D11-a; 03 §E.2 as amended by
 * 11 ARCH CHANGE REQUEST 1): an `AndroidKeyStore` AES-256-GCM key (non-exportable, alias
 * `thestoro.collection_listener.v1`, no user-auth requirement so it works while the phone is locked
 * after its first unlock — when bank notifications arrive) + `base64(iv(12) || ciphertext+tag)` in the
 * private SharedPreferences `collection_listener_secure`. Not `EncryptedSharedPreferences` (deprecated
 * in androidx security-crypto 1.1.0). Nothing else is stored there.
 *
 * The same key encrypts the queued message bodies ([Queue]). The token is never returned to JS, never
 * logged, and never put in WorkManager `Data`: the worker reads it from here.
 */
class CredentialStore(context: Context) {
  private val ctx = context.applicationContext
  private val prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  companion object {
    const val ALIAS = "thestoro.collection_listener.v1"
    const val PREFS = "collection_listener_secure"
    private const val PROVIDER = "AndroidKeyStore"
    private const val TRANSFORM = "AES/GCM/NoPadding"
    private const val IV_BYTES = 12
    private const val TAG_BITS = 128
    private const val K_TOKEN = "token"
    private const val K_URL = "ingest_url"
  }

  private fun keyStore(): KeyStore = KeyStore.getInstance(PROVIDER).apply { load(null) }

  @Synchronized
  private fun key(create: Boolean): SecretKey? {
    val ks = keyStore()
    (ks.getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
    if (!create) return null
    val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, PROVIDER)
    gen.init(
      KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setKeySize(256)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setRandomizedEncryptionRequired(true)
        .build(),
    )
    return gen.generateKey()
  }

  /** `iv(12) || ciphertext+tag`. Throws [KeystoreFailure]. */
  fun encrypt(plain: ByteArray): ByteArray {
    try {
      val k = key(create = true) ?: throw IllegalStateException("no key")
      val c = Cipher.getInstance(TRANSFORM)
      c.init(Cipher.ENCRYPT_MODE, k) // the provider picks a random IV (randomized encryption required)
      val iv = c.iv
      require(iv.size == IV_BYTES) { "unexpected IV size" }
      val ct = c.doFinal(plain)
      return iv + ct
    } catch (e: KeystoreFailure) {
      throw e
    } catch (e: Throwable) {
      throw KeystoreFailure(e)
    }
  }

  /** Throws [KeystoreFailure] (missing key, bad tag, truncated blob). */
  fun decrypt(blob: ByteArray): ByteArray {
    try {
      val k = key(create = false) ?: throw IllegalStateException("no key")
      require(blob.size > IV_BYTES) { "short blob" }
      val c = Cipher.getInstance(TRANSFORM)
      c.init(Cipher.DECRYPT_MODE, k, GCMParameterSpec(TAG_BITS, blob, 0, IV_BYTES))
      return c.doFinal(blob, IV_BYTES, blob.size - IV_BYTES)
    } catch (e: KeystoreFailure) {
      throw e
    } catch (e: Throwable) {
      throw KeystoreFailure(e)
    }
  }

  private fun get(k: String): String? {
    val enc = prefs.getString(k, null) ?: return null
    return String(decrypt(Base64.decode(enc, Base64.NO_WRAP)), Charsets.UTF_8)
  }

  /** Encrypt + store both, or throw [KeystoreFailure] leaving nothing half-written. */
  @Synchronized
  fun save(token: String, ingestUrl: String) {
    val t = Base64.encodeToString(encrypt(token.toByteArray(Charsets.UTF_8)), Base64.NO_WRAP)
    val u = Base64.encodeToString(encrypt(ingestUrl.toByteArray(Charsets.UTF_8)), Base64.NO_WRAP)
    if (!prefs.edit().putString(K_TOKEN, t).putString(K_URL, u).commit()) {
      throw KeystoreFailure(IllegalStateException("prefs commit"))
    }
  }

  fun hasCredential(): Boolean = prefs.contains(K_TOKEN) && prefs.contains(K_URL)

  /** The token, or null when none is stored. Throws [KeystoreFailure] when it cannot be decrypted. */
  fun token(): String? = get(K_TOKEN)

  fun ingestUrl(): String? = get(K_URL)

  /** Delete the Keystore entry and the secure preferences (clearCredentials). Never throws. */
  @Synchronized
  fun clear() {
    try {
      prefs.edit().clear().commit()
    } catch (_: Throwable) {
    }
    try {
      ctx.deleteSharedPreferences(PREFS)
    } catch (_: Throwable) {
    }
    try {
      val ks = keyStore()
      if (ks.containsAlias(ALIAS)) ks.deleteEntry(ALIAS)
    } catch (_: Throwable) {
    }
  }

}

package expo.modules.collectionlistener.store

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper

/**
 * The local queue and seen table (doc 15 spec 11 §4.5.4): SQLite `collection_listener.db` in the
 * app's private database dir (`allowBackup: false` keeps it out of backups).
 *
 * - `seen(fp TEXT PRIMARY KEY, seen_at INTEGER)`: an fp seen within `maxAgeHours` is an update in place
 *   or a backfill repeat → ignored.
 * - `queue(fp TEXT PRIMARY KEY, payload BLOB NOT NULL, created_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0)`:
 *   `payload` = AES-GCM ciphertext of the message JSON ([CredentialStore.encrypt]). Bodies are never
 *   stored in plain text, not even for minutes.
 * - Cap 500 rows (oldest first out, `State.droppedOverflow++`); rows and seen entries older than
 *   `maxAgeHours` are purged on every offer and every worker run (the server would say `too_old`).
 *
 * One instance per process; every method is synchronized (the service's executor and WorkManager's
 * thread both use it).
 */
class Queue private constructor(context: Context) :
  SQLiteOpenHelper(context.applicationContext, DB_NAME, null, DB_VERSION) {

  companion object {
    const val DB_NAME = "collection_listener.db"
    private const val DB_VERSION = 1
    const val CAP = 500

    @Volatile private var instance: Queue? = null

    fun get(context: Context): Queue =
      instance ?: synchronized(this) { instance ?: Queue(context).also { instance = it } }

    /** Close and delete the database file (clearCredentials). */
    fun destroy(context: Context) {
      synchronized(this) {
        try {
          instance?.close()
        } catch (_: Throwable) {
        }
        instance = null
        try {
          context.applicationContext.deleteDatabase(DB_NAME)
        } catch (_: Throwable) {
        }
      }
    }
  }

  data class Row(val fp: String, val payload: ByteArray, val createdAt: Long, val attempts: Int)

  enum class Offer { QUEUED, SEEN }

  override fun onCreate(db: SQLiteDatabase) {
    db.execSQL("CREATE TABLE seen (fp TEXT PRIMARY KEY, seen_at INTEGER)")
    db.execSQL(
      "CREATE TABLE queue (fp TEXT PRIMARY KEY, payload BLOB NOT NULL, created_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0)",
    )
    db.execSQL("CREATE INDEX queue_created ON queue(created_at)")
  }

  override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
    db.execSQL("DROP TABLE IF EXISTS seen")
    db.execSQL("DROP TABLE IF EXISTS queue")
    onCreate(db)
  }

  /** True when this fp was seen within the window (no insert). */
  @Synchronized
  fun wasSeen(fp: String, nowMs: Long, maxAgeMs: Long): Boolean {
    readableDatabase.rawQuery("SELECT seen_at FROM seen WHERE fp = ?", arrayOf(fp)).use { c ->
      if (!c.moveToFirst()) return false
      return nowMs - c.getLong(0) <= maxAgeMs
    }
  }

  /**
   * Seen-check + insert of a key that is never queued (A6: a redacted post, so the reconnect backfill
   * does not count the same shade entry twice). True when it was new inside the window.
   */
  @Synchronized
  fun markSeen(fp: String, nowMs: Long, maxAgeMs: Long): Boolean {
    val db = writableDatabase
    db.beginTransaction()
    try {
      purgeLocked(db, nowMs, maxAgeMs)
      val seen = db.rawQuery("SELECT seen_at FROM seen WHERE fp = ?", arrayOf(fp)).use { c ->
        c.moveToFirst() && nowMs - c.getLong(0) <= maxAgeMs
      }
      if (!seen) {
        db.insertWithOnConflict("seen", null, ContentValues().apply {
          put("fp", fp)
          put("seen_at", nowMs)
        }, SQLiteDatabase.CONFLICT_REPLACE)
      }
      db.setTransactionSuccessful()
      return !seen
    } finally {
      db.endTransaction()
    }
  }

  /**
   * Seen-check + insert in one transaction. Returns [Offer.SEEN] for a repeat inside the window,
   * else marks it seen, queues the ciphertext, applies the 500-row cap and returns
   * [Offer.QUEUED] plus how many old rows the cap pushed out.
   */
  @Synchronized
  fun offer(fp: String, payload: ByteArray, nowMs: Long, maxAgeMs: Long): Pair<Offer, Int> {
    val db = writableDatabase
    db.beginTransaction()
    try {
      purgeLocked(db, nowMs, maxAgeMs)
      val seen = db.rawQuery("SELECT seen_at FROM seen WHERE fp = ?", arrayOf(fp)).use { c ->
        c.moveToFirst() && nowMs - c.getLong(0) <= maxAgeMs
      }
      if (seen) {
        db.setTransactionSuccessful()
        return Offer.SEEN to 0
      }
      db.insertWithOnConflict("seen", null, ContentValues().apply {
        put("fp", fp)
        put("seen_at", nowMs)
      }, SQLiteDatabase.CONFLICT_REPLACE)
      db.insertWithOnConflict("queue", null, ContentValues().apply {
        put("fp", fp)
        put("payload", payload)
        put("created_at", nowMs)
        put("attempts", 0)
      }, SQLiteDatabase.CONFLICT_REPLACE)
      val over = countLocked(db) - CAP
      var dropped = 0
      if (over > 0) {
        db.execSQL(
          "DELETE FROM queue WHERE fp IN (SELECT fp FROM queue ORDER BY created_at ASC, fp ASC LIMIT ?)",
          arrayOf<Any>(over),
        )
        dropped = over
      }
      db.setTransactionSuccessful()
      return Offer.QUEUED to dropped
    } finally {
      db.endTransaction()
    }
  }

  @Synchronized
  fun purge(nowMs: Long, maxAgeMs: Long) {
    purgeLocked(writableDatabase, nowMs, maxAgeMs)
  }

  private fun purgeLocked(db: SQLiteDatabase, nowMs: Long, maxAgeMs: Long) {
    val cutoff = nowMs - maxAgeMs
    db.delete("queue", "created_at < ?", arrayOf(cutoff.toString()))
    db.delete("seen", "seen_at < ?", arrayOf(cutoff.toString()))
  }

  @Synchronized
  fun count(): Int = countLocked(readableDatabase)

  private fun countLocked(db: SQLiteDatabase): Int =
    db.rawQuery("SELECT COUNT(*) FROM queue", null).use { c -> if (c.moveToFirst()) c.getInt(0) else 0 }

  /** The oldest [limit] rows, oldest first. */
  @Synchronized
  fun oldest(limit: Int): List<Row> {
    val out = ArrayList<Row>()
    readableDatabase.rawQuery(
      "SELECT fp, payload, created_at, attempts FROM queue ORDER BY created_at ASC, fp ASC LIMIT ?",
      arrayOf(limit.toString()),
    ).use { c ->
      while (c.moveToNext()) out.add(Row(c.getString(0), c.getBlob(1), c.getLong(2), c.getInt(3)))
    }
    return out
  }

  @Synchronized
  fun delete(fps: Collection<String>) {
    if (fps.isEmpty()) return
    val db = writableDatabase
    db.beginTransaction()
    try {
      for (fp in fps) db.delete("queue", "fp = ?", arrayOf(fp))
      db.setTransactionSuccessful()
    } finally {
      db.endTransaction()
    }
  }

  @Synchronized
  fun bumpAttempts(fps: Collection<String>) {
    if (fps.isEmpty()) return
    val db = writableDatabase
    db.beginTransaction()
    try {
      for (fp in fps) db.execSQL("UPDATE queue SET attempts = attempts + 1 WHERE fp = ?", arrayOf<Any>(fp))
      db.setTransactionSuccessful()
    } finally {
      db.endTransaction()
    }
  }

  /** Empty both tables (a new device replaces the old one: 09's "Set up again"). */
  @Synchronized
  fun wipe() {
    val db = writableDatabase
    db.delete("queue", null, null)
    db.delete("seen", null, null)
  }
}

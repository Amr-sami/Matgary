import ExpoModulesCore

/**
 * Sets `NSURLIsExcludedFromBackupKey` on a single file so it is left out of
 * iCloud / Finder backups. The offline SQLite store (thestoro.db and its
 * -wal / -shm siblings) is the only caller today: it is a replayable cache
 * of tenant data, so it must not travel with the device backup.
 *
 * Synchronous on purpose — the caller runs right after the database is
 * opened, before the first render, and the attribute write is a single
 * syscall. Returns `false` (never throws) when the file is missing or the
 * attribute cannot be set.
 */
public class BackupExclusionModule: Module {
  public func definition() -> ModuleDefinition {
    Name("BackupExclusion")

    Function("setExcluded") { (path: String, excluded: Bool) -> Bool in
      // expo-sqlite hands us a plain filesystem path; expo-file-system hands
      // out file:// URIs. Accept both.
      let url: URL
      if path.hasPrefix("file://") {
        guard let parsed = URL(string: path) else { return false }
        url = parsed
      } else {
        url = URL(fileURLWithPath: path)
      }
      guard FileManager.default.fileExists(atPath: url.path) else { return false }

      var target = url
      var values = URLResourceValues()
      values.isExcludedFromBackup = excluded
      do {
        try target.setResourceValues(values)
        return true
      } catch {
        return false
      }
    }
  }
}

---
'@tanstack/browser-db-sqlite-persistence': patch
---

Make `BrowserWASQLiteDriver.close()` wait for every operation queued before it. Before, it closed the database at once, next to a statement that was still stepping, and wa-sqlite's `sqlite3_close` answered SQLITE_BUSY ("unable to close due to unfinalized statements"). A second call returns the same close.

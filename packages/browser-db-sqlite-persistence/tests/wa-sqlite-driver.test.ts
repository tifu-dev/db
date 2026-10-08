import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runSQLiteDriverContractSuite } from '../../db-sqlite-persistence-core/tests/contracts/sqlite-driver-contract'
import { BrowserWASQLiteDriver } from '../src/wa-sqlite-driver'
import { createWASQLiteTestDatabase } from './helpers/wa-sqlite-test-db'
import type { BrowserWASQLiteDatabase } from '../src/wa-sqlite-driver'
import type { SQLiteDriverContractHarness } from '../../db-sqlite-persistence-core/tests/contracts/sqlite-driver-contract'

function createDriverHarness(): SQLiteDriverContractHarness {
  const tempDirectory = mkdtempSync(join(tmpdir(), `db-browser-wa-sqlite-`))
  const dbPath = join(tempDirectory, `state.sqlite`)
  const database = createWASQLiteTestDatabase({ filename: dbPath })
  const driver = new BrowserWASQLiteDriver({ database })

  return {
    driver,
    cleanup: async () => {
      try {
        await driver.close()
      } finally {
        rmSync(tempDirectory, { recursive: true, force: true })
      }
    },
  }
}

runSQLiteDriverContractSuite(`browser wa-sqlite driver`, createDriverHarness)

/**
 * A database whose statements finish only when the test releases them, and whose close
 * fails the way wa-sqlite's `sqlite3_close` does while a statement is still stepping
 * (SQLITE_BUSY, "unable to close due to unfinalized statements").
 */
function createHeldDatabase() {
  const events: Array<string> = []
  const pending: Array<() => void> = []
  let inFlight = 0
  const database: BrowserWASQLiteDatabase = {
    execute: <TRow = unknown>(sql: string) => {
      inFlight++
      events.push(`start ${sql}`)
      return new Promise<ReadonlyArray<TRow>>((resolve) => {
        pending.push(() => {
          inFlight--
          events.push(`end ${sql}`)
          resolve([])
        })
      })
    },
    close: () => {
      if (inFlight > 0) {
        throw new Error(
          `SQLITE_BUSY: unable to close due to unfinalized statements`,
        )
      }
      events.push(`close`)
    },
  }
  const releaseNext = async (): Promise<void> => {
    for (let attempt = 0; attempt < 10 && pending.length === 0; attempt++) {
      await Promise.resolve()
    }
    pending.shift()?.()
  }
  return { database, events, releaseNext }
}

describe(`browser wa-sqlite driver close`, () => {
  it(`waits for a statement queued before it`, async () => {
    const { database, events, releaseNext } = createHeldDatabase()
    const driver = new BrowserWASQLiteDriver({ database })

    const query = driver.query(`SELECT 1`)
    const closed = driver.close()
    await releaseNext()

    await expect(query).resolves.toEqual([])
    await expect(closed).resolves.toBeUndefined()
    expect(events).toEqual([`start SELECT 1`, `end SELECT 1`, `close`])
  })

  it(`waits for a transaction queued before it to commit`, async () => {
    const { database, events, releaseNext } = createHeldDatabase()
    const driver = new BrowserWASQLiteDriver({ database })

    const transaction = driver.transaction(async (transactionDriver) => {
      await transactionDriver.run(`INSERT INTO t VALUES (1)`)
    })
    const closed = driver.close()
    await releaseNext()
    await releaseNext()
    await releaseNext()

    await expect(transaction).resolves.toBeUndefined()
    await expect(closed).resolves.toBeUndefined()
    expect(events.slice(-2)).toEqual([`end COMMIT`, `close`])
  })

  it(`closes the database once when called twice`, async () => {
    const { database, events } = createHeldDatabase()
    const driver = new BrowserWASQLiteDriver({ database })

    await Promise.all([driver.close(), driver.close()])

    expect(events).toEqual([`close`])
  })
})

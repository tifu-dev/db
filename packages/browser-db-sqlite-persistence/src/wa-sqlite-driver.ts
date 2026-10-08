import {
  InvalidPersistedCollectionConfigError,
  SQLITE_DRIVER_SHARED_LOGICAL_SCHEDULING_KEY,
} from '@tanstack/db-sqlite-persistence-core'
import type { SQLiteDriver } from '@tanstack/db-sqlite-persistence-core'

export type BrowserWASQLiteDatabase = {
  execute: <TRow = unknown>(
    sql: string,
    params?: ReadonlyArray<unknown>,
  ) => Promise<ReadonlyArray<TRow>>
  close?: () => Promise<void> | void
}

export type BrowserWASQLiteDriverOptions = {
  database: BrowserWASQLiteDatabase
}

type DatabaseExecutionState = {
  queue: Promise<void>
  nextSavepointId: number
}

const databaseExecutionStates = new WeakMap<
  BrowserWASQLiteDatabase,
  DatabaseExecutionState
>()

function getDatabaseExecutionState(
  database: BrowserWASQLiteDatabase,
): DatabaseExecutionState {
  const existing = databaseExecutionStates.get(database)
  if (existing) {
    return existing
  }

  const state: DatabaseExecutionState = {
    queue: Promise.resolve(),
    nextSavepointId: 1,
  }
  databaseExecutionStates.set(database, state)
  return state
}

function assertTransactionCallbackHasDriverArg(
  fn: (transactionDriver: SQLiteDriver) => Promise<unknown>,
): void {
  if (fn.length > 0) {
    return
  }

  throw new InvalidPersistedCollectionConfigError(
    `SQLiteDriver.transaction callback must accept the transaction driver argument`,
  )
}

function assertDatabaseShape(
  database: BrowserWASQLiteDatabase,
): asserts database is BrowserWASQLiteDatabase {
  if (typeof database.execute !== `function`) {
    throw new InvalidPersistedCollectionConfigError(
      `Browser wa-sqlite database handle must provide execute(sql, params?)`,
    )
  }
}

export class BrowserWASQLiteDriver implements SQLiteDriver {
  readonly [SQLITE_DRIVER_SHARED_LOGICAL_SCHEDULING_KEY] = {}
  private readonly database: BrowserWASQLiteDatabase
  private readonly executionState: DatabaseExecutionState
  private closing: Promise<void> | null = null

  constructor(options: BrowserWASQLiteDriverOptions) {
    assertDatabaseShape(options.database)
    this.database = options.database
    this.executionState = getDatabaseExecutionState(this.database)
  }

  exec(sql: string): Promise<void> {
    return this.enqueue(async () => {
      await this.database.execute(sql)
    })
  }

  query<T>(
    sql: string,
    params: ReadonlyArray<unknown> = [],
  ): Promise<ReadonlyArray<T>> {
    return this.enqueue(() => this.database.execute<T>(sql, params))
  }

  run(sql: string, params: ReadonlyArray<unknown> = []): Promise<void> {
    return this.enqueue(async () => {
      await this.database.execute(sql, params)
    })
  }

  transaction<T>(
    fn: (transactionDriver: SQLiteDriver) => Promise<T>,
  ): Promise<T> {
    try {
      assertTransactionCallbackHasDriverArg(fn)
    } catch (error) {
      return Promise.reject(error)
    }

    return this.enqueue(async () => {
      await this.database.execute(`BEGIN IMMEDIATE`)
      try {
        const result = await fn(this.createTransactionDriver())
        await this.database.execute(`COMMIT`)
        return result
      } catch (error) {
        try {
          await this.database.execute(`ROLLBACK`)
        } catch {
          // Preserve original transaction error.
        }
        throw error
      }
    })
  }

  transactionWithDriver<T>(
    fn: (transactionDriver: SQLiteDriver) => Promise<T>,
  ): Promise<T> {
    return this.transaction(fn)
  }

  /**
   * Closes the database after every operation queued before the call has
   * settled. wa-sqlite's `sqlite3_close` refuses with SQLITE_BUSY ("unable to
   * close due to unfinalized statements") while a statement is still stepping,
   * and a worker that starts each message as it arrives would otherwise run the
   * close next to it.
   */
  close(): Promise<void> {
    this.closing ??= this.enqueue(async () => {
      if (typeof this.database.close === `function`) {
        await Promise.resolve(this.database.close())
      }
    })
    return this.closing
  }

  getDatabase(): BrowserWASQLiteDatabase {
    return this.database
  }

  private createTransactionDriver(): SQLiteDriver {
    return {
      exec: (sql) => this.database.execute(sql).then(() => undefined),
      query: <T>(sql: string, params: ReadonlyArray<unknown> = []) =>
        this.database.execute<T>(sql, params),
      run: (sql: string, params: ReadonlyArray<unknown> = []) =>
        this.database.execute(sql, params).then(() => undefined),
      transaction: <T>(fn: (transactionDriver: SQLiteDriver) => Promise<T>) =>
        this.runNestedTransaction(fn),
      transactionWithDriver: <T>(
        fn: (transactionDriver: SQLiteDriver) => Promise<T>,
      ) => this.runNestedTransaction(fn),
    }
  }

  private async runNestedTransaction<T>(
    fn: (transactionDriver: SQLiteDriver) => Promise<T>,
  ): Promise<T> {
    assertTransactionCallbackHasDriverArg(fn)

    const savepointName = `tsdb_sp_${this.executionState.nextSavepointId}`
    this.executionState.nextSavepointId++
    await this.database.execute(`SAVEPOINT ${savepointName}`)
    try {
      const result = await fn(this.createTransactionDriver())
      await this.database.execute(`RELEASE SAVEPOINT ${savepointName}`)
      return result
    } catch (error) {
      await this.database.execute(`ROLLBACK TO SAVEPOINT ${savepointName}`)
      await this.database.execute(`RELEASE SAVEPOINT ${savepointName}`)
      throw error
    }
  }

  private enqueue<T>(operation: () => Promise<T> | T): Promise<T> {
    const queuedOperation = this.executionState.queue.then(operation, operation)
    // Brand the exact Promise returned to callers. Transparent wrappers may
    // preserve this identity for late discovery; wrappers that create a new
    // Promise must forward the driver key before adapter construction.
    Object.defineProperty(
      queuedOperation,
      SQLITE_DRIVER_SHARED_LOGICAL_SCHEDULING_KEY,
      { value: this[SQLITE_DRIVER_SHARED_LOGICAL_SCHEDULING_KEY] },
    )
    this.executionState.queue = queuedOperation.then(
      () => undefined,
      () => undefined,
    )
    return queuedOperation
  }
}

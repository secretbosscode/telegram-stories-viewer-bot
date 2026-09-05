import Database from 'better-sqlite3';

/**
 * Synchronous SQLite access layer.
 *
 * Historically this wrapped the asynchronous `sqlite3` driver and spun the event
 * loop with `deasync` until each callback fired. That re-entered the event loop
 * from inside every query, so unrelated timers, Telegram updates and queue
 * callbacks could run *in the middle of* a transaction. It was the root cause
 * of the payment rollbacks and the queue re-entrancy seen in production.
 *
 * `better-sqlite3` is genuinely synchronous: a call returns only when SQLite
 * has finished, and nothing else runs meanwhile. The public surface of this
 * class is kept identical so no caller changes.
 *
 * The on-disk format is plain SQLite; existing databases open unchanged.
 */

interface RunInfo {
  changes: number;
  lastInsertRowid: number | bigint;
}

// get()/all() return `any`, as the previous driver did: every call site casts
// the row to its own interface (`as MonitorRow[]`), and a structural Row type
// makes those casts fail to compile.
interface PreparedStatement {
  run: (...params: unknown[]) => RunInfo;
  get: (...params: unknown[]) => any;
  all: (...params: unknown[]) => any[];
}

/**
 * The previous driver coerced JavaScript values that SQLite cannot bind
 * directly. better-sqlite3 throws instead, so normalise here to keep every
 * existing call site working: booleans become 0/1, `undefined` becomes NULL and
 * Dates become their millisecond timestamp (the old driver's behaviour).
 * Plain objects are named-parameter maps and are normalised recursively.
 */
function normalizeParam(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return value.getTime();
  if (Array.isArray(value)) return value.map(normalizeParam);
  if (
    value !== null &&
    typeof value === 'object' &&
    !Buffer.isBuffer(value) &&
    !(value instanceof Uint8Array)
  ) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = normalizeParam(entry);
    }
    return out;
  }
  return value;
}

function normalizeParams(params: unknown[]): unknown[] {
  return params.map(normalizeParam);
}

export default class SyncDatabase {
  private readonly db: Database.Database;
  // Prepared statements are cached per SQL string. They are cleared on exec()
  // because that is where schema changes (DDL) come from.
  private readonly statements = new Map<string, Database.Statement>();

  constructor(filename: string) {
    this.db = new Database(filename);
    // better-sqlite3 enables foreign-key enforcement on every connection; the
    // previous driver used SQLite's default, which leaves it off. Existing
    // databases were written for years under that default, so turning it on
    // here would make ordinary updates/deletes fail on rows that already
    // violate a constraint. Keep the previous behaviour; enabling enforcement
    // is a separate migration decision, not part of a driver swap.
    this.db.pragma('foreign_keys = OFF');
    // Wait for a lock instead of failing immediately with SQLITE_BUSY when a
    // WAL checkpoint or backup briefly holds the file.
    this.db.pragma('busy_timeout = 5000');
  }

  exec(sql: string): void {
    this.statements.clear();
    this.db.exec(sql);
  }

  /**
   * Flushes and closes the underlying handle. Called on shutdown so pending
   * writes are committed rather than left to journal recovery on next boot.
   */
  close(): void {
    this.statements.clear();
    this.db.close();
  }

  prepare(sql: string): PreparedStatement {
    const statement = (): Database.Statement => {
      let stmt = this.statements.get(sql);
      if (!stmt) {
        stmt = this.db.prepare(sql);
        if (this.statements.size >= 256) this.statements.clear();
        this.statements.set(sql, stmt);
      }
      return stmt;
    };

    return {
      run: (...params: unknown[]): RunInfo => {
        const info = statement().run(...normalizeParams(params));
        return { changes: info.changes, lastInsertRowid: info.lastInsertRowid };
      },
      get: (...params: unknown[]): any => {
        const stmt = statement();
        // The old driver returned `undefined` when a write statement was read
        // with get(); better-sqlite3 throws. Preserve the old behaviour.
        if (!stmt.reader) {
          stmt.run(...normalizeParams(params));
          return undefined;
        }
        return stmt.get(...normalizeParams(params));
      },
      all: (...params: unknown[]): any[] => {
        const stmt = statement();
        if (!stmt.reader) {
          stmt.run(...normalizeParams(params));
          return [];
        }
        return stmt.all(...normalizeParams(params));
      },
    };
  }
}

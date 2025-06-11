import sqlite3 from 'sqlite3';
import deasync from 'deasync';

export default class SyncDatabase {
  private db: sqlite3.Database;

  constructor(filename: string) {
    sqlite3.verbose();
    this.db = new sqlite3.Database(filename);
  }

  exec(sql: string): void {
    let done = false;
    let err: Error | null = null;
    this.db.exec(sql, (e) => { err = e ?? null; done = true; });
    deasync.loopWhile(() => !done);
    if (err) throw err;
  }

  prepare(sql: string) {
    const db = this.db;
    return {
      run: (...params: any[]) => {
        let done = false;
        let err: Error | null = null;
        let info: { changes: number; lastID: number } = { changes: 0, lastID: 0 };
        const stmt = db.prepare(sql, (e) => { if (e) { err = e; done = true; }});
        deasync.loopWhile(() => !stmt);
        stmt.run(params, function(e) {
          err = e ?? null;
          info = { changes: this.changes, lastID: this.lastID };
          done = true;
        });
        deasync.loopWhile(() => !done);
        stmt.finalize();
        if (err) throw err;
        return { changes: info.changes, lastInsertRowid: info.lastID };
      },
      get: (...params: any[]) => {
        let done = false;
        let err: Error | null = null;
        let row: any;
        const stmt = db.prepare(sql, (e) => { if (e) { err = e; done = true; }});
        deasync.loopWhile(() => !stmt);
        stmt.get(params, (e, r) => { err = e ?? null; row = r; done = true; });
        deasync.loopWhile(() => !done);
        stmt.finalize();
        if (err) throw err;
        return row;
      },
      all: (...params: any[]) => {
        let done = false;
        let err: Error | null = null;
        let rows: any[] = [];
        const stmt = db.prepare(sql, (e) => { if (e) { err = e; done = true; }});
        deasync.loopWhile(() => !stmt);
        stmt.all(params, (e, r) => { err = e ?? null; rows = r || []; done = true; });
        deasync.loopWhile(() => !done);
        stmt.finalize();
        if (err) throw err;
        return rows;
      },
    };
  }
}

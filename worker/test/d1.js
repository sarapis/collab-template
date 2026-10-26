// A D1 database for tests: real SQLite (node:sqlite) behind D1's interface,
// with worker/schema.sql applied.
//
// ⚠️ Real SQL rather than a hand-written fake, for the content rows above all:
// a version and its live pointer move in ONE batch, and only a database that
// actually rolls a failed batch back can show that a refused save leaves
// nothing behind. A fake that records calls would pass while the real thing
// half-wrote.
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = new URL('../schema.sql', import.meta.url);

class Statement {
  constructor(db, sql, args = []) { this.db = db; this.sql = sql; this.args = args; }
  bind(...args) { return new Statement(this.db, this.sql, args.map((a) => (a === undefined ? null : a))); }
  async first(col) {
    const row = this.db.prepare(this.sql).get(...this.args);
    if (!row) return null;
    return col ? row[col] : { ...row };
  }
  async all() { return { results: this.db.prepare(this.sql).all(...this.args).map((r) => ({ ...r })), success: true }; }
  async run() {
    const r = this.db.prepare(this.sql).run(...this.args);
    return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
}

export function d1() {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(SCHEMA, 'utf8'));
  return {
    raw: db,
    prepare: (sql) => new Statement(db, sql),
    // D1's batch is a transaction: all or nothing, and one at a time.
    // ⚠️ Run WITHOUT yielding between statements. Awaiting each one let a second
    // batch start inside the first's transaction, which D1 never does: two
    // requests creating a task at once must each see the other's row or none.
    async batch(stmts) {
      db.exec('BEGIN');
      try {
        const out = [];
        for (const s of stmts) {
          const r = db.prepare(s.sql).run(...s.args);
          out.push({ success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } });
        }
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    async exec(sql) { db.exec(sql); return { count: 1 }; },
  };
}

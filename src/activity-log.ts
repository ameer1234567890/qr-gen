import { DurableObject } from "cloudflare:workers";

export interface LogEntry {
  ts: string;
  user: string;
  action: string;
  detail: string;
  ip: string;
}

const MAX_LOG = 1000;

/**
 * One global instance holds everything that must outlive a single request:
 * sessions, the activity log, and the sign-in attempt limiter. Being a single
 * SQLite-backed Durable Object means every read-modify-write below is atomic.
 */
export class ActivityLog extends DurableObject {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS log (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         ts TEXT NOT NULL, user TEXT NOT NULL, action TEXT NOT NULL,
         detail TEXT NOT NULL, ip TEXT NOT NULL)`,
    );
    this.sql.exec(`CREATE INDEX IF NOT EXISTS log_ip ON log (ip, ts)`);
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS sessions (
         token_hash TEXT PRIMARY KEY, user TEXT NOT NULL, expires INTEGER NOT NULL)`,
    );
  }

  // ---------- activity log ----------

  record(e: LogEntry): void {
    this.sql.exec(
      `INSERT INTO log (ts, user, action, detail, ip) VALUES (?, ?, ?, ?, ?)`,
      e.ts, e.user, e.action, e.detail, e.ip,
    );
    this.prune();
  }

  /** Newest first. In-flight sign-in reservations are hidden. */
  list(): LogEntry[] {
    return this.sql
      .exec<LogEntry>(
        `SELECT ts, user, action, detail, ip FROM log
         WHERE action != 'login_pending' ORDER BY id DESC LIMIT ?`,
        MAX_LOG,
      )
      .toArray();
  }

  private prune(): void {
    this.sql.exec(`DELETE FROM log WHERE id <= (SELECT MAX(id) FROM log) - ?`, MAX_LOG);
  }

  // ---------- sign-in, with a per-IP attempt limit ----------

  /**
   * Reserves a sign-in attempt for `ip`. Returns null when the IP has already
   * used up its attempts in the window. Reserving *before* credentials are
   * checked (and atomically) means parallel guesses cannot slip past the limit.
   */
  beginLogin(ip: string, ts: string, sinceTs: string, limit: number): number | null {
    const { n } = this.sql
      .exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM log
         WHERE ip = ? AND ts >= ? AND action IN ('login_failed', 'login_pending')`,
        ip, sinceTs,
      )
      .one();
    if (n >= limit) return null;
    const { id } = this.sql
      .exec<{ id: number }>(
        `INSERT INTO log (ts, user, action, detail, ip)
         VALUES (?, '-', 'login_pending', 'Sign-in in progress', ?) RETURNING id`,
        ts, ip,
      )
      .one();
    this.prune();
    return id;
  }

  failLogin(id: number, user: string): void {
    this.sql.exec(
      `UPDATE log SET user = ?, action = 'login_failed', detail = 'Incorrect credentials' WHERE id = ?`,
      user, id,
    );
  }

  completeLogin(id: number, user: string, tokenHash: string, expires: number): void {
    this.sql.exec(
      `UPDATE log SET user = ?, action = 'login', detail = 'Signed in' WHERE id = ?`,
      user, id,
    );
    this.sql.exec(`DELETE FROM sessions WHERE expires <= ?`, Date.now());
    this.sql.exec(
      `INSERT OR REPLACE INTO sessions (token_hash, user, expires) VALUES (?, ?, ?)`,
      tokenHash, user, expires,
    );
  }

  // ---------- sessions ----------

  getSession(tokenHash: string): string | null {
    const rows = this.sql
      .exec<{ user: string }>(
        `SELECT user FROM sessions WHERE token_hash = ? AND expires > ?`,
        tokenHash, Date.now(),
      )
      .toArray();
    return rows.length ? rows[0].user : null;
  }

  deleteSession(tokenHash: string): void {
    this.sql.exec(`DELETE FROM sessions WHERE token_hash = ?`, tokenHash);
  }
}

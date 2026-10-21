import type { Row } from './types';

const TABLES = new Set([
  'app_settings',
  'admin_users',
  'groups',
  'sources',
  'channels',
  'streams',
  'channel_aliases',
  'profiles',
  'profile_channels',
  'viewers',
  'subscriptions',
  'access_logs',
  'sessions',
]);
export class Store {
  constructor(public db: D1Database) {}
  statement(sql: string, args: unknown[] = []) {
    return this.db
      .prepare(sql)
      .bind(...args.map((v) => (v === undefined ? null : typeof v === 'boolean' ? Number(v) : v)));
  }
  async all(sql: string, args: unknown[] = []): Promise<Row[]> {
    return (await this.statement(sql, args).all<Row>()).results;
  }
  async one(sql: string, args: unknown[] = []): Promise<Row | null> {
    return this.statement(sql, args).first<Row>();
  }
  async scalar(sql: string, args: unknown[] = []): Promise<any> {
    const row = await this.one(sql, args);
    return row ? Object.values(row)[0] : null;
  }
  async run(sql: string, args: unknown[] = []) {
    return this.statement(sql, args).run();
  }
  async setting(key: string, fallback = '') {
    return String(
      (await this.one('SELECT value FROM app_settings WHERE key=?', [key]))?.value ?? fallback,
    );
  }
  settingStatement(key: string, value: unknown) {
    return this.statement(
      'INSERT INTO app_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP',
      [key, String(value)],
    );
  }
  async settings(): Promise<Record<string, string>> {
    return Object.fromEntries(
      (await this.all('SELECT key,value FROM app_settings')).map((r) => [r.key, r.value]),
    );
  }
  async write(statements: D1PreparedStatement[]) {
    // D1 batch is transactional. A failed statement rolls back every mutation.
    return this.db.batch([
      ...statements,
      this.statement(
        "INSERT INTO app_settings(key,value) VALUES('db_version','1') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1,updated_at=CURRENT_TIMESTAMP",
      ),
    ]);
  }
  insert(table: string, row: Row) {
    if (!TABLES.has(table)) throw new Error('Invalid table');
    const keys = Object.keys(row);
    if (keys.some((k) => !/^[a-z_][a-z0-9_]*$/.test(k))) throw new Error('Invalid column');
    return this.statement(
      `INSERT INTO ${table}(${keys.map((k) => `"${k}"`).join(',')}) VALUES(${keys.map(() => '?').join(',')})`,
      keys.map((k) => row[k]),
    );
  }
  update(table: string, id: number, row: Row) {
    if (!TABLES.has(table)) throw new Error('Invalid table');
    const keys = Object.keys(row);
    if (keys.some((k) => !/^[a-z_][a-z0-9_]*$/.test(k))) throw new Error('Invalid column');
    return this.statement(
      `UPDATE ${table} SET ${keys.map((k) => `"${k}"=?`).join(',')} WHERE id=?`,
      [...keys.map((k) => row[k]), id],
    );
  }
  bulkInsert(table: string, rows: Row[]) {
    if (!TABLES.has(table) || !rows.length) throw new Error('Invalid bulk insert');
    const keys = Object.keys(rows[0]);
    if (keys.some((k) => !/^[a-z_][a-z0-9_]*$/.test(k))) throw new Error('Invalid column');
    return this.statement(
      `INSERT INTO ${table}(${keys.map((k) => `"${k}"`).join(',')}) SELECT ${keys.map((k) => `json_extract(value,'$.${k}')`).join(',')} FROM json_each(?)`,
      [JSON.stringify(rows)],
    );
  }
}

export const int = (v: unknown, fallback = 0): number => {
  const n = Number(v);
  return v !== '' && v != null && Number.isFinite(n) ? Math.trunc(n) : fallback;
};
export const bool = (v: unknown, fallback = false): boolean =>
  v == null || v === '' ? fallback : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
export const json = <T = any>(v: unknown, fallback: T): T => {
  try {
    return JSON.parse(String(v));
  } catch {
    return fallback;
  }
};
export const csv = (v: unknown): string[] =>
  String(v ?? '')
    .split(/[,，\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
export const now = () => new Date().toISOString().replace('T', ' ').replace('Z', '');
export const version = (settings: Record<string, string>) => int(settings.db_version, 1);

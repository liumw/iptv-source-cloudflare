import { Store, json } from './store';
import type { Row } from './types';
import { withCatalogLock } from './catalog-lock';

export const lineIdentity = (line: Row) =>
  line.url + '\n' + JSON.stringify(json<Row>(line.attrs_json, {}).vlc_opts ?? []);

export async function pendingRows(store: Store): Promise<Row[]> {
  return (
    await store.all(`SELECT p.*,g.name group_name,count(s.id) stream_count
    FROM pending_channels p LEFT JOIN groups g ON g.id=p.group_id
    LEFT JOIN streams s ON s.pending_channel_id=p.id GROUP BY p.id ORDER BY p.name,p.id`)
  ).map((p) => ({ ...p, group: p.group_name ? { name: p.group_name } : null }));
}

export async function reviewLines(
  store: Store,
  column: 'channel_id' | 'pending_channel_id',
  id: number,
) {
  return store.all(
    `SELECT s.*,src.name source_name FROM streams s JOIN sources src ON src.id=s.source_id
    WHERE s.${column}=? ORDER BY s.is_default DESC,s.priority DESC,s.id`,
    [id],
  );
}

export function displayLines(lines: Row[], existing: Row[] = []) {
  const identities = new Set(existing.map(lineIdentity));
  return lines.map((s) => ({
    id: s.id,
    url: s.url,
    name: s.raw_name,
    source: s.source_name,
    network: s.network,
    carrier: s.carrier,
    region: s.region,
    enabled: !!s.enabled,
    excluded: !!s.excluded,
    is_default: !!s.is_default,
    duplicate: identities.has(lineIdentity(s)),
    options: json<Row>(s.attrs_json, {}).vlc_opts ?? [],
  }));
}

function legacyLinks(store: Store, pending: Row, target: number | string) {
  const metadata = json<Row>(pending.legacy_json, {}),
    statements: D1PreparedStatement[] = [];
  for (const alias of metadata.aliases ?? [])
    statements.push(
      store.statement(
        `INSERT OR IGNORE INTO channel_aliases(channel_id,alias,alias_norm) VALUES(${target},?,?)`,
        [alias.alias, alias.alias_norm],
      ),
    );
  for (const link of metadata.profiles ?? [])
    statements.push(
      store.statement(
        `INSERT OR IGNORE INTO profile_channels(channel_id,profile_id,include,chno_override,sort_override) VALUES(${target},?,?,?,?)`,
        [link.profile_id, link.include, link.chno_override, link.sort_override],
      ),
    );
  return statements;
}

export async function confirmPending(store: Store, ids: number[]) {
  return withCatalogLock(store, async () => {
    const rows = await store.all(
      'SELECT * FROM pending_channels WHERE id IN (SELECT value FROM json_each(?))',
      [JSON.stringify(ids)],
    );
    if (rows.length !== ids.length) throw new Error('待确认数据已变化，请刷新后重试');
    const official = await store.all('SELECT key,chno FROM channels');
    const keys = new Set(official.map((ch) => ch.key));
    const numbers = new Set(official.filter((ch) => ch.chno != null).map((ch) => ch.chno));
    for (const pending of rows) {
      if (keys.has(pending.key))
        throw new Error(`「${pending.name}」已存在于正式频道库，请选择线路合并`);
      if (pending.chno != null && numbers.has(pending.chno))
        throw new Error(`「${pending.name}」的台号已被占用，请先处理台号冲突`);
      if (pending.chno != null) numbers.add(pending.chno);
    }
    if (!rows.length) return 0;
    const payload = JSON.stringify(ids);
    const columns =
      'key,name,group_id,logo,tvg_id,chno,region,region_manual,adult,enabled,priority,notes,created_at,updated_at';
    const statements: D1PreparedStatement[] = [
      store.statement(
        `INSERT INTO channels(${columns},auto_created,reviewed)
        SELECT ${columns},1,1 FROM pending_channels WHERE id IN (SELECT value FROM json_each(?))`,
        [payload],
      ),
      store.statement(
        `UPDATE streams SET channel_id=(SELECT c.id FROM channels c JOIN pending_channels p ON p.key=c.key WHERE p.id=streams.pending_channel_id),pending_channel_id=NULL
        WHERE pending_channel_id IN (SELECT value FROM json_each(?))`,
        [payload],
      ),
    ];
    for (const pending of rows) {
      const target = `(SELECT c.id FROM channels c JOIN pending_channels p ON p.key=c.key WHERE p.id=${pending.id})`;
      statements.push(...legacyLinks(store, pending, target));
    }
    statements.push(
      store.statement('DELETE FROM pending_channels WHERE id IN (SELECT value FROM json_each(?))', [
        payload,
      ]),
    );
    await store.write(statements);
    return rows.length;
  });
}

export async function mergePending(
  store: Store,
  pendingID: number,
  targetID: number,
  ids: number[],
) {
  if (!ids.length || ids.length > 5000) throw new Error('请至少选择一条要合并的线路');
  return withCatalogLock(store, async () => {
    const pending = await store.one('SELECT * FROM pending_channels WHERE id=?', [pendingID]);
    const target = await store.one('SELECT * FROM channels WHERE id=?', [targetID]);
    if (!pending || !target) throw new Error('待确认频道或正式目标已变化，请刷新后重试');
    const lines = await reviewLines(store, 'pending_channel_id', pendingID);
    const chosen = lines.filter((s) => ids.includes(s.id));
    if (chosen.length !== ids.length)
      throw new Error('选中的线路已变化或不属于此待确认频道，请重新选择');
    const existing = new Set((await reviewLines(store, 'channel_id', targetID)).map(lineIdentity));
    for (const line of chosen) {
      const identity = lineIdentity(line);
      if (existing.has(identity)) throw new Error('所选线路与目标已有线路重复，请重新选择');
      existing.add(identity);
    }
    const statements = [
      store.statement(
        `UPDATE streams SET pending_channel_id=NULL,channel_id=?,is_default=0
      WHERE pending_channel_id=? AND id IN (SELECT value FROM json_each(?))`,
        [targetID, pendingID, JSON.stringify(ids)],
      ),
    ];
    statements.push(
      store.statement(
        `DELETE FROM pending_channels WHERE id=?
      AND NOT EXISTS(SELECT 1 FROM streams WHERE pending_channel_id=?)`,
        [pendingID, pendingID],
      ),
    );
    await store.write(statements);
    return { moved: chosen.length, remaining: lines.length - chosen.length };
  });
}

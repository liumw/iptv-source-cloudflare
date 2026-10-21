import constants from './constants.json';
import { normalizeKey } from './ingest';
import { sha256 } from './security';
import { Store } from './store';

export class ChannelInputError extends Error {}

export async function manualSourceStatement(store: Store) {
  const collision = await store.one(
    "SELECT id FROM sources WHERE name='手工线路' AND origin!='manual'",
  );
  const name = collision ? `手工线路-${crypto.randomUUID().slice(0, 8)}` : '手工线路';
  return store.statement(
    "INSERT INTO sources(name,origin,format) SELECT ?,'manual','single' WHERE NOT EXISTS(SELECT 1 FROM sources WHERE origin='manual')",
    [name],
  );
}

export async function createManualChannel(store: Store, form: FormData) {
  const text = (key: string, fallback = '') => String(form.get(key) ?? fallback).trim();
  const name = text('name');
  if (!name || name.length > 128) throw new ChannelInputError('频道名称需为 1–128 个字符。');
  const group = text('group_name');
  const tvgID = text('tvg_id');
  if (group.length > 128 || tvgID.length > 128)
    throw new ChannelInputError('分组名称和 tvg-id 最多为 128 个字符。');
  const region = text('region', 'national');
  const network = text('network', 'all');
  const carrier = text('carrier', 'all');
  if (!Object.hasOwn(constants.REGIONS, region)) throw new ChannelInputError('请选择有效地区。');
  if (!constants.NETWORKS.includes(network) || !constants.CARRIERS.includes(carrier))
    throw new ChannelInputError('请选择有效的网络类型和运营商。');
  const number = text('chno');
  if (number && (!/^\d+$/.test(number) || !Number.isSafeInteger(Number(number))))
    throw new ChannelInputError('台号必须为非负整数，或留空自动编号。');
  const url = text('url');
  if (url && !/^(?:https?|rtsp|rtsps|rtmp|rtmps|udp|rtp):\/\/[^\s]+$/i.test(url))
    throw new ChannelInputError('播放地址无效，请填写完整播放地址，或留空后再添加线路。');
  const logo = text('logo');
  if (logo && !/^https?:\/\/[^\s]+$/i.test(logo))
    throw new ChannelInputError('台标需为完整的 HTTP 或 HTTPS 地址。');
  const key = normalizeKey(name).slice(0, 128) || `manual-${crypto.randomUUID()}`;
  if (await store.one('SELECT id FROM channels WHERE key=? OR name=?', [key, name]))
    throw new ChannelInputError('该频道已存在，请打开现有频道添加线路。');
  const adult = form.has('adult') ? 1 : 0;
  const statements: D1PreparedStatement[] = [];
  if (group)
    statements.push(
      store.statement('INSERT INTO groups(name) VALUES(?) ON CONFLICT(name) DO NOTHING', [group]),
    );
  statements.push(
    store.statement(
      'INSERT INTO channels(key,name,group_id,region,region_manual,chno,tvg_id,logo,notes,adult,auto_created,reviewed,enabled) VALUES(?,?,(SELECT id FROM groups WHERE name=?),?,1,?,?,?,?,?,0,1,1)',
      [
        key,
        name,
        group,
        region,
        number ? Number(number) : null,
        tvgID || null,
        logo || null,
        text('notes') || null,
        adult,
      ],
    ),
  );
  if (url) {
    // Do not reuse or overwrite an imported source that happens to have this display name.
    statements.push(
      await manualSourceStatement(store),
      store.statement(
        "INSERT INTO streams(source_id,channel_id,fingerprint,url,raw_name,network,carrier,region,network_manual,carrier_manual,region_manual,is_default,adult) VALUES((SELECT id FROM sources WHERE origin='manual' ORDER BY id LIMIT 1),(SELECT id FROM channels WHERE key=?),?,?,?,?,?,?,1,1,1,1,?)",
        [
          key,
          (await sha256(url + crypto.randomUUID())).slice(0, 40),
          url,
          name,
          network,
          carrier,
          region,
          adult,
        ],
      ),
    );
  }
  // Channel, optional group/source/stream, and playlist cache version commit together.
  await store.write(statements);
  return (await store.one('SELECT id FROM channels WHERE key=?', [key]))!.id as number;
}

export async function deleteChannels(store: Store, ids: number[]) {
  if (!ids.length) return;
  const selected = JSON.stringify(ids);
  await store.write([
    store.statement('DELETE FROM streams WHERE channel_id IN (SELECT value FROM json_each(?))', [
      selected,
    ]),
    store.statement(
      'DELETE FROM channel_aliases WHERE channel_id IN (SELECT value FROM json_each(?))',
      [selected],
    ),
    store.statement(
      'DELETE FROM profile_channels WHERE channel_id IN (SELECT value FROM json_each(?))',
      [selected],
    ),
    store.statement('DELETE FROM channels WHERE id IN (SELECT value FROM json_each(?))', [
      selected,
    ]),
  ]);
}

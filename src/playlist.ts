import constants from './constants.json';
import type { Row, ViewerEnv } from './types';
import { Store, int, json } from './store';
import { compatible } from './network';
import { sha256 } from './security';

export const reasonLabels: Record<string, string> = {
  ok: '可用',
  need_ipv4: '需要 IPv4',
  need_ipv6: '需要 IPv6',
  need_iptv: '需要 IPTV 专网',
  unknown_carrier: '运营商未知',
  carrier_mismatch: '运营商不匹配',
  region_mismatch: '区域不匹配',
  excluded: '已手动排除',
  adult: '成人内容',
  adult_only: '非成人内容',
  group: '分组不符合',
  channel_key: '频道不在清单',
  not_selected: '未在指定频道中',
  keyword: '关键词过滤',
  logo: '缺少台标',
  score: '健康分不足',
  network: '网络类型不符合',
  carrier: '运营商不符合',
  region: '区域不符合',
  no_stream: '无可用线路',
  limit: '超出数量限制',
};
export const configFor = (profile: Row): Row => ({
  ...constants.DEFAULT_PROFILE_CONFIG,
  ...json(profile.config_json, {}),
});
export function normalizePath(value: string): string {
  let path = value.trim().replace(/^\/+|\/+$/g, '');
  if (path.endsWith('/index.m3u') || path.endsWith('/index.m3u8'))
    path = path.slice(0, path.lastIndexOf('/'));
  else path = path.replace(/\.m3u8?$/i, '');
  return path.replace(/^\/+|\/+$/g, '');
}
export function validatePath(value: string): string | null {
  const path = normalizePath(value);
  if (
    !path ||
    path.length > 128 ||
    path.split('/').some((v) => !v || v === '.' || v === '..') ||
    !/^[\w\-\u4e00-\u9fff/]+$/u.test(path)
  )
    return '访问路径无效';
  if (constants.RESERVED_PATHS.includes(path.split('/')[0])) return '访问路径与系统保留路径冲突';
  return null;
}
export function contentAllowed(
  stream: Row,
  channel: Row,
  config: Row,
  explicit: boolean,
  exclude: Set<number>,
): string {
  if (exclude.has(channel.id)) return 'excluded';
  const adult = !!(stream.adult || channel.adult);
  if (config.only_adult && !adult) return 'adult_only';
  if (!config.only_adult && !config.allow_adult && adult) return 'adult';
  if (explicit) return 'ok';
  const group = channel.group?.name ?? '';
  for (const [field, value, reason] of [
    ['groups', group, 'group'],
    ['channel_keys', channel.key, 'channel_key'],
  ] as const) {
    if (config[`include_${field}`]?.length && !config[`include_${field}`].includes(value))
      return reason;
    if (config[`exclude_${field}`]?.includes(value)) return reason;
  }
  if (
    config.include_keywords?.length &&
    !config.include_keywords.some((k: string) => channel.name.includes(k))
  )
    return 'keyword';
  if (config.exclude_keywords?.some((k: string) => channel.name.includes(k))) return 'keyword';
  if (config.require_logo && !(channel.logo || stream.tvg_logo)) return 'logo';
  if (Number(stream.score) < Number(config.min_score || 0)) return 'score';
  if (
    config.networks?.length &&
    stream.network !== 'all' &&
    !config.networks.includes(stream.network)
  )
    return 'network';
  if (
    config.carriers?.length &&
    stream.carrier !== 'all' &&
    !config.carriers.includes(stream.carrier)
  )
    return 'carrier';
  if (
    config.regions?.length &&
    !(channel.region === 'national'
      ? config.regions.some((r: string) => r !== 'overseas')
      : config.regions.includes(channel.region))
  )
    return 'region';
  return 'ok';
}
export const attrEscape = (v: unknown) =>
  String(v)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/[\r\n]/g, ' ');
export function renderEntry(
  channel: Row,
  stream: Row,
  group: string,
  chno: number | null,
  ending: string,
): string {
  const attrs: Record<string, string> = {};
  if (channel.tvg_id || stream.tvg_id) attrs['tvg-id'] = channel.tvg_id || stream.tvg_id;
  attrs['tvg-name'] = channel.name;
  if (channel.logo || stream.tvg_logo) attrs['tvg-logo'] = channel.logo || stream.tvg_logo;
  attrs['group-title'] = group;
  if (chno != null) attrs['tvg-chno'] = String(chno);
  const payload = json<Row>(stream.attrs_json, {});
  for (const [key, value] of Object.entries(payload.attrs ?? {}))
    if (key !== 'tvg-chno' && !(key in attrs) && value) attrs[key] = String(value);
  for (const [key, prop] of [
    ['catchup', 'catchup'],
    ['catchup-source', 'catchup_source'],
    ['catchup-days', 'catchup_days'],
    ['timeshift', 'timeshift'],
  ])
    if (!(key in attrs) && stream[prop]) attrs[key] = stream[prop];
  const name = String(channel.name).replace(/[\r\n]/g, ' ');
  return [
    `#EXTINF:-1 ${Object.entries(attrs)
      .map(([k, v]) => `${k}="${attrEscape(v)}"`)
      .join(' ')},${name}`,
    ...(payload.vlc_opts ?? []),
    ...(payload.kodiprops ?? []),
    ...(payload.directives ?? []),
    stream.url,
  ].join(ending);
}
export async function loadRows(store: Store): Promise<{ stream: Row; channel: Row }[]> {
  const rows =
    await store.all(`SELECT s.*,c.id c_id,c.name c_name,c.key c_key,c.group_id c_group_id,c.logo c_logo,c.tvg_id c_tvg_id,c.chno c_chno,c.region c_region,c.adult c_adult,g.name c_group_name
    FROM streams s JOIN channels c ON c.id=s.channel_id JOIN sources src ON src.id=s.source_id LEFT JOIN groups g ON g.id=c.group_id
    WHERE s.enabled=1 AND s.excluded=0 AND c.enabled=1 AND src.enabled=1`);
  return rows.map((row) => ({
    stream: row,
    channel: {
      id: row.c_id,
      name: row.c_name,
      key: row.c_key,
      group_id: row.c_group_id,
      group: row.c_group_name ? { name: row.c_group_name } : null,
      logo: row.c_logo,
      tvg_id: row.c_tvg_id,
      chno: row.c_chno,
      region: row.c_region,
      adult: row.c_adult,
    },
  }));
}
export interface RenderResult {
  text: string;
  etag: string;
  stats: Row;
  channels: Row[];
}
export async function renderPlaylist(
  store: Store,
  subscription: Row,
  viewer: ViewerEnv,
  debug = false,
): Promise<RenderResult> {
  const profile =
    subscription.profile ??
    (await store.one('SELECT * FROM profiles WHERE id=?', [subscription.profile_id]));
  if (!profile) throw new Error('内容视图不存在');
  const config = configFor(profile),
    rows = await loadRows(store),
    overrides = await store.all('SELECT * FROM profile_channels WHERE profile_id=?', [profile.id]);
  const include = new Set<number>(
    overrides.filter((o) => o.include === 1).map((o) => o.channel_id),
  );
  const exclude = new Set<number>(
    overrides.filter((o) => o.include === 0).map((o) => o.channel_id),
  );
  const numbers = new Map<number, number | null>(),
    chnoOverrides = new Map<number, number>(),
    sortOverrides = new Map<number, number>();
  for (const o of overrides) {
    if (o.chno_override != null) chnoOverrides.set(o.channel_id, o.chno_override);
    if (o.sort_override != null) sortOverrides.set(o.channel_id, o.sort_override);
  }
  const buckets = new Map<number, { channel: Row; streams: Row[]; reasons: string[] }>(),
    reasons: Record<string, number> = {};
  const count = (reason: string) => (reasons[reason] = (reasons[reason] ?? 0) + 1);
  for (const { channel, stream } of rows) {
    if (include.size && !include.has(channel.id)) {
      count('not_selected');
      continue;
    }
    let reason = contentAllowed(stream, channel, config, include.has(channel.id), exclude);
    if (reason === 'ok') reason = compatible(stream, channel, viewer);
    if (reason !== 'ok') count(reason);
    const bucket = buckets.get(channel.id) ?? { channel, streams: [], reasons: [] };
    bucket.reasons.push(reason);
    if (reason === 'ok') bucket.streams.push(stream);
    buckets.set(channel.id, bucket);
  }
  const available: { channel: Row; streams: Row[]; reasons: string[] }[] = [],
    unavailable: Row[] = [];
  for (const bucket of buckets.values()) {
    if (!bucket.streams.length) {
      const reason = bucket.reasons.find((r) => r !== 'ok') ?? 'no_stream';
      unavailable.push({ name: bucket.channel.name, reason, label: reasonLabels[reason] });
      continue;
    }
    const seen = new Set<string>();
    bucket.streams.sort(
      (a, b) =>
        Number(b.is_default) - Number(a.is_default) ||
        b.priority - a.priority ||
        b.score - a.score ||
        a.id - b.id,
    );
    bucket.streams = bucket.streams.filter((s) => {
      if (seen.has(s.url)) return false;
      seen.add(s.url);
      return true;
    });
    available.push(bucket);
  }
  const groupRank = (ch: Row) => {
    const i = (config.group_order ?? []).indexOf(ch.group?.name ?? '');
    return i < 0 ? [1, ch.group_id ?? 9999] : [0, i];
  };
  const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
  available.sort((a, b) => {
    const x = groupRank(a.channel),
      y = groupRank(b.channel);
    return (
      x[0] - y[0] ||
      x[1] - y[1] ||
      (sortOverrides.get(a.channel.id) ?? 999999) - (sortOverrides.get(b.channel.id) ?? 999999) ||
      (a.channel.chno ?? chnoOverrides.get(a.channel.id) ?? 999999) -
        (b.channel.chno ?? chnoOverrides.get(b.channel.id) ?? 999999) ||
      collator.compare(a.channel.name, b.channel.name)
    );
  });
  if (config.max_channels) available.splice(Math.max(0, int(config.max_channels)));
  const maxStreams = int(config.max_streams_per_channel),
    step = Math.max(1, int(config.numbering_step, 1));
  if (maxStreams > 0) for (const b of available) b.streams = b.streams.slice(0, maxStreams);
  let current = Math.max(1, int(config.start_chno, 1));
  // Library numbers are authoritative in every mode, including zero and "none".
  // Reserve even filtered/empty channels so automatic numbers cannot steal their keys.
  const reserved = await store.all('SELECT chno FROM channels WHERE chno IS NOT NULL');
  const used = new Set<number>(reserved.map((c) => c.chno));
  for (const b of available) if (b.channel.chno != null) numbers.set(b.channel.id, b.channel.chno);
  if (config.numbering !== 'auto' && config.numbering !== 'none') {
    for (const b of available) {
      if (numbers.has(b.channel.id)) continue;
      const n = chnoOverrides.get(b.channel.id);
      if (n != null && !used.has(n)) {
        numbers.set(b.channel.id, n);
        used.add(n);
      }
    }
  }
  for (const b of available) {
    if (numbers.has(b.channel.id)) continue;
    if (config.numbering === 'none') numbers.set(b.channel.id, null);
    else {
      while (used.has(current)) current += step;
      numbers.set(b.channel.id, current);
      used.add(current);
      current += step;
    }
  }
  const ending = config.line_ending === 'crlf' ? '\r\n' : '\n',
    lines = ['#EXTM3U' + (config.epg_url ? ` x-tvg-url="${attrEscape(config.epg_url)}"` : '')];
  if (debug) lines.push(`# 环境: ${viewer.label} | 频道 ${available.length} 个`);
  const channels: Row[] = [];
  let emitted = 0;
  for (const bucket of available) {
    const ch = bucket.channel,
      group = config.flatten_groups
        ? config.flatten_group_name || '全部'
        : (config.group_map?.[ch.group?.name] ?? ch.group?.name ?? '未分组'),
      chno = numbers.get(ch.id) ?? null;
    for (const stream of bucket.streams) {
      lines.push(renderEntry(ch, stream, group, chno, ending));
      emitted++;
    }
    channels.push({
      ...ch,
      group,
      chno,
      logo: ch.logo || bucket.streams.find((s) => s.tvg_logo)?.tvg_logo || null,
      streams: bucket.streams.map((s) => ({
        id: s.id,
        url: s.url,
        network: s.network,
        carrier: s.carrier,
        is_default: !!s.is_default,
        priority: s.priority,
      })),
    });
  }
  const text = lines.join(ending) + ending,
    limit = rows.length - emitted - Object.values(reasons).reduce((n, v) => n + v, 0);
  if (limit > 0) reasons.limit = limit;
  return {
    text,
    etag: await sha256(text),
    channels,
    stats: {
      channels_total: buckets.size,
      channels_emitted: channels.length,
      streams_total: rows.length,
      streams_emitted: emitted,
      channels_filtered: buckets.size - channels.length,
      streams_filtered: rows.length - emitted,
      reasons: Object.fromEntries(
        Object.entries(reasons)
          .sort((a, b) => b[1] - a[1])
          .map(([k, v]) => [reasonLabels[k] ?? k, v]),
      ),
      unavailable: unavailable.slice(0, 30),
      unavailable_total: unavailable.length,
      viewer: viewer.label,
    },
  };
}

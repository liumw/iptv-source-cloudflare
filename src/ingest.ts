import constants from './constants.json';
import type { Row } from './types';
import { Store, json, now } from './store';
import { parseIP, isPublicIP } from './network';
import { randomToken, sha256 } from './security';

const MAX_BYTES = 2 * 1024 * 1024;
const escapeRE = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const stripBrackets = (s: string) => s.replace(/\[[^\]]*\]|\([^)]*\)|【[^】]*】/g, '');
function stripNoise(value: string): string {
  for (const token of [...constants.NOISE_TOKENS].sort((a, b) => b.length - a.length)) {
    value = value.replace(
      new RegExp(
        /^[\x00-\x7f]+$/.test(token) ? `(?<![a-z])${escapeRE(token)}(?![a-z])` : escapeRE(token),
        'gi',
      ),
      '',
    );
  }
  return value;
}
export function normalizeKey(name: string): string {
  let value = stripBrackets(name.normalize('NFKC').toLowerCase().trim());
  value = value
    .replace(/cctv\s*[-_]?\s*(\d+)\s*(\+|plus)/g, 'cctv$1plus')
    .replace(/cctv\s*[-_]?\s*(\d+)/g, 'cctv$1')
    .replace(/中央\s*(\d+)\s*台/g, 'cctv$1')
    .replace(/(\d+)\s*套/g, 'cctv$1');
  value = stripNoise(value).replace(/[\s\-_·|/\\:：,，、]+/g, '');
  if (/^cctv\d+/.test(value))
    for (let changed = true; changed;) {
      changed = false;
      for (const suffix of constants.CCTV_SUFFIXES)
        if (value.endsWith(suffix) && value.length > suffix.length) {
          value = value.slice(0, -suffix.length);
          changed = true;
        }
    }
  return value;
}
export const cleanName = (value: string) =>
  stripNoise(stripBrackets(value.normalize('NFKC')).replace(/\s+/g, ' '))
    .replace(/[\s\-_·|]+$/g, '')
    .trim() || value.trim();
export const isAdult = (name: string, group = '') =>
  constants.ADULT_KEYWORDS.some((k) =>
    (name + ' ' + group).toLowerCase().includes(k.toLowerCase()),
  );
export const isJunk = (name: string) =>
  !name.trim() ||
  /^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(name) ||
  constants.JUNK_KEYWORDS.some((k) => name.toLowerCase().includes(k.toLowerCase()));
export function inferRegion(name: string, group = ''): string {
  for (const [code, words] of Object.entries(constants.REGION_KEYWORDS))
    if (words.some((k) => (name + ' ' + group).toLowerCase().includes(k.toLowerCase())))
      return code;
  return 'national';
}
export function inferCarrier(url: string, name = ''): string {
  for (const [carrier, words] of Object.entries(constants.CARRIER_KEYWORDS))
    if (words.some((k) => (url + ' ' + name).toLowerCase().includes(k.toLowerCase())))
      return carrier;
  return 'all';
}
export function inferNetwork(url: string): string {
  if (/^(igmp|rtp|udp):\/\//i.test(url)) return 'iptv';
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
    const ip = parseIP(host);
    if (!ip) return 'all';
    if (ip.kind() === 'ipv6') return 'ipv6';
    return isPublicIP(host) ? 'ipv4' : 'iptv';
  } catch {
    return 'all';
  }
}
export function similarity(a: string, b: string): number {
  if (!a.length && !b.length) return 100;
  if (Math.abs(a.length - b.length) > (a.length + b.length) * 0.3) return 0;
  let previous = new Uint16Array(b.length + 1);
  for (let i = 0; i < a.length; i++) {
    const current = new Uint16Array(b.length + 1);
    for (let j = 0; j < b.length; j++)
      current[j + 1] = a[i] === b[j] ? previous[j] + 1 : Math.max(previous[j + 1], current[j]);
    previous = current;
  }
  return (200 * previous[b.length]) / (a.length + b.length);
}
export interface Entry {
  name: string;
  url: string;
  group_title: string | null;
  attrs: Row;
  vlc_opts: string[];
  kodiprops: string[];
  directives: string[];
}
const entry = (name = '', url = ''): Entry => ({
  name,
  url,
  group_title: null,
  attrs: {},
  vlc_opts: [],
  kodiprops: [],
  directives: [],
});
function attrs(text: string): Row {
  const out: Row = {};
  const regex = /([A-Za-z0-9_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s,]+))/g;
  for (const match of text.matchAll(regex)) out[match[1]] = match[2] ?? match[3] ?? match[4] ?? '';
  return out;
}
export function parsePlaylist(text: string, format = 'auto'): Entry[] {
  const m3u =
      format === 'm3u' ||
      (format === 'auto' && /#EXTM3U|#EXTINF/.test(text.trimStart().slice(0, 300))),
    entries: Entry[] = [];
  if (m3u) {
    let pending: Entry | null = null,
      group: string | null = null;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#EXTM3U')) continue;
      if (line.startsWith('#EXTINF:')) {
        let quote = '',
          comma = -1;
        for (let i = 8; i < line.length; i++) {
          const c = line[i];
          if (quote) {
            if (c === quote) quote = '';
          } else if (c === '"' || c === "'") quote = c;
          else if (c === ',') {
            comma = i;
            break;
          }
        }
        pending = entry(comma < 0 ? '' : line.slice(comma + 1).trim());
        pending.attrs = attrs(
          line.slice(8, comma < 0 ? undefined : comma).replace(/^\s*-?\d+(?:\.\d+)?\s*/, ''),
        );
        pending.group_title = group;
        continue;
      }
      if (line.startsWith('#EXTGRP:')) {
        group = line.slice(8).trim() || null;
        if (pending && !pending.group_title) pending.group_title = group;
        continue;
      }
      if (line.startsWith('#')) {
        if (pending) {
          if (line.startsWith('#EXTVLCOPT:')) pending.vlc_opts.push(line);
          else if (line.startsWith('#KODIPROP:')) pending.kodiprops.push(line);
          else pending.directives.push(line);
        }
        continue;
      }
      pending ??= entry();
      pending.url = line;
      pending.name ||= line.split('?')[0].replace(/\/$/, '').split('/').at(-1) || line;
      pending.group_title ||= pending.attrs['group-title'] || group;
      entries.push(pending);
      pending = null;
    }
  } else {
    let group: string | null = null;
    const urls = (s: string) =>
      s.match(/(?:https?|rtmp|rtsp|rtp|udp|igmp|p3p|mitv):\/\/[^\s,]+/gi) ?? [];
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      if (line.endsWith(',#genre#')) {
        group = line.slice(0, -8).trim();
        continue;
      }
      const comma = line.indexOf(',');
      const name = comma < 0 ? '' : line.slice(0, comma).trim(),
        rest = comma < 0 ? line : line.slice(comma + 1);
      for (const part of rest.split(/[#|]/))
        for (const url of urls(part)) {
          const e = entry(name || url, url);
          e.group_title = group;
          entries.push(e);
        }
    }
  }
  return entries;
}
export function decodePlaylist(bytes: ArrayBuffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return new TextDecoder('gb18030').decode(bytes);
  }
}
export async function readBounded(response: Response, limit = MAX_BYTES): Promise<ArrayBuffer> {
  if (Number(response.headers.get('content-length') ?? 0) > limit)
    throw new Error('源文件超过 2 MB 限制');
  if (!response.body) return new ArrayBuffer(0);
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error('源文件超过 2 MB 限制');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out.buffer;
}
export function publicURL(value: string): URL {
  const url = new URL(value);
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.includes('%') ||
    (!host.includes('.') && !host.includes(':')) ||
    (parseIP(host) && !isPublicIP(host))
  )
    throw new Error('云端只允许公开 HTTP(S) 地址');
  return url;
}
export async function publicFetch(value: string, headers: HeadersInit = {}): Promise<Response> {
  let url = publicURL(value);
  for (let hops = 0; hops < 5; hops++) {
    const response = await fetch(url, {
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
    });
    if (response.status >= 300 && response.status < 400 && response.headers.has('location')) {
      const next = publicURL(new URL(response.headers.get('location')!, url).href);
      if (next.origin !== url.origin) headers = {};
      await response.body?.cancel();
      url = next;
      continue;
    }
    return response;
  }
  throw new Error('源地址重定向次数过多');
}
export async function ingestSource(store: Store, source: Row, force = false): Promise<Row> {
  const stats: Row = {
    parsed: 0,
    streams_new: 0,
    streams_updated: 0,
    streams_disabled: 0,
    channels_created: 0,
    matched: 0,
    junk: 0,
    invalid: 0,
    skipped: false,
    error: null,
  };
  if (source.origin === 'manual') return { ...stats, skipped: true, reason: 'manual' };
  const token = randomToken(16),
    clock = Math.floor(Date.now() / 1000);
  const lock = await store.one(
    'INSERT INTO cloud_locks(name,token,expires_at) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET token=excluded.token,expires_at=excluded.expires_at WHERE cloud_locks.expires_at<? RETURNING token',
    ['ingest', token, clock + 120, clock],
  );
  if (lock?.token !== token) return { ...stats, error: '已有源正在导入，请稍后重试' };
  try {
    let text = source.inline_text ?? '',
      digest = '',
      response: Response | null = null;
    if (source.origin === 'url') {
      const headers = new Headers(json(source.headers_json, {}));
      if (!force) {
        if (source.etag) headers.set('if-none-match', source.etag);
        if (source.last_modified) headers.set('if-modified-since', source.last_modified);
      }
      response = await publicFetch(source.url, headers);
      if (response.status === 304) {
        await store.run(
          'UPDATE sources SET last_fetch_at=?,last_http_status=304,last_error=NULL WHERE id=?',
          [now(), source.id],
        );
        return { ...stats, skipped: true, reason: 'not_modified' };
      }
      if (!response.ok) throw new Error(`源站返回 HTTP ${response.status}`);
      text = decodePlaylist(await readBounded(response));
    } else if (!['inline', 'upload'].includes(source.origin))
      throw new Error('云端不能读取本机文件路径，请重新上传或改为 URL / 粘贴文本');
    if (new TextEncoder().encode(text).length > MAX_BYTES) throw new Error('源内容超过 2 MB 限制');
    if (!text.trim()) throw new Error('源内容为空');
    digest = await sha256(text);
    if (
      !force &&
      source.content_hash === digest &&
      (await store.one('SELECT id FROM streams WHERE source_id=? LIMIT 1', [source.id]))
    ) {
      await store.run('UPDATE sources SET last_fetch_at=?,last_error=NULL WHERE id=?', [
        now(),
        source.id,
      ]);
      return { ...stats, skipped: true, reason: 'unchanged' };
    }
    const entries = parsePlaylist(text, source.format ?? 'auto');
    stats.parsed = entries.length;
    if (!entries.length) throw new Error('未解析到有效播放条目，保留现有数据');
    if (entries.length > 5000) throw new Error('单个源最多 5000 条线路，请拆分源文件');
    const [channels, aliases, groups, allStreams] = await Promise.all([
      store.all('SELECT * FROM channels'),
      store.all('SELECT * FROM channel_aliases'),
      store.all('SELECT * FROM groups'),
      store.all('SELECT * FROM streams'),
    ]);
    const channelMap = new Map(channels.map((c) => [c.key, c])),
      nameMap = new Map(channels.map((c) => [normalizeKey(c.name), c])),
      byID = new Map(channels.map((c) => [c.id, c])),
      aliasMap = new Map(aliases.map((a) => [a.alias_norm, a.channel_id]));
    const sourceStreams = allStreams.filter((s) => s.source_id === source.id),
      byFingerprint = new Map(sourceStreams.map((s) => [s.fingerprint, s]));
    const byIdentity = new Map<string, Row>();
    for (const stream of sourceStreams) {
      const payload = json<Row>(stream.attrs_json, {});
      byIdentity.set(stream.url + '\n' + JSON.stringify(payload.vlc_opts ?? []), stream);
    }
    let nextChannel = Math.max(0, ...channels.map((c) => c.id)) + 1,
      nextGroup = Math.max(0, ...groups.map((g) => g.id)) + 1,
      nextStream = Math.max(0, ...allStreams.map((s) => s.id)) + 1;
    const groupMap = new Map(groups.map((g) => [g.name, g])),
      newGroups: Row[] = [],
      newChannels: Row[] = [],
      newStreams: Row[] = [],
      updatedStreams: Row[] = [],
      newAliases: Row[] = [],
      seen = new Set<number>(),
      fingerprints = new Set<string>();
    const getGroup = (name: string | null) => {
      if (!name) return null;
      let group = groupMap.get(name);
      if (!group) {
        group = { id: nextGroup++, name };
        groupMap.set(name, group);
        newGroups.push(group);
      }
      return group.id;
    };
    for (const e of entries) {
      if (!e.url.includes('://') || /[\r\n]/.test(e.url)) {
        stats.invalid++;
        continue;
      }
      if (isJunk(e.name)) {
        stats.junk++;
        continue;
      }
      const identity = e.url + '\n' + JSON.stringify(e.vlc_opts);
      if (fingerprints.has(identity)) continue;
      fingerprints.add(identity);
      const existing = byIdentity.get(identity),
        norm = normalizeKey(e.name);
      let channel = existing?.channel_id
        ? byID.get(existing.channel_id)
        : (channelMap.get(norm) ?? nameMap.get(norm) ?? byID.get(aliasMap.get(norm) ?? -1));
      if (!channel) {
        let best: Row | undefined,
          bestScore = 0;
        for (const candidate of channelMap.values()) {
          if (
            Math.abs(candidate.key.length - norm.length) >
            Math.max(candidate.key.length, norm.length) * 0.1
          )
            continue;
          const score = similarity(norm, candidate.key);
          if (score > bestScore) {
            best = candidate;
            bestScore = score;
          }
        }
        if (best && bestScore >= 92) {
          channel = best;
          if (norm && !aliasMap.has(norm) && !channelMap.has(norm) && !nameMap.has(norm)) {
            newAliases.push({ channel_id: best.id, alias: e.name, alias_norm: norm });
            aliasMap.set(norm, best.id);
          }
        }
      }
      if (!channel) {
        let key = norm || 'ch-' + (await sha256(e.name)).slice(0, 10);
        let suffix = 2;
        const base = key;
        while (channelMap.has(key)) key = base + '-' + suffix++;
        channel = {
          id: nextChannel++,
          key,
          name: cleanName(e.name),
          group_id: getGroup(e.group_title),
          region: inferRegion(e.name, e.group_title ?? ''),
          adult: Number(isAdult(e.name, e.group_title ?? '')),
          auto_created: 1,
          reviewed: 0,
          logo: e.attrs['tvg-logo'] || null,
          tvg_id: e.attrs['tvg-id'] || null,
        };
        channelMap.set(key, channel);
        nameMap.set(normalizeKey(channel.name), channel);
        byID.set(channel.id, channel);
        newChannels.push(channel);
        stats.channels_created++;
      } else if (!existing?.channel_id) stats.matched++;
      const attributes = {
        attrs: e.attrs,
        vlc_opts: e.vlc_opts,
        kodiprops: e.kodiprops,
        directives: e.directives,
      };
      const row: Row = {
        id: existing?.id ?? nextStream++,
        source_id: source.id,
        channel_id: channel.id,
        fingerprint: existing?.fingerprint ?? (await sha256(identity)).slice(0, 40),
        url: e.url,
        raw_name: e.name,
        group_title_raw: e.group_title,
        tvg_id: e.attrs['tvg-id'] || existing?.tvg_id || null,
        tvg_name: e.attrs['tvg-name'] || existing?.tvg_name || null,
        tvg_logo: e.attrs['tvg-logo'] || existing?.tvg_logo || null,
        catchup: e.attrs.catchup || existing?.catchup || null,
        catchup_source: e.attrs['catchup-source'] || existing?.catchup_source || null,
        catchup_days: e.attrs['catchup-days'] || existing?.catchup_days || null,
        timeshift: e.attrs.timeshift || existing?.timeshift || null,
        attrs_json: JSON.stringify(attributes),
        network: existing?.network_manual
          ? existing.network
          : constants.NETWORKS.includes(source.default_network)
            ? source.default_network
            : inferNetwork(e.url),
        carrier: existing?.carrier_manual
          ? existing.carrier
          : constants.CARRIERS.includes(source.default_carrier)
            ? source.default_carrier
            : inferCarrier(e.url, e.name),
        region: existing?.region_manual
          ? existing.region
          : source.default_region in constants.REGIONS
            ? source.default_region
            : inferRegion(e.name, e.group_title ?? ''),
        adult: Number(existing?.adult || source.adult || isAdult(e.name, e.group_title ?? '')),
        enabled: 1,
        last_seen_at: now(),
      };
      seen.add(row.id);
      if (existing) {
        updatedStreams.push(row);
        stats.streams_updated++;
      } else {
        newStreams.push(row);
        stats.streams_new++;
      }
    }
    if (!seen.size) throw new Error('没有可用的播放条目，保留现有线路');
    const statements: D1PreparedStatement[] = [];
    const addBulk = (table: string, rows: Row[]) => {
      for (let i = 0; i < rows.length; i += 200)
        statements.push(store.bulkInsert(table, rows.slice(i, i + 200)));
    };
    addBulk('groups', newGroups);
    addBulk('channels', newChannels);
    addBulk('channel_aliases', newAliases);
    addBulk('streams', newStreams);
    // One JSON parameter updates many rows without exceeding D1's parameter limit.
    for (let i = 0; i < updatedStreams.length; i += 200) {
      const updates = updatedStreams.slice(i, i + 200),
        keys = Object.keys(updates[0]).filter(
          (k) => !['id', 'source_id', 'fingerprint'].includes(k),
        );
      statements.push(
        store.statement(
          `UPDATE streams SET (${keys.join(',')})=(SELECT ${keys.map((k) => `json_extract(value,'$.${k}')`).join(',')} FROM json_each(?) WHERE json_extract(value,'$.id')=streams.id) WHERE id IN (SELECT json_extract(value,'$.id') FROM json_each(?))`,
          [JSON.stringify(updates), JSON.stringify(updates)],
        ),
      );
    }
    const missing = sourceStreams.filter((s) => s.enabled && !seen.has(s.id)).map((s) => s.id);
    stats.streams_disabled = missing.length;
    if (missing.length)
      statements.push(
        store.statement(
          'UPDATE streams SET enabled=0 WHERE source_id=? AND id IN (SELECT value FROM json_each(?))',
          [source.id, JSON.stringify(missing)],
        ),
      );
    statements.push(
      store.update('sources', source.id, {
        content_hash: digest,
        last_error: null,
        last_fetch_at: now(),
        last_http_status: response?.status ?? null,
        etag: response?.headers.get('etag') ?? source.etag ?? null,
        last_modified: response?.headers.get('last-modified') ?? source.last_modified ?? null,
      }),
    );
    await store.write(statements);
    return stats;
  } catch (e) {
    stats.error = (e as Error).message;
    await store.run('UPDATE sources SET last_error=?,last_fetch_at=? WHERE id=?', [
      stats.error,
      now(),
      source.id,
    ]);
    return stats;
  } finally {
    await store.run('DELETE FROM cloud_locks WHERE name=? AND token=?', ['ingest', token]);
  }
}

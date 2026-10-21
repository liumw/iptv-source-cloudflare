import ipaddr from 'ipaddr.js';
import constants from './constants.json';
import type { IPInfo, Row, ViewerEnv, Resolved } from './types';
import { Store, bool } from './store';

export function parseIP(value: unknown): ipaddr.IPv4 | ipaddr.IPv6 | null {
  let text = String(value ?? '').trim();
  if (text.startsWith('[')) text = text.slice(1, text.indexOf(']'));
  else if (text.includes('.') && text.split(':').length === 2) text = text.split(':')[0];
  try {
    const ip = ipaddr.parse(text);
    return ip.kind() === 'ipv6' && (ip as ipaddr.IPv6).isIPv4MappedAddress()
      ? (ip as ipaddr.IPv6).toIPv4Address()
      : ip;
  } catch {
    return null;
  }
}
export function clientIP(request: Request): string {
  const value = (request as Request & { cf?: unknown }).cf
    ? request.headers.get('cf-connecting-ipv6') || request.headers.get('cf-connecting-ip')
    : '127.0.0.1';
  return parseIP(value)?.toString() ?? '';
}
export const ipVersion = (value: unknown): number | null => {
  const ip = parseIP(value);
  return ip ? (ip.kind() === 'ipv4' ? 4 : 6) : null;
};
export const isPublicIP = (value: unknown): boolean => parseIP(value)?.range() === 'unicast';
export function carrierFromISP(value: unknown): string {
  const text = String(value ?? '')
    .toLowerCase()
    .replace(/[\s_-]/g, '');
  if (/unicom|联通|cncgroup|chinanetcom/.test(text)) return 'unicom';
  if (/chinamobile|cmcc|移动|chinatietong|铁通/.test(text)) return 'mobile';
  if (/chinatelecom|chinanet|电信/.test(text)) return 'telecom';
  return text ? 'other' : 'unknown';
}
const asns: Record<number, string> = {
  4134: 'telecom',
  4809: 'telecom',
  4812: 'telecom',
  23724: 'telecom',
  4837: 'unicom',
  4808: 'unicom',
  9929: 'unicom',
  17621: 'unicom',
  9808: 'mobile',
  56040: 'mobile',
  24400: 'mobile',
  58453: 'mobile',
};
const provinces = Object.fromEntries(
  'beijing:BJ tianjin:TJ hebei:HE shanxi:SX inner-mongolia:NM liaoning:LN jilin:JL heilongjiang:HL shanghai:SH jiangsu:JS zhejiang:ZJ anhui:AH fujian:FJ jiangxi:JX shandong:SD henan:HA hubei:HB hunan:HN guangdong:GD guangxi:GX hainan:HI chongqing:CQ sichuan:SC guizhou:GZ yunnan:YN tibet:XZ xizang:XZ shaanxi:SN gansu:GS qinghai:QH ningxia:NX xinjiang:XJ'
    .split(' ')
    .map((v) => v.split(':')),
);
export function regionFrom(country: unknown, regionCode: unknown, name: unknown): string {
  const code = String(country ?? '').toUpperCase();
  if (['HK', 'TW', 'MO'].includes(code)) return `CN-${code}`;
  if (!code || code === 'XX' || code === 'T1') return 'national';
  if (code !== 'CN') return 'overseas';
  const suffix = String(regionCode ?? '')
    .toUpperCase()
    .replace(/^CN-/, '');
  if (`CN-${suffix}` in constants.REGIONS) return `CN-${suffix}`;
  const text = String(name ?? '')
    .toLowerCase()
    .replace(/\s+/g, '-');
  for (const [province, short] of Object.entries(provinces))
    if (text === province || text.startsWith(province + '-')) return `CN-${short}`;
  for (const [key, label] of Object.entries(constants.REGIONS))
    if (key.startsWith('CN-') && text.includes(label)) return key;
  return 'national';
}
const infoBase = (value: string): IPInfo => ({
  ip: parseIP(value)?.toString() ?? '',
  version: ipVersion(value),
  carrier: 'unknown',
  region: 'national',
  isp: '',
  location: '',
  source: 'local',
  message: '仅能确认此次请求的地址类型；不能推断双栈或 IPTV 专网权限。',
});
const lookupCache = new Map<string, { expires: number; info: IPInfo }>();
let retryAfter = 0;
export async function inspectIP(
  value: string,
  online: boolean,
  request?: Request,
): Promise<IPInfo> {
  const info = infoBase(value);
  if (!info.version) {
    info.message = 'IP 格式无效。';
    return info;
  }
  if (!isPublicIP(info.ip)) {
    info.message = '内网或保留地址不查询公网归属地，可配置网段绑定。';
    return info;
  }
  if (!online) {
    info.message = '归属识别已关闭，仅按地址类型过滤。';
    return info;
  }
  if (request && info.ip === clientIP(request)) {
    const cf = (request as Request & { cf?: Row }).cf;
    if (cf) {
      info.isp = String(cf.asOrganization ?? '');
      info.carrier = asns[Number(cf.asn)] ?? carrierFromISP(info.isp);
      info.region = regionFrom(cf.country, cf.regionCode, cf.region);
      info.location = [cf.country, cf.region, cf.city].filter(Boolean).join(' · ');
      info.source = 'cloudflare';
      return info;
    }
  }
  const cached = lookupCache.get(info.ip);
  if (cached && cached.expires > Date.now()) return cached.info;
  if (Date.now() < retryAfter)
    return { ...info, source: 'unavailable', message: '归属查询暂不可用，采用保守过滤。' };
  try {
    const response = await fetch(
      `https://ipwho.is/${info.ip}?fields=ip,success,country,country_code,region,region_code,city,connection`,
      { signal: AbortSignal.timeout(2500), redirect: 'error' },
    );
    if (response.status === 429)
      retryAfter =
        Date.now() +
        Math.min(86400, Math.max(60, Number(response.headers.get('retry-after')) || 300)) * 1000;
    if (!response.ok) throw new Error('Lookup failed');
    const data = (await response.json()) as Row;
    if (data.success !== true || parseIP(data.ip)?.toString() !== info.ip)
      throw new Error('Invalid lookup');
    info.isp = [data.connection?.isp, data.connection?.org]
      .filter(Boolean)
      .join(' / ')
      .slice(0, 300);
    info.carrier = carrierFromISP(info.isp);
    info.region = regionFrom(data.country_code, data.region_code, data.region);
    info.location = [data.country, data.region, data.city].filter(Boolean).join(' · ');
    info.source = 'ipwho.is';
    lookupCache.set(info.ip, { expires: Date.now() + 86400000, info });
    if (lookupCache.size > 2048) lookupCache.delete(lookupCache.keys().next().value!);
  } catch {
    retryAfter = Math.max(retryAfter, Date.now() + 60000);
    return { ...info, source: 'unavailable', message: '归属查询失败，采用保守网络过滤。' };
  }
  return info;
}
export function viewerFrom(row: Row | null, automatic = false): ViewerEnv {
  const viewer: ViewerEnv = {
    id: row?.id ?? null,
    name: row?.name ?? '访问者自动识别',
    carrier: row?.carrier ?? 'unknown',
    supports_ipv4: !!row?.supports_ipv4,
    supports_ipv6: !!row?.supports_ipv6,
    supports_iptv: !!row?.supports_iptv,
    region: row?.region ?? 'national',
    automatic,
    label: '',
  };
  const carrier = (constants.CARRIER_LABELS as Row)[viewer.carrier];
  viewer.label = [
    viewer.name,
    viewer.carrier !== 'unknown' ? carrier : null,
    viewer.supports_ipv4 ? 'IPv4' : null,
    viewer.supports_ipv6 ? 'IPv6' : null,
    viewer.supports_iptv ? 'IPTV' : null,
    viewer.region !== 'national' ? (constants.REGIONS as Row)[viewer.region] : null,
  ]
    .filter(Boolean)
    .join(' / ');
  return viewer;
}
export function parseNetworkRules(
  text: string,
  viewers: Row[],
): { rules: { network: [ipaddr.IPv4 | ipaddr.IPv6, number]; viewer: Row }[]; errors: string[] } {
  const rules: { network: [ipaddr.IPv4 | ipaddr.IPv6, number]; viewer: Row }[] = [],
    errors: string[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.split('#')[0].trim();
    if (!line) return;
    const comma = line.indexOf(',');
    try {
      if (comma < 0) throw new Error('格式应为：网段,网络环境名称');
      const cidr = line.slice(0, comma).trim(),
        name = line.slice(comma + 1).trim();
      const network = ipaddr.parseCIDR(
        cidr.includes('/') ? cidr : `${cidr}/${ipVersion(cidr) === 6 ? 128 : 32}`,
      );
      const viewer = viewers.find((v) => v.name === name);
      if (!viewer) throw new Error(`网络环境「${name}」不存在`);
      rules.push({ network, viewer });
    } catch (e) {
      errors.push(`第 ${i + 1} 行：${(e as Error).message}`);
    }
  });
  rules.sort((a, b) => b.network[1] - a.network[1]);
  return { rules, errors };
}
export async function resolveViewer(
  store: Store,
  subscription: Row,
  request: Request,
  candidate?: string,
  query?: URLSearchParams,
): Promise<Resolved> {
  const ip = candidate ?? clientIP(request),
    settings = await store.settings();
  let viewer: ViewerEnv,
    source: string,
    info = infoBase(ip);
  const bound = subscription.viewer_id
    ? await store.one('SELECT * FROM viewers WHERE id=?', [subscription.viewer_id])
    : null;
  if (bound) {
    viewer = viewerFrom(bound);
    source = 'viewer';
  } else {
    const address = parseIP(ip),
      viewers = await store.all('SELECT * FROM viewers');
    const { rules } = parseNetworkRules(settings.ip_network_rules ?? '', viewers);
    const mapped = rules.find(
      (r) => address && address.kind() === r.network[0].kind() && address.match(r.network),
    );
    if (mapped) {
      viewer = viewerFrom(mapped.viewer);
      source = 'cidr';
    } else {
      info = await inspectIP(ip, settings.ip_lookup_enabled !== '0', request);
      viewer = viewerFrom(
        {
          carrier: info.carrier,
          region: info.region,
          supports_ipv4: info.version === 4,
          supports_ipv6: info.version === 6,
        },
        true,
      );
      source = 'auto';
    }
  }
  if (
    subscription.allow_query_override &&
    query &&
    ['carrier', 'ipv4', 'ipv6', 'iptv', 'region'].some((k) => query.has(k))
  ) {
    const row = { ...viewer, name: viewer.name + '（参数覆盖）' };
    if ([...constants.CARRIERS, 'unknown'].includes(query.get('carrier') ?? ''))
      row.carrier = query.get('carrier')!;
    if ((query.get('region') ?? '') in constants.REGIONS) row.region = query.get('region')!;
    for (const [key, prop] of [
      ['ipv4', 'supports_ipv4'],
      ['ipv6', 'supports_ipv6'],
      ['iptv', 'supports_iptv'],
    ] as const)
      row[prop] = bool(query.get(key), viewer[prop]);
    viewer = viewerFrom(row, viewer.automatic);
    source = 'query';
  }
  return { viewer, source, info };
}
export function compatible(stream: Row, channel: Row, viewer: ViewerEnv): string {
  const network = stream.network || 'all',
    carrier = stream.carrier || 'all',
    region = stream.region || channel.region || 'national';
  if (network === 'ipv4' && !viewer.supports_ipv4) return 'need_ipv4';
  if (network === 'ipv6' && !viewer.supports_ipv6) return 'need_ipv6';
  if (network === 'iptv') {
    if (!viewer.supports_iptv) return 'need_iptv';
    if (viewer.carrier === 'unknown') return 'unknown_carrier';
    if (constants.KNOWN_CARRIERS.includes(viewer.carrier) && carrier !== viewer.carrier)
      return 'carrier_mismatch';
  }
  if (carrier !== 'all' && viewer.carrier !== 'unknown' && carrier !== viewer.carrier)
    return 'carrier_mismatch';
  if (viewer.automatic && carrier !== 'all' && viewer.carrier === 'unknown')
    return 'unknown_carrier';
  if (viewer.automatic && viewer.region === 'national' && region !== 'national')
    return 'region_mismatch';
  if (region !== 'national' && viewer.region !== 'national' && region !== viewer.region)
    return 'region_mismatch';
  return 'ok';
}
export type IPRule = {
  source: string;
  kind: string;
  version: number;
  network?: string;
  start?: string;
  end?: string;
  contains: (ip: ipaddr.IPv4 | ipaddr.IPv6) => boolean;
};
export function parseWhitelist(text: string): { rules: IPRule[]; errors: Row[] } {
  const rules: IPRule[] = [],
    errors: Row[] = [];
  text.split(/\r?\n/).forEach((raw, line) => {
    const value = raw.split('#')[0].trim();
    if (!value) return;
    try {
      const values = value.toLowerCase() === 'localhost' ? ['127.0.0.1', '::1'] : [value];
      for (const item of values) {
        if (item.includes('-')) {
          const [a, b] = item.split('-').map(parseIP);
          if (!a || !b || a.kind() !== b.kind()) throw new Error('无效 IP 区间');
          const numeric = (ip: ipaddr.IPv4 | ipaddr.IPv6) =>
            ip.toByteArray().reduce((n, v) => n * 256n + BigInt(v), 0n);
          const start = numeric(a),
            end = numeric(b);
          if (start > end) throw new Error('区间起点大于终点');
          rules.push({
            source: value,
            kind: 'range',
            version: a.kind() === 'ipv4' ? 4 : 6,
            start: a.toString(),
            end: b.toString(),
            contains: (ip) => ip.kind() === a.kind() && numeric(ip) >= start && numeric(ip) <= end,
          });
        } else {
          let cidr = item;
          if (item.includes('*')) {
            const segments = item.split('.');
            if (
              segments.length !== 4 ||
              segments.some(
                (s, i) => s !== '*' && (segments.slice(0, i).includes('*') || !/^\d+$/.test(s)),
              )
            )
              throw new Error('无效 IPv4 通配符');
            const prefix = segments.indexOf('*') * 8;
            cidr = segments.map((s) => (s === '*' ? '0' : s)).join('.') + '/' + prefix;
          } else if (!item.includes('/')) cidr = `${item}/${ipVersion(item) === 6 ? 128 : 32}`;
          const network = ipaddr.parseCIDR(cidr);
          rules.push({
            source: value,
            kind: item.includes('*') ? 'wildcard' : item.includes('/') ? 'cidr' : 'ip',
            version: network[0].kind() === 'ipv4' ? 4 : 6,
            network: cidr,
            contains: (ip) => ip.kind() === network[0].kind() && ip.match(network),
          });
        }
      }
    } catch (e) {
      errors.push({ line_no: line + 1, source: raw, message: (e as Error).message });
    }
  });
  return { rules, errors };
}
export function checkIP(
  text: string,
  value: string,
): { allowed: boolean; rule: IPRule | null; parsed: string | null } {
  const ip = parseIP(value),
    { rules, errors } = parseWhitelist(text);
  if (!rules.length && !errors.length)
    return { allowed: true, rule: null, parsed: ip?.toString() ?? null };
  const rule = ip ? rules.find((r) => r.contains(ip)) : null;
  return { allowed: !!rule, rule: rule ?? null, parsed: ip?.toString() ?? null };
}

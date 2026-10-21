import nunjucks from 'nunjucks/browser/nunjucks-slim.js';
import templates from '../.generated/templates.mjs';
import constants from './constants.json';
import type { Row } from './types';

nunjucks.installJinjaCompat();
const engine = new nunjucks.Environment(new nunjucks.PrecompiledLoader(templates), {
  autoescape: true,
});
engine.addFilter('list', (v) => (Array.isArray(v) ? v : Object.keys(v ?? {})));
engine.addFilter('string', (v) => String(v ?? ''));
engine.addFilter('format', (v, n) => String(v).replace('%.0f', String(Math.round(Number(n)))));
engine.addFilter('truncate_mid', (v, n = 48) =>
  !v || v.length <= n ? v : v.slice(0, n / 2) + '…' + v.slice(-n / 2),
);
engine.addFilter('dt', (v, format = '%Y-%m-%d %H:%M') => {
  if (!v) return '-';
  const raw = String(v).replace(' ', 'T');
  const date = new Date(/(?:Z|[+-]\d{2}:?\d{2})$/.test(raw) ? raw : raw + 'Z');
  if (Number.isNaN(date.getTime())) return String(v);
  const shifted = new Date(date.getTime() + 8 * 3600000);
  const value = shifted.toISOString().replace('T', ' ');
  const parts: Record<string, string> = {
    '%Y': value.slice(0, 4),
    '%m': value.slice(5, 7),
    '%d': value.slice(8, 10),
    '%H': value.slice(11, 13),
    '%M': value.slice(14, 16),
    '%S': value.slice(17, 19),
  };
  return String(format).replace(/%[YmdHMS]/g, (k) => parts[k]);
});
engine.addFilter(
  'tojson',
  (v) =>
    new nunjucks.runtime.SafeString(
      JSON.stringify(v ?? null).replace(
        /[<>&\u2028\u2029]/g,
        (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'),
      ),
    ),
);
const navigation = [
  [
    '工作空间',
    [
      ['概览', '/_admin', 'grid'],
      ['源管理', '/_admin/sources', 'source'],
      ['频道库', '/_admin/channels', 'tv'],
      ['待确认', '/_admin/review', 'check'],
    ],
  ],
  [
    '观看与分发',
    [
      ['内容视图', '/_admin/profiles', 'layers'],
      ['在线播放', '/_admin/play', 'play'],
      ['订阅链接', '/_admin/subscriptions', 'link'],
    ],
  ],
  [
    '网络与系统',
    [
      ['网络环境', '/_admin/viewers', 'network'],
      ['访问者识别', '/_admin/network', 'globe'],
      ['访问日志', '/_admin/logs', 'logs'],
      ['系统设置', '/_admin/settings', 'settings'],
    ],
  ],
];

export function render(
  name: string,
  request: Request,
  user: Row | null,
  context: Row = {},
): string {
  const url = new URL(request.url);
  const counts = context.counts ?? {};
  const title =
    (
      {
        dashboard: '概览',
        sources: '源管理',
        channels: '频道库',
        channel_new: '手动添加频道',
        review: '待确认',
        profiles: '内容视图',
        play: '在线播放',
        viewers: '网络环境',
        subscriptions: '订阅链接',
        network: '访问者识别',
        settings: '系统设置',
        logs: '访问日志',
      } as Row
    )[name.replace('.html', '')] ?? 'IPTV 管理';
  return engine.render(name, {
    networks: constants.NETWORKS,
    carriers: constants.CARRIERS,
    regions: constants.REGIONS,
    network_labels: constants.NETWORK_LABELS,
    carrier_labels: constants.CARRIER_LABELS,
    carrier_names: constants.CARRIER_LABELS,
    region_names: constants.REGIONS,
    navigation,
    page_title: title,
    path: url.pathname,
    msg: url.searchParams.get('msg'),
    err: url.searchParams.get('err'),
    username: user?.username,
    user,
    base_url: url.origin,
    request: {
      query_params: {
        get: (key: string, fallback: string) => url.searchParams.get(key) ?? fallback,
      },
    },
    dashboard_cards: [
      ['频道总数', counts.channels, 'tv', '你的统一频道库'],
      ['启用线路', counts.enabled_streams, 'signal', `共 ${counts.streams} 条线路，按规则筛选`],
      ['订阅链接', counts.subscriptions, 'link', '内容与网络的专属组合'],
      ['今日访问', counts.access_today, 'globe', '播放列表请求记录'],
    ],
    ...context,
  });
}

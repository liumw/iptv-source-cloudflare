import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Env, Variables, Row } from './types';
import { Store, int, now, json } from './store';
import { admin } from './admin';
import { currentUser, equal, sha256, safeReturn } from './security';
import {
  clientIP,
  ipVersion,
  inspectIP,
  resolveViewer,
  viewerFrom,
  checkIP,
  parseWhitelist,
} from './network';
import { normalizePath, renderPlaylist, configFor } from './playlist';
import { ingestSource } from './ingest';
import { playProxy } from './proxy';

export const app = new Hono<{ Bindings: Env; Variables: Variables }>();
app.use('*', async (c, next) => {
  c.set('store', new Store(c.env.DB));
  if (
    (c.req.path.startsWith('/_admin') || c.req.path.startsWith('/_api')) &&
    (!c.env.SESSION_SECRET || c.env.SESSION_SECRET.length < 32)
  )
    return c.text('请先配置至少 32 字符的 SESSION_SECRET。', 503);
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    const origin = c.req.header('origin');
    if (
      (origin && origin !== new URL(c.req.url).origin) ||
      c.req.header('sec-fetch-site') === 'cross-site'
    )
      return c.text('拒绝跨站写入请求', 403);
  }
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'same-origin');
  if (c.req.path.startsWith('/_admin'))
    c.header(
      'Content-Security-Policy',
      "frame-ancestors 'none'; object-src 'none'; base-uri 'self'",
    );
});
app.use(
  '/_admin/*',
  bodyLimit({ maxSize: 3 * 1024 * 1024, onError: (c) => c.text('上传内容不能超过 3 MB', 413) }),
);
app.get('/health', async (c) => {
  await c.get('store').scalar('SELECT 1');
  return c.json({ status: 'ok', runtime: 'cloudflare-workers', database: 'D1', version: '1.0.0' });
});
app.on(['GET', 'HEAD'], '/static/*', (c) => c.env.ASSETS.fetch(c.req.raw));
app.get('/favicon.ico', (c) => c.redirect('/static/favicon.svg', 302));

app.use('/_api/*', async (c, next) => {
  const user = await currentUser(c.get('store'), c.req.raw, c.env.SESSION_SECRET);
  if (!user) return c.json({ detail: 'unauthorized' }, 401);
  if (user.must_change_password)
    return c.json({ detail: 'password_change_required', redirect: '/_admin/change-password' }, 403);
  c.set('user', user);
  await next();
});
app.get('/_api/stats', async (c) =>
  c.json(
    await c
      .get('store')
      .one(
        `SELECT (SELECT count(*) FROM sources WHERE origin!='manual') sources,(SELECT count(*) FROM channels) channels,(SELECT count(*) FROM streams) streams,(SELECT count(*) FROM subscriptions) subscriptions`,
      ),
  ),
);
app.get('/_api/settings', async (c) => {
  const settings = await c.get('store').settings(),
    parsed = parseWhitelist(settings.playlist_ip_whitelist ?? '');
  return c.json({
    playlist_ip_whitelist: settings.playlist_ip_whitelist ?? '',
    trust_proxy: false,
    default_ua: settings.default_ua ?? '',
    rules: parsed.rules.map((r) => r.source),
    errors: parsed.errors.map((e) => e.source),
  });
});
app.patch('/_api/settings', async (c) => {
  const payload = await c.req.json<Row>(),
    store = c.get('store'),
    statements: D1PreparedStatement[] = [];
  for (const key of ['playlist_ip_whitelist', 'default_ua'])
    if (payload[key] != null) statements.push(store.settingStatement(key, String(payload[key])));
  await store.write(statements);
  return c.json({ ok: true });
});
app.post('/_api/settings/test-ip', async (c) => {
  const payload = await c.req.json<Row>(),
    result = checkIP(
      payload.whitelist ?? (await c.get('store').setting('playlist_ip_whitelist')),
      String(payload.ip ?? ''),
    );
  return c.json({
    allowed: result.allowed,
    matched_rule: result.rule?.source ?? null,
    parsed_ip: result.parsed,
  });
});
app.get('/_api/network/detect', async (c) => {
  const store = c.get('store'),
    value = c.req.query('ip') ?? clientIP(c.req.raw),
    online = (await store.setting('ip_lookup_enabled', '1')) === '1';
  const info = await inspectIP(value, online, c.req.raw),
    resolved = await resolveViewer(store, {}, c.req.raw, value);
  return c.json({ ip: info, viewer: resolved.viewer, source: resolved.source });
});
app.get('/_api/subscriptions/:id/test', async (c) => {
  const store = c.get('store'),
    sub = await store.one('SELECT * FROM subscriptions WHERE id=?', [int(c.req.param('id'))]);
  if (!sub) return c.json({ detail: 'subscription not found' }, 404);
  const explicit = c.req.query('viewer_id')
    ? await store.one('SELECT * FROM viewers WHERE id=?', [int(c.req.query('viewer_id'))])
    : null;
  const viewer = explicit
      ? viewerFrom(explicit)
      : (await resolveViewer(store, sub, c.req.raw)).viewer,
    result = await renderPlaylist(store, sub, viewer, true);
  return c.json({ viewer: viewer.label, stats: result.stats, head: result.text.slice(0, 2000) });
});
app.post('/_api/fetch', async (c) => {
  const store = c.get('store'),
    sources = await store.all("SELECT * FROM sources WHERE enabled=1 AND origin='url'"),
    results: Row = {};
  // Explicit manual fetch is limited to one source per request on the free tier.
  for (const source of sources.slice(0, 1)) results[source.id] = await ingestSource(store, source);
  return c.json({
    results,
    remaining: Math.max(0, sources.length - 1),
    message: sources.length > 1 ? '请在源管理逐个抓取其余源，避免超过单次请求配额。' : undefined,
  });
});
// Register proxy behind the same admin authentication middleware.
admin.get('/_admin/play/proxy', playProxy);
app.route('/', admin);
app.get('/', (c) => c.redirect('/_admin', 302));

app.on(['GET', 'HEAD'], '/*', async (c) => {
  const store = c.get('store'),
    path = normalizePath(c.req.path);
  if (!path) return c.text('not found', 404);
  const sub = await store.one(
    'SELECT s.* FROM subscriptions s JOIN profiles p ON p.id=s.profile_id WHERE s.path=? AND s.enabled=1 AND p.enabled=1',
    [path],
  );
  if (!sub) return c.text('not found', 404);
  const settings = await store.settings(),
    ip = clientIP(c.req.raw);
  const log = async (
    status: number,
    size: number,
    reason: string,
    resolved?: Awaited<ReturnType<typeof resolveViewer>>,
  ) => {
    await store.run(
      'INSERT INTO access_logs(subscription_id,path,ip,user_agent,status,bytes,detected_carrier,detected_ipv6,request_ip_version,detected_region,reason) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      [
        sub.id,
        path.slice(0, 255),
        ip.slice(0, 64),
        (c.req.header('user-agent') ?? '').slice(0, 500),
        status,
        size,
        resolved?.viewer.carrier ?? null,
        resolved?.viewer.supports_ipv6 ? 1 : 0,
        ipVersion(ip),
        resolved?.viewer.region ?? null,
        reason,
      ],
    );
  };
  if (!checkIP(settings.playlist_ip_whitelist ?? '', ip).allowed) {
    const status = Math.max(400, Math.min(499, int(settings.whitelist_deny_status, 403)));
    await log(status, 0, 'ip_not_allowed');
    return new Response('forbidden: ip not allowed\n', {
      status,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
  if (sub.access_token && !equal(c.req.query('token') ?? '', sub.access_token)) {
    await log(403, 0, 'bad_token');
    return new Response('forbidden: bad token\n', {
      status: 403,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
  const resolved = await resolveViewer(
    store,
    sub,
    c.req.raw,
    undefined,
    new URL(c.req.url).searchParams,
  );
  const profile = await store.one('SELECT * FROM profiles WHERE id=?', [sub.profile_id]);
  if (!profile) return c.text('not found', 404);
  sub.profile = profile;
  const ttl = Math.max(0, Math.min(86400, int(sub.cache_ttl ?? profile.cache_ttl, 30))),
    signature = JSON.stringify({ ...resolved.viewer, id: null, name: null, label: null });
  const cacheKey = new Request(
    `https://iptv-cache.invalid/${await sha256(`channel-number-v2|${sub.id}|${settings.db_version ?? 1}|${signature}`)}`,
  );
  const cached = ttl > 0 ? await caches.default.match(cacheKey) : null;
  let text: string, etag: string;
  if (cached) {
    text = await cached.text();
    etag = cached.headers.get('etag')!;
  } else {
    const result = await renderPlaylist(store, sub, resolved.viewer);
    text = result.text;
    etag = `"${result.etag}"`;
    if (ttl > 0)
      c.executionCtx.waitUntil(
        caches.default.put(
          cacheKey,
          new Response(text, { headers: { 'Cache-Control': `public,max-age=${ttl}`, ETag: etag } }),
        ),
      );
  }
  const headers = new Headers({
    'Content-Type': 'text/plain; charset=utf-8',
    ETag: etag,
    'Cache-Control': sub.access_token ? 'private,no-store' : `private,max-age=${ttl}`,
    'Access-Control-Allow-Origin': '*',
    'X-Viewer-Carrier': resolved.viewer.carrier,
    'X-Viewer-Region': resolved.viewer.region,
    'X-Viewer-IPv4': resolved.viewer.supports_ipv4 ? '1' : '0',
    'X-Viewer-IPv6': resolved.viewer.supports_ipv6 ? '1' : '0',
    'X-Viewer-Source': resolved.source,
    Vary: 'CF-Connecting-IP,CF-Connecting-IPv6',
  });
  const matches = (c.req.header('if-none-match') ?? '')
    .split(',')
    .some((t) => t.trim().replace(/^W\//, '') === etag);
  const size = new TextEncoder().encode(text).length;
  if (matches) {
    await log(304, 0, 'not_modified', resolved);
    return new Response(null, { status: 304, headers });
  }
  await log(200, size, resolved.source, resolved);
  if (c.req.method === 'HEAD') {
    headers.set('Content-Length', String(size));
    return new Response(null, { headers });
  }
  return new Response(text, { headers });
});
app.onError((error, c) => {
  console.error(error);
  const message = /CHANNEL_NUMBER_TAKEN/.test(error.message)
    ? '台号已被其他频道使用，请刷新后换一个台号。'
    : /UNIQUE constraint/.test(error.message)
      ? '名称、路径或标识已存在，请修改后重试。'
      : /FOREIGN KEY/.test(error.message)
        ? '关联数据已变化，请刷新后重试。'
        : error.message;
  if (c.req.path.startsWith('/_admin') && c.req.method === 'POST') {
    const referer = c.req.header('referer');
    let target = '/_admin';
    try {
      const url = new URL(referer ?? c.req.url);
      if (url.origin === new URL(c.req.url).origin) target = safeReturn(url.pathname + url.search);
    } catch {}
    const url = new URL(target, c.req.url);
    url.searchParams.set('err', message.slice(0, 300));
    return c.redirect(url.pathname + url.search, 303);
  }
  return c.json({ error: '请求失败，请检查配置或稍后重试。' }, 500);
});

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    const store = new Store(env.DB);
    ctx.waitUntil(
      Promise.all([
        store.run('DELETE FROM sessions WHERE expires_at<?', [Math.floor(Date.now() / 1000)]),
        store.run('DELETE FROM login_attempts WHERE window_start<?', [
          Math.floor(Date.now() / 1000) - 3600,
        ]),
        store.run("DELETE FROM access_logs WHERE created_at<datetime('now','-30 days')"),
      ]).then(() => {}),
    );
  },
};

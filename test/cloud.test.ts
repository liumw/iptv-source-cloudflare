import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { hashPassword, verifyPassword } from '../src/security.ts';
import { parsePlaylist, normalizeKey, inferNetwork, similarity } from '../src/ingest.ts';
import { parseWhitelist, checkIP, compatible, viewerFrom, regionFrom } from '../src/network.ts';
import { rewriteM3U8 } from '../src/proxy.ts';

let mf: Miniflare;
let db: any;
let cookie = '';
const password = 'test-cloud-password-123';
const origin = 'http://localhost';
async function request(path: string, options: RequestInit & { cf?: any } = {}) {
  const headers = new Headers(options.headers);
  if (cookie) headers.set('cookie', cookie);
  return mf.dispatchFetch(origin + path, { redirect: 'manual', ...options, headers });
}
async function post(path: string, fields: Record<string, string | string[]> = {}, follow = false) {
  const body = new URLSearchParams();
  for (const [k, value] of Object.entries(fields))
    for (const v of Array.isArray(value) ? value : [value]) body.append(k, v);
  const response = await request(path, { method: 'POST', body, headers: { origin } });
  if (follow && response.status === 303) return request(response.headers.get('location')!);
  return response;
}
async function scalar(sql: string, ...args: any[]) {
  const row = await db
    .prepare(sql)
    .bind(...args)
    .first();
  return row ? Object.values(row)[0] : null;
}

before(async () => {
  await build({
    entryPoints: ['src/index.ts'],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    outfile: '.generated/worker-test.mjs',
    logLevel: 'silent',
  });
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      scriptPath: resolve('.generated/worker-test.mjs'),
      compatibilityDate: '2026-10-20',
      d1Databases: { DB: 'test-iptv' },
      bindings: {
        SESSION_SECRET: 'test-secret-with-more-than-thirty-two-characters',
        ENABLE_PLAY_PROXY: 'false',
      },
      cf: false,
    }),
  );
  db = await mf.getD1Database('DB');
  const schema = (await readFile('migrations/0001_schema.sql', 'utf8')).replace(/^\s*--.*$/gm, '');
  await db.batch(
    schema
      .split(';')
      .filter((sql) => sql.trim())
      .map((sql) => db.prepare(sql)),
  );
  const hashed = await hashPassword(password);
  await db
    .prepare('INSERT INTO admin_users(username,password_hash,must_change_password) VALUES(?,?,0)')
    .bind('admin', hashed)
    .run();
  await db.exec(`INSERT INTO app_settings(key,value) VALUES('db_version','1'),('ip_lookup_enabled','1');
INSERT INTO profiles(id,slug,name,config_json) VALUES(1,'full','全量','{"max_streams_per_channel":5,"numbering":"auto"}');
INSERT INTO viewers(id,name,carrier,supports_ipv4,supports_ipv6,supports_iptv,is_default) VALUES(1,'客厅电视','telecom',1,1,1,1);
INSERT INTO groups(id,name) VALUES(1,'央视');
INSERT INTO sources(id,name,origin,format,inline_text) VALUES(1,'fixture','inline','m3u','#EXTM3U');
INSERT INTO channels(id,key,name,group_id,reviewed) VALUES(1,'cctv5','CCTV5',1,1),(2,'cctv8','CCTV8',1,1),(3,'restricted','Restricted',1,1);
INSERT INTO streams(id,source_id,channel_id,fingerprint,url,network,carrier,region,tvg_logo) VALUES(1,1,1,'a','https://example.com/a.m3u8','ipv4','telecom','CN-GD','https://example.com/logo.png'),(2,1,2,'b','https://example.com/b.m3u8','ipv4','unicom','CN-GD',NULL),(3,1,3,'c','https://example.com/c.m3u8','ipv6','all','national',NULL),(4,1,3,'d','udp://239.0.0.1:1234','iptv','telecom','national',NULL);
INSERT INTO subscriptions(id,name,profile_id,viewer_id,path) VALUES(1,'固定',1,1,'living'),(2,'自动',1,NULL,'auto');`);
});
after(async () => {
  await mf?.dispose();
});

test('password compatibility and safe text parsing', async () => {
  assert.ok(
    await verifyPassword(
      password,
      await hashPassword(password, '00112233445566778899aabbccddeeff', 200000),
    ),
  );
  assert.equal(await verifyPassword('wrong', await hashPassword(password)), false);
  assert.equal(normalizeKey('CCTV-5 体育 高清'), 'cctv5');
  assert.equal(inferNetwork('udp://239.0.0.1:1234'), 'iptv');
  assert.equal(inferNetwork('http://[240e::1]/a'), 'ipv6');
  assert.ok(similarity('cctv5', 'cctv5') === 100);
  const parsed = parsePlaylist(
    '#EXTM3U\n#EXTINF:-1 tvg-logo="https://example.com/a.png" group-title="央视",CCTV5\n#EXTVLCOPT:http-referrer=https://example.com\nhttps://example.com/a.m3u8',
  );
  assert.equal(parsed[0].attrs['tvg-logo'], 'https://example.com/a.png');
  assert.equal(parsed[0].vlc_opts.length, 1);
  assert.equal(
    parsePlaylist('少儿,#genre#\n动画,http://example.com/a#http://example.com/b', 'txt').length,
    2,
  );
});
test('IPv4 IPv6 CIDR whitelist and conservative compatibility', () => {
  assert.ok(checkIP('192.168.1.*', '::ffff:192.168.1.2').allowed);
  assert.ok(checkIP('240e::/16', '240e::1').allowed);
  assert.ok(checkIP('10.0.0.1-10.0.0.10', '10.0.0.5').allowed);
  assert.equal(checkIP('garbage', '1.2.3.4').allowed, false);
  assert.equal(checkIP('# comment', '1.2.3.4').allowed, true);
  assert.equal(parseWhitelist('10.*.1.*').errors.length, 1);
  assert.equal(regionFrom('CN', 'GD', ''), 'CN-GD');
  assert.equal(
    compatible({ network: 'ipv4', carrier: 'unicom' }, {}, viewerFrom({ supports_ipv4: 1 }, true)),
    'unknown_carrier',
  );
});
test('health, unauthenticated API and login', async () => {
  assert.equal((await request('/health')).status, 200);
  assert.equal((await request('/_api/stats')).status, 401);
  assert.equal((await request('/_admin')).status, 303);
  assert.match(await (await request('/_admin/login')).text(), /欢迎回来/);
  const response = await post('/_admin/login', { username: 'admin', password });
  assert.equal(response.status, 303);
  cookie = response.headers.get('set-cookie')!.split(';')[0];
  assert.match(cookie, /iptv_cloud_session=/);
});
test('every management page renders the existing UI without runtime code generation', async () => {
  for (const path of [
    '/_admin',
    '/_admin/sources',
    '/_admin/channels',
    '/_admin/channels/1',
    '/_admin/review',
    '/_admin/profiles',
    '/_admin/profiles/full',
    '/_admin/profiles/full?preview=1',
    '/_admin/viewers',
    '/_admin/subscriptions',
    '/_admin/subscriptions/1/test',
    '/_admin/play',
    '/_admin/network',
    '/_admin/network?ip=127.0.0.1&subscription_id=1',
    '/_admin/settings',
    '/_admin/logs',
  ]) {
    const response = await request(path),
      html = await response.text();
    assert.equal(response.status, 200, path + ' ' + html.slice(0, 180));
    assert.match(html, /主导航/, path);
  }
  const html = await (await request('/_admin/play')).text();
  assert.match(html, /channel-number-value/);
  assert.match(html, /data-channel-logo/);
  assert.match(html, /data-proxy-enabled="0"/);
  const channels = await (await request('/_admin/channels')).text();
  assert.match(channels, /CCTV5/);
  assert.match(channels, />1<\/td>/);
});
test('native Cloudflare IP metadata isolates carriers and IPv4 IPv6', async () => {
  const first = await request('/auto.m3u', {
    headers: { 'cf-connecting-ip': '1.2.3.4', 'x-forwarded-for': '8.8.8.8' },
    cf: { country: 'CN', regionCode: 'GD', asn: 4134, asOrganization: 'China Telecom' },
  });
  const playlist = await first.text();
  assert.equal(first.status, 200);
  assert.match(playlist, /,CCTV5\n/);
  assert.doesNotMatch(playlist, /,CCTV8\n|,Restricted\n/);
  assert.equal(first.headers.get('x-viewer-carrier'), 'telecom');
  assert.equal(first.headers.get('x-viewer-ipv6'), '0');
  assert.match(first.headers.get('cache-control')!, /^private/);
  const second = await request('/auto', {
    headers: { 'cf-connecting-ip': '8.8.8.8', 'if-none-match': first.headers.get('etag')! },
    cf: { country: 'CN', regionCode: 'GD', asn: 4837, asOrganization: 'China Unicom' },
  });
  assert.equal(second.status, 200);
  assert.match(await second.text(), /,CCTV8\n/);
  const ipv6 = await request('/auto', {
    headers: { 'cf-connecting-ip': '240e::1' },
    cf: { country: 'CN', regionCode: 'GD', asn: 4134 },
  });
  assert.equal(ipv6.headers.get('x-viewer-ipv4'), '0');
  assert.match(await ipv6.text(), /,Restricted\n/);
});
test('network rules, subscription access tokens and private cache', async () => {
  const response = await post('/_admin/network/settings', {
    ip_lookup_enabled: '1',
    ip_network_rules: '192.168.1.0/24,客厅电视',
  });
  assert.equal(response.status, 303);
  const detection = (await (await request('/_api/network/detect?ip=192.168.1.9')).json()) as any;
  assert.equal(detection.source, 'cidr');
  assert.equal(detection.viewer.supports_iptv, true);
  await post('/_admin/subscriptions/add', {
    name: '受保护',
    profile_id: '1',
    path: 'private',
    access_token: 'secret-token',
    cache_ttl: '30',
  });
  assert.equal((await request('/private')).status, 403);
  assert.equal((await request('/private?token=secret-token')).status, 200);
  await post('/_admin/settings/update', {
    playlist_ip_whitelist: '10.0.0.0/8',
    whitelist_deny_status: '403',
  });
  assert.equal((await request('/private?token=secret-token')).status, 403);
  await post('/_admin/settings/update', {
    playlist_ip_whitelist: '',
    whitelist_deny_status: '403',
  });
});
test('source ingestion is persisted, repeatable and preserves manual overrides', async () => {
  const body =
    '#EXTM3U\n#EXTINF:-1 tvg-logo="https://example.com/new.png" group-title="央视",CCTV5\nhttp://1.2.3.4/new.m3u8\n#EXTINF:-1 group-title="少儿",新动画\nhttp://1.2.3.4/child.m3u8';
  await post('/_admin/sources/add', {
    name: 'import-test',
    origin: 'inline',
    format: 'm3u',
    inline_text: body,
    headers_json: '{}',
  });
  const id = await scalar("SELECT id FROM sources WHERE name='import-test'");
  let response = await post(`/_admin/sources/${id}/fetch`);
  assert.equal(response.status, 303);
  assert.equal(new URL(response.headers.get('location')!, origin).searchParams.get('err'), null);
  assert.equal(await scalar('SELECT count(*) FROM streams WHERE source_id=?', id), 2);
  const stream = await db
    .prepare('SELECT * FROM streams WHERE source_id=? ORDER BY id LIMIT 1')
    .bind(id)
    .first();
  await post(`/_admin/streams/${stream.id}/update`, {
    network: 'ipv6',
    carrier: 'unicom',
    priority: '20',
    excluded: '1',
  });
  response = await post(`/_admin/sources/${id}/fetch`, { force: '1' });
  assert.equal(response.status, 303);
  const changed = await db.prepare('SELECT * FROM streams WHERE id=?').bind(stream.id).first();
  assert.equal(changed.network, 'ipv6');
  assert.equal(changed.carrier, 'unicom');
  assert.equal(changed.excluded, 1);
  assert.equal(await scalar('SELECT count(*) FROM streams WHERE source_id=?', id), 2);
});
test('channel numbers, pinned channels, defaults, merges and viewer references', async () => {
  await post('/_admin/channels/1/chno', { chno: '101', return_to: '/_admin/channels' });
  assert.equal(await scalar('SELECT chno FROM channels WHERE id=1'), 101);
  await post('/_admin/profiles/full/channels', { channel_ids: ['1'] });
  assert.equal(
    await scalar('SELECT count(*) FROM profile_channels WHERE profile_id=1 AND include=1'),
    1,
  );
  const playlist = await (await request('/living')).text();
  assert.match(playlist, /,CCTV5\n/);
  assert.doesNotMatch(playlist, /,CCTV8\n/);
  await post('/_admin/profiles/full/channels/clear');
  assert.equal(
    await scalar('SELECT count(*) FROM profile_channels WHERE profile_id=1 AND include=1'),
    0,
  );
  await post('/_admin/streams/1/default');
  assert.equal(await scalar('SELECT is_default FROM streams WHERE id=1'), 1);
  await post('/_admin/channels/3/merge', { target_id: '1' });
  assert.equal(await scalar('SELECT count(*) FROM channels WHERE id=3'), 0);
  assert.equal(await scalar('SELECT channel_id FROM streams WHERE id=3'), 1);
  await post('/_admin/viewers/add', {
    name: '移动手机',
    carrier: 'mobile',
    region: 'CN-BJ',
    supports_ipv6: '1',
  });
  assert.equal(await scalar("SELECT supports_ipv4 FROM viewers WHERE name='移动手机'"), 0);
});
test('CSRF, disabled proxy and HLS URL rewriting', async () => {
  assert.equal(
    (
      await request('/_admin/channels/1/delete', {
        method: 'POST',
        headers: { origin: 'https://evil.example' },
      })
    ).status,
    403,
  );
  assert.equal((await request('/_admin/play/proxy?url=https://example.com/a.m3u8')).status, 501);
  const rewritten = rewriteM3U8(
    '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\nsegment.ts\n',
    'https://example.com/path/list.m3u8',
  );
  assert.match(rewritten, /url=https%3A%2F%2Fexample.com%2Fpath%2Fkey.bin/);
  assert.match(rewritten, /url=https%3A%2F%2Fexample.com%2Fpath%2Fsegment.ts/);
});

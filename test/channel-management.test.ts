import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { hashPassword } from '../src/security.ts';

let mf: Miniflare;
let db: any;
let cookie = '';
const origin = 'http://localhost';
async function request(path: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers);
  if (cookie) headers.set('cookie', cookie);
  return mf.dispatchFetch(origin + path, { ...options, headers, redirect: 'manual' });
}
async function post(path: string, fields: Record<string, string | string[]> = {}) {
  const body = new URLSearchParams();
  for (const [name, value] of Object.entries(fields))
    for (const item of Array.isArray(value) ? value : [value]) body.append(name, item);
  return request(path, { method: 'POST', body, headers: { origin } });
}
async function scalar(sql: string, ...args: unknown[]) {
  const row = await db
    .prepare(sql)
    .bind(...args)
    .first();
  return row ? Object.values(row)[0] : null;
}
async function create(fields: Record<string, string>) {
  const response = await post('/_admin/channels/add', fields);
  assert.equal(response.status, 303);
  const location = new URL(response.headers.get('location')!, origin);
  assert.equal(location.searchParams.get('err'), null);
  assert.match(location.pathname, /^\/_admin\/channels\/\d+$/);
  return Number(location.pathname.split('/').pop());
}

before(async () => {
  await build({
    entryPoints: ['src/index.ts'],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    outfile: '.generated/channel-management-worker.mjs',
    logLevel: 'silent',
  });
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      scriptPath: resolve('.generated/channel-management-worker.mjs'),
      compatibilityDate: '2026-10-20',
      d1Databases: { DB: 'channel-management-empty' },
      bindings: {
        SESSION_SECRET: 'channel-management-test-secret-with-more-than-32-characters',
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
  await db
    .prepare('INSERT INTO admin_users(username,password_hash,must_change_password) VALUES(?,?,0)')
    .bind('testadmin', await hashPassword('channel-test-password'))
    .run();
  await db.exec(
    "INSERT INTO profiles(id,slug,name,config_json) VALUES(1,'full','全部频道','{}'); INSERT INTO subscriptions(name,profile_id,path,access_token) VALUES('测试',1,'live','channel-test-token');",
  );
  const login = await post('/_admin/login', {
    username: 'testadmin',
    password: 'channel-test-password',
  });
  assert.equal(login.status, 303);
  cookie = login.headers.get('set-cookie')!.split(';')[0];
});
after(async () => {
  await mf?.dispose();
});

test('a channel can be created without any imported source or initial stream', async () => {
  const page = await request('/_admin/channels/new');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /手动添加频道/);
  const id = await create({ name: '手动空频道', chno: '0' });
  const channel = await db.prepare('SELECT * FROM channels WHERE id=?').bind(id).first();
  assert.equal(channel.reviewed, 1);
  assert.equal(channel.auto_created, 0);
  assert.equal(channel.enabled, 1);
  assert.equal(channel.chno, 0);
  assert.equal(await scalar('SELECT count(*) FROM sources'), 0);
  assert.equal(await scalar('SELECT count(*) FROM streams'), 0);
  const list = await (await request('/_admin/channels')).text();
  assert.match(list, /手动空频道/);
  assert.match(list, /批量永久删除/);
  assert.doesNotMatch(list, /删除（停用）/);
});

test('invalid or duplicate manual channels preserve form values without partial writes', async () => {
  const beforeCounts = await db
    .prepare(
      'SELECT (SELECT count(*) FROM channels) c,(SELECT count(*) FROM groups) g,(SELECT count(*) FROM sources) s,(SELECT count(*) FROM streams) t',
    )
    .first();
  for (const fields of [
    { name: '   ' },
    { name: '手动空频道 HD' },
    { name: '无效台号', chno: '2.5' },
    { name: '无效地址', url: 'javascript://alert(1)' },
    { name: '无效网络', network: 'bad' },
    { name: '无效运营商', carrier: 'bad' },
    { name: '无效地区', region: '__proto__' },
    { name: '<保留输入>', logo: 'data:image/svg+xml,test' },
  ]) {
    const response = await post('/_admin/channels/add', {
      ...fields,
      group_name: '不应创建的分组',
    });
    assert.equal(response.status, 400, JSON.stringify(fields));
    const html = await response.text();
    if (fields.name === '<保留输入>') assert.match(html, /value="&lt;保留输入&gt;"/);
  }
  assert.deepEqual(
    await db
      .prepare(
        'SELECT (SELECT count(*) FROM channels) c,(SELECT count(*) FROM groups) g,(SELECT count(*) FROM sources) s,(SELECT count(*) FROM streams) t',
      )
      .first(),
    beforeCounts,
  );
  const response = await request('/_admin/channels/add', {
    method: 'POST',
    headers: { origin: 'https://evil.example' },
    body: new URLSearchParams({ name: '跨站写入' }),
  });
  assert.equal(response.status, 403);
});

test('manual channel and first stream commit together and do not hijack an imported source', async () => {
  await db
    .prepare(
      "INSERT INTO sources(name,origin,url) VALUES('手工线路','url','https://example.com/source.m3u')",
    )
    .run();
  const id = await create({
    name: '手动完整频道',
    group_name: '手动分组',
    region: 'national',
    chno: '832',
    logo: 'https://example.com/logo.svg',
    tvg_id: 'manual-test',
    notes: '自定义信息',
    url: 'https://example.com/manual.m3u8',
    network: 'all',
    carrier: 'all',
  });
  const row = await db
    .prepare(
      'SELECT c.*,g.name group_name FROM channels c LEFT JOIN groups g ON g.id=c.group_id WHERE c.id=?',
    )
    .bind(id)
    .first();
  assert.equal(row.chno, 832);
  assert.equal(row.group_name, '手动分组');
  assert.equal(row.region_manual, 1);
  assert.equal(row.logo, 'https://example.com/logo.svg');
  const stream = await db
    .prepare(
      'SELECT s.*,src.origin FROM streams s JOIN sources src ON src.id=s.source_id WHERE s.channel_id=?',
    )
    .bind(id)
    .first();
  assert.equal(stream.origin, 'manual');
  assert.equal(stream.is_default, 1);
  assert.equal(stream.network_manual, 1);
  assert.equal(stream.carrier_manual, 1);
  assert.equal(stream.region_manual, 1);
  assert.equal(await scalar("SELECT origin FROM sources WHERE name='手工线路'"), 'url');
  const emptyID = await scalar("SELECT id FROM channels WHERE name='手动空频道'");
  assert.equal(
    (
      await post(`/_admin/channels/${emptyID}/streams/add`, {
        url: 'https://example.com/later.m3u8',
        is_default: '1',
      })
    ).status,
    303,
  );
  assert.equal(
    await scalar(
      'SELECT src.origin FROM streams s JOIN sources src ON src.id=s.source_id WHERE s.channel_id=?',
      emptyID,
    ),
    'manual',
  );
  assert.equal(await scalar("SELECT count(*) FROM sources WHERE origin='manual'"), 1);
  const playlist = await (await request('/live?token=channel-test-token')).text();
  assert.match(playlist, /https:\/\/example.com\/manual.m3u8/);
});

test('single and batch deletion remove all dependent records and invalidate playlists', async () => {
  const first = await create({
    name: '删除甲频道',
    group_name: '共享分组',
    url: 'https://example.com/remove-a.m3u8',
  });
  const second = await create({
    name: '删除乙频道',
    group_name: '共享分组',
    url: 'https://example.com/remove-b.m3u8',
  });
  const retained = await create({
    name: '保留丙频道',
    group_name: '共享分组',
    url: 'https://example.com/retain-c.m3u8',
  });
  for (const id of [first, second, retained]) {
    await db
      .prepare('INSERT INTO channel_aliases(channel_id,alias,alias_norm) VALUES(?,?,?)')
      .bind(id, `别名${id}`, `delete-alias-${id}`)
      .run();
    await db
      .prepare('INSERT INTO profile_channels(profile_id,channel_id,include) VALUES(1,?,1)')
      .bind(id)
      .run();
  }
  const before = await request('/live?token=channel-test-token');
  const etag = before.headers.get('etag')!;
  assert.match(await before.text(), /删除甲频道/);
  const sources = await scalar('SELECT count(*) FROM sources');
  const invalidDelete = await post(`/_admin/channels/${first}.5/delete`);
  assert.equal(invalidDelete.status, 303);
  assert.ok(new URL(invalidDelete.headers.get('location')!, origin).searchParams.get('err'));
  assert.equal(await scalar('SELECT count(*) FROM channels WHERE id=?', first), 1);
  const response = await post(`/_admin/channels/${first}/delete`, {
    return_to: '/_admin/channels?q=删除',
  });
  assert.equal(response.status, 303);
  assert.equal(new URL(response.headers.get('location')!, origin).searchParams.get('q'), '删除');
  for (const table of ['streams', 'channel_aliases', 'profile_channels'])
    assert.equal(await scalar(`SELECT count(*) FROM ${table} WHERE channel_id=?`, first), 0, table);
  assert.equal(await scalar('SELECT count(*) FROM channels WHERE id=?', first), 0);
  const changed = await request('/live?token=channel-test-token', {
    headers: { 'if-none-match': etag },
  });
  assert.equal(changed.status, 200);
  assert.notEqual(changed.headers.get('etag'), etag);
  assert.doesNotMatch(await changed.text(), /删除甲频道/);
  assert.equal(
    (
      await post('/_admin/channels/batch-delete', {
        channel_ids: [String(second), String(second), '-1', 'bad'],
      })
    ).status,
    303,
  );
  assert.equal(await scalar('SELECT count(*) FROM channels WHERE id=?', second), 0);
  for (const table of ['streams', 'channel_aliases', 'profile_channels']) {
    assert.equal(
      await scalar(`SELECT count(*) FROM ${table} WHERE channel_id=?`, second),
      0,
      table,
    );
    assert.equal(
      await scalar(`SELECT count(*) FROM ${table} WHERE channel_id=?`, retained),
      1,
      table,
    );
  }
  assert.equal(await scalar('SELECT count(*) FROM channels WHERE id=?', retained), 1);
  assert.equal(await scalar('SELECT count(*) FROM sources'), sources);
  assert.equal(await scalar("SELECT count(*) FROM groups WHERE name='共享分组'"), 1);
  assert.equal(await scalar('SELECT count(*) FROM streams WHERE channel_id IS NULL'), 0);
  const version = await scalar("SELECT value FROM app_settings WHERE key='db_version'");
  await post('/_admin/channels/batch-delete');
  assert.equal(await scalar("SELECT value FROM app_settings WHERE key='db_version'"), version);
});

import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { hashPassword } from '../src/security.ts';
import { applyChannelNumberMigration, applyPendingMigration } from './schema.ts';

let mf: Miniflare,
  db: any,
  cookie = '';
const origin = 'http://localhost';
const request = (path: string, init: RequestInit = {}) =>
  mf.dispatchFetch(origin + path, {
    redirect: 'manual',
    ...init,
    headers: { cookie, origin, referer: origin + '/_admin/channels', ...init.headers },
  });
const post = (path: string, fields: Record<string, string> = {}) =>
  request(path, { method: 'POST', body: new URLSearchParams(fields) });
const error = (response: Response) =>
  new URL(response.headers.get('location')!, origin).searchParams.get('err');
async function schema(database: any) {
  const sql = (await readFile('migrations/0001_schema.sql', 'utf8')).replace(/^\s*--.*$/gm, '');
  await database.batch(
    sql
      .split(';')
      .filter((s) => s.trim())
      .map((s) => database.prepare(s)),
  );
}
before(async () => {
  await build({
    entryPoints: ['src/index.ts'],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    outfile: '.generated/channel-numbers-worker.mjs',
    logLevel: 'silent',
  });
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      scriptPath: resolve('.generated/channel-numbers-worker.mjs'),
      compatibilityDate: '2026-10-20',
      d1Databases: { DB: 'channel-numbers', LEGACY: 'legacy-numbers' },
      bindings: { SESSION_SECRET: 'channel-numbers-test-secret-longer-than-thirty-two-characters' },
      cf: false,
    }),
  );
  db = await mf.getD1Database('DB');
  await schema(db);
  await applyChannelNumberMigration(db);
  await applyPendingMigration(db);
  await db
    .prepare('INSERT INTO admin_users(username,password_hash,must_change_password) VALUES(?,?,0)')
    .bind('testadmin', await hashPassword('channel-numbers-password'))
    .run();
  await db.exec(`INSERT INTO profiles(id,slug,name,config_json,cache_ttl) VALUES(1,'numbered','台号测试','{}',0);
    INSERT INTO viewers(id,name,carrier,supports_ipv4,supports_ipv6,region) VALUES(1,'双栈','all',1,1,'national');
    INSERT INTO subscriptions(name,profile_id,viewer_id,path,access_token,cache_ttl) VALUES('台号测试',1,1,'numbered','number-token',0);
    INSERT INTO sources(id,name,origin) VALUES(1,'线路','inline');
    INSERT INTO channels(id,key,name,chno,reviewed,enabled) VALUES(1,'one','频道甲',1,1,1),(2,'auto','自动频道',NULL,1,1),(3,'zero','零号频道',0,1,1),(4,'fixed','手动频道',88,1,1),(5,'empty','停用空频道',2,1,0),(6,'ipv6','IPv6频道',NULL,1,1);
    INSERT INTO streams(source_id,channel_id,fingerprint,url,network,carrier,region) VALUES(1,1,'one','https://example.com/one','all','all','national'),(1,2,'auto','https://example.com/auto','all','all','national'),(1,3,'zero','https://example.com/zero','all','all','national'),(1,4,'fixed','https://example.com/fixed','all','all','national'),(1,4,'backup','https://example.com/fixed-backup','all','all','national'),(1,6,'ipv6','https://example.com/ipv6','ipv6','all','national');
    INSERT INTO profile_channels(profile_id,channel_id,chno_override) VALUES(1,4,99),(1,2,1),(1,6,7);`);
  cookie = (
    await post('/_admin/login', { username: 'testadmin', password: 'channel-numbers-password' })
  ).headers
    .get('set-cookie')!
    .split(';')[0];
  await db.exec(
    `UPDATE streams SET attrs_json='{"attrs":{"tvg-chno":"555"}}' WHERE channel_id IN (2,4)`,
  );
  await db.exec("UPDATE channels SET logo='https://example.com/one.png' WHERE id=1");
  await db.exec(`UPDATE streams SET tvg_logo='https://example.com/imported.png' WHERE channel_id=1;
    UPDATE streams SET tvg_logo='https://example.com/auto.png' WHERE channel_id=2;
    UPDATE streams SET tvg_logo='https://example.com/default.png',is_default=1 WHERE fingerprint='fixed';
    UPDATE streams SET tvg_logo='https://example.com/backup.png',priority=100 WHERE fingerprint='backup';`);
});
after(async () => {
  await mf?.dispose();
});

for (const mode of ['auto', 'fixed', 'none'])
  test(`${mode} subscriptions preserve authoritative manual numbers, zero and all lines`, async () => {
    const options = (await (
      await request('/_admin/profiles/numbered/channel-options')
    ).json()) as any;
    assert.deepEqual(
      options.channels.map((channel: any) => channel.chno),
      [0, 1, 88, null, null],
    );
    assert.deepEqual(
      options.channels.slice(0, 3).map((channel: any) => channel.id),
      [3, 1, 4],
    );
    assert.equal(
      options.channels.find((channel: any) => channel.id === 1).logo,
      'https://example.com/one.png',
    );
    assert.equal(options.channels.find((channel: any) => channel.id === 3).logo, null);
    assert.equal(
      options.channels.find((channel: any) => channel.id === 2).logo,
      'https://example.com/auto.png',
    );
    assert.equal(
      options.channels.find((channel: any) => channel.id === 4).logo,
      'https://example.com/default.png',
    );
    await db
      .prepare('UPDATE profiles SET config_json=? WHERE id=1')
      .bind(
        JSON.stringify({
          numbering: mode,
          start_chno: 1,
          numbering_step: 1,
          max_streams_per_channel: 5,
        }),
      )
      .run();
    const read = async () => {
      const response = await request('/numbered?token=number-token');
      assert.equal(response.status, 200);
      const text = await response.text();
      const entries = [...text.matchAll(/^#EXTINF:([^\n]*),([^\n]+)$/gm)].map((m) => ({
        name: m[2],
        number: m[1].match(/tvg-chno="(\d+)"/)?.[1] ?? null,
      }));
      assert.equal(entries.find((e) => e.name === '频道甲')!.number, '1');
      assert.equal(entries.find((e) => e.name === '零号频道')!.number, '0');
      assert.deepEqual(
        entries.filter((e) => e.name === '手动频道').map((e) => e.number),
        ['88', '88'],
      );
      assert.equal(
        entries.find((e) => e.name === '自动频道')!.number,
        mode === 'none' ? null : '3',
      );
      return entries;
    };
    const dual = await read();
    assert.equal(
      dual.find((e) => e.name === 'IPv6频道')!.number,
      mode === 'none' ? null : mode === 'fixed' ? '7' : '4',
    );
    await db.exec('UPDATE viewers SET supports_ipv6=0 WHERE id=1');
    assert.ok(!(await read()).some((e) => e.name === 'IPv6频道'));
    await db.exec('UPDATE viewers SET supports_ipv6=1 WHERE id=1');
  });

test('list, detail and create reject duplicate numbers before changing any fields', async () => {
  for (const number of ['1', '0', '2', '-1', '1.5', '1e2', 'NaN', '9007199254740992']) {
    const response = await post('/_admin/channels/2/chno', {
      chno: number,
      return_to: '/_admin/channels?q=keep',
    });
    assert.equal(response.status, 303);
    assert.ok(error(response), number);
    assert.equal(new URL(response.headers.get('location')!, origin).searchParams.get('q'), 'keep');
    assert.equal(await db.prepare('SELECT chno FROM channels WHERE id=2').first('chno'), null);
  }
  const previous = await db.prepare('SELECT * FROM channels WHERE id=2').first();
  const changed = await post('/_admin/channels/2/update', {
    name: '不应改名',
    group_name: '不应创建分组',
    chno: '1',
    logo: 'https://example.com/changed.png',
  });
  assert.match(error(changed)!, /频道甲/);
  assert.deepEqual(await db.prepare('SELECT * FROM channels WHERE id=2').first(), previous);
  assert.equal(
    await db.prepare("SELECT count(*) n FROM groups WHERE name='不应创建分组'").first('n'),
    0,
  );
  const added = await post('/_admin/channels/add', { name: '重复台号新频道', chno: '1' });
  assert.equal(added.status, 400);
  assert.match(await added.text(), /频道甲/);
  assert.equal(
    await db.prepare("SELECT count(*) n FROM channels WHERE name='重复台号新频道'").first('n'),
    0,
  );
  assert.equal(
    error(await post('/_admin/channels/4/chno', { chno: '88' })),
    null,
    'resaving own number is allowed',
  );
  assert.equal(error(await post('/_admin/channels/3/chno', { chno: '' })), null);
  assert.equal(error(await post('/_admin/channels/2/chno', { chno: '000' })), null);
  assert.match(error(await post('/_admin/channels/3/chno', { chno: '0' }))!, /自动频道/);
});

test('database guards reject direct writes and concurrent channel edits', async () => {
  await assert.rejects(
    () => db.prepare("INSERT INTO channels(key,name,chno) VALUES('duplicate','重复',1)").run(),
    /CHANNEL_NUMBER_TAKEN/,
  );
  await assert.rejects(
    () => db.prepare('UPDATE channels SET chno=1 WHERE id=2').run(),
    /CHANNEL_NUMBER_TAKEN/,
  );
  const responses = await Promise.all([
    post('/_admin/channels/2/chno', { chno: '33' }),
    post('/_admin/channels/6/chno', { chno: '33' }),
  ]);
  assert.equal(responses.filter((r) => error(r) === null).length, 1);
  assert.equal(responses.filter((r) => error(r) !== null).length, 1);
  assert.equal(await db.prepare('SELECT count(*) n FROM channels WHERE chno=33').first('n'), 1);
});

test('upgrading a legacy database preserves existing numbers and prevents additional conflicts', async () => {
  const legacy = await mf.getD1Database('LEGACY');
  await schema(legacy);
  await legacy.exec(
    "INSERT INTO channels(key,name,chno) VALUES('old-a','旧甲',7),('old-b','旧乙',7);",
  );
  await applyChannelNumberMigration(legacy);
  assert.equal(await legacy.prepare('SELECT count(*) n FROM channels WHERE chno=7').first('n'), 2);
  await assert.rejects(
    () => legacy.prepare("INSERT INTO channels(key,name,chno) VALUES('new','新频道',7)").run(),
    /CHANNEL_NUMBER_TAKEN/,
  );
  await legacy.exec(
    "UPDATE channels SET chno=NULL WHERE key='old-b'; UPDATE channels SET notes='保持台号' WHERE key='old-a';",
  );
  assert.equal(
    await legacy.prepare("SELECT chno FROM channels WHERE key='old-a'").first('chno'),
    7,
  );
});

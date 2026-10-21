import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { hashPassword } from '../src/security.ts';
import { applyChannelNumberMigration, applyPendingMigration } from './schema.ts';
import { confirmPending } from '../src/review.ts';
import { Store } from '../src/store.ts';

let mf: Miniflare,
  db: any,
  cookie = '';
const origin = 'http://localhost';
const request = (path: string, init: RequestInit = {}) =>
  mf.dispatchFetch(origin + path, {
    redirect: 'manual',
    ...init,
    headers: { cookie, origin, referer: origin + '/_admin/review', ...init.headers },
  });
async function post(path: string, fields: Record<string, string | string[]> = {}) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields))
    for (const item of Array.isArray(value) ? value : [value]) body.append(key, item);
  return request(path, { method: 'POST', body });
}
const scalar = (sql: string) => db.prepare(sql).first('n');
const rows = async (sql: string) => (await db.prepare(sql).all()).results;
const err = (response: Response) =>
  new URL(response.headers.get('location')!, origin).searchParams.get('err');
async function schema(database: any) {
  const sql = (await readFile('migrations/0001_schema.sql', 'utf8')).replace(/^\s*--.*$/gm, '');
  await database.batch(
    sql
      .split(';')
      .filter((s) => s.trim())
      .map((s) => database.prepare(s)),
  );
  await applyChannelNumberMigration(database);
}
const playlist =
  '#EXTM3U\n#EXTINF:-1 tvg-logo="https://example.com/imported.png",CCTV5 HD\nhttps://example.com/duplicate.m3u8\n#EXTINF:-1,CCTV5 HD\nhttps://example.com/new1.m3u8\n#EXTINF:-1,CCTV5 HD\nhttps://example.com/new2.m3u8\n#EXTINF:-1,独立新频道\nhttps://example.com/unique.m3u8';
before(async () => {
  await build({
    entryPoints: ['src/index.ts'],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    outfile: '.generated/review-worker.mjs',
    logLevel: 'silent',
  });
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      scriptPath: resolve('.generated/review-worker.mjs'),
      compatibilityDate: '2026-10-20',
      d1Databases: { DB: 'review', LEGACY: 'review-legacy' },
      bindings: { SESSION_SECRET: 'review-test-secret-longer-than-thirty-two-characters' },
      cf: false,
    }),
  );
  db = await mf.getD1Database('DB');
  await schema(db);
  await applyPendingMigration(db);
  await db
    .prepare('INSERT INTO admin_users(username,password_hash,must_change_password) VALUES(?,?,0)')
    .bind('testadmin', await hashPassword('review-test-password'))
    .run();
  await db.exec(`INSERT INTO app_settings(key,value) VALUES('ip_lookup_enabled','0');
    INSERT INTO sources(id,name,origin,inline_text) VALUES(1,'正式线路','manual',NULL),(2,'解析源','inline',NULL);
    INSERT INTO channels(id,key,name,chno,logo,notes,reviewed) VALUES(1,'cctv5','CCTV5',5,'https://example.com/manual.png','手动备注',1);
    INSERT INTO streams(id,source_id,channel_id,fingerprint,url,is_default) VALUES(1,1,1,'existing','https://example.com/duplicate.m3u8',1);
    INSERT INTO profiles(id,slug,name,config_json,cache_ttl) VALUES(1,'full','测试','{}',0);
    INSERT INTO subscriptions(name,profile_id,path,cache_ttl) VALUES('测试',1,'review-live',0);`);
  await db.prepare('UPDATE sources SET inline_text=? WHERE id=2').bind(playlist).run();
  cookie = (
    await post('/_admin/login', { username: 'testadmin', password: 'review-test-password' })
  ).headers
    .get('set-cookie')!
    .split(';')[0];
});
after(async () => {
  await mf?.dispose();
});

test('all unseen lines are staged, official-only suggestions and subscriptions remain unchanged', async () => {
  assert.equal(err(await post('/_admin/sources/2/fetch', { force: '1' })), null);
  assert.equal(await scalar('SELECT count(*) n FROM channels'), 1);
  assert.equal(await scalar('SELECT count(*) n FROM pending_channels'), 2);
  assert.equal(
    await scalar(
      'SELECT count(*) n FROM streams WHERE channel_id IS NULL AND pending_channel_id IS NOT NULL',
    ),
    4,
  );
  const pending = await scalar("SELECT id n FROM pending_channels WHERE key='cctv5'");
  const options: any = await (
    await request(`/_admin/review/${pending}/merge-options?target_id=1`)
  ).json();
  assert.deepEqual(
    options.targets.map((t: any) => t.id),
    [1],
  );
  assert.equal(options.incoming.length, 3);
  assert.equal(options.existing.length, 1);
  assert.equal(options.incoming.filter((s: any) => s.duplicate).length, 1);
  const review = await (await request('/_admin/review')).text();
  assert.match(review, /data-target-id="1"/);
  assert.equal((review.match(/data-target-id=/g) ?? []).length, 1);
  const catalog = await (await request('/_admin/channels')).text();
  assert.doesNotMatch(catalog, /独立新频道/);
  const subscription = await (await request('/review-live')).text();
  assert.doesNotMatch(subscription, /new1|new2|unique/);
  const channelOptions: any = await (await request('/_admin/profiles/full/channel-options')).json();
  assert.equal(channelOptions.channels.length, 1);
});

test('invalid, duplicate, cross-candidate and locked merges make no partial changes', async () => {
  const pending = await scalar("SELECT id n FROM pending_channels WHERE key='cctv5'");
  const initial = await rows('SELECT * FROM streams ORDER BY id');
  const duplicate = initial.find(
    (s: any) => s.pending_channel_id === pending && s.url.includes('duplicate'),
  ).id;
  const foreign = initial.find((s: any) => s.url.includes('unique')).id;
  for (const fields of [
    { target_id: '1' },
    { target_id: '1', stream_ids: [String(duplicate)] },
    { target_id: '1', stream_ids: [String(foreign)] },
    { target_id: '999', stream_ids: [String(duplicate)] },
  ]) {
    assert.ok(err(await post(`/_admin/review/${pending}/merge`, fields)));
    assert.deepEqual(await rows('SELECT * FROM streams ORDER BY id'), initial);
  }
  await db
    .prepare("INSERT INTO cloud_locks(name,token,expires_at) VALUES('ingest','test-lock',?)")
    .bind(Math.floor(Date.now() / 1000) + 120)
    .run();
  assert.match(err(await post(`/_admin/review/${pending}/confirm`))!, /正在更新/);
  await db.exec("DELETE FROM cloud_locks WHERE token='test-lock'");
  assert.ok(err(await post(`/_admin/review/${pending}/confirm`)));
  assert.equal(await scalar('SELECT count(*) n FROM channels'), 1);
});

test('partial merge preserves settings, default line and unselected candidates across refresh and reimport', async () => {
  const pending = await scalar("SELECT id n FROM pending_channels WHERE key='cctv5'");
  const chosen = await scalar("SELECT id n FROM streams WHERE url LIKE '%new1%'");
  const channel = await rows('SELECT * FROM channels WHERE id=1');
  const defaultLine = await rows('SELECT * FROM streams WHERE id=1');
  assert.equal(
    err(
      await post(`/_admin/review/${pending}/merge`, {
        target_id: '1',
        stream_ids: [String(chosen)],
      }),
    ),
    null,
  );
  assert.equal(await scalar(`SELECT channel_id n FROM streams WHERE id=${chosen}`), 1);
  assert.equal(
    await scalar(`SELECT count(*) n FROM streams WHERE pending_channel_id=${pending}`),
    2,
  );
  assert.deepEqual(await rows('SELECT * FROM channels WHERE id=1'), channel);
  assert.deepEqual(await rows('SELECT * FROM streams WHERE id=1'), defaultLine);
  const associations = await rows(
    'SELECT id,channel_id,pending_channel_id FROM streams ORDER BY id',
  );
  await post('/_admin/sources/2/fetch', { force: '1' });
  assert.deepEqual(
    await rows('SELECT id,channel_id,pending_channel_id FROM streams ORDER BY id'),
    associations,
  );
  await post('/_admin/sources/2/delete');
  await post('/_admin/sources/add', {
    name: '解析源',
    origin: 'inline',
    format: 'm3u',
    inline_text: playlist,
    headers_json: '{}',
  });
  const sourceID = await scalar("SELECT id n FROM sources WHERE name='解析源'");
  assert.equal(err(await post(`/_admin/sources/${sourceID}/fetch`, { force: '1' })), null);
  assert.deepEqual(
    await rows('SELECT id,channel_id,pending_channel_id FROM streams ORDER BY id'),
    associations,
  );
});

test('new confirmation moves records into official table, and bulk conflicts roll back atomically', async () => {
  const before = await rows('SELECT * FROM pending_channels ORDER BY id');
  assert.ok(err(await post('/_admin/review/confirm-all')));
  assert.deepEqual(await rows('SELECT * FROM pending_channels ORDER BY id'), before);
  assert.equal(await scalar('SELECT count(*) n FROM channels'), 1);
  const unique = await scalar("SELECT id n FROM pending_channels WHERE key='独立新频道'");
  assert.equal(err(await post(`/_admin/review/${unique}/confirm`)), null);
  assert.equal(await scalar(`SELECT count(*) n FROM pending_channels WHERE id=${unique}`), 0);
  const official = await scalar("SELECT id n FROM channels WHERE key='独立新频道'");
  assert.equal(
    await scalar("SELECT channel_id n FROM streams WHERE url LIKE '%unique%'"),
    official,
  );
  assert.match(await (await request('/review-live')).text(), /unique/);
  assert.ok(
    err(await post(`/_admin/review/${unique}/confirm`)),
    'stale approval cannot target another table',
  );
});

test('legacy split preserves approved records, stream IDs and archived aliases/profile overrides', async () => {
  const legacy = await mf.getD1Database('LEGACY');
  await schema(legacy);
  await legacy.exec(`INSERT INTO sources(id,name,origin) VALUES(1,'旧源','inline');
    INSERT INTO channels(id,key,name,chno,logo,notes,auto_created,reviewed) VALUES(1,'official','正式',8,'official.png','正式设置',1,1),(2,'pending','候选',22,'pending.png','候选设置',1,0);
    INSERT INTO streams(id,source_id,channel_id,fingerprint,url,is_default) VALUES(11,1,1,'approved','https://example.com/approved',1),(12,1,2,'pending','https://example.com/pending',1);
    INSERT INTO profiles(id,slug,name) VALUES(1,'legacy','旧视图');
    INSERT INTO channel_aliases(channel_id,alias,alias_norm) VALUES(2,'旧别名','legacy-alias');
    INSERT INTO profile_channels(profile_id,channel_id,include,chno_override) VALUES(1,2,1,99);`);
  const original = await legacy.prepare('SELECT * FROM channels WHERE id=1').first();
  await applyPendingMigration(legacy);
  assert.deepEqual(await legacy.prepare('SELECT * FROM channels WHERE id=1').first(), original);
  assert.equal(
    await legacy.prepare('SELECT channel_id FROM streams WHERE id=12').first('channel_id'),
    null,
  );
  assert.equal(
    await legacy
      .prepare('SELECT pending_channel_id FROM streams WHERE id=12')
      .first('pending_channel_id'),
    2,
  );
  const candidate = await legacy.prepare('SELECT * FROM pending_channels WHERE id=2').first();
  assert.equal(candidate.chno, 22);
  assert.equal(candidate.logo, 'pending.png');
  const metadata = JSON.parse(candidate.legacy_json);
  assert.equal(metadata.aliases[0].alias, '旧别名');
  assert.equal(metadata.profiles[0].chno_override, 99);
  assert.equal((await legacy.prepare('PRAGMA foreign_key_check').all()).results.length, 0);
  await assert.rejects(
    () => legacy.prepare('UPDATE streams SET channel_id=1 WHERE id=12').run(),
    /CHECK constraint/,
  );
  await confirmPending(new Store(legacy as any), [2]);
  assert.equal(
    await legacy.prepare("SELECT chno FROM channels WHERE key='pending'").first('chno'),
    22,
  );
  assert.equal(await legacy.prepare('SELECT count(*) n FROM pending_channels').first('n'), 0);
  assert.equal(
    await legacy
      .prepare("SELECT alias FROM channel_aliases WHERE alias_norm='legacy-alias'")
      .first('alias'),
    '旧别名',
  );
  assert.equal(
    await legacy
      .prepare('SELECT chno_override FROM profile_channels WHERE profile_id=1')
      .first('chno_override'),
    99,
  );
  assert.equal((await legacy.prepare('PRAGMA foreign_key_check').all()).results.length, 0);
});

test('merging every selected line removes the empty candidate and rejects stale submissions', async () => {
  await db.exec("INSERT INTO pending_channels(key,name) VALUES('last-one','最后候选');");
  const id = await scalar("SELECT id n FROM pending_channels WHERE key='last-one'");
  await db
    .prepare('UPDATE pending_channels SET legacy_json=? WHERE id=?')
    .bind(
      JSON.stringify({
        aliases: [{ alias: '候选旧别名', alias_norm: 'candidate-only' }],
        profiles: [{ profile_id: 1, include: 1, chno_override: 999, sort_override: 1 }],
      }),
      id,
    )
    .run();
  const aliases = await rows('SELECT * FROM channel_aliases');
  const pins = await rows('SELECT * FROM profile_channels');
  await db
    .prepare(
      "INSERT INTO streams(source_id,pending_channel_id,fingerprint,url,priority,network_manual) VALUES(1,?,'last-line','https://example.com/last-line',73,1)",
    )
    .bind(id)
    .run();
  const line = await scalar("SELECT id n FROM streams WHERE fingerprint='last-line'");
  assert.equal(
    err(await post(`/_admin/review/${id}/merge`, { target_id: '1', stream_ids: [String(line)] })),
    null,
  );
  assert.equal(await scalar(`SELECT count(*) n FROM pending_channels WHERE id=${id}`), 0);
  assert.equal(await scalar(`SELECT channel_id n FROM streams WHERE id=${line}`), 1);
  assert.equal(await scalar(`SELECT priority n FROM streams WHERE id=${line}`), 73);
  assert.equal(await scalar(`SELECT network_manual n FROM streams WHERE id=${line}`), 1);
  assert.deepEqual(await rows('SELECT * FROM channel_aliases'), aliases);
  assert.deepEqual(await rows('SELECT * FROM profile_channels'), pins);
  assert.ok(
    err(await post(`/_admin/review/${id}/merge`, { target_id: '1', stream_ids: [String(line)] })),
  );
});

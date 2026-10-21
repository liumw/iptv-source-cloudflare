import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { hashPassword } from '../src/security.ts';
import { applyChannelNumberMigration } from './schema.ts';

test('deleting feeds retains their streams, subscription output and independent playback settings', async () => {
  await build({
    entryPoints: ['src/index.ts'],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    outfile: '.generated/source-management-worker.mjs',
    logLevel: 'silent',
  });
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      scriptPath: resolve('.generated/source-management-worker.mjs'),
      compatibilityDate: '2026-10-20',
      d1Databases: { DB: 'source-retention' },
      bindings: { SESSION_SECRET: 'source-retention-test-secret-with-more-than-32-characters' },
      cf: false,
    }),
  );
  try {
    const db = await mf.getD1Database('DB');
    const schema = (await readFile('migrations/0001_schema.sql', 'utf8')).replace(
      /^\s*--.*$/gm,
      '',
    );
    await db.batch(
      schema
        .split(';')
        .filter((s) => s.trim())
        .map((s) => db.prepare(s)),
    );
    await applyChannelNumberMigration(db);
    await db
      .prepare('INSERT INTO admin_users(username,password_hash,must_change_password) VALUES(?,?,0)')
      .bind('testadmin', await hashPassword('source-retention-password'))
      .run();
    await db.exec(`INSERT INTO profiles(id,slug,name,config_json) VALUES(1,'full','全部频道','{}');
      INSERT INTO subscriptions(name,profile_id,path,access_token) VALUES('测试',1,'live','retention-token');
      INSERT INTO sources(id,name,origin,enabled,priority,headers_json) VALUES(1,'源甲','inline',1,7,'{"User-Agent":"fixture-A"}'),(2,'源乙','url',1,4,'{"User-Agent":"fixture-B"}'),(3,'未启用源','inline',0,0,'{}'),(4,'空源','url',1,0,'{}');
      INSERT INTO channels(id,key,name,reviewed,chno,logo) VALUES(1,'first','甲频道',1,9,'https://example.com/logo.png'),(2,'second','乙频道',1,12,NULL),(3,'disabled','停用线路频道',1,13,NULL);
      INSERT INTO streams(id,source_id,channel_id,fingerprint,url,raw_name,is_default,network,carrier,region,network_manual,carrier_manual,region_manual,attrs_json) VALUES(1,1,1,'shared-fp','https://example.com/a.m3u8','甲频道',1,'all','all','national',1,1,1,'{"vlc_opts":["#EXTVLCOPT:http-user-agent=fixture"]}'),(2,2,2,'shared-fp','https://example.com/b.m3u8','乙频道',1,'all','all','national',1,1,1,'{}'),(3,3,3,'shared-fp','https://example.com/disabled.m3u8','停用线路频道',1,'all','all','national',1,1,1,'{}');
      INSERT INTO channel_aliases(channel_id,alias,alias_norm) VALUES(1,'甲台','first-alias');
      INSERT INTO profile_channels(profile_id,channel_id,include) VALUES(1,1,1),(1,2,1),(1,3,1);`);
    let cookie = '';
    const request = (path: string, options: RequestInit = {}) =>
      mf.dispatchFetch('http://localhost' + path, {
        redirect: 'manual',
        ...options,
        headers: { cookie, origin: 'http://localhost', ...options.headers },
      });
    const post = (path: string, fields: Record<string, string> = {}) =>
      request(path, { method: 'POST', body: new URLSearchParams(fields) });
    cookie = (
      await post('/_admin/login', { username: 'testadmin', password: 'source-retention-password' })
    ).headers
      .get('set-cookie')!
      .split(';')[0];
    const playlist = () => request('/live?token=retention-token');
    const before = await playlist();
    const beforeText = await before.text();
    const etag = before.headers.get('etag')!;
    assert.match(beforeText, /example.com\/a.m3u8/);
    assert.match(beforeText, /example.com\/b.m3u8/);
    assert.doesNotMatch(beforeText, /disabled.m3u8/);
    const channels = (await db.prepare('SELECT * FROM channels ORDER BY id').all()).results;
    const streams = (await db.prepare('SELECT * FROM streams ORDER BY id').all()).results;
    const page = await (await request('/_admin/sources')).text();
    assert.match(page, /已导入的频道和播放线路会保留/);
    for (const id of [1, 2, 3, 4]) {
      const deleted = await post(`/_admin/sources/${id}/delete`);
      assert.equal(deleted.status, 303);
      assert.ok(
        new URL(deleted.headers.get('location')!, 'http://localhost').searchParams
          .get('msg')!
          .includes('线路已保留'),
      );
      assert.equal(await db.prepare('SELECT id FROM sources WHERE id=?').bind(id).first(), null);
    }
    assert.deepEqual(
      (await db.prepare('SELECT * FROM channels ORDER BY id').all()).results,
      channels,
    );
    const afterStreams = (await db.prepare('SELECT * FROM streams ORDER BY id').all()).results;
    assert.equal(afterStreams.length, streams.length);
    afterStreams.forEach((row, i) => {
      const { source_id: _new, ...after } = row;
      const { source_id: _old, ...previous } = streams[i];
      assert.deepEqual(after, previous);
    });
    assert.equal(await db.prepare('SELECT count(*) n FROM channel_aliases').first('n'), 1);
    assert.equal(await db.prepare('SELECT count(*) n FROM profile_channels').first('n'), 3);
    const retained = (
      await db.prepare("SELECT * FROM sources WHERE format='retained' ORDER BY id").all()
    ).results;
    assert.equal(retained.length, 3, 'an empty source needs no internal stream owner');
    assert.deepEqual(
      retained.map((r) => r.enabled),
      [1, 1, 0],
    );
    assert.deepEqual(
      retained.map((r) => r.headers_json),
      ['{"User-Agent":"fixture-A"}', '{"User-Agent":"fixture-B"}', '{}'],
    );
    assert.ok(
      retained.every(
        (r) =>
          r.origin === 'manual' &&
          r.url === null &&
          r.inline_text === null &&
          r.refresh_minutes === 0,
      ),
    );
    assert.deepEqual(await (await request('/_api/stats')).json(), {
      sources: 0,
      channels: 3,
      streams: 3,
      subscriptions: 1,
    });
    const updated = await request('/live?token=retention-token', {
      headers: { 'if-none-match': etag },
    });
    assert.equal(updated.status, 304, 'unchanged playlist content may reuse the same ETag');
    assert.equal(updated.headers.get('etag'), etag);
    assert.equal(await (await playlist()).text(), beforeText);
    const count = await db.prepare('SELECT count(*) n FROM sources').first('n');
    await post('/_admin/sources/1/delete');
    await post(`/_admin/sources/${retained[0].id}/delete`);
    assert.equal(await db.prepare('SELECT count(*) n FROM sources').first('n'), count);
    await post('/_admin/sources/add', {
      name: '源甲',
      origin: 'inline',
      format: 'm3u',
      inline_text: '#EXTM3U',
      headers_json: '{}',
    });
    assert.equal(
      await db
        .prepare("SELECT count(*) n FROM sources WHERE name='源甲' AND origin!='manual'")
        .first('n'),
      1,
    );
    const added = await post('/_admin/channels/add', {
      name: '新手动频道',
      url: 'https://example.com/new.m3u8',
    });
    assert.equal(added.status, 303);
    const manual = await db
      .prepare(
        "SELECT src.* FROM streams s JOIN sources src ON src.id=s.source_id WHERE s.url='https://example.com/new.m3u8'",
      )
      .first();
    assert.equal(manual!.format, 'single');
    assert.equal(manual!.headers_json, '{}');
    await db
      .prepare(
        "INSERT INTO profile_channels(profile_id,channel_id,include) SELECT 1,id,1 FROM channels WHERE name='新手动频道'",
      )
      .run();
    assert.match(await (await playlist()).text(), /example.com\/new.m3u8/);
    const invalid = await post('/_admin/sources/1.5/delete');
    assert.ok(
      new URL(invalid.headers.get('location')!, 'http://localhost').searchParams.get('err'),
    );
    const deleteChannel = await post('/_admin/channels/1/delete');
    assert.equal(deleteChannel.status, 303);
    assert.equal(
      await db.prepare('SELECT count(*) n FROM streams WHERE channel_id=1').first('n'),
      0,
    );
    assert.doesNotMatch(await (await playlist()).text(), /example.com\/a.m3u8/);
    await db.exec(
      "INSERT INTO sources(id,name,origin) VALUES(50,'rollback-source','url'); INSERT INTO streams(source_id,channel_id,fingerprint,url) VALUES(50,2,'rollback-stream','https://example.com/rollback.m3u8');",
    );
    await db
      .prepare(
        "CREATE TRIGGER reject_source_delete BEFORE DELETE ON sources WHEN OLD.id=50 BEGIN SELECT RAISE(ABORT,'test rollback'); END",
      )
      .run();
    const beforeRollback = await db.prepare('SELECT count(*) n FROM sources').first('n');
    const failed = await post('/_admin/sources/50/delete');
    assert.ok(new URL(failed.headers.get('location')!, 'http://localhost').searchParams.get('err'));
    assert.equal(await db.prepare('SELECT count(*) n FROM sources').first('n'), beforeRollback);
    assert.equal(
      await db
        .prepare("SELECT source_id FROM streams WHERE fingerprint='rollback-stream'")
        .first('source_id'),
      50,
      'failed source deletion rolls back the ownership transfer',
    );
  } finally {
    await mf.dispose();
  }
});

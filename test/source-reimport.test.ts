import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { hashPassword } from '../src/security.ts';
import { applyChannelNumberMigration } from './schema.ts';

test('reimporting deleted feeds reuses line IDs and preserves manual channel and line settings', async () => {
  await build({
    entryPoints: ['src/index.ts'],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    outfile: '.generated/source-reimport-worker.mjs',
    logLevel: 'silent',
  });
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      scriptPath: resolve('.generated/source-reimport-worker.mjs'),
      compatibilityDate: '2026-10-20',
      d1Databases: { DB: 'source-reimport' },
      bindings: { SESSION_SECRET: 'source-reimport-test-secret-longer-than-32-characters' },
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
      .bind('testadmin', await hashPassword('reimport-test-password'))
      .run();
    let cookie = '';
    const request = (path: string, init: RequestInit = {}) =>
      mf.dispatchFetch('http://localhost' + path, {
        redirect: 'manual',
        ...init,
        headers: { cookie, origin: 'http://localhost', ...init.headers },
      });
    const post = (path: string, fields: Record<string, string> = {}) =>
      request(path, { method: 'POST', body: new URLSearchParams(fields) });
    cookie = (
      await post('/_admin/login', { username: 'testadmin', password: 'reimport-test-password' })
    ).headers
      .get('set-cookie')!
      .split(';')[0];
    const rows = async (sql: string) => (await db.prepare(sql).all()).results;
    const scalar = (sql: string) => db.prepare(sql).first('n');
    const playlist = (changed = false, partial = false) => {
      const a = `#EXTINF:-1 tvg-id="remote-${changed}" tvg-logo="https://example.com/remote-${changed}.png" group-title="远程分组",${changed ? '完全不同的上游名称' : '原始甲频道'}\n#EXTVLCOPT:http-user-agent=alpha\nhttps://example.com/a.m3u8\n`;
      return (
        '#EXTM3U\n' +
        a +
        a +
        (partial
          ? ''
          : `#EXTINF:-1,原始甲频道\n#EXTVLCOPT:http-user-agent=beta\nhttps://example.com/a.m3u8\n#EXTINF:-1,原始乙频道\nhttps://example.com/b.m3u8\n`)
      );
    };
    const add = async (content: string) => {
      const response = await post('/_admin/sources/add', {
        name: '重复导入测试源',
        origin: 'inline',
        format: 'm3u',
        inline_text: content,
        headers_json: '{}',
        default_network: 'ipv4',
        default_carrier: 'telecom',
        default_region: 'beijing',
      });
      assert.equal(response.status, 303);
      assert.equal(
        new URL(response.headers.get('location')!, 'http://localhost').searchParams.get('err'),
        null,
      );
      return (await db.prepare("SELECT id FROM sources WHERE name='重复导入测试源'").first())!
        .id as number;
    };
    const ingest = async (id: number, error = false) => {
      const response = await post(`/_admin/sources/${id}/fetch`, { force: '1' });
      assert.equal(response.status, 303);
      const params = new URL(response.headers.get('location')!, 'http://localhost').searchParams;
      if (error) assert.match(params.get('err')!, /多条保留记录/);
      else assert.equal(params.get('err'), null);
    };
    let sourceID = await add(playlist());
    await ingest(sourceID);
    assert.equal(await scalar('SELECT count(*) n FROM channels'), 2);
    assert.equal(
      await scalar('SELECT count(*) n FROM streams'),
      3,
      'duplicate input is ignored, distinct VLC options remain distinct',
    );
    const originalStreams = await rows('SELECT * FROM streams ORDER BY id');
    const channelID = originalStreams[0].channel_id;
    const streamID = originalStreams[0].id;
    await post(`/_admin/channels/${channelID}/update`, {
      name: '手动改名后的频道',
      chno: '88',
      logo: 'https://example.com/my-logo.png',
      tvg_id: 'my-tvg-id',
      group_name: '手动分组',
      region: 'guangdong',
      notes: '保留我的设置',
      enabled: '1',
      adult: '1',
    });
    await post(`/_admin/streams/${streamID}/update`, {
      network: 'ipv6',
      carrier: 'unicom',
      region: 'guangdong',
      priority: '77',
      excluded: '1',
      adult: '1',
    });
    await post(`/_admin/streams/${streamID}/default`);
    await post(`/_admin/streams/${originalStreams[2].id}/assign`, {
      target_channel_id: String(channelID),
    });
    await db
      .prepare('UPDATE channels SET enabled=0,reviewed=1,logo=NULL,chno=89,notes=? WHERE id=?')
      .bind('手动停用的空频道', originalStreams[2].channel_id)
      .run();
    await db.exec(`INSERT INTO profiles(id,slug,name) VALUES(1,'test','测试');
      INSERT INTO profile_channels(profile_id,channel_id,chno_override,sort_override,include) VALUES(1,${channelID},99,4,1);
      INSERT INTO channel_aliases(channel_id,alias,alias_norm) VALUES(${channelID},'手动别名','manual-alias');
      INSERT INTO sources(id,name,origin,format) VALUES(100,'手动线路','manual','single'),(101,'其他正在使用的源','inline','m3u');`);
    for (const id of [100, 101])
      await db
        .prepare(
          'INSERT INTO streams(source_id,channel_id,fingerprint,url,raw_name,attrs_json) VALUES(?,?,?,?,?,?)',
        )
        .bind(
          id,
          channelID,
          'guard-' + id,
          'https://example.com/a.m3u8',
          '原始甲频道',
          originalStreams[0].attrs_json,
        )
        .run();
    const channelSnapshot = await rows('SELECT * FROM channels ORDER BY id');
    const aliases = await rows('SELECT * FROM channel_aliases');
    const pins = await rows('SELECT * FROM profile_channels');
    const lineSnapshot = await rows(
      `SELECT id,channel_id,fingerprint,network,carrier,region,network_manual,carrier_manual,region_manual,priority,is_default,excluded,adult,score,fail_count,first_seen_at FROM streams WHERE id=${streamID}`,
    );
    const associations = await rows(
      'SELECT id,channel_id,fingerprint FROM streams WHERE source_id NOT IN (100,101) ORDER BY id',
    );
    const guards = await rows('SELECT * FROM streams WHERE source_id IN (100,101) ORDER BY id');
    const assertPreserved = async () => {
      assert.deepEqual(await rows('SELECT * FROM channels ORDER BY id'), channelSnapshot);
      assert.deepEqual(await rows('SELECT * FROM channel_aliases'), aliases);
      assert.deepEqual(await rows('SELECT * FROM profile_channels'), pins);
      assert.deepEqual(
        await rows(
          'SELECT id,channel_id,fingerprint FROM streams WHERE source_id NOT IN (100,101) ORDER BY id',
        ),
        associations,
      );
      assert.deepEqual(
        await rows(
          `SELECT id,channel_id,fingerprint,network,carrier,region,network_manual,carrier_manual,region_manual,priority,is_default,excluded,adult,score,fail_count,first_seen_at FROM streams WHERE id=${streamID}`,
        ),
        lineSnapshot,
      );
      assert.deepEqual(
        await rows('SELECT * FROM streams WHERE source_id IN (100,101) ORDER BY id'),
        guards,
      );
      assert.equal(await scalar('SELECT count(*) n FROM streams'), 5);
    };
    for (let round = 0; round < 3; round++) {
      const oldID = sourceID;
      await post(`/_admin/sources/${oldID}/delete`);
      await assertPreserved();
      sourceID = await add(playlist(true));
      assert.notEqual(sourceID, oldID);
      await ingest(sourceID);
      await ingest(sourceID);
      await assertPreserved();
      assert.deepEqual(
        (await rows(`SELECT id FROM streams WHERE source_id=${sourceID} ORDER BY id`)).map(
          (s) => s.id,
        ),
        originalStreams.map((s) => s.id),
      );
      assert.equal(
        await scalar("SELECT count(*) n FROM sources WHERE format='retained'"),
        0,
        'empty retained owners are removed',
      );
    }
    // A partial reimport keeps absent retained lines available; a later full refresh reclaims them.
    await post(`/_admin/sources/${sourceID}/delete`);
    sourceID = await add(playlist(true, true));
    await ingest(sourceID);
    await assertPreserved();
    assert.equal(await scalar(`SELECT count(*) n FROM streams WHERE source_id=${sourceID}`), 1);
    assert.equal(
      await scalar(
        "SELECT count(*) n FROM streams s JOIN sources src ON src.id=s.source_id WHERE src.format='retained'",
      ),
      2,
    );
    await db
      .prepare('UPDATE sources SET inline_text=? WHERE id=?')
      .bind(playlist(true), sourceID)
      .run();
    await ingest(sourceID);
    await assertPreserved();
    // Ambiguous retained ownership must fail atomically rather than create duplicates or lose edits.
    await post(`/_admin/sources/${sourceID}/delete`);
    await db.exec(
      `INSERT INTO sources(id,name,origin,format) VALUES(200,'歧义保留线路','manual','retained');`,
    );
    await db
      .prepare(
        'INSERT INTO streams(source_id,channel_id,fingerprint,url,raw_name,attrs_json) VALUES(200,?,?,?,?,?)',
      )
      .bind(
        channelID,
        'ambiguous',
        originalStreams[0].url,
        '完全不同的上游名称',
        originalStreams[0].attrs_json,
      )
      .run();
    const beforeAmbiguity = await rows('SELECT * FROM streams ORDER BY id');
    sourceID = await add(playlist(true));
    await ingest(sourceID, true);
    assert.deepEqual(await rows('SELECT * FROM streams ORDER BY id'), beforeAmbiguity);
  } finally {
    await mf.dispose();
  }
});

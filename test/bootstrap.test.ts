import { test } from 'node:test';
import { applyChannelNumberMigration } from './schema.ts';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createBootstrap, initialize } from '../scripts/init-admin.mjs';
import { createDefaultBootstrap } from '../scripts/bootstrap-default.mjs';
import { verifyPassword } from '../src/security.ts';

test('bootstrap uses independent credentials and stores no source data', async () => {
  const first = createBootstrap();
  const second = createBootstrap();
  assert.notEqual(first.password, second.password);
  assert.notEqual(first.hash, second.hash);
  assert.notEqual(first.token, second.token);
  assert.ok(await verifyPassword(first.password, first.hash));
  assert.ok(!(await verifyPassword('admin123', first.hash)));
  assert.equal(first.username, 'admin');
  assert.doesNotMatch(first.sql, /INSERT INTO (?:sources|channels|streams|viewers)\b/i);
  assert.throws(() => createBootstrap({ password: 'short' }), /12/);
  assert.throws(
    () => createBootstrap({ username: "admin'); DROP TABLE admin_users;--" }),
    /用户名/,
  );
});

test('initialization refuses to overwrite files and preserves an existing valid secret', async () => {
  await mkdir('.generated', { recursive: true });
  const dir = await mkdtemp(resolve('.generated', 'bootstrap-'));
  const initial = await initialize({ directory: dir });
  const secret = await readFile(resolve(dir, '.dev.vars'), 'utf8');
  const sql = await readFile(resolve(dir, 'private/bootstrap.sql'), 'utf8');
  assert.ok(secret.match(/SESSION_SECRET="(.+)"/)![1].length >= 32);
  assert.equal(sql, initial.sql);
  await assert.rejects(() => initialize({ directory: dir }), /拒绝覆盖/);
  assert.equal(await readFile(resolve(dir, '.dev.vars'), 'utf8'), secret);
  assert.equal(await readFile(resolve(dir, 'private/bootstrap.sql'), 'utf8'), sql);
});

for (const automatic of [false, true])
  test(`fresh D1 ${automatic ? 'automatic admin/admin123' : 'manual random admin'} initialization, password enforcement and empty UI`, async () => {
    await build({
      entryPoints: ['src/index.ts'],
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      outfile: '.generated/bootstrap-worker.mjs',
      logLevel: 'silent',
    });
    const mf = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        scriptPath: resolve('.generated/bootstrap-worker.mjs'),
        compatibilityDate: '2026-10-20',
        d1Databases: { DB: 'bootstrap-empty-d1' },
        bindings: {
          SESSION_SECRET: 'bootstrap-test-secret-with-more-than-thirty-two-characters',
          ENABLE_PLAY_PROXY: 'false',
        },
        cf: false,
      }),
    );
    try {
      const db = await mf.getD1Database('DB');
      const statements = (sql: string) =>
        sql
          .replace(/^\s*--.*$/gm, '')
          .split(';')
          .filter((s) => s.trim())
          .map((s) => db.prepare(s));
      await db.batch(statements(await readFile('migrations/0001_schema.sql', 'utf8')));
      const initial = automatic
        ? { ...createDefaultBootstrap(), password: 'admin123' }
        : createBootstrap();
      await db.batch(statements(initial.sql));
      await applyChannelNumberMigration(db);
      for (const table of ['sources', 'channels', 'streams', 'viewers']) {
        assert.equal(await db.prepare(`SELECT count(*) n FROM ${table}`).first('n'), 0, table);
      }
      assert.equal(await db.prepare('SELECT count(*) n FROM admin_users').first('n'), 1);
      const sub = (await db.prepare('SELECT * FROM subscriptions').first()) as any;
      assert.equal(sub.viewer_id, null);
      assert.equal(sub.allow_query_override, 0);
      let cookie = '';
      const request = (path: string, init: RequestInit = {}) =>
        mf.dispatchFetch('http://localhost' + path, {
          redirect: 'manual',
          ...init,
          headers: { cookie, ...init.headers },
        });
      const login = () =>
        request('/_admin/login', {
          method: 'POST',
          headers: { origin: 'http://localhost' },
          body: new URLSearchParams({ username: 'admin', password: initial.password }),
        });
      let response = await login();
      assert.equal(response.status, 303);
      assert.equal(response.headers.get('location'), '/_admin/change-password');
      cookie = response.headers.get('set-cookie')!.split(';')[0];
      response = await request('/_admin/change-password');
      assert.equal(response.status, 200);
      assert.match(await response.text(), /先设置你的专属密码/);
      for (const path of [
        '/_admin',
        '/_admin/sources',
        '/_admin/channels',
        '/_admin/review',
        '/_admin/profiles',
        '/_admin/profiles/full',
        '/_admin/viewers',
        '/_admin/subscriptions',
        '/_admin/play',
        '/_admin/network',
        '/_admin/settings',
        '/_admin/logs',
      ]) {
        response = await request(path);
        assert.equal(response.status, 303, path);
        assert.equal(response.headers.get('location'), '/_admin/change-password');
      }
      assert.equal((await request('/_api/stats')).status, 403);
      assert.equal(
        (
          await request('/_api/settings', {
            method: 'PATCH',
            body: '{}',
            headers: { 'content-type': 'application/json' },
          })
        ).status,
        403,
      );
      response = await request('/_admin/channels/add', {
        method: 'POST',
        body: new URLSearchParams({ name: 'blocked' }),
      });
      assert.equal(response.headers.get('location'), '/_admin/change-password');
      assert.equal(await db.prepare('SELECT count(*) FROM channels').first('count(*)'), 0);
      for (const fields of [
        {
          current_password: 'wrong',
          new_password: 'a-different-long-password',
          confirm_password: 'a-different-long-password',
        },
        {
          current_password: initial.password,
          new_password: 'admin123',
          confirm_password: 'admin123',
        },
        {
          current_password: initial.password,
          new_password: 'a-different-long-password',
          confirm_password: 'mismatch',
        },
        {
          current_password: initial.password,
          new_password: initial.password,
          confirm_password: initial.password,
        },
      ]) {
        response = await request('/_admin/settings/password', {
          method: 'POST',
          body: new URLSearchParams(fields),
        });
        assert.match(response.headers.get('location')!, /^\/_admin\/change-password\?err=/);
        assert.equal(
          await db
            .prepare('SELECT must_change_password FROM admin_users')
            .first('must_change_password'),
          1,
        );
      }
      assert.equal((await request('/live')).status, 403);
      response = await request('/live?token=' + initial.token);
      assert.equal(response.status, 200);
      assert.equal(await response.text(), '#EXTM3U\n');
      assert.equal(response.headers.get('x-viewer-source'), 'auto');
      if (automatic) await db.batch(statements(createDefaultBootstrap().sql));
      else await assert.rejects(() => db.batch(statements(initial.sql)));
      assert.equal(
        await db.prepare('SELECT access_token FROM subscriptions').first('access_token'),
        initial.token,
      );
      assert.equal(
        await db.prepare('SELECT password_hash FROM admin_users').first('password_hash'),
        initial.hash,
      );
      const newPassword = 'new-own-admin-password-123';
      response = await request('/_admin/settings/password', {
        method: 'POST',
        headers: { origin: 'http://localhost' },
        body: new URLSearchParams({
          current_password: initial.password,
          new_password: newPassword,
          confirm_password: newPassword,
        }),
      });
      assert.equal(response.status, 303);
      assert.equal((await request('/_api/stats')).status, 401);
      cookie = '';
      assert.equal((await login()).status, 401);
      response = await request('/_admin/login', {
        method: 'POST',
        headers: { origin: 'http://localhost' },
        body: new URLSearchParams({ username: 'admin', password: newPassword }),
      });
      assert.equal(response.status, 303);
      cookie = response.headers.get('set-cookie')!.split(';')[0];
      for (const path of [
        '/_admin',
        '/_admin/channels',
        '/_admin/subscriptions',
        '/_admin/settings',
      ]) {
        response = await request(path);
        assert.equal(response.status, 200, path);
        const html = await response.text();
        assert.match(html, /主导航/);
        assert.doesNotMatch(html, /iptv4\.m3u|admin123|迁移时生成/);
      }
      assert.equal(
        await db
          .prepare('SELECT must_change_password FROM admin_users')
          .first('must_change_password'),
        0,
      );
      if (automatic) {
        const before = await db.prepare('SELECT * FROM admin_users').first();
        await db.prepare("UPDATE app_settings SET value='0' WHERE key='ip_lookup_enabled'").run();
        await db.prepare('DELETE FROM subscriptions').run();
        await db.prepare('DELETE FROM profiles').run();
        await db.batch(statements(createDefaultBootstrap().sql));
        assert.deepEqual(await db.prepare('SELECT * FROM admin_users').first(), before);
        assert.equal(
          await db
            .prepare("SELECT value FROM app_settings WHERE key='ip_lookup_enabled'")
            .first('value'),
          '0',
        );
        assert.equal(await db.prepare('SELECT count(*) FROM subscriptions').first('count(*)'), 0);
        assert.equal(await db.prepare('SELECT count(*) FROM profiles').first('count(*)'), 0);
        assert.equal((await request('/_api/stats')).status, 200);
        await db.prepare("UPDATE admin_users SET username='own-admin'").run();
        await db.batch(statements(createDefaultBootstrap().sql));
        assert.equal(await db.prepare('SELECT count(*) FROM admin_users').first('count(*)'), 1);
        assert.equal(
          await db.prepare('SELECT username FROM admin_users').first('username'),
          'own-admin',
        );
      }
    } finally {
      await mf.dispose();
    }
  });

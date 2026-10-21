import { Hono } from 'hono';
import type { Context } from 'hono';
import constants from './constants.json';
import type { Env, Variables, Row } from './types';
import { Store, bool, int, json, csv, now } from './store';
import { render } from './views';
import {
  createSession,
  currentUser,
  equal,
  hashPassword,
  safeReturn,
  sessionToken,
  sha256,
} from './security';
import {
  clientIP,
  inspectIP,
  resolveViewer,
  viewerFrom,
  compatible,
  parseWhitelist,
  checkIP,
  parseNetworkRules,
} from './network';
import { configFor, normalizePath, validatePath, renderPlaylist } from './playlist';
import { ingestSource, normalizeKey, similarity, decodePlaylist } from './ingest';
import {
  ChannelInputError,
  createManualChannel,
  deleteChannels,
  manualSourceStatement,
} from './channels';

type C = Context<{ Bindings: Env; Variables: Variables }>;
export const admin = new Hono<{ Bindings: Env; Variables: Variables }>();
const data = async (c: C) => c.req.raw.formData();
const text = (f: FormData, key: string, defaultValue = '') =>
  String(f.get(key) ?? defaultValue).trim();
const checked = (f: FormData, key: string) => (f.has(key) ? 1 : 0);
const redirect = (c: C, path: string, msg?: string, err?: string) => {
  const url = new URL(safeReturn(path), c.req.url);
  if (msg) url.searchParams.set('msg', msg);
  if (err) url.searchParams.set('err', err);
  return c.redirect(url.pathname + url.search, 303);
};
function page(c: C, name: string, context: Row = {}) {
  c.header('Cache-Control', 'no-store');
  return c.html(render(name, c.req.raw, c.get('user') ?? null, context));
}
const one = (c: C, table: string, id: unknown) =>
  c.get('store').one(`SELECT * FROM ${table} WHERE id=?`, [int(id)]);
async function channelRows(store: Store): Promise<Row[]> {
  const rows = await store.all(
    'SELECT c.*,g.name group_name FROM channels c LEFT JOIN groups g ON g.id=c.group_id ORDER BY c.name',
  );
  return rows.map((c) => ({
    ...c,
    group: c.group_name ? { id: c.group_id, name: c.group_name } : null,
  }));
}
async function subscriptions(store: Store): Promise<Row[]> {
  const [rows, profiles, viewers] = await Promise.all([
    store.all('SELECT * FROM subscriptions ORDER BY id'),
    store.all('SELECT * FROM profiles'),
    store.all('SELECT * FROM viewers'),
  ]);
  return rows.map((r) => ({
    ...r,
    viewer_id: r.viewer_id ?? null,
    profile: profiles.find((p) => p.id === r.profile_id),
    viewer: viewers.find((v) => v.id === r.viewer_id) ?? null,
  }));
}
async function groupID(store: Store, name: string): Promise<number | null> {
  if (!name) return null;
  const row = await store.one(
    'INSERT INTO groups(name) VALUES(?) ON CONFLICT(name) DO UPDATE SET name=excluded.name RETURNING id',
    [name],
  );
  return row!.id;
}
async function refs(store: Store, f: FormData): Promise<Row> {
  const profile = await store.one('SELECT * FROM profiles WHERE id=?', [int(f.get('profile_id'))]);
  const viewer = f.get('viewer_id')
    ? await store.one('SELECT * FROM viewers WHERE id=?', [int(f.get('viewer_id'))])
    : null;
  if (!profile || (f.get('viewer_id') && !viewer)) throw new Error('内容视图或网络环境不存在');
  return { profile_id: profile.id, viewer_id: viewer?.id ?? null };
}
admin.use('*', async (c, next) => {
  const path = c.req.path;
  if (!path.startsWith('/_admin') || path === '/_admin/login') {
    await next();
    return;
  }
  const user = await currentUser(c.get('store'), c.req.raw, c.env.SESSION_SECRET);
  if (!user)
    return c.redirect(
      '/_admin/login?next=' + encodeURIComponent(path + new URL(c.req.url).search),
      303,
    );
  c.set('user', user);
  await next();
});
admin.get('/_admin/login', async (c) => {
  const user = await currentUser(c.get('store'), c.req.raw, c.env.SESSION_SECRET);
  if (user) return c.redirect('/_admin', 302);
  return page(c, 'login.html');
});
admin.post('/_admin/login', async (c) => {
  const store = c.get('store'),
    f = await data(c),
    ipHash = await sha256(clientIP(c.req.raw) || 'unknown'),
    clock = Math.floor(Date.now() / 1000);
  const attempt = await store.one(
    'INSERT INTO login_attempts(ip_hash,attempts,window_start) VALUES(?,1,?) ON CONFLICT(ip_hash) DO UPDATE SET attempts=CASE WHEN window_start<? THEN 1 ELSE attempts+1 END,window_start=CASE WHEN window_start<? THEN excluded.window_start ELSE window_start END RETURNING attempts',
    [ipHash, clock, clock - 900, clock - 900],
  );
  if (attempt!.attempts > 10) {
    c.status(429);
    return page(c, 'login.html', { err: '登录尝试过多，请 15 分钟后重试。' });
  }
  const user = await store.one('SELECT * FROM admin_users WHERE username=?', [text(f, 'username')]);
  if (
    !user ||
    !(await import('./security').then((s) =>
      s.verifyPassword(String(f.get('password') ?? ''), user.password_hash),
    ))
  ) {
    c.status(401);
    return page(c, 'login.html', { err: '用户名或密码错误', username_input: text(f, 'username') });
  }
  await store.run('DELETE FROM login_attempts WHERE ip_hash=?', [ipHash]);
  c.header(
    'Set-Cookie',
    await createSession(
      store,
      user,
      c.env.SESSION_SECRET,
      new URL(c.req.url).protocol === 'https:',
    ),
  );
  return c.redirect(safeReturn(text(f, 'next_url')), 303);
});
admin.post('/_admin/logout', async (c) => {
  const token = await sessionToken(c.req.raw, c.env.SESSION_SECRET);
  if (token) await c.get('store').run('DELETE FROM sessions WHERE token_hash=?', [token]);
  c.header(
    'Set-Cookie',
    'iptv_cloud_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' +
      (new URL(c.req.url).protocol === 'https:' ? '; Secure' : ''),
  );
  return c.redirect('/_admin/login', 303);
});
admin.get('/_admin', async (c) => {
  const store = c.get('store');
  const counts = await store.one(`SELECT
    (SELECT count(*) FROM sources WHERE origin!='manual') sources,
    (SELECT count(*) FROM channels) channels,(SELECT count(*) FROM streams) streams,
    (SELECT count(*) FROM streams WHERE enabled=1 AND excluded=0) enabled_streams,
    (SELECT count(*) FROM channels WHERE auto_created=1 AND reviewed=0) review,
    (SELECT count(*) FROM subscriptions) subscriptions,
    (SELECT count(*) FROM access_logs WHERE created_at>=datetime('now','+8 hours','start of day','-8 hours')) access_today`);
  return page(c, 'dashboard.html', {
    counts,
    sources: await store.all(
      "SELECT * FROM sources WHERE origin!='manual' ORDER BY priority DESC,id",
    ),
    logs: await store.all('SELECT * FROM access_logs ORDER BY id DESC LIMIT 8'),
    subscriptions: (await subscriptions(store)).filter((s) => s.enabled),
  });
});
admin.get('/_admin/', (c) => c.redirect('/_admin', 302));
admin.get('/_admin/sources', async (c) => {
  const rows = await c
    .get('store')
    .all(
      "SELECT s.*,count(t.id) stream_count FROM sources s LEFT JOIN streams t ON s.id=t.source_id WHERE s.origin!='manual' GROUP BY s.id ORDER BY s.priority DESC,s.id",
    );
  return page(c, 'sources.html', { sources: rows.map((r) => [r, r.stream_count]) });
});
async function sourceFields(f: FormData, existing?: Row): Promise<Row> {
  const origin = text(f, 'origin', 'inline');
  if (!['url', 'inline', 'upload'].includes(origin))
    throw new Error('请使用 URL、上传文件或粘贴文本');
  let content = String(f.get('inline_text') ?? existing?.inline_text ?? '');
  const file = f.get('playlist_file');
  if (file && typeof file !== 'string' && file.size) {
    if (file.size > 2 * 1024 * 1024) throw new Error('文件超过 2 MB');
    content = decodePlaylist(await file.arrayBuffer());
  }
  if (origin === 'upload' && !content) throw new Error('请选择文件上传');
  const headers = json<Row | null>(f.get('headers_json'), null);
  if (
    !headers ||
    Array.isArray(headers) ||
    typeof headers !== 'object' ||
    Object.values(headers).some((v) => typeof v !== 'string')
  )
    throw new Error('请求头必须是字符串键值组成的 JSON 对象');
  const name = text(f, 'name');
  if (!name) throw new Error('源名称不能为空');
  return {
    name,
    format: ['auto', 'm3u', 'txt'].includes(text(f, 'format')) ? text(f, 'format') : 'auto',
    origin,
    url: text(f, 'url') || null,
    file_path: null,
    inline_text: content || null,
    priority: int(f.get('priority')),
    adult: checked(f, 'adult'),
    default_network: text(f, 'default_network', 'auto'),
    default_carrier: text(f, 'default_carrier', 'auto'),
    default_region: text(f, 'default_region', 'auto'),
    headers_json: JSON.stringify(headers),
    updated_at: now(),
  };
}
admin.post('/_admin/sources/add', async (c) => {
  const row = await sourceFields(await data(c));
  await c.get('store').write([c.get('store').insert('sources', row)]);
  return redirect(c, '/_admin/sources', '源已添加');
});
admin.post('/_admin/sources/:id/update', async (c) => {
  const store = c.get('store'),
    f = await data(c),
    existing = await one(c, 'sources', c.req.param('id'));
  if (!existing) throw new Error('源不存在');
  await store.write([
    store.update('sources', existing.id, {
      ...(await sourceFields(f, existing)),
      enabled: checked(f, 'enabled'),
    }),
  ]);
  return redirect(c, '/_admin/sources', '源已更新');
});
admin.post('/_admin/sources/:id/fetch', async (c) => {
  const source = await one(c, 'sources', c.req.param('id'));
  if (!source) throw new Error('源不存在');
  const f = await data(c),
    stats = await ingestSource(c.get('store'), source, bool(f.get('force')));
  return redirect(
    c,
    '/_admin/sources',
    stats.error
      ? undefined
      : stats.skipped
        ? '源内容未变化'
        : `解析 ${stats.parsed}，新增线路 ${stats.streams_new}，更新 ${stats.streams_updated}，新建频道 ${stats.channels_created}`,
    stats.error ?? undefined,
  );
});
admin.post('/_admin/sources/:id/delete', async (c) => {
  const store = c.get('store');
  await store.write([
    store.statement("DELETE FROM sources WHERE id=? AND origin!='manual'", [
      int(c.req.param('id')),
    ]),
  ]);
  return redirect(c, '/_admin/sources', '源已删除');
});

admin.get('/_admin/channels', async (c) => {
  const store = c.get('store'),
    q = c.req.query('q') ?? '',
    group = c.req.query('group_id') ?? '',
    review = bool(c.req.query('review'));
  const where: string[] = [],
    args: unknown[] = [];
  if (q) {
    where.push('(c.name LIKE ? OR c.key LIKE ?)');
    args.push('%' + q + '%', '%' + q + '%');
  }
  if (group) {
    where.push('c.group_id=?');
    args.push(int(group));
  }
  if (review) where.push('c.auto_created=1 AND c.reviewed=0');
  const clause = where.length ? ' WHERE ' + where.join(' AND ') : '',
    total = Number(await store.scalar('SELECT count(*) FROM channels c' + clause, args)),
    pages = Math.max(1, Math.ceil(total / 100)),
    pageNo = Math.min(pages, Math.max(1, int(c.req.query('page'), 1)));
  const rows = await store.all(
    `SELECT c.*,g.name group_name,count(s.id) stream_count FROM channels c LEFT JOIN groups g ON g.id=c.group_id LEFT JOIN streams s ON s.channel_id=c.id ${clause} GROUP BY c.id ORDER BY c.name LIMIT 100 OFFSET ?`,
    [...args, (pageNo - 1) * 100],
  );
  return page(c, 'channels.html', {
    rows: rows.map((r) => [r, r.group_name ? { name: r.group_name } : null, r.stream_count]),
    groups: await store.all('SELECT * FROM groups ORDER BY sort_order,name'),
    total,
    pages,
    page: pageNo,
    per_page: 100,
    q,
    group_id: group,
    review,
    return_to: new URL(c.req.url).pathname + new URL(c.req.url).search,
  });
});
async function newChannelPage(c: C, form: Row = {}, err?: string) {
  return page(c, 'channel_new.html', {
    groups: await c.get('store').all('SELECT * FROM groups ORDER BY sort_order,name'),
    form: { region: 'national', network: 'all', carrier: 'all', ...form },
    err,
  });
}
admin.get('/_admin/channels/new', (c) => newChannelPage(c));
admin.post('/_admin/channels/add', async (c) => {
  const form = await data(c);
  try {
    const id = await createManualChannel(c.get('store'), form);
    return redirect(c, `/_admin/channels/${id}`, '频道已手动添加');
  } catch (error) {
    if (!(error instanceof ChannelInputError)) throw error;
    c.status(400);
    return newChannelPage(c, Object.fromEntries(form), error.message);
  }
});
admin.post('/_admin/channels/batch-confirm', async (c) => batchChannels(c, false));
admin.post('/_admin/channels/batch-delete', async (c) => batchChannels(c, true));
async function batchChannels(c: C, remove: boolean) {
  const f = await data(c),
    ids = [
      ...new Set(
        f
          .getAll('channel_ids')
          .map((v) =>
            /^[1-9]\d*$/.test(String(v)) && Number.isSafeInteger(Number(v)) ? Number(v) : 0,
          )
          .filter((n) => n > 0),
      ),
    ];
  if (ids.length > 1000) throw new Error('单次最多操作 1000 个频道');
  if (ids.length) {
    const store = c.get('store');
    if (remove) await deleteChannels(store, ids);
    else
      await store.write([
        store.statement(
          'UPDATE channels SET reviewed=1,updated_at=CURRENT_TIMESTAMP WHERE id IN (SELECT value FROM json_each(?))',
          [JSON.stringify(ids)],
        ),
      ]);
  }
  return redirect(
    c,
    safeReturn(text(f, 'return_to'), '/_admin/channels'),
    remove ? '频道及其线路、别名和视图关联已永久删除' : '频道已确认',
  );
}
admin.get('/_admin/channels/:id', async (c) => {
  const store = c.get('store'),
    channel = (await channelRows(store)).find((ch) => ch.id === int(c.req.param('id')));
  if (!channel) return redirect(c, '/_admin/channels', undefined, '频道不存在');
  channel.aliases = await store.all('SELECT * FROM channel_aliases WHERE channel_id=?', [
    channel.id,
  ]);
  const streams = await store.all(
    'SELECT s.*,src.name source_name,src.origin source_origin FROM streams s JOIN sources src ON src.id=s.source_id WHERE s.channel_id=? ORDER BY s.is_default DESC,s.priority DESC,s.id',
    [channel.id],
  );
  const viewers = await store.all('SELECT * FROM viewers ORDER BY id');
  return page(c, 'channel_detail.html', {
    channel,
    streams: streams.map((s) => ({
      ...s,
      source: { name: s.source_name, origin: s.source_origin },
    })),
    groups: await store.all('SELECT * FROM groups ORDER BY sort_order,name'),
    viewers,
    matrix: viewers.map((v) => [
      v,
      streams.filter((s) => compatible(s, channel, viewerFrom(v)) === 'ok').length,
      streams.length,
    ]),
  });
});
admin.post('/_admin/channels/:id/update', async (c) => {
  const store = c.get('store'),
    f = await data(c),
    id = int(c.req.param('id'));
  if (!(await one(c, 'channels', id))) throw new Error('频道不存在');
  const name = text(f, 'name');
  if (!name) throw new Error('频道名称不能为空');
  await store.write([
    store.update('channels', id, {
      name,
      group_id: await groupID(store, text(f, 'group_name')),
      region: text(f, 'region', 'national'),
      region_manual: 1,
      chno: text(f, 'chno') ? int(f.get('chno')) : null,
      tvg_id: text(f, 'tvg_id') || null,
      logo: text(f, 'logo') || null,
      notes: text(f, 'notes') || null,
      enabled: checked(f, 'enabled'),
      adult: checked(f, 'adult'),
      reviewed: 1,
      updated_at: now(),
    }),
  ]);
  return redirect(c, `/_admin/channels/${id}`, '频道已更新');
});
admin.post('/_admin/channels/:id/chno', async (c) => {
  const f = await data(c),
    store = c.get('store');
  await store.write([
    store.update('channels', int(c.req.param('id')), {
      chno: text(f, 'chno') ? int(f.get('chno')) : null,
      updated_at: now(),
    }),
  ]);
  return redirect(c, safeReturn(text(f, 'return_to'), '/_admin/channels'), '台号已保存');
});
admin.post('/_admin/channels/:id/delete', async (c) => {
  const id = c.req.param('id');
  if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) throw new Error('频道 ID 无效');
  const form = await data(c);
  await deleteChannels(c.get('store'), [Number(id)]);
  return redirect(
    c,
    safeReturn(text(form, 'return_to'), '/_admin/channels'),
    '频道及其线路、别名和视图关联已永久删除',
  );
});
async function mergeChannel(c: C, id: number, targetID: number) {
  const store = c.get('store'),
    source = await one(c, 'channels', id),
    target = await one(c, 'channels', targetID);
  if (!source || !target || id === targetID) throw new Error('合并目标无效');
  const statements = [
    store.statement(
      'UPDATE streams SET is_default=0 WHERE channel_id=? AND EXISTS(SELECT 1 FROM streams WHERE channel_id=? AND is_default=1)',
      [id, targetID],
    ),
    store.statement('UPDATE streams SET channel_id=? WHERE channel_id=?', [targetID, id]),
    store.statement('UPDATE channel_aliases SET channel_id=? WHERE channel_id=?', [targetID, id]),
    store.statement('DELETE FROM channels WHERE id=?', [id]),
    store.statement(
      'INSERT OR IGNORE INTO channel_aliases(channel_id,alias,alias_norm) VALUES(?,?,?)',
      [targetID, source.name, normalizeKey(source.name)],
    ),
  ];
  await store.write(statements);
  return redirect(c, `/_admin/channels/${targetID}`, '频道已合并');
}
admin.post('/_admin/channels/:id/merge', async (c) =>
  mergeChannel(c, int(c.req.param('id')), int((await data(c)).get('target_id'))),
);

admin.post('/_admin/channels/:id/streams/add', async (c) => {
  const store = c.get('store'),
    f = await data(c),
    channel = await one(c, 'channels', c.req.param('id'));
  if (!channel) throw new Error('频道不存在');
  const url = text(f, 'url');
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(url) || /[\r\n]/.test(url)) throw new Error('播放地址无效');
  const statements: D1PreparedStatement[] = [await manualSourceStatement(store)];
  if (checked(f, 'is_default'))
    statements.push(
      store.statement('UPDATE streams SET is_default=0 WHERE channel_id=?', [channel.id]),
    );
  statements.push(
    store.statement(
      "INSERT INTO streams(source_id,channel_id,fingerprint,url,raw_name,network,carrier,region,priority,is_default,adult,network_manual,carrier_manual,region_manual) VALUES((SELECT id FROM sources WHERE origin='manual' ORDER BY id LIMIT 1),?,?,?,?,?,?,?,?,?,?,1,1,1)",
      [
        channel.id,
        (await sha256(url + crypto.randomUUID())).slice(0, 40),
        url,
        text(f, 'name') || channel.name,
        text(f, 'network', 'all'),
        text(f, 'carrier', 'all'),
        text(f, 'region') || null,
        int(f.get('priority')),
        checked(f, 'is_default'),
        checked(f, 'adult'),
      ],
    ),
  );
  await store.write(statements);
  return redirect(c, `/_admin/channels/${channel.id}`, '线路已添加');
});
admin.post('/_admin/streams/:id/update', async (c) => {
  const store = c.get('store'),
    f = await data(c),
    stream = await one(c, 'streams', c.req.param('id'));
  if (!stream) throw new Error('线路不存在');
  await store.write([
    store.update('streams', stream.id, {
      network: text(f, 'network', 'all'),
      carrier: text(f, 'carrier', 'all'),
      region: text(f, 'region') || null,
      network_manual: 1,
      carrier_manual: 1,
      region_manual: 1,
      priority: int(f.get('priority')),
      adult: checked(f, 'adult'),
      excluded: checked(f, 'excluded'),
    }),
  ]);
  return redirect(c, `/_admin/channels/${stream.channel_id}`, '线路已保存');
});
admin.post('/_admin/streams/:id/default', async (c) => {
  const store = c.get('store'),
    stream = await one(c, 'streams', c.req.param('id'));
  if (!stream?.channel_id) throw new Error('线路不存在');
  await store.write([
    store.statement('UPDATE streams SET is_default=0 WHERE channel_id=?', [stream.channel_id]),
    store.update('streams', stream.id, { is_default: 1 }),
  ]);
  return redirect(c, `/_admin/channels/${stream.channel_id}`, '默认线路已更新');
});
admin.post('/_admin/streams/:id/delete', async (c) => {
  const store = c.get('store'),
    stream = await one(c, 'streams', c.req.param('id'));
  if (!stream) throw new Error('线路不存在');
  await store.write([
    store.statement('DELETE FROM streams WHERE id=?', [stream.id]),
    store.statement(
      'UPDATE streams SET is_default=1 WHERE id=(SELECT id FROM streams WHERE channel_id=? AND enabled=1 AND excluded=0 ORDER BY priority DESC,score DESC,id LIMIT 1) AND NOT EXISTS(SELECT 1 FROM streams WHERE channel_id=? AND is_default=1)',
      [stream.channel_id, stream.channel_id],
    ),
  ]);
  return redirect(c, `/_admin/channels/${stream.channel_id}`, '线路已删除');
});
admin.post('/_admin/streams/:id/assign', async (c) => {
  const store = c.get('store'),
    f = await data(c),
    stream = await one(c, 'streams', c.req.param('id'));
  if (!stream) throw new Error('线路不存在');
  let target = await one(c, 'channels', f.get('target_channel_id'));
  const name = text(f, 'target_name');
  if (!target && name) {
    target = await store.one('SELECT * FROM channels WHERE key=? OR name=?', [
      normalizeKey(name),
      name,
    ]);
    if (!target) {
      await store.write([store.insert('channels', { key: normalizeKey(name), name, reviewed: 1 })]);
      target = await store.one('SELECT * FROM channels WHERE key=?', [normalizeKey(name)]);
    }
  }
  if (!target) throw new Error('目标频道不存在');
  await store.write([store.update('streams', stream.id, { channel_id: target.id, is_default: 0 })]);
  return redirect(c, `/_admin/channels/${target.id}`, '线路已移动');
});

admin.get('/_admin/review', async (c) => {
  const store = c.get('store'),
    channels = await channelRows(store),
    pending = channels.filter((ch) => ch.auto_created && !ch.reviewed),
    pages = Math.max(1, Math.ceil(pending.length / 50)),
    pageNo = Math.min(pages, Math.max(1, int(c.req.query('page'), 1)));
  const counts = new Map(
    (await store.all('SELECT channel_id,count(*) n FROM streams GROUP BY channel_id')).map((r) => [
      r.channel_id,
      r.n,
    ]),
  );
  const rows = pending.slice((pageNo - 1) * 50, pageNo * 50).map((ch) => [
    ch,
    counts.get(ch.id) ?? 0,
    channels
      .filter((other) => other.id !== ch.id)
      .map((other) => ({ channel: other, score: similarity(ch.key, other.key) }))
      .filter((v) => v.score >= 70)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3),
  ]);
  return page(c, 'review.html', { rows, total: pending.length, pages, page: pageNo });
});
admin.post('/_admin/review/confirm-all', async (c) => {
  const store = c.get('store');
  await store.write([
    store.statement('UPDATE channels SET reviewed=1 WHERE auto_created=1 AND reviewed=0'),
  ]);
  return redirect(c, '/_admin/review', '所有待确认频道已审核');
});
admin.post('/_admin/review/:id/confirm', async (c) => {
  const store = c.get('store');
  await store.write([store.update('channels', int(c.req.param('id')), { reviewed: 1 })]);
  return redirect(c, '/_admin/review', '频道已确认');
});
admin.post('/_admin/review/:id/merge', async (c) =>
  mergeChannel(c, int(c.req.param('id')), int((await data(c)).get('target_id'))),
);

admin.get('/_admin/profiles', async (c) => {
  const rows = await c
    .get('store')
    .all(
      'SELECT p.*,count(s.id) sub_count FROM profiles p LEFT JOIN subscriptions s ON s.profile_id=p.id GROUP BY p.id ORDER BY p.id',
    );
  return page(c, 'profiles.html', { profiles: rows.map((p) => [p, p.sub_count]) });
});
admin.post('/_admin/profiles/add', async (c) => {
  const f = await data(c),
    slug = text(f, 'slug').toLowerCase();
  if (!/^[a-z0-9_-]{1,64}$/.test(slug)) throw new Error('slug 只支持字母、数字、下划线和短横线');
  const store = c.get('store');
  await store.write([
    store.insert('profiles', {
      slug,
      name: text(f, 'name') || slug,
      config_json: JSON.stringify(constants.DEFAULT_PROFILE_CONFIG),
    }),
  ]);
  return redirect(c, `/_admin/profiles/${slug}`, '内容视图已创建');
});
admin.get('/_admin/profiles/:slug', async (c) => {
  const store = c.get('store'),
    profile = await store.one('SELECT * FROM profiles WHERE slug=?', [c.req.param('slug')]);
  if (!profile) throw new Error('内容视图不存在');
  const viewers = await store.all('SELECT * FROM viewers ORDER BY id'),
    selected = int(c.req.query('viewer_id'));
  const viewer = viewerFrom(
    viewers.find((v) => v.id === selected) ?? viewers.find((v) => v.is_default) ?? null,
  );
  const result = c.req.query('preview')
    ? await renderPlaylist(store, { profile }, viewer, true)
    : null;
  const pinned = await store.all(
    'SELECT c.* FROM channels c JOIN profile_channels pc ON c.id=pc.channel_id WHERE pc.profile_id=? AND pc.include=1 ORDER BY c.name',
    [profile.id],
  );
  return page(c, 'profile_detail.html', {
    profile,
    config: configFor(profile),
    pinned_channels: pinned,
    viewers,
    selected_viewer: selected || null,
    preview_stats: result?.stats,
    preview_head: result?.text.split('\n').slice(0, 25).join('\n') ?? '',
    viewer_env: viewer,
    groups: await store.all('SELECT * FROM groups ORDER BY sort_order,name'),
  });
});
admin.post('/_admin/profiles/:slug/update', async (c) => {
  const store = c.get('store'),
    profile = await store.one('SELECT * FROM profiles WHERE slug=?', [c.req.param('slug')]);
  if (!profile) throw new Error('内容视图不存在');
  const f = await data(c),
    config = configFor(profile);
  for (const key of [
    'include_groups',
    'exclude_groups',
    'include_keywords',
    'exclude_keywords',
    'networks',
    'carriers',
    'regions',
    'group_order',
  ])
    config[key] = csv(f.get(key));
  for (const key of [
    'allow_adult',
    'only_adult',
    'require_logo',
    'flatten_groups',
    'debug_comment',
  ])
    config[key] = !!checked(f, key);
  for (const key of ['max_streams_per_channel', 'start_chno', 'numbering_step'])
    config[key] = int(f.get(key), Number(config[key]));
  config.max_channels = text(f, 'max_channels') ? Math.max(1, int(f.get('max_channels'))) : null;
  config.min_score = Number(f.get('min_score')) || 0;
  config.numbering = ['none', 'fixed', 'auto'].includes(text(f, 'numbering'))
    ? text(f, 'numbering')
    : 'fixed';
  config.line_ending = text(f, 'line_ending') === 'crlf' ? 'crlf' : 'lf';
  config.epg_url = text(f, 'epg_url') || null;
  await store.write([
    store.update('profiles', profile.id, {
      name: text(f, 'name') || profile.slug,
      config_json: JSON.stringify(config),
      cache_ttl: Math.max(0, int(f.get('cache_ttl'), 30)),
      updated_at: now(),
    }),
  ]);
  return redirect(c, `/_admin/profiles/${profile.slug}`, '内容视图已保存');
});
admin.get('/_admin/profiles/:slug/channel-options', async (c) => {
  const store = c.get('store'),
    profile = await store.one('SELECT * FROM profiles WHERE slug=?', [c.req.param('slug')]);
  if (!profile) return c.json({ error: '内容视图不存在' }, 404);
  const channels = (await channelRows(store)).filter(
    (ch) => ch.enabled && (ch.reviewed || !ch.auto_created),
  );
  const selected = await store.all(
    'SELECT channel_id FROM profile_channels WHERE profile_id=? AND include=1',
    [profile.id],
  );
  return c.json({
    channels: channels.map((ch) => ({
      id: ch.id,
      name: ch.name,
      key: ch.key,
      group: ch.group?.name ?? '未分组',
      adult: !!ch.adult,
    })),
    selected: selected.map((v) => v.channel_id),
  });
});
async function removePinned(c: C, channelID?: number) {
  const store = c.get('store'),
    profile = await store.one('SELECT * FROM profiles WHERE slug=?', [c.req.param('slug')]);
  if (!profile) throw new Error('内容视图不存在');
  const clause = channelID ? ' AND channel_id=?' : '',
    args = channelID ? [profile.id, channelID] : [profile.id];
  await store.write([
    store.statement(
      'UPDATE profile_channels SET include=NULL WHERE profile_id=? AND include=1 AND (chno_override IS NOT NULL OR sort_override IS NOT NULL)' +
        clause,
      args,
    ),
    store.statement(
      'DELETE FROM profile_channels WHERE profile_id=? AND include=1 AND chno_override IS NULL AND sort_override IS NULL' +
        clause,
      args,
    ),
  ]);
  return redirect(c, `/_admin/profiles/${profile.slug}`, '指定频道已更新');
}
admin.post('/_admin/profiles/:slug/channels/clear', (c) => removePinned(c));
admin.post('/_admin/profiles/:slug/channels/:id/remove', (c) =>
  removePinned(c, int(c.req.param('id'))),
);
admin.post('/_admin/profiles/:slug/channels', async (c) => {
  const store = c.get('store'),
    profile = await store.one('SELECT * FROM profiles WHERE slug=?', [c.req.param('slug')]);
  if (!profile) throw new Error('内容视图不存在');
  const f = await data(c),
    ids = [
      ...new Set(
        f
          .getAll('channel_ids')
          .map((v) => int(v))
          .filter((n) => n > 0),
      ),
    ];
  const allowed = new Set(
    (
      await store.all('SELECT id FROM channels WHERE enabled=1 AND (reviewed=1 OR auto_created=0)')
    ).map((r) => r.id),
  );
  if (ids.some((id) => !allowed.has(id))) throw new Error('请先确认所选频道');
  const payload = JSON.stringify(ids),
    statements = [
      store.statement(
        'UPDATE profile_channels SET include=NULL WHERE profile_id=? AND include=1 AND (chno_override IS NOT NULL OR sort_override IS NOT NULL)',
        [profile.id],
      ),
      store.statement(
        'DELETE FROM profile_channels WHERE profile_id=? AND include=1 AND chno_override IS NULL AND sort_override IS NULL',
        [profile.id],
      ),
    ];
  if (ids.length)
    statements.push(
      store.statement(
        'INSERT INTO profile_channels(profile_id,channel_id,include) SELECT ?,value,1 FROM json_each(?) WHERE true ON CONFLICT(profile_id,channel_id) DO UPDATE SET include=1',
        [profile.id, payload],
      ),
    );
  await store.write(statements);
  return redirect(c, `/_admin/profiles/${profile.slug}`, '指定频道已保存');
});
admin.post('/_admin/profiles/:slug/delete', async (c) => {
  const store = c.get('store');
  await store.write([store.statement('DELETE FROM profiles WHERE slug=?', [c.req.param('slug')])]);
  return redirect(c, '/_admin/profiles', '内容视图已删除');
});

admin.get('/_admin/viewers', async (c) =>
  page(c, 'viewers.html', {
    viewers: await c.get('store').all('SELECT * FROM viewers ORDER BY id'),
  }),
);
function viewerFields(f: FormData): Row {
  const name = text(f, 'name');
  if (!name) throw new Error('环境名称不能为空');
  const carrier = text(f, 'carrier', 'unknown'),
    region = text(f, 'region', 'national');
  if (![...constants.CARRIERS, 'unknown'].includes(carrier) || !(region in constants.REGIONS))
    throw new Error('运营商或地区参数无效');
  return {
    name,
    carrier,
    region,
    notes: text(f, 'notes') || null,
    supports_ipv4: checked(f, 'supports_ipv4'),
    supports_ipv6: checked(f, 'supports_ipv6'),
    supports_iptv: checked(f, 'supports_iptv'),
    updated_at: now(),
  };
}
admin.post('/_admin/viewers/add', async (c) => {
  const row = viewerFields(await data(c)),
    store = c.get('store');
  await store.write([store.insert('viewers', row)]);
  return redirect(c, '/_admin/viewers', '网络环境已添加');
});
admin.post('/_admin/viewers/:id/update', async (c) => {
  const f = await data(c),
    row = viewerFields(f),
    store = c.get('store'),
    statements: D1PreparedStatement[] = [];
  if (checked(f, 'is_default')) statements.push(store.statement('UPDATE viewers SET is_default=0'));
  statements.push(
    store.update('viewers', int(c.req.param('id')), {
      ...row,
      is_default: checked(f, 'is_default'),
    }),
  );
  await store.write(statements);
  return redirect(c, '/_admin/viewers', '网络环境已保存');
});
admin.post('/_admin/viewers/:id/delete', async (c) => {
  const store = c.get('store');
  await store.write([store.statement('DELETE FROM viewers WHERE id=?', [int(c.req.param('id'))])]);
  return redirect(c, '/_admin/viewers', '网络环境已删除');
});

async function subscriptionPage(c: C, extra: Row = {}) {
  const store = c.get('store');
  return page(c, 'subscriptions.html', {
    subscriptions: await subscriptions(store),
    profiles: await store.all('SELECT * FROM profiles ORDER BY name'),
    viewers: await store.all('SELECT * FROM viewers ORDER BY name'),
    ...extra,
  });
}
admin.get('/_admin/subscriptions', (c) => subscriptionPage(c));
async function subscriptionFields(store: Store, f: FormData): Promise<Row> {
  const path = text(f, 'path'),
    error = validatePath(path);
  if (error) throw new Error(error);
  return {
    ...(await refs(store, f)),
    name: text(f, 'name') || normalizePath(path),
    path: normalizePath(path),
    access_token: text(f, 'access_token') || null,
    cache_ttl: Math.max(0, int(f.get('cache_ttl'), 30)),
    allow_query_override: checked(f, 'allow_query_override'),
    updated_at: now(),
  };
}
admin.post('/_admin/subscriptions/add', async (c) => {
  const store = c.get('store'),
    f = await data(c);
  await store.write([store.insert('subscriptions', await subscriptionFields(store, f))]);
  return redirect(c, '/_admin/subscriptions', '订阅链接已创建');
});
admin.post('/_admin/subscriptions/:id/update', async (c) => {
  const store = c.get('store'),
    f = await data(c);
  await store.write([
    store.update('subscriptions', int(c.req.param('id')), {
      ...(await subscriptionFields(store, f)),
      enabled: checked(f, 'enabled'),
    }),
  ]);
  return redirect(c, '/_admin/subscriptions', '订阅已更新');
});
admin.post('/_admin/subscriptions/:id/delete', async (c) => {
  const store = c.get('store');
  await store.write([
    store.statement('DELETE FROM subscriptions WHERE id=?', [int(c.req.param('id'))]),
  ]);
  return redirect(c, '/_admin/subscriptions', '订阅已删除');
});
admin.get('/_admin/subscriptions/:id/test', async (c) => {
  const store = c.get('store'),
    sub = await one(c, 'subscriptions', c.req.param('id'));
  if (!sub) throw new Error('订阅不存在');
  const explicit = c.req.query('viewer_id')
    ? await one(c, 'viewers', c.req.query('viewer_id'))
    : null;
  const viewer = explicit
      ? viewerFrom(explicit)
      : (await resolveViewer(store, sub, c.req.raw)).viewer,
    result = await renderPlaylist(store, sub, viewer, true);
  return subscriptionPage(c, {
    test_subscription: sub,
    test_stats: result.stats,
    test_head: result.text.split('\n').slice(0, 40).join('\n'),
    test_viewer: viewer,
  });
});

admin.get('/_admin/play', async (c) => {
  const store = c.get('store'),
    profiles = await store.all('SELECT * FROM profiles WHERE enabled=1 ORDER BY id'),
    viewers = await store.all('SELECT * FROM viewers ORDER BY id');
  const profile = profiles.find((p) => p.slug === c.req.query('profile')) ?? profiles[0],
    viewer =
      viewers.find((v) => v.id === int(c.req.query('viewer_id'))) ??
      viewers.find((v) => v.is_default) ??
      viewers[0];
  const viewerEnv = viewer
    ? viewerFrom(viewer)
    : (await resolveViewer(store, {}, c.req.raw)).viewer;
  const result = profile ? await renderPlaylist(store, { profile }, viewerEnv) : null;
  return page(c, 'play.html', {
    profiles,
    selected_profile: profile ?? null,
    viewers,
    selected_viewer: viewer?.id ?? null,
    viewer_env: viewerEnv,
    play_channels: result?.channels ?? [],
    stats: result?.stats ?? null,
    play_proxy_enabled: c.env.ENABLE_PLAY_PROXY === 'true',
  });
});
admin.get('/_admin/network', async (c) => {
  const store = c.get('store'),
    candidate = (c.req.query('ip') ?? '').trim() || clientIP(c.req.raw),
    run = new URL(c.req.url).searchParams.has('ip'),
    settings = await store.settings();
  const online = settings.ip_lookup_enabled !== '0',
    info = await inspectIP(candidate, run && online, c.req.raw),
    selected = c.req.query('subscription_id')
      ? await one(c, 'subscriptions', c.req.query('subscription_id'))
      : null;
  const resolved = run ? await resolveViewer(store, selected ?? {}, c.req.raw, candidate) : null,
    result = selected && resolved ? await renderPlaylist(store, selected, resolved.viewer) : null;
  return page(c, 'network.html', {
    info,
    resolved,
    result,
    candidate,
    request_ip: clientIP(c.req.raw),
    lookup_enabled: online,
    network_rules: settings.ip_network_rules ?? '',
    viewers: await store.all('SELECT * FROM viewers ORDER BY name'),
    subscriptions: await subscriptions(store),
    selected,
  });
});
admin.post('/_admin/network/settings', async (c) => {
  const store = c.get('store'),
    f = await data(c),
    rules = text(f, 'ip_network_rules'),
    { errors } = parseNetworkRules(rules, await store.all('SELECT * FROM viewers'));
  if (errors.length) throw new Error(errors.join('；'));
  await store.write([
    store.settingStatement('ip_network_rules', rules),
    store.settingStatement('ip_lookup_enabled', checked(f, 'ip_lookup_enabled')),
  ]);
  return redirect(c, '/_admin/network', '网络识别设置已保存');
});
async function settingsPage(c: C, extra: Row = {}) {
  const settings = await c.get('store').settings(),
    whitelist = extra.whitelist ?? settings.playlist_ip_whitelist ?? '',
    parsed = parseWhitelist(whitelist);
  return page(c, 'settings.html', {
    whitelist,
    rules: parsed.rules,
    errors: parsed.errors,
    trust_proxy: false,
    default_ua: settings.default_ua ?? '',
    deny_status: settings.whitelist_deny_status ?? '403',
    ...extra,
  });
}
admin.get('/_admin/settings', (c) => settingsPage(c));
admin.post('/_admin/settings/update', async (c) => {
  const store = c.get('store'),
    f = await data(c),
    status = int(f.get('whitelist_deny_status'), 403);
  if (status < 400 || status > 499) throw new Error('拒绝状态码必须为 4xx');
  await store.write([
    store.settingStatement('playlist_ip_whitelist', String(f.get('playlist_ip_whitelist') ?? '')),
    store.settingStatement('default_ua', text(f, 'default_ua')),
    store.settingStatement('whitelist_deny_status', status),
  ]);
  return redirect(c, '/_admin/settings', '设置已保存');
});
admin.post('/_admin/settings/test-ip', async (c) => {
  const f = await data(c),
    value = text(f, 'test_ip'),
    whitelist = String(f.get('current_whitelist') ?? ''),
    result = checkIP(whitelist, value);
  return settingsPage(c, {
    whitelist,
    test_result: { ...result, rule: result.rule?.source, input: value },
  });
});
admin.post('/_admin/settings/password', async (c) => {
  const f = await data(c),
    user = c.get('user'),
    security = await import('./security'),
    password = String(f.get('new_password') ?? '');
  if (!(await security.verifyPassword(String(f.get('current_password') ?? ''), user.password_hash)))
    throw new Error('当前密码不正确');
  if (password.length < 12) throw new Error('云端新密码至少 12 位');
  if (password !== String(f.get('confirm_password') ?? ''))
    throw new Error('两次输入的新密码不一致');
  const store = c.get('store');
  await store.write([
    store.update('admin_users', user.id, {
      password_hash: await hashPassword(password),
      must_change_password: 0,
    }),
    store.statement('DELETE FROM sessions WHERE user_id=?', [user.id]),
  ]);
  c.header('Set-Cookie', 'iptv_cloud_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  return redirect(c, '/_admin/login', '密码已修改，请重新登录');
});
admin.get('/_admin/logs', async (c) => {
  const status = c.req.query('status') ?? '',
    store = c.get('store'),
    logs = await store.all(
      'SELECT * FROM access_logs' +
        (status ? ' WHERE status=?' : '') +
        ' ORDER BY id DESC LIMIT 200',
      status ? [int(status)] : [],
    );
  return page(c, 'logs.html', { logs, status });
});

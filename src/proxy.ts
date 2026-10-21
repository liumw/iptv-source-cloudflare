import type { Context } from 'hono';
import type { Env, Variables } from './types';
import { publicFetch, readBounded } from './ingest';

const proxied = (value: string) => '/_admin/play/proxy?url=' + encodeURIComponent(value);
export function rewriteM3U8(text: string, base: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => {
      const value = line.trim();
      if (!value) return line;
      if (value.startsWith('#'))
        return line.replace(/URI="([^"]*)"/g, (match, uri) =>
          !uri || /^(data:|skd:)/i.test(uri) ? match : `URI="${proxied(new URL(uri, base).href)}"`,
        );
      return proxied(new URL(value, base).href);
    })
    .join('\n')
    .replace(/\n*$/, '\n');
}
export async function playProxy(
  c: Context<{ Bindings: Env; Variables: Variables }>,
): Promise<Response> {
  if (c.env.ENABLE_PLAY_PROXY !== 'true')
    return c.text(
      '云端视频代理未启用。可复制线路地址到外部播放器，或由部署者显式开启 ENABLE_PLAY_PROXY。',
      501,
    );
  const headers = new Headers({ 'User-Agent': c.req.header('user-agent') ?? 'IPTV-Manager/1.0' });
  if (c.req.header('range')) headers.set('Range', c.req.header('range')!);
  const value = c.req.query('url') ?? '';
  const upstream = await publicFetch(value, headers),
    contentType = upstream.headers.get('content-type') ?? '';
  const isPlaylist =
    /mpegurl/i.test(contentType) ||
    new URL(upstream.url || value).pathname.toLowerCase().endsWith('.m3u8');
  if (isPlaylist) {
    if (!upstream.ok) {
      await upstream.body?.cancel();
      return c.text(`源站返回 HTTP ${upstream.status}`, 502);
    }
    const bytes = await readBounded(upstream);
    return new Response(rewriteM3U8(new TextDecoder().decode(bytes), upstream.url || value), {
      headers: { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' },
    });
  }
  const passed = new Headers();
  for (const key of [
    'content-type',
    'content-range',
    'accept-ranges',
    'cache-control',
    'last-modified',
    'etag',
  ])
    if (upstream.headers.has(key)) passed.set(key, upstream.headers.get(key)!);
  passed.set('Cache-Control', 'no-store');
  return new Response(upstream.body, { status: upstream.status, headers: passed });
}

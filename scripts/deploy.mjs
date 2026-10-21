import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'jsonc-parser';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const errors = [];
const config = parse(await readFile('wrangler.jsonc', 'utf8'), errors, {
  allowTrailingComma: true,
});
if (errors.length) throw new Error('wrangler.jsonc 语法错误，请检查配置。');
const id = config.d1_databases?.find((binding) => binding.binding === 'DB')?.database_id;
if (!id || id === '00000000-0000-0000-0000-000000000000') {
  throw new Error('请先创建 D1，并将真实 database_id 填入 wrangler.jsonc。详见 README.md。');
}
const secrets = await readFile('.dev.vars', 'utf8').catch(() => '');
const secret = secrets.match(/^SESSION_SECRET\s*=\s*["']?([^\r\n"']+)/m)?.[1];
if (!secret || secret.length < 32)
  throw new Error('请在 .dev.vars 配置至少 32 字符的随机 SESSION_SECRET。');
for (const args of [
  ['scripts/build.mjs'],
  ['node_modules/wrangler/bin/wrangler.js', 'deploy', '--secrets-file', '.dev.vars'],
]) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit', cwd: root });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

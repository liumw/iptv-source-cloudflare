import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'jsonc-parser';
import { createDefaultBootstrap } from './bootstrap-default.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function deploy({ directory = root, env = process.env, run = spawnSync } = {}) {
  const errors = [];
  const config = parse(await readFile(resolve(directory, 'wrangler.jsonc'), 'utf8'), errors, {
    allowTrailingComma: true,
  });
  if (errors.length) throw new Error('wrangler.jsonc 语法错误，请检查配置。');
  const id = config.d1_databases?.find((binding) => binding.binding === 'DB')?.database_id;
  if (!id || id === '00000000-0000-0000-0000-000000000000') {
    throw new Error('请先创建 D1，并将真实 database_id 填入 wrangler.jsonc。详见 README.md。');
  }

  // Workers Builds manages runtime secrets; local deploys upload the private secrets file.
  const cloudBuild = env.WORKERS_CI === '1';
  if (!cloudBuild) {
    const secrets = await readFile(resolve(directory, '.dev.vars'), 'utf8').catch(() => '');
    const secret = secrets.match(/^SESSION_SECRET\s*=\s*["']?([^\r\n"']+)/m)?.[1]?.trim();
    if (!secret || secret.length < 32)
      throw new Error('请在 .dev.vars 配置至少 32 字符的随机 SESSION_SECRET。');
  }

  const wrangler = 'node_modules/wrangler/bin/wrangler.js';
  const commands = [['scripts/build.mjs']];
  let bootstrapDir;
  try {
    if (cloudBuild) {
      await mkdir(resolve(directory, '.generated'), { recursive: true });
      bootstrapDir = await mkdtemp(resolve(directory, '.generated', 'initial-admin-'));
      const file = resolve(bootstrapDir, 'bootstrap.sql');
      await writeFile(file, createDefaultBootstrap().sql, { mode: 0o600 });
      commands.push([wrangler, 'd1', 'migrations', 'apply', 'DB', '--remote']);
      commands.push([wrangler, 'd1', 'execute', 'DB', '--remote', '--file', file]);
    }
    commands.push([wrangler, 'deploy', ...(!cloudBuild ? ['--secrets-file', '.dev.vars'] : [])]);
    for (const args of commands) {
      const result = run(process.execPath, args, { stdio: 'inherit', cwd: directory, env });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`部署步骤失败（退出码 ${result.status ?? 1}）。`);
    }
  } finally {
    if (bootstrapDir) await rm(bootstrapDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  deploy().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

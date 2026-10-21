import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { deploy } from '../scripts/deploy.mjs';

async function fixture(id = '11111111-1111-4111-8111-111111111111') {
  await mkdir('.generated', { recursive: true });
  const directory = await mkdtemp(resolve('.generated', 'deploy-'));
  await writeFile(
    resolve(directory, 'wrangler.jsonc'),
    JSON.stringify({
      d1_databases: [{ binding: 'DB', database_name: 'renamed-db', database_id: id }],
    }),
  );
  return directory;
}

test('Cloudflare deploy works without local secrets, migrates the binding before publish', async () => {
  const directory = await fixture();
  // Even an accidentally present local file must never overwrite the platform secret.
  await writeFile(resolve(directory, '.dev.vars'), 'SESSION_SECRET="short"');
  const commands: string[][] = [];
  const run = (_node: string, args: string[]) => {
    commands.push(args);
    return { status: 0 };
  };
  await deploy({ directory, env: { WORKERS_CI: '1' }, run });
  assert.deepEqual(
    commands.map((args) => args.slice(1)),
    [[], ['d1', 'migrations', 'apply', 'DB', '--remote'], ['deploy']],
  );
  assert.ok(!commands.flat().includes('--secrets-file'));

  commands.length = 0;
  const emptyDirectory = await fixture();
  await deploy({ directory: emptyDirectory, env: { WORKERS_CI: '1' }, run });
  assert.equal(commands.length, 3);
});

test('local deploy rejects missing or short secrets and uploads a valid private file', async () => {
  const directory = await fixture();
  const commands: string[][] = [];
  const run = (_node: string, args: string[]) => {
    commands.push(args);
    return { status: 0 };
  };
  await assert.rejects(() => deploy({ directory, env: {}, run }), /SESSION_SECRET/);
  await writeFile(resolve(directory, '.dev.vars'), 'SESSION_SECRET="short"');
  await assert.rejects(() => deploy({ directory, env: { CI: 'true' }, run }), /SESSION_SECRET/);
  assert.equal(commands.length, 0);
  await writeFile(resolve(directory, '.dev.vars'), `SESSION_SECRET="${'x'.repeat(48)}"`);
  await deploy({ directory, env: {}, run });
  assert.deepEqual(
    commands.map((args) => args.slice(1)),
    [[], ['deploy', '--secrets-file', '.dev.vars']],
  );
});

test('placeholder D1 and failed migrations prevent publishing', async () => {
  const placeholder = await fixture('00000000-0000-0000-0000-000000000000');
  const commands: string[][] = [];
  const run = (_node: string, args: string[]) => {
    commands.push(args);
    return { status: args.includes('migrations') ? 1 : 0 };
  };
  await assert.rejects(
    () => deploy({ directory: placeholder, env: { WORKERS_CI: '1' }, run }),
    /D1/,
  );
  assert.equal(commands.length, 0);
  const directory = await fixture();
  await assert.rejects(() => deploy({ directory, env: { WORKERS_CI: '1' }, run }), /退出码 1/);
  assert.equal(commands.length, 2);
  assert.ok(!commands.some((args) => args.includes('deploy')));
});

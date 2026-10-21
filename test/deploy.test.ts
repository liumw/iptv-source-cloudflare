import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { deploy } from '../scripts/deploy.mjs';

async function fixture(id = '11111111-1111-4111-8111-111111111111') {
  await mkdir('.generated', { recursive: true });
  const directory = await mkdtemp(resolve('.generated', 'deploy-'));
  await writeFile(
    resolve(directory, 'wrangler.jsonc'),
    JSON.stringify({
      name: 'test-worker',
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
    if (args.includes('execute')) {
      const sql = readFileSync(args.at(-1)!, 'utf8');
      assert.match(sql, /INSERT INTO admin_users/);
      assert.match(sql, /NOT EXISTS \(SELECT 1 FROM admin_users\)/);
      assert.doesNotMatch(sql, /admin123/);
    }
    return { status: 0, stdout: JSON.stringify([{ name: 'SESSION_SECRET', type: 'secret_text' }]) };
  };
  await deploy({ directory, env: { WORKERS_CI: '1' }, run });
  assert.deepEqual(
    commands.map((args) => args.slice(1)),
    [
      [],
      ['d1', 'migrations', 'apply', 'DB', '--remote'],
      ['d1', 'execute', 'DB', '--remote', '--file', commands[2].at(-1)!],
      ['secret', 'list', '--format', 'json'],
      ['deploy'],
    ],
  );
  await assert.rejects(() => access(commands[2].at(-1)!));
  assert.ok(!commands.flat().includes('--secrets-file'));

  commands.length = 0;
  const emptyDirectory = await fixture();
  await deploy({ directory: emptyDirectory, env: { WORKERS_CI: '1' }, run });
  assert.equal(commands.length, 5);
});

test('first cloud deploy automatically uploads an independent key and cleans private files', async () => {
  const keys: string[] = [];
  for (const missingWorker of [false, true]) {
    const directory = await fixture();
    let file = '';
    let bootstrapFile = '';
    const run = (_node: string, args: string[], options: any) => {
      if (args.includes('execute')) bootstrapFile = args.at(-1)!;
      if (args.includes('list')) {
        assert.equal(options.encoding, 'utf8');
        assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
        return missingWorker
          ? { status: 1, stderr: '\x1b[31mWorker "test-worker" not found.\x1b[0m' }
          : { status: 0, stdout: '[]' };
      }
      if (args.includes('deploy')) {
        assert.ok(args.includes('--secrets-file'));
        file = args.at(-1)!;
        const value = JSON.parse(readFileSync(file, 'utf8'));
        assert.deepEqual(Object.keys(value), ['SESSION_SECRET']);
        assert.match(value.SESSION_SECRET, /^[A-Za-z0-9_-]{64}$/);
        assert.ok(!file.includes('.generated/public'));
        keys.push(value.SESSION_SECRET);
      }
      return { status: 0 };
    };
    await deploy({ directory, env: { WORKERS_CI: '1' }, run });
    assert.ok(file && bootstrapFile);
    await assert.rejects(() => access(file));
    await assert.rejects(() => access(bootstrapFile));
  }
  assert.notEqual(keys[0], keys[1]);
});

test('cloud secret discovery fails closed on permissions, network, or malformed responses', async () => {
  for (const result of [
    { status: 1, stderr: 'Authentication error [code: 10000]' },
    { status: 1, stderr: 'fetch failed' },
    { status: 1, stderr: 'Worker "another-worker" not found.' },
    { status: 0, stdout: '' },
    { status: 0, stdout: '{}' },
    { status: 0, stdout: '[null]' },
    { status: 0, stdout: '[{"type":"secret_text"}]' },
  ]) {
    const directory = await fixture();
    let bootstrapFile = '';
    const run = (_node: string, args: string[]) => {
      assert.ok(!args.includes('deploy'));
      if (args.includes('execute')) bootstrapFile = args.at(-1)!;
      return args.includes('list') ? result : { status: 0 };
    };
    await assert.rejects(() => deploy({ directory, env: { WORKERS_CI: '1' }, run }), /已停止发布/);
    await assert.rejects(() => access(bootstrapFile));
  }
});

test('failed publish removes the generated signing key without printing its value', async () => {
  const directory = await fixture();
  let file = '';
  const run = (_node: string, args: string[]) => {
    if (args.includes('list')) return { status: 0, stdout: '[]' };
    if (args.includes('deploy')) {
      file = args.at(-1)!;
      assert.ok(JSON.parse(readFileSync(file, 'utf8')).SESSION_SECRET);
      return { status: 1 };
    }
    return { status: 0 };
  };
  await assert.rejects(
    () => deploy({ directory, env: { WORKERS_CI: '1' }, run }),
    /^Error: 部署步骤失败（退出码 1）。$/,
  );
  await assert.rejects(() => access(file));
});

test('one-click source declares no manual session-secret input', async () => {
  await assert.rejects(() => access('.dev.vars.example'));
  await assert.rejects(() => access('.env.example'));
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  assert.equal(pkg.cloudflare.bindings.SESSION_SECRET, undefined);
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

test('failed default initialization prevents publishing and removes the temporary SQL', async () => {
  const directory = await fixture();
  let file = '';
  const run = (_node: string, args: string[]) => {
    assert.ok(!args.includes('deploy'));
    if (args.includes('execute')) {
      file = args.at(-1)!;
      return { status: 1 };
    }
    return { status: 0 };
  };
  await assert.rejects(() => deploy({ directory, env: { WORKERS_CI: '1' }, run }), /退出码 1/);
  assert.ok(file);
  await assert.rejects(() => readFile(file));
});

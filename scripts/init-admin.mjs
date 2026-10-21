import { randomBytes, pbkdf2Sync } from 'node:crypto';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import constants from '../src/constants.json' with { type: 'json' };

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;

export function createBootstrap({
  username = 'admin',
  password = randomBytes(24).toString('base64url'),
} = {}) {
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(username))
    throw new Error('用户名需为 1–64 位字母、数字、点、下划线或短横线。');
  if (password.length < 12) throw new Error('初始管理员密码至少需要 12 位。');
  const salt = randomBytes(16).toString('hex');
  const digest = pbkdf2Sync(password, Buffer.from(salt, 'hex'), 100000, 32, 'sha256').toString(
    'hex',
  );
  const hash = `pbkdf2_sha256$100000$${salt}$${digest}`;
  const token = randomBytes(32).toString('hex');
  const sql = [
    '-- PRIVATE: initialize a new empty database after applying migrations.',
    '-- Repeating this import must fail rather than reset an existing administrator.',
    `INSERT INTO admin_users(username,password_hash,must_change_password) VALUES(${literal(username)},${literal(hash)},1);`,
    "INSERT INTO app_settings(key,value) VALUES('db_version','1'),('ip_lookup_enabled','1'),('ip_network_rules','');",
    `INSERT INTO profiles(id,slug,name,config_json) VALUES(1,'full','全部频道',${literal(JSON.stringify(constants.DEFAULT_PROFILE_CONFIG))});`,
    `INSERT INTO subscriptions(name,profile_id,viewer_id,path,access_token,allow_query_override) VALUES('自动识别订阅',1,NULL,'live',${literal(token)},0);`,
    '',
  ].join('\n');
  return { username, password, token, hash, sql };
}

export async function initialize({ directory = root, username = 'admin', password } = {}) {
  const privateDir = resolve(directory, 'private');
  for (const file of ['bootstrap.sql', 'bootstrap.credentials.txt']) {
    try {
      await access(resolve(privateDir, file));
      throw new Error(`拒绝覆盖已有的 private/${file}。初始化只需执行一次。`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const varsPath = resolve(directory, '.dev.vars');
  let existingVars;
  try {
    existingVars = await readFile(varsPath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (
    existingVars !== undefined &&
    (existingVars.match(/^SESSION_SECRET\s*=\s*["']?([^\r\n"']+)/m)?.[1]?.trim().length ?? 0) < 32
  ) {
    throw new Error('已有 .dev.vars 的 SESSION_SECRET 无效；请设置至少 32 字符的随机密钥后重试。');
  }
  const bootstrap = createBootstrap({ username, password });
  await mkdir(privateDir, { recursive: true });
  await writeFile(resolve(privateDir, 'bootstrap.sql'), bootstrap.sql, { flag: 'wx', mode: 0o600 });
  await writeFile(
    resolve(privateDir, 'bootstrap.credentials.txt'),
    `初始管理员凭据（私下保存）\n用户名：${bootstrap.username}\n密码：${bootstrap.password}\n\n部署后打开 /_admin 登录。若之后修改了密码，以新密码为准。\n`,
    { flag: 'wx', mode: 0o600 },
  );
  if (existingVars === undefined)
    await writeFile(varsPath, `SESSION_SECRET="${randomBytes(48).toString('base64url')}"\n`, {
      flag: 'wx',
      mode: 0o600,
    });
  return bootstrap;
}

async function main() {
  const args = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const value = args[++i];
    if (!value) throw new Error('缺少参数值。支持 --username 和 --password-env。');
    if (args[i - 1] === '--username') options.username = value;
    else if (args[i - 1] === '--password-env') {
      options.password = process.env[value];
      if (!options.password) throw new Error('指定的密码环境变量为空。');
    } else throw new Error('未知参数。支持 --username 和 --password-env。');
  }
  const result = await initialize(options);
  console.log(
    `已为 ${result.username} 生成独立初始化文件：\n- private/bootstrap.sql：导入你自己的空 D1\n- private/bootstrap.credentials.txt：查看初始密码\n- .dev.vars：本机和部署用会话密钥\n\n未连接数据库或上传任何数据；不会生成直播源或频道。`,
  );
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

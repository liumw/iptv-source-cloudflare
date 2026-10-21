import { randomBytes, pbkdf2Sync } from 'node:crypto';
import constants from '../src/constants.json' with { type: 'json' };

const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;

export function createDefaultBootstrap() {
  const salt = randomBytes(16);
  const digest = pbkdf2Sync('admin123', salt, 100000, 32, 'sha256');
  const hash = `pbkdf2_sha256$100000$${salt.toString('hex')}$${digest.toString('hex')}`;
  const token = randomBytes(32).toString('hex');
  const empty = 'NOT EXISTS (SELECT 1 FROM admin_users)';
  // Create the administrator last: all statements become no-ops on an initialized DB.
  // OR IGNORE also makes a retry safe if an earlier attempt stopped before the last insert.
  const sql = [
    '-- Automatic first deployment only. Never replace existing users or configuration.',
    ...[
      ['db_version', '1'],
      ['ip_lookup_enabled', '1'],
      ['ip_network_rules', ''],
    ].map(
      ([key, value]) =>
        `INSERT OR IGNORE INTO app_settings(key,value) SELECT ${literal(key)},${literal(value)} WHERE ${empty};`,
    ),
    `INSERT OR IGNORE INTO profiles(slug,name,config_json) SELECT 'full','全部频道',${literal(JSON.stringify(constants.DEFAULT_PROFILE_CONFIG))} WHERE ${empty};`,
    `INSERT OR IGNORE INTO subscriptions(name,profile_id,viewer_id,path,access_token,allow_query_override) SELECT '自动识别订阅',id,NULL,'live',${literal(token)},0 FROM profiles WHERE slug='full' AND ${empty};`,
    `INSERT INTO admin_users(username,password_hash,must_change_password) SELECT 'admin',${literal(hash)},1 WHERE ${empty};`,
    '',
  ].join('\n');
  return { sql, hash, token };
}

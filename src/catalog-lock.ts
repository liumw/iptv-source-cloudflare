import { Store } from './store';
import { randomToken } from './security';

// Approval and ingestion share this lock so a refresh cannot undo a review decision.
export async function withCatalogLock<T>(store: Store, operation: () => Promise<T>): Promise<T> {
  const token = randomToken(16),
    clock = Math.floor(Date.now() / 1000);
  const lock = await store.one(
    'INSERT INTO cloud_locks(name,token,expires_at) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET token=excluded.token,expires_at=excluded.expires_at WHERE cloud_locks.expires_at<? RETURNING token',
    ['ingest', token, clock + 120, clock],
  );
  if (lock?.token !== token) throw new Error('频道数据正在更新，请稍后重试');
  try {
    return await operation();
  } finally {
    await store.run('DELETE FROM cloud_locks WHERE name=? AND token=?', ['ingest', token]);
  }
}

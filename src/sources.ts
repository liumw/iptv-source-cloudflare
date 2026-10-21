import { Store } from './store';

export async function deleteSource(store: Store, id: number): Promise<boolean> {
  const source = await store.one("SELECT name FROM sources WHERE id=? AND origin!='manual'", [id]);
  if (!source) return false;
  const retainedName = `保留线路 · ${String(source.name).slice(0, 64)} · ${id}-${crypto.randomUUID()}`;
  // A separate internal owner per deleted source avoids fingerprint collisions and
  // preserves source-level playback settings without mixing them with manual additions.
  await store.write([
    store.statement(
      `INSERT INTO sources(name,origin,format,enabled,priority,adult,default_network,default_carrier,default_region,headers_json,proxy)
       SELECT ?,'manual','retained',enabled,priority,adult,default_network,default_carrier,default_region,headers_json,proxy
       FROM sources WHERE id=? AND origin!='manual' AND EXISTS(SELECT 1 FROM streams WHERE source_id=?)`,
      [retainedName, id, id],
    ),
    store.statement(
      `UPDATE streams SET source_id=(SELECT id FROM sources WHERE name=? AND origin='manual' AND format='retained')
       WHERE source_id=? AND EXISTS(SELECT 1 FROM sources WHERE name=? AND origin='manual' AND format='retained')`,
      [retainedName, id, retainedName],
    ),
    store.statement("DELETE FROM sources WHERE id=? AND origin!='manual'", [id]),
  ]);
  return true;
}

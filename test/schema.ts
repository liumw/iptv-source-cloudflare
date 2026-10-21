import { readFile } from 'node:fs/promises';

export async function applyChannelNumberMigration(db: any) {
  const sql = await readFile('migrations/0002_channel_numbers.sql', 'utf8');
  await db.batch(sql.split('-- statement-break').map((statement) => db.prepare(statement)));
}

export async function applyPendingMigration(db: any) {
  const sql = await readFile('migrations/0003_pending_channels.sql', 'utf8');
  await db.batch(sql.split('-- statement-break').map((statement) => db.prepare(statement)));
}

-- Imported candidates have a separate identity space from the official catalog.
CREATE TABLE pending_channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  group_id INTEGER REFERENCES groups(id),
  logo TEXT,
  tvg_id TEXT,
  chno INTEGER,
  region TEXT NOT NULL DEFAULT 'national',
  region_manual INTEGER NOT NULL DEFAULT 0,
  adult INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  legacy_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- statement-break
ALTER TABLE streams ADD COLUMN pending_channel_id INTEGER REFERENCES pending_channels(id) ON DELETE CASCADE CHECK(pending_channel_id IS NULL OR channel_id IS NULL);
-- statement-break
CREATE INDEX ix_stream_pending_channel ON streams(pending_channel_id);
-- statement-break
INSERT INTO pending_channels(id,key,name,group_id,logo,tvg_id,chno,region,region_manual,adult,enabled,priority,notes,created_at,updated_at,legacy_json)
SELECT c.id,c.key,c.name,c.group_id,c.logo,c.tvg_id,c.chno,c.region,c.region_manual,c.adult,c.enabled,c.priority,c.notes,c.created_at,c.updated_at,
  json_object('aliases',json((SELECT json_group_array(json_object('alias',alias,'alias_norm',alias_norm)) FROM channel_aliases WHERE channel_id=c.id)),
              'profiles',json((SELECT json_group_array(json_object('profile_id',profile_id,'include',include,'chno_override',chno_override,'sort_override',sort_override)) FROM profile_channels WHERE channel_id=c.id)))
FROM channels c WHERE c.auto_created=1 AND c.reviewed=0;
-- statement-break
UPDATE streams SET pending_channel_id=channel_id,channel_id=NULL WHERE channel_id IN (SELECT id FROM pending_channels);
-- statement-break
DELETE FROM channel_aliases WHERE channel_id IN (SELECT id FROM pending_channels);
-- statement-break
DELETE FROM profile_channels WHERE channel_id IN (SELECT id FROM pending_channels);
-- statement-break
DELETE FROM channels WHERE auto_created=1 AND reviewed=0;
-- statement-break
UPDATE app_settings SET value=CAST(value AS INTEGER)+1 WHERE key='db_version';

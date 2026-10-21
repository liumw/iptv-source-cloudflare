-- Keep existing manual numbers intact, including legacy conflicts; prevent new conflicts.
CREATE INDEX IF NOT EXISTS ix_channel_chno ON channels(chno);
-- statement-break
CREATE TRIGGER IF NOT EXISTS channels_chno_insert
BEFORE INSERT ON channels
WHEN NEW.chno IS NOT NULL AND EXISTS(SELECT 1 FROM channels WHERE chno=NEW.chno)
BEGIN
  SELECT RAISE(ABORT, 'CHANNEL_NUMBER_TAKEN');
END;
-- statement-break
CREATE TRIGGER IF NOT EXISTS channels_chno_update
BEFORE UPDATE OF chno ON channels
WHEN NEW.chno IS NOT NULL AND EXISTS(SELECT 1 FROM channels WHERE chno=NEW.chno AND id!=NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'CHANNEL_NUMBER_TAKEN');
END;
-- statement-break
INSERT INTO app_settings(key,value) VALUES('db_version','1')
ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1,updated_at=CURRENT_TIMESTAMP;

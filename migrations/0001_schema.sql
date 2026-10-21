-- Schema compatible with the Python local database; runtime defaults included.
CREATE TABLE access_logs (
	id INTEGER NOT NULL,
	subscription_id INTEGER,
	path VARCHAR(255) NOT NULL,
	ip VARCHAR(64),
	user_agent TEXT,
	status INTEGER NOT NULL DEFAULT 200,
	bytes INTEGER NOT NULL DEFAULT 0,
	detected_carrier VARCHAR(16),
	detected_ipv6 BOOLEAN NOT NULL DEFAULT 0,
	request_ip_version INTEGER,
	detected_region VARCHAR(16),
	reason VARCHAR(64),
	created_at DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
	PRIMARY KEY (id)
);

CREATE INDEX ix_access_log_created ON access_logs (created_at);

CREATE TABLE admin_users (
	id INTEGER NOT NULL,
	username VARCHAR(64) NOT NULL,
	password_hash VARCHAR(255) NOT NULL,
	must_change_password BOOLEAN NOT NULL DEFAULT 1,
	created_at DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
	PRIMARY KEY (id),
	UNIQUE (username)
);

CREATE TABLE app_settings (
	"key" VARCHAR(64) NOT NULL,
	value TEXT NOT NULL DEFAULT '',
	updated_at DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
	PRIMARY KEY ("key")
);

CREATE TABLE groups (
	id INTEGER NOT NULL,
	name VARCHAR(128) NOT NULL,
	sort_order INTEGER NOT NULL DEFAULT 100,
	adult BOOLEAN NOT NULL DEFAULT 0,
	icon VARCHAR(255),
	PRIMARY KEY (id),
	UNIQUE (name)
);

CREATE TABLE profiles (
	id INTEGER NOT NULL,
	slug VARCHAR(64) NOT NULL,
	name VARCHAR(128) NOT NULL,
	config_json TEXT NOT NULL DEFAULT '{}',
	cache_ttl INTEGER NOT NULL DEFAULT 30,
	enabled BOOLEAN NOT NULL DEFAULT 1,
	created_at DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
	updated_at DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
	PRIMARY KEY (id),
	UNIQUE (slug)
);

CREATE TABLE sources (
	id INTEGER NOT NULL,
	name VARCHAR(128) NOT NULL,
	format VARCHAR(16) NOT NULL DEFAULT 'm3u',
	origin VARCHAR(16) NOT NULL DEFAULT 'url',
	url TEXT,
	file_path TEXT,
	inline_text TEXT,
	enabled BOOLEAN NOT NULL DEFAULT 1,
	priority INTEGER NOT NULL DEFAULT 0,
	adult BOOLEAN NOT NULL DEFAULT 0,
	default_network VARCHAR(16) NOT NULL DEFAULT 'auto',
	default_carrier VARCHAR(16) NOT NULL DEFAULT 'auto',
	default_region VARCHAR(16) NOT NULL DEFAULT 'auto',
	headers_json TEXT NOT NULL DEFAULT '{}',
	proxy VARCHAR(255),
	refresh_minutes INTEGER NOT NULL DEFAULT 0,
	last_fetch_at DATETIME,
	last_http_status INTEGER,
	last_error TEXT,
	etag VARCHAR(255),
	last_modified VARCHAR(255),
	content_hash VARCHAR(64),
	created_at DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
	updated_at DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
	PRIMARY KEY (id),
	UNIQUE (name)
);

CREATE TABLE viewers (
	id INTEGER NOT NULL,
	name VARCHAR(128) NOT NULL,
	carrier VARCHAR(16) NOT NULL DEFAULT 'unknown',
	supports_ipv4 BOOLEAN NOT NULL DEFAULT 1,
	supports_ipv6 BOOLEAN NOT NULL DEFAULT 0,
	supports_iptv BOOLEAN NOT NULL DEFAULT 0,
	region VARCHAR(16) NOT NULL DEFAULT 'national',
	is_default BOOLEAN NOT NULL DEFAULT 0,
	notes TEXT,
	created_at DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
	updated_at DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
	PRIMARY KEY (id),
	UNIQUE (name)
);

CREATE TABLE channels (
	id INTEGER NOT NULL,
	"key" VARCHAR(128) NOT NULL,
	name VARCHAR(128) NOT NULL,
	group_id INTEGER,
	logo TEXT,
	tvg_id VARCHAR(128),
	chno INTEGER,
	region VARCHAR(16) NOT NULL DEFAULT 'national',
	region_manual BOOLEAN NOT NULL DEFAULT 0,
	adult BOOLEAN NOT NULL DEFAULT 0,
	auto_created BOOLEAN NOT NULL DEFAULT 0,
	reviewed BOOLEAN NOT NULL DEFAULT 0,
	enabled BOOLEAN NOT NULL DEFAULT 1,
	priority INTEGER NOT NULL DEFAULT 0,
	notes TEXT,
	created_at DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
	updated_at DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
	PRIMARY KEY (id),
	UNIQUE ("key"),
	FOREIGN KEY(group_id) REFERENCES groups (id)
);

CREATE TABLE subscriptions (
	id INTEGER NOT NULL,
	name VARCHAR(128) NOT NULL,
	profile_id INTEGER NOT NULL,
	viewer_id INTEGER,
	path VARCHAR(128) NOT NULL,
	access_token VARCHAR(128),
	allow_query_override BOOLEAN NOT NULL DEFAULT 0,
	cache_ttl INTEGER NOT NULL DEFAULT 30,
	enabled BOOLEAN NOT NULL DEFAULT 1,
	created_at DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
	updated_at DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
	PRIMARY KEY (id),
	FOREIGN KEY(profile_id) REFERENCES profiles (id) ON DELETE CASCADE,
	FOREIGN KEY(viewer_id) REFERENCES viewers (id) ON DELETE SET NULL,
	UNIQUE (path)
);

CREATE TABLE builds (
	id INTEGER NOT NULL,
	subscription_id INTEGER NOT NULL,
	created_at DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
	stats_json TEXT NOT NULL DEFAULT '{}',
	diff_json TEXT NOT NULL DEFAULT '{}',
	output_hash VARCHAR(64) NOT NULL DEFAULT '',
	snapshot_path TEXT,
	PRIMARY KEY (id),
	FOREIGN KEY(subscription_id) REFERENCES subscriptions (id) ON DELETE CASCADE
);

CREATE TABLE channel_aliases (
	id INTEGER NOT NULL,
	channel_id INTEGER NOT NULL,
	alias VARCHAR(128) NOT NULL,
	alias_norm VARCHAR(128) NOT NULL,
	PRIMARY KEY (id),
	FOREIGN KEY(channel_id) REFERENCES channels (id) ON DELETE CASCADE,
	UNIQUE (alias_norm)
);

CREATE TABLE profile_channels (
	id INTEGER NOT NULL,
	profile_id INTEGER NOT NULL,
	channel_id INTEGER NOT NULL,
	include BOOLEAN,
	chno_override INTEGER,
	sort_override INTEGER,
	PRIMARY KEY (id),
	CONSTRAINT ux_profile_channel UNIQUE (profile_id, channel_id),
	FOREIGN KEY(profile_id) REFERENCES profiles (id) ON DELETE CASCADE,
	FOREIGN KEY(channel_id) REFERENCES channels (id) ON DELETE CASCADE
);

CREATE TABLE streams (
	id INTEGER NOT NULL,
	source_id INTEGER NOT NULL,
	channel_id INTEGER,
	fingerprint VARCHAR(40) NOT NULL,
	url TEXT NOT NULL,
	raw_name VARCHAR(255) NOT NULL DEFAULT '',
	group_title_raw VARCHAR(128),
	tvg_id VARCHAR(128),
	tvg_name VARCHAR(128),
	tvg_logo TEXT,
	catchup VARCHAR(64),
	catchup_source TEXT,
	catchup_days VARCHAR(16),
	timeshift VARCHAR(16),
	attrs_json TEXT NOT NULL DEFAULT '{}',
	network VARCHAR(16) NOT NULL DEFAULT 'all',
	carrier VARCHAR(16) NOT NULL DEFAULT 'all',
	region VARCHAR(16),
	network_manual BOOLEAN NOT NULL DEFAULT 0,
	carrier_manual BOOLEAN NOT NULL DEFAULT 0,
	region_manual BOOLEAN NOT NULL DEFAULT 0,
	is_default BOOLEAN NOT NULL DEFAULT 0,
	priority INTEGER NOT NULL DEFAULT 0,
	enabled BOOLEAN NOT NULL DEFAULT 1,
	excluded BOOLEAN NOT NULL DEFAULT 0,
	adult BOOLEAN NOT NULL DEFAULT 0,
	score FLOAT NOT NULL DEFAULT 0.0,
	last_ok_at DATETIME,
	fail_count INTEGER NOT NULL DEFAULT 0,
	first_seen_at DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
	last_seen_at DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
	PRIMARY KEY (id),
	CONSTRAINT ux_stream_source_fp UNIQUE (source_id, fingerprint),
	FOREIGN KEY(source_id) REFERENCES sources (id) ON DELETE CASCADE,
	FOREIGN KEY(channel_id) REFERENCES channels (id) ON DELETE SET NULL
);

CREATE INDEX ix_stream_source ON streams (source_id);

CREATE UNIQUE INDEX ux_stream_default ON streams (channel_id) WHERE is_default = 1 AND channel_id IS NOT NULL;

CREATE INDEX ix_stream_channel ON streams (channel_id);

CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL, password_version TEXT NOT NULL);

CREATE INDEX ix_sessions_expiry ON sessions(expires_at);

CREATE TABLE login_attempts (ip_hash TEXT PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0, window_start INTEGER NOT NULL);

CREATE TABLE cloud_locks (name TEXT PRIMARY KEY, token TEXT NOT NULL, expires_at INTEGER NOT NULL);

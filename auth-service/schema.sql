CREATE TABLE IF NOT EXISTS sessions (
 id TEXT PRIMARY KEY, challenge TEXT NOT NULL, google_verifier TEXT NOT NULL,
 expires INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', encrypted_refresh TEXT
);
CREATE INDEX IF NOT EXISTS session_expiry ON sessions(expires);
CREATE TABLE IF NOT EXISTS devices (
 token_hash TEXT PRIMARY KEY, encrypted_refresh TEXT NOT NULL, created INTEGER NOT NULL,
 expires INTEGER NOT NULL, last_refresh INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS device_expiry ON devices(expires);

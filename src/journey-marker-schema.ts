/** Markers survive recorder inbox acknowledgement and non-destructive route edits. */
export const JOURNEY_MARKER_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS local_journey_markers(
 id TEXT PRIMARY KEY NOT NULL,
 user_id TEXT NOT NULL REFERENCES local_users(id) ON DELETE CASCADE,
 session_id TEXT NOT NULL,
 root_journey_id TEXT NOT NULL,
 captured_at TEXT NOT NULL,
 location_at TEXT NOT NULL,
 latitude REAL NOT NULL CHECK(latitude BETWEEN -90 AND 90),
 longitude REAL NOT NULL CHECK(longitude BETWEEN -180 AND 180),
 accuracy_meters REAL NOT NULL CHECK(accuracy_meters BETWEEN 0 AND 100),
 notes TEXT NOT NULL DEFAULT '',
 deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_markers_journey ON local_journey_markers(user_id,root_journey_id,captured_at);
CREATE TABLE IF NOT EXISTS local_marker_media(
 id TEXT PRIMARY KEY NOT NULL,
 marker_id TEXT NOT NULL REFERENCES local_journey_markers(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('photo','voice')),
 file_name TEXT NOT NULL,
 created_at TEXT NOT NULL
);
`;

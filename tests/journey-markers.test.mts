import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import vm from 'node:vm';
import { validCapturedMarker } from '../src/journey-marker-model.ts';

const require = createRequire(import.meta.url), ts = require('typescript');
const directory = fileURLToPath(new URL('../src/', import.meta.url));
const at = (minute: number) => new Date(Date.parse('2026-09-17T12:00:00Z') + minute * 60000).toISOString();
const marker = { id: `marker_${randomUUID()}`, capturedAt: at(3), locationAt: at(3), latitude: 0, longitude: 0, accuracyMeters: 5 };

function fixture(compat = false) {
  const database = new DatabaseSync(':memory:'), files = new Map<string, number>();
  const state = { compat, userId: '', notices: 0, failCopy: false, switchDuringCopy: false };
  const db = {
    execSync: (sql: string) => database.exec(sql),
    runSync: (sql: string, ...args: any[]) => database.prepare(sql).run(...args),
    getFirstSync: (sql: string, ...args: any[]) => database.prepare(sql).get(...args) ?? null,
    getAllSync: (sql: string, ...args: any[]) => database.prepare(sql).all(...args),
    withTransactionSync(work: () => void) { database.exec('BEGIN IMMEDIATE'); try { work(); database.exec('COMMIT'); } catch (error) { database.exec('ROLLBACK'); throw error; } },
  };
  const loaded = new Map<string, any>();
  const overrides: Record<string, any> = {
    'expo-crypto': { randomUUID }, './database-owner': { getMasterDatabase: () => db },
    './local-archive-events': { notifyLocalArchiveChanged: () => state.notices++ },
    './auth': { getCurrentUser: () => ({ id: state.userId }) },
    '../modules/journeydeck-membership': { getMembershipStatus: async () => ({ nativeModuleAvailable: true, tier: 'paid' }) },
    '../modules/journeydeck-recorder': { getNativeAutomaticRecorderStatus: async () => ({ nativeModuleAvailable: true, statusReliable: true, recording: false, paused: false, sessionId: null }) },
    'expo-file-system/legacy': {
      documentDirectory: 'file:///Documents/', makeDirectoryAsync: async () => {},
      copyAsync: async ({ to }: { to: string }) => {
        files.set(to, 1234); if (state.failCopy) throw new Error('copy failed');
        if (state.switchDuringCopy) database.prepare("UPDATE local_preferences SET value='someone-else' WHERE key='active_user_id'").run();
      },
      getInfoAsync: async (uri: string) => ({ exists: files.has(uri), isDirectory: false, size: files.get(uri) }),
      deleteAsync: async (uri: string) => { for (const key of files.keys()) if (key.startsWith(uri)) files.delete(key); },
    },
  };
  function load(path: string): any {
    if (loaded.has(path)) return loaded.get(path);
    const exports: any = {}; loaded.set(path, exports);
    vm.runInNewContext(ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
      { exports, process: { env: { EXPO_PUBLIC_JOURNEYDECK_MARKER_OTA_COMPAT: state.compat ? '1' : undefined } }, Date, Math, JSON, Map, Set, TextEncoder, console, require: (id: string) => id in overrides ? overrides[id] : load(resolve(dirname(path), `${id}.ts`)) });
    return exports;
  }
  const local = load(resolve(directory, 'local-store.ts')); local.initializeLocalStore();
  state.userId = local.ensureLocalUser({ displayName: 'Driver' }).id; local.setActiveLocalUserId(state.userId);
  const rootId = compat ? 'local_native_recording_test' : 'root';
  local.upsertJourney({ id: rootId, userId: state.userId, legacyDriveId: null, startedAt: at(0), endedAt: at(10), durationMinutes: 10, miles: 4,
    startLat: 0, startLng: 0, endLat: 0, endLng: .01, startPlaceId: null, endPlaceId: null, averageSpeedMph: 24, maxSpeedMph: 30, songCount: 0, vehicleName: null, provider: 'native_recorder' });
  local.insertGpsPoints(state.userId, rootId, Array.from({ length: 11 }, (_, i) => ({ sequence: i, recordedAt: at(i), latitude: 0, longitude: .001 * i, accuracyMeters: 5, altitudeMeters: null, headingDegrees: 90, speedMps: 10 })));
  if (compat) database.prepare('INSERT INTO local_preferences(key,value,updated_at) VALUES(?,?,?)').run(
    `journey.marker.v1:${encodeURIComponent(state.userId)}:${marker.id}`, JSON.stringify({ ...marker, userId: state.userId, sessionId: 'native_recording_test', notes: '', media: [] }), at(3));
  else database.prepare(`INSERT INTO local_journey_markers(id,user_id,session_id,root_journey_id,captured_at,location_at,latitude,longitude,accuracy_meters) VALUES(?,?,'session','root',?,?,0,0,5)`).run(marker.id, state.userId, marker.capturedAt, marker.locationAt);
  return { database, files, state, local, rootId, upgrade() { state.compat = false; loaded.delete(resolve(directory, 'local-store.ts')); loaded.delete(resolve(directory, 'journey-marker-compatibility.ts')); load(resolve(directory, 'local-store.ts')).initializeLocalStore(); }, markers: load(resolve(directory, 'journey-marker-store.ts')), editor: load(resolve(directory, 'journey-editor-store.ts')), close: () => database.close() };
}

test('capture validation rejects stale, future, inaccurate, out-of-session and invalid fixes', () => {
  assert.equal(validCapturedMarker(marker, at(0), at(10)), true);
  for (const patch of [{ locationAt: at(2) }, { locationAt: at(4) }, { accuracyMeters: 101 }, { latitude: NaN }, { capturedAt: at(11) }, { capturedAt: at(-1) }]) {
    assert.equal(validCapturedMarker({ ...marker, ...patch }, at(0), at(10)), false);
  }
});

test('OTA keeps schema 7 intact, saves real notes/photos, and upgrades all content atomically into schema 8', async () => {
  const f = fixture(true);
  try {
    assert.equal(f.database.prepare('PRAGMA user_version').get()?.user_version, 7);
    assert.equal(f.database.prepare("SELECT name FROM sqlite_master WHERE name='local_journey_markers'").get(), undefined);
    f.markers.saveMarkerNotes(f.state.userId, marker.id, 'Saved using the OTA');
    await f.markers.addMarkerMedia(f.state.userId, marker.id, 'photo', 'file:///cache/p.jpg');
    assert.equal(f.markers.listJourneyMarkers(f.state.userId, f.rootId)[0].notes, 'Saved using the OTA');
    assert.equal(f.markers.listMarkerJourneys(f.state.userId).length, 1);
    assert.equal(f.markers.listMarkerMedia(f.state.userId, marker.id).length, 1);
    await assert.rejects(f.markers.addMarkerMedia(f.state.userId, marker.id, 'voice', 'file:///cache/v.m4a'), /new JourneyDeck build/);
    assert.equal(f.database.prepare('PRAGMA user_version').get()?.user_version, 7);
    f.upgrade();
    assert.equal(f.database.prepare('PRAGMA user_version').get()?.user_version, 8);
    assert.equal(f.database.prepare('SELECT notes FROM local_journey_markers').get()?.notes, 'Saved using the OTA');
    assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM local_marker_media').get()?.n, 1);
    assert.equal(f.database.prepare("SELECT COUNT(*) AS n FROM local_preferences WHERE key LIKE 'journey.marker.v1:%'").get()?.n, 0);
    assert.equal(f.files.size, 1, 'upgrade preserves the saved photo');
  } finally { f.close(); }
});

test('OTA profile isolation, failed photo copies and account cleanup keep private data scoped', async () => {
  const f = fixture(true);
  try {
    assert.throws(() => f.markers.listSessionMarkers('other', 'native_recording_test'), /profile/);
    f.state.failCopy = true;
    await assert.rejects(f.markers.addMarkerMedia(f.state.userId, marker.id, 'photo', 'file:///cache/p.jpg'));
    assert.equal(f.files.size, 0);
    assert.equal(f.markers.listMarkerMedia(f.state.userId, marker.id).length, 0);
    f.local.deleteLocalUserData(f.state.userId);
    assert.equal(f.database.prepare("SELECT COUNT(*) AS n FROM local_preferences WHERE key LIKE 'journey.marker.v1:%'").get()?.n, 0);
  } finally { f.close(); }
});

test('notes and multiple attachments persist; profile boundaries and path traversal are rejected', async () => {
  const f = fixture();
  try {
    f.markers.saveMarkerNotes(f.state.userId, marker.id, 'A great moment');
    await f.markers.addMarkerMedia(f.state.userId, marker.id, 'photo', 'file:///cache/picture.jpg');
    await f.markers.addMarkerMedia(f.state.userId, marker.id, 'voice', 'file:///cache/memo.m4a');
    assert.equal(f.markers.listJourneyMarkers(f.state.userId, 'root')[0].notes, 'A great moment');
    const media = f.markers.listMarkerMedia(f.state.userId, marker.id);
    assert.equal(media.length, 2); assert.equal(f.files.size, 2);
    assert.ok(f.markers.markerMediaUri(f.state.userId, media[0]).startsWith('file:///Documents/journeydeck-marker-media/'));
    assert.throws(() => f.markers.markerMediaUri(f.state.userId, { ...media[0], fileName: '../secret.jpg' }), /Invalid/);
    assert.throws(() => f.markers.listJourneyMarkers('other', 'root'), /profile/);
    await f.markers.removeMarkerMedia(f.state.userId, marker.id, media[0]);
    assert.equal(f.markers.listMarkerMedia(f.state.userId, marker.id).length, 1);
    assert.equal(f.files.size, 1);
  } finally { f.close(); }
});

test('failed copy and profile change during copy leave no attachment or private orphan', async () => {
  for (const mode of ['failCopy', 'switchDuringCopy'] as const) {
    const f = fixture();
    try {
      f.state[mode] = true;
      await assert.rejects(f.markers.addMarkerMedia(f.state.userId, marker.id, 'photo', 'file:///cache/p.jpg'));
      assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM local_marker_media').get()?.n, 0);
      assert.equal(f.files.size, 0);
    } finally { f.close(); }
  }
});

test('trim hides excluded markers, restore recovers them, and a split boundary belongs to exactly one segment', async () => {
  const f = fixture();
  try {
    await f.editor.commitJourneyEdit(f.editor.loadJourneyEditor(f.state.userId, 'root'), { kind: 'trim', startMs: Date.parse(at(4)), endMs: Date.parse(at(9)) });
    assert.equal(f.markers.listJourneyMarkers(f.state.userId, 'root').length, 0);
    await f.editor.commitJourneyEdit(f.editor.loadJourneyEditor(f.state.userId, 'root'), { kind: 'restore' });
    assert.equal(f.markers.listJourneyMarkers(f.state.userId, 'root').length, 1);
    await f.editor.commitJourneyEdit(f.editor.loadJourneyEditor(f.state.userId, 'root'), { kind: 'split', atMs: Date.parse(at(3)) });
    const journeys = f.database.prepare('SELECT id FROM local_journeys').all();
    assert.equal(journeys.reduce((n, row) => n + f.markers.listJourneyMarkers(f.state.userId, row.id).length, 0), 1);
    f.local.deleteLocalUserData(f.state.userId);
    assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM local_journey_markers').get()?.n, 0);
  } finally { f.close(); }
});

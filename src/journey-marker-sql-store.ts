import { randomUUID } from 'expo-crypto';
import * as FileSystem from 'expo-file-system/legacy';
import { getMasterDatabase } from './database-owner';
import { getActiveLocalUserId, initializeLocalStore, isPrivateCloudDeletionPending } from './local-store';
import { notifyLocalArchiveChanged } from './local-archive-events';
import type { CapturedJourneyMarker } from './journey-marker-model';

export type JourneyMarker = CapturedJourneyMarker & { notes: string; sessionId: string };
export type MarkerMedia = { id: string; kind: 'photo' | 'voice'; fileName: string };

function ownedDatabase(userId: string) {
  initializeLocalStore();
  if (getActiveLocalUserId() !== userId || isPrivateCloudDeletionPending(userId)) throw new Error('The active profile changed.');
  return getMasterDatabase();
}
const columns = `m.id,m.captured_at AS capturedAt,m.location_at AS locationAt,m.latitude,m.longitude,
 m.accuracy_meters AS accuracyMeters,m.notes,m.session_id AS sessionId`;

export function listMarkerJourneys(userId: string) {
  return ownedDatabase(userId).getAllSync<{ id: string; startedAt: string }>(`SELECT j.id,j.started_at AS startedAt
    FROM local_journeys j LEFT JOIN local_journey_edit_members e ON e.journey_id=j.id AND e.user_id=j.user_id
    WHERE j.user_id=? AND EXISTS (SELECT 1 FROM local_journey_markers m
      WHERE m.user_id=j.user_id AND m.root_journey_id=COALESCE(e.root_id,j.id) AND m.deleted_at IS NULL
        AND m.captured_at>=j.started_at AND m.captured_at<=j.ended_at)
    ORDER BY j.started_at DESC;`, userId);
}

export function listJourneyMarkers(userId: string, journeyId: string): JourneyMarker[] {
  const db = ownedDatabase(userId);
  // Resolve the immutable original through trim/split membership. Markers outside
  // the visible time range stay saved for Restore Original, without false map pins.
  return db.getAllSync<JourneyMarker>(`SELECT ${columns} FROM local_journey_markers m
    JOIN local_journeys j ON j.user_id=m.user_id AND j.id=?
    LEFT JOIN local_journey_edit_members e ON e.journey_id=j.id AND e.user_id=j.user_id
    WHERE m.user_id=? AND m.deleted_at IS NULL AND m.root_journey_id=COALESCE(e.root_id,j.id)
      AND m.captured_at>=j.started_at AND m.captured_at<=j.ended_at
      AND NOT EXISTS (SELECT 1 FROM local_journeys next JOIN local_journey_edit_members n ON n.journey_id=next.id
        WHERE n.user_id=m.user_id AND n.root_id=m.root_journey_id AND n.active=1
          AND next.started_at=m.captured_at AND next.started_at>j.started_at)
    ORDER BY m.captured_at,m.id;`, journeyId, userId);
}

export function listSessionMarkers(userId: string, sessionId: string): JourneyMarker[] {
  return ownedDatabase(userId).getAllSync<JourneyMarker>(`SELECT ${columns} FROM local_journey_markers m
    WHERE user_id=? AND session_id=? AND deleted_at IS NULL ORDER BY captured_at,id;`, userId, sessionId);
}

function assertMarker(userId: string, markerId: string) {
  const db = ownedDatabase(userId);
  if (!db.getFirstSync('SELECT id FROM local_journey_markers WHERE user_id=? AND id=? AND deleted_at IS NULL;', userId, markerId)) {
    throw new Error('This marker is no longer available.');
  }
  return db;
}
function assertEditingAllowed(userId: string, markerId: string) {
  const db = assertMarker(userId, markerId);
  if (db.getFirstSync("SELECT id FROM recording_sessions WHERE owner_user_id=? AND status<>'completed';", userId)) {
    throw new Error('Finish your journey before adding notes or media.');
  }
  return db;
}
export function saveMarkerNotes(userId: string, markerId: string, notes: string) {
  if (notes.length > 10000) throw new Error('Notes can contain up to 10,000 characters.');
  assertEditingAllowed(userId, markerId).runSync('UPDATE local_journey_markers SET notes=? WHERE user_id=? AND id=?;', notes, userId, markerId);
  notifyLocalArchiveChanged();
}
export function listMarkerMedia(userId: string, markerId: string): MarkerMedia[] {
  return assertMarker(userId, markerId).getAllSync<MarkerMedia>('SELECT id,kind,file_name AS fileName FROM local_marker_media WHERE marker_id=? ORDER BY created_at,id;', markerId);
}
function mediaDirectory(userId: string) {
  if (!FileSystem.documentDirectory) throw new Error('Private storage is unavailable.');
  return `${FileSystem.documentDirectory}journeydeck-marker-media/${encodeURIComponent(userId)}/`;
}
export function markerMediaUri(userId: string, media: MarkerMedia) {
  ownedDatabase(userId);
  if (!/^[0-9a-f-]{36}\.(jpg|m4a)$/.test(media.fileName)) throw new Error('Invalid marker attachment.');
  return mediaDirectory(userId) + media.fileName;
}
export async function addMarkerMedia(userId: string, markerId: string, kind: MarkerMedia['kind'], sourceUri: string) {
  assertEditingAllowed(userId, markerId);
  if (!sourceUri.startsWith('file://')) throw new Error('Select a file on this device.');
  const id = randomUUID(), fileName = `${id}.${kind === 'photo' ? 'jpg' : 'm4a'}`;
  const destination = mediaDirectory(userId) + fileName;
  await FileSystem.makeDirectoryAsync(mediaDirectory(userId), { intermediates: true });
  try {
    await FileSystem.copyAsync({ from: sourceUri, to: destination });
    const info = await FileSystem.getInfoAsync(destination);
    if (!info.exists || info.isDirectory || !info.size || info.size > 100 * 1024 * 1024) throw new Error('Attachment must be between 1 byte and 100 MB.');
    // Recheck profile/recorder after the asynchronous file copy.
    assertEditingAllowed(userId, markerId).runSync('INSERT INTO local_marker_media(id,marker_id,kind,file_name,created_at) VALUES(?,?,?,?,?);', id, markerId, kind, fileName, new Date().toISOString());
  } catch (error) {
    await FileSystem.deleteAsync(destination, { idempotent: true });
    throw error;
  }
  notifyLocalArchiveChanged();
}
export async function removeMarkerMedia(userId: string, markerId: string, media: MarkerMedia) {
  assertEditingAllowed(userId, markerId);
  const stored = listMarkerMedia(userId, markerId).find(item => item.id === media.id);
  if (!stored) return;
  await FileSystem.deleteAsync(markerMediaUri(userId, stored), { idempotent: true });
  assertEditingAllowed(userId, markerId).runSync('DELETE FROM local_marker_media WHERE marker_id=? AND id=?;', markerId, stored.id);
  notifyLocalArchiveChanged();
}
export async function deleteMarkerMediaForProfile(userId: string) {
  initializeLocalStore();
  if (getActiveLocalUserId() !== userId) throw new Error('The active profile changed.');
  // Fixed app-owned directory, escaped profile component. No user-provided paths.
  await FileSystem.deleteAsync(mediaDirectory(userId), { idempotent: true });
}

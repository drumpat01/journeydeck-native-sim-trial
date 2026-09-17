import { useEffect, useRef, useState, type ComponentProps } from 'react';
import { Alert, AppState, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system/legacy';
import { captureJourneyMarker } from './journey-marker-capture';
import { MARKER_OTA_COMPAT } from './journey-marker-compatibility';
import { getCurrentUser } from './auth';
import { syncNativeRecorderInbox } from './native-recorder-inbox';
import { subscribeLocalArchiveChanges } from './local-archive-events';
import { useAppTheme, useThemedStyles } from './app-theme';
import { NativeSheet } from './native-sheet';
import { InteractiveRouteMap } from './interactive-route-map';
import { activeSession } from './storage';
import { V3_MARKERS_PROTOTYPE_ENABLED } from './release-features';
import { addMarkerMedia, listJourneyMarkers, listMarkerMedia, markerMediaUri, removeMarkerMedia, saveMarkerNotes, type JourneyMarker } from './journey-marker-store';

export function CreateJourneyMarkerButton({ sessionId }: { sessionId: string }) {
  const styles = useThemedStyles(baseStyles);
  const busy = useRef(false);
  const [message, setMessage] = useState('Save this moment · add details after your drive');
  const [saving, setSaving] = useState(false);
  if (!V3_MARKERS_PROTOTYPE_ENABLED) return null;
  return <Pressable accessibilityRole="button" accessibilityLabel="Create a marker" disabled={saving}
    style={styles.card} onPress={() => {
      if (busy.current) return;
      busy.current = true; setSaving(true);
      void (async () => {
        try {
          await captureJourneyMarker(sessionId);
          setMessage('Marker saved. Add details after your drive.');
          // Capture is already durable even if foreground import must retry later.
          await syncNativeRecorderInbox().catch(() => undefined);
        } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not save the marker.'); }
        finally { busy.current = false; setSaving(false); }
      })();
    }}>
    <Text style={styles.title}>{saving ? 'Saving marker…' : '▣  Create a marker'}</Text>
    <Text accessibilityLiveRegion="polite" style={styles.body}>{message}</Text>
  </Pressable>;
}

export function JourneyMarkerRoute({ journeyId, ...props }: ComponentProps<typeof InteractiveRouteMap> & { journeyId: string }) {
  const styles = useThemedStyles(baseStyles);
  const userId = getCurrentUser().id;
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<JourneyMarker | null>(null);
  useEffect(() => subscribeLocalArchiveChanges(() => setRevision(value => value + 1)), []);
  useEffect(() => { setSelected(null); }, [journeyId, userId]);
  void revision;
  const markers = V3_MARKERS_PROTOTYPE_ENABLED ? listJourneyMarkers(userId, journeyId) : [];
  return <>
    <InteractiveRouteMap {...props} markers={markers} onSelectMarker={setSelected} />
    {V3_MARKERS_PROTOTYPE_ENABLED && <View style={styles.section}>
      <Text style={styles.title}>Markers · {markers.length}</Text>
      {!markers.length && <Text style={styles.body}>{MARKER_OTA_COMPAT ? 'Tap Create a marker while recording. Your saved moments appear here. Siri capture requires the next app build.' : 'While recording, say “Siri, create a marker in JourneyDeck.” Your saved moments appear here.'}</Text>}
      {markers.map((marker, index) => <Pressable key={marker.id} accessibilityRole="button" style={styles.card} onPress={() => setSelected(marker)}>
        <Text style={styles.title}>▣  Marker {index + 1} · {new Date(marker.capturedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</Text>
        <Text style={styles.body} numberOfLines={2}>{marker.notes || 'Add notes, photos or a voice memo'}</Text>
      </Pressable>)}
    </View>}
    {selected && <MarkerEditor key={`${userId}:${selected.id}`} userId={userId} marker={selected} onClose={() => setSelected(null)} />}
  </>;
}

function MarkerEditor({ userId, marker, onClose }: { userId: string; marker: JourneyMarker; onClose: () => void }) {
  const styles = useThemedStyles(baseStyles), theme = useAppTheme();
  const [notes, setNotes] = useState(marker.notes), [savedNotes, setSavedNotes] = useState(marker.notes);
  const [media, setMedia] = useState(() => listMarkerMedia(userId, marker.id));
  const [busy, setBusy] = useState(false), [voice, setVoice] = useState(false);
  const editingBlocked = Boolean(activeSession());
  const refresh = () => setMedia(listMarkerMedia(userId, marker.id));
  const perform = async (action: () => Promise<void> | void) => {
    setBusy(true);
    try { await action(); refresh(); }
    catch (error) { Alert.alert('Marker', error instanceof Error ? error.message : 'Unable to save. Please try again.'); }
    finally { setBusy(false); }
  };
  const addPhoto = () => perform(async () => {
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1, allowsMultipleSelection: false });
    if (result.canceled) return;
    const asset = result.assets[0]!;
    const image = await manipulateAsync(asset.uri, asset.width > 2048 ? [{ resize: { width: 2048 } }] : [], { compress: 0.9, format: SaveFormat.JPEG });
    try { await addMarkerMedia(userId, marker.id, 'photo', image.uri); }
    finally { await FileSystem.deleteAsync(image.uri, { idempotent: true }); }
  });
  return <NativeSheet visible kicker="JOURNEY MARKER" title="Remember this moment" onClose={onClose} busy={busy} closeDisabled={voice} dirty={notes !== savedNotes}
    footer={<Pressable accessibilityRole="button" disabled={busy || voice || editingBlocked} style={[styles.saveButton, { backgroundColor: theme.palette.accent }, (busy || voice || editingBlocked) && { opacity: 0.55 }]} onPress={() => void perform(() => { saveMarkerNotes(userId, marker.id, notes); setSavedNotes(notes); })}><Text style={[styles.title, { color: theme.palette.onAccent }]}>Save notes</Text></Pressable>}>
    <Text style={styles.body}>{new Date(marker.capturedAt).toLocaleString()}</Text>
    <Text style={styles.body}>Location accuracy: ±{Math.round(marker.accuracyMeters)} m · GPS fix {Math.max(0, Math.round((Date.parse(marker.capturedAt) - Date.parse(marker.locationAt)) / 1000))} seconds before capture</Text>
    {editingBlocked && <Text style={styles.body}>Finish your journey before adding details.</Text>}
    <TextInput accessibilityLabel="Marker notes" multiline editable={!editingBlocked && !busy && !voice} maxLength={10000} value={notes} onChangeText={setNotes}
      placeholder="What made this moment special?" placeholderTextColor={theme.palette.muted} style={styles.notes} />
    <Text accessibilityLiveRegion="polite" style={styles.body}>{notes !== savedNotes ? 'Unsaved note changes · tap Save notes.' : 'Notes saved.'} Photos save automatically when added.</Text>
    <View style={styles.row}>
      <Pressable accessibilityRole="button" disabled={editingBlocked || busy || voice} onPress={() => void addPhoto()} style={styles.card}><Text style={styles.title}>Add photo</Text></Pressable>
      <Pressable accessibilityRole="button" disabled={MARKER_OTA_COMPAT || editingBlocked || busy || voice} onPress={() => {
        if (MARKER_OTA_COMPAT) return;
        try { require('expo-audio'); setVoice(true); } catch { Alert.alert('Voice memo', 'Install the latest JourneyDeck build to record a voice memo.'); }
      }} style={styles.card}><Text style={styles.title}>{MARKER_OTA_COMPAT ? 'Voice memo · next build' : 'Record voice memo'}</Text></Pressable>
    </View>
    {voice && <MarkerVoiceRecorder userId={userId} markerId={marker.id} onDone={() => { setVoice(false); refresh(); }} />}
    {media.map(item => <View key={item.id} style={styles.card}>
      {item.kind === 'photo' ? <Image source={markerMediaUri(userId, item)} style={styles.photo} contentFit="contain" accessibilityLabel="Marker photo" /> : <MarkerVoicePlayer disabled={voice} uri={markerMediaUri(userId, item)} />}
      <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${item.kind === 'photo' ? 'photo' : 'voice memo'}`} disabled={busy || voice || editingBlocked} style={styles.action}
        onPress={() => Alert.alert('Remove attachment?', 'This removes the saved attachment from this marker.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Remove', style: 'destructive', onPress: () => void perform(() => removeMarkerMedia(userId, marker.id, item)) }])}>
        <Text style={styles.body}>Remove {item.kind === 'photo' ? 'photo' : 'voice memo'}</Text>
      </Pressable>
    </View>)}
    <Text style={styles.body}>Markers and attachments are saved on this device. They are not included in share cards or iCloud sync.</Text>
  </NativeSheet>;
}

function MarkerVoicePlayer({ uri, disabled }: { uri: string; disabled: boolean }) {
  const audio = require('expo-audio') as typeof import('expo-audio');
  const player = audio.useAudioPlayer(uri, { keepAudioSessionActive: true });
  const status = audio.useAudioPlayerStatus(player), styles = useThemedStyles(baseStyles);
  useEffect(() => { if (disabled) player.pause(); }, [disabled, player]);
  useEffect(() => { const listener = AppState.addEventListener('change', state => { if (state !== 'active') player.pause(); }); return () => listener.remove(); }, [player]);
  return <Pressable accessibilityRole="button" disabled={disabled} style={styles.action} onPress={() => {
    if (status.playing) player.pause();
    else void (async () => { await audio.setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true, shouldPlayInBackground: false }); if (status.didJustFinish || status.currentTime >= status.duration) await player.seekTo(0); player.play(); })().catch(() => Alert.alert('Voice memo', 'This audio file could not be played.'));
  }}><Text style={styles.title}>{status.playing ? 'Pause' : 'Play'} voice memo · {Math.round(status.currentTime)}s</Text></Pressable>;
}

function MarkerVoiceRecorder({ userId, markerId, onDone }: { userId: string; markerId: string; onDone: () => void }) {
  const audio = require('expo-audio') as typeof import('expo-audio');
  const recorder = audio.useAudioRecorder(audio.RecordingPresets.HIGH_QUALITY);
  const status = audio.useAudioRecorderState(recorder), styles = useThemedStyles(baseStyles);
  const [phase, setPhase] = useState<'ready' | 'starting' | 'recording' | 'saving' | 'retry'>('ready');
  const saving = useRef(false);
  const stopAndSave = async () => {
    if (saving.current) return;
    saving.current = true; setPhase('saving');
    try {
      if (recorder.isRecording) await recorder.stop();
      if (!recorder.uri) throw new Error('No voice memo was recorded. Try again.');
      await addMarkerMedia(userId, markerId, 'voice', recorder.uri);
      await FileSystem.deleteAsync(recorder.uri, { idempotent: true }).catch(() => undefined);
      onDone();
    } catch (error) { setPhase('retry'); Alert.alert('Voice memo not saved', error instanceof Error ? error.message : 'Try saving again.'); }
    finally { saving.current = false; await audio.setAudioModeAsync({ allowsRecording: false }).catch(() => undefined); }
  };
  const stopRef = useRef(stopAndSave); stopRef.current = stopAndSave;
  useEffect(() => {
    if (phase !== 'recording') return;
    const timer = setTimeout(() => void stopRef.current(), 120000);
    const listener = AppState.addEventListener('change', state => { if (state !== 'active') void stopRef.current(); });
    return () => { clearTimeout(timer); listener.remove(); };
  }, [phase]);
  useEffect(() => () => { void audio.setAudioModeAsync({ allowsRecording: false }).catch(() => undefined); }, []);
  return <View style={styles.card}>
    <Text style={styles.body}>Voice memo · {Math.round(status.durationMillis / 1000)}s · up to 2 minutes</Text>
    <Pressable accessibilityRole="button" style={styles.action} disabled={phase === 'starting' || phase === 'saving'} onPress={() => {
      if (phase !== 'ready') { void stopAndSave(); return; }
      setPhase('starting');
      void (async () => {
        if (!(await audio.requestRecordingPermissionsAsync()).granted) throw new Error('Allow microphone access in Settings to record a voice memo.');
        if (getCurrentUser().id !== userId || activeSession()) throw new Error('Finish your journey before recording a memo.');
        await audio.setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true, shouldPlayInBackground: false });
        await recorder.prepareToRecordAsync();
        if (AppState.currentState !== 'active') throw new Error('Keep JourneyDeck open to record a memo.');
        recorder.record(); setPhase('recording');
      })().catch(error => { setPhase('ready'); void audio.setAudioModeAsync({ allowsRecording: false }).catch(() => undefined); Alert.alert('Voice memo', error.message); });
    }}><Text style={styles.title}>{phase === 'ready' ? 'Start recording' : phase === 'retry' ? 'Retry saving memo' : phase === 'recording' ? 'Stop & save memo' : 'Please wait…'}</Text></Pressable>
    {(phase === 'ready' || phase === 'retry') && <Pressable accessibilityRole="button" style={styles.action} onPress={() => {
      if (phase === 'ready') { onDone(); return; }
      Alert.alert('Discard this unsaved memo?', 'Your saved marker and other attachments remain.', [{ text: 'Keep memo', style: 'cancel' }, { text: 'Discard', style: 'destructive', onPress: () => {
        void (async () => { if (recorder.uri) await FileSystem.deleteAsync(recorder.uri, { idempotent: true }); onDone(); })().catch(() => Alert.alert('Voice memo', 'Unable to discard the memo. Please try again.'));
      } }]);
    }}><Text style={styles.body}>{phase === 'retry' ? 'Discard unsaved memo' : 'Cancel'}</Text></Pressable>}
  </View>;
}

const baseStyles = StyleSheet.create({
  section: { gap: 10, marginVertical: 18 },
  card: { backgroundColor: '#101522', borderColor: '#777083', borderWidth: 1, borderRadius: 18, padding: 16, gap: 8, marginVertical: 4 },
  title: { color: '#fff6ed', fontSize: 17, fontWeight: '700' },
  body: { color: '#b9aec9', fontSize: 14, lineHeight: 21 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  notes: { color: '#fff6ed', backgroundColor: '#101522', borderWidth: 1, borderColor: '#777083', borderRadius: 16, padding: 14, minHeight: 130, textAlignVertical: 'top', fontSize: 17 },
  photo: { width: '100%', height: 240, borderRadius: 12 },
  action: { minHeight: 44, justifyContent: 'center', paddingVertical: 8 },
  saveButton: { minHeight: 58, borderRadius: 18, padding: 16, alignItems: 'center', justifyContent: 'center' },
});

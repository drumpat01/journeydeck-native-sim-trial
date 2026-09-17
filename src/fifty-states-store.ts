import { useCallback, useEffect, useState } from 'react';
import { getCurrentUser } from './auth';
import { getPrivatePreference, upsertPrivatePreference } from './local-store';
import { normalizeSeenStates, toggleSeenState, type USStateCode } from './fifty-states-model';

const PREFERENCE_KEY = 'game.fifty-states.v1';
type StoredChecklist = { seen: USStateCode[]; updatedAt: string };
type Listener = { userId: string; notify: () => void };
const listeners = new Set<Listener>();

export function loadFiftyStates(userId: string): USStateCode[] {
  return normalizeSeenStates(getPrivatePreference<StoredChecklist>(userId, PREFERENCE_KEY)?.seen);
}

export function saveFiftyStates(userId: string, seen: readonly USStateCode[]): USStateCode[] {
  const normalized = normalizeSeenStates(seen);
  upsertPrivatePreference(userId, PREFERENCE_KEY, { seen: normalized, updatedAt: new Date().toISOString() } satisfies StoredChecklist);
  for (const listener of listeners) if (listener.userId === userId) listener.notify();
  return normalized;
}

export function useFiftyStates(userId = getCurrentUser().id) {
  const [seen, setSeen] = useState<USStateCode[]>(() => loadFiftyStates(userId));
  useEffect(() => {
    const listener = { userId, notify: () => setSeen(loadFiftyStates(userId)) };
    listeners.add(listener);
    setSeen(loadFiftyStates(userId));
    return () => { listeners.delete(listener); };
  }, [userId]);
  const toggle = useCallback((code: USStateCode) => saveFiftyStates(userId, toggleSeenState(loadFiftyStates(userId), code)), [userId]);
  const reset = useCallback(() => saveFiftyStates(userId, []), [userId]);
  return { seen, toggle, reset };
}

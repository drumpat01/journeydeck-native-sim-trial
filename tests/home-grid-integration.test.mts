import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../src/', import.meta.url);
const shell = await readFile(new URL('shell.tsx', root), 'utf8');
const ipadHome = await readFile(new URL('ipad-home.tsx', root), 'utf8');
const sharedGrid = await readFile(new URL('home-widget-grid.tsx', root), 'utf8');

test('compact and regular Home use the same persisted twelve-column editor', () => {
  assert.match(shell, /useHomeWidgetLayout\('compact', Boolean\(onFiftyStates\), V3_ASK_JOURNEYDECK_ENABLED\)/);
  assert.match(ipadHome, /useHomeWidgetLayout\(layoutClass, Boolean\(onFiftyStates\), V3_ASK_JOURNEYDECK_ENABLED\)/);
  assert.match(shell, /testID="compact-home-widget-grid"/);
  assert.match(shell, /placement\.span \/ 12/);
  assert.match(sharedGrid, /HomeLayoutToolbar/);
  assert.match(sharedGrid, /Restore Default/);
});

test('Journey Library matches the compact metric widget height', () => {
  const metricHeight = shell.match(/compactHomeMetric: \{ minHeight: (\d+)/)?.[1];
  const journeyHeight = shell.match(/compactHomeJourneySummary: \{ minHeight: (\d+)/)?.[1];
  assert.ok(metricHeight && journeyHeight);
  assert.equal(journeyHeight, metricHeight);
});

test('recorder and UIKit navigation remain outside the customizable grid', () => {
  const recorder = shell.indexOf('{recorder}', shell.indexOf('function HomeScreen'));
  const grid = shell.indexOf('testID="compact-home-widget-grid"', recorder);
  assert.ok(recorder > 0 && grid > recorder);
  assert.doesNotMatch(sharedGrid, /NativeTabs|sidebarAdaptable|NativeNavigation/);
});

test('both Home layouts route their V3 question widget to the same native prompt', () => {
  for (const source of [shell, ipadHome]) {
    assert.match(source, /placement.id === 'askJourneyDeck' && V3_ASK_JOURNEYDECK_ENABLED/);
    assert.match(source, /<AskJourneyDeckWidget onPress=\{\(\) => router.push\('\/ask-journeydeck'\)\} disabled=\{editing(?:Layout)?\}/);
  }
});

test('drag commits only after successful completion and exposes equivalent VoiceOver actions', () => {
  assert.match(sharedGrid, /Gesture\.Pan\(\)/);
  assert.match(sharedGrid, /\.onEnd\(\(event, success\) => \{ if \(success\)/);
  assert.match(sharedGrid, /\.onFinalize\(\(\) =>/);
  assert.equal(sharedGrid.match(/scheduleOnRN\(commitMove/g)?.length, 1);
  for (const label of ['Move earlier', 'Move later', 'Resize', 'Show', 'Hide']) assert.match(sharedGrid, new RegExp(label));
  assert.match(sharedGrid, /ReduceMotion\.System/);
});

test('hidden widgets remain mounted so their local state survives hide and show', () => {
  assert.match(sharedGrid, /placement\.hidden && !editing && styles\.hidden/);
  assert.match(sharedGrid, /hidden: \{ display: 'none' \}/);
  assert.doesNotMatch(sharedGrid, /if \(placement\.hidden/);
});

test('Home keeps customization adjacent to a fixed recorder above movable widgets', () => {
  assert.doesNotMatch(sharedGrid, /12-column adaptive Home grid/);
  for (const source of [shell, ipadHome]) {
    assert.match(source, /testID="home-fixed-recorder"[\s\S]*?<HomeLayoutToolbar[\s\S]*?\{recorder\}[\s\S]*?<\/View>/);
  }
  assert.ok(shell.indexOf('styles.approvedHomeScenicSpace, recorderActive') < shell.indexOf('testID="home-fixed-recorder"'));
  assert.match(sharedGrid, /styles.resizeGrip, \{ \[edge\]: 0/);
});

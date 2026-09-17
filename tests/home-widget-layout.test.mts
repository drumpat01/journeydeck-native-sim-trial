import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
let stored: string | null = null;
const module = { exports: {} as any };
const source = require('node:fs').readFileSync(new URL('../src/home-widget-layout.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
vm.runInNewContext(code, { module, exports: module.exports, require: (id: string) => id === 'expo-secure-store' ? { getItem: () => stored, setItem: (_key: string, value: string) => { stored = value; } } : require(id) });
const grid = module.exports;

test('edge resizing snaps within supported spans using physical left and right edges', () => {
  assert.equal(grid.homeWidgetResizeSpan('memories', 6, 300, 100, 'right'), 8);
  assert.equal(grid.homeWidgetResizeSpan('memories', 6, 300, -100, 'left'), 8);
  assert.equal(grid.homeWidgetResizeSpan('memories', 8, 400, 100, 'left'), 6);
  assert.equal(grid.homeWidgetResizeSpan('memories', 6, 300, -900, 'right'), 6);
  assert.equal(grid.homeWidgetResizeSpan('memories', 6, 300, 900, 'right'), 12);
  assert.equal(grid.homeWidgetResizeSpan('miles', 6, 300, -100, 'right'), 4);
  assert.equal(grid.homeWidgetResizeSpan('miles', 6, 0, 100, 'right'), 6);
  assert.equal(grid.homeWidgetResizeSpan('miles', 6, 300, NaN, 'right'), 6);
  const original = grid.defaultHomeWidgetLayout('regular');
  const resized = grid.resizeHomeWidget(original, 'memories', 8);
  assert.equal(resized.find((p: any) => p.id === 'memories').span, 8);
  assert.equal(original.find((p: any) => p.id === 'memories').span, 6);
  assert.equal(grid.resizeHomeWidget(original, 'memories', 7).find((p: any) => p.id === 'memories').span, 6);
});

test('Home grid defaults use twelve columns and distinct compact and regular spans', () => {
  const regular = grid.defaultHomeWidgetLayout('regular');
  assert.equal(regular.length, 7);
  assert.deepEqual(Array.from(regular.slice(0, 4), (item: any) => item.span), [3, 3, 3, 3]);
  assert.deepEqual(Array.from(grid.defaultHomeWidgetLayout('compact').slice(0, 4), (item: any) => item.span), [6, 6, 6, 6]);
});

test('50 States joins only the V3 widget catalog and defaults to full width', () => {
  assert.equal(grid.defaultHomeWidgetLayout('compact').some((item: any) => item.id === 'fiftyStates'), false);
  const compact = grid.defaultHomeWidgetLayout('compact', true);
  const regular = grid.defaultHomeWidgetLayout('regular', true);
  assert.equal(compact.length, 8);
  assert.equal(compact.find((item: any) => item.id === 'fiftyStates').span, 12);
  assert.equal(regular.find((item: any) => item.id === 'fiftyStates').span, 12);
  const migrated = grid.normalizeHomeWidgetLayout(grid.defaultHomeWidgetLayout('compact'), 'compact', true);
  assert.equal(migrated[4].id, 'fiftyStates');
});

test('Ask widget migrates into both layouts without dropping hidden states or custom order', () => {
  for (const kind of ['compact', 'regular']) {
    const old = grid.moveHomeWidget(grid.defaultHomeWidgetLayout(kind, true), 'soundtrack', -7);
    old.find((p: any) => p.id === 'fiftyStates').hidden = true;
    const migrated = grid.normalizeHomeWidgetLayout(old, kind, true, true);
    assert.equal(migrated.length, 9);
    assert.equal(migrated[4].id, 'askJourneyDeck');
    assert.equal(migrated[4].span, 12);
    assert.equal(migrated.find((p: any) => p.id === 'fiftyStates').hidden, true);
    assert.deepEqual(Array.from(migrated.filter((p: any) => p.id !== 'askJourneyDeck'), (p: any) => p.id), Array.from(old, (p: any) => p.id));
    assert.equal(grid.normalizeHomeWidgetLayout(migrated, kind, false, false).some((p: any) => p.id === 'askJourneyDeck'), false);
  }
});

test('normalization rejects duplicates, repairs spans, and adds future widgets', () => {
  const result = grid.normalizeHomeWidgetLayout([{ id: 'journeys', span: 5, order: 99 }, { id: 'journeys', span: 12, order: 0 }, { id: 'bogus', span: 12 }], 'regular');
  assert.equal(result.find((item: any) => item.id === 'journeys').span, 6);
  assert.deepEqual(Array.from(result, (item: any) => item.order), [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(new Set(result.map((item: any) => item.id)).size, 7);
});

test('move, resize, hide and persistence remain profile-specific', () => {
  const regular = grid.defaultHomeWidgetLayout('regular');
  const moved = grid.moveHomeWidget(regular, 'soundtrack', -6);
  assert.equal(moved[0].id, 'soundtrack');
  const resized = grid.cycleHomeWidgetSpan(moved, 'soundtrack');
  assert.equal(resized[0].span, 6);
  const hidden = grid.toggleHomeWidget(resized, 'soundtrack');
  const layouts = { compact: grid.defaultHomeWidgetLayout('compact'), regular: hidden };
  grid.saveHomeWidgetLayouts(layouts);
  assert.equal(grid.loadHomeWidgetLayouts().regular[0].hidden, true);
  assert.equal(grid.loadHomeWidgetLayouts().compact[0].span, 6);
});

test('corrupted persisted JSON restores both profiles independently', () => {
  stored = '{not-json';
  const layouts = grid.loadHomeWidgetLayouts();
  assert.deepEqual(Array.from(layouts.compact.slice(0, 4), (item: any) => item.span), [6, 6, 6, 6]);
  assert.deepEqual(Array.from(layouts.regular.slice(0, 4), (item: any) => item.span), [3, 3, 3, 3]);
});

test('fold packing keeps every widget wholly inside one twelve-column pane', () => {
  const rows = grid.packHomeWidgetRows(grid.defaultHomeWidgetLayout('regular'), 2);
  assert.ok(rows.some((row: any) => row.pane === 0));
  assert.ok(rows.some((row: any) => row.pane === 1));
  for (const row of rows) {
    assert.ok(row.usedColumns <= 12);
    assert.equal(row.usedColumns, row.placements.reduce((sum: number, item: any) => sum + item.span, 0));
  }
});

test('drag snapping respects RTL and ignores interrupted or undersized movement', () => {
  assert.equal(grid.homeWidgetMoveOffset(10, 8), 0);
  assert.equal(grid.homeWidgetMoveOffset(Number.NaN, 50), 0);
  assert.equal(grid.homeWidgetMoveOffset(60, 4, false), 1);
  assert.equal(grid.homeWidgetMoveOffset(60, 4, true), -1);
  assert.equal(grid.homeWidgetMoveOffset(2, -80), -2);
});

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { Alert, I18nManager, Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Reanimated, { ReduceMotion, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { SymbolView } from 'expo-symbols';
import { useAppTheme } from './app-theme';
import { cycleHomeWidgetSpan, defaultHomeWidgetLayout, homeWidgetMoveOffset, homeWidgetResizeSpan, resizeHomeWidget, loadHomeWidgetLayouts, moveHomeWidget, saveHomeWidgetLayouts, toggleHomeWidget, type HomeLayoutClass, type HomeWidgetId, type HomeWidgetPlacement, type StoredHomeLayouts } from './home-widget-layout';

export const HOME_WIDGET_HOLD_MS = 1000;

export function useHomeWidgetLayout(layoutClass: HomeLayoutClass, includeFiftyStates = false, includeAsk = false) {
  const [layouts, setLayouts] = useState<StoredHomeLayouts>(() => loadHomeWidgetLayouts(includeFiftyStates, includeAsk));
  const placements = layouts[layoutClass];
  const update = useCallback((next: HomeWidgetPlacement[]) => {
    setLayouts(current => {
      const updated = { ...current, [layoutClass]: next };
      try { saveHomeWidgetLayouts(updated); }
      catch { Alert.alert('Layout could not be saved', 'Your current arrangement remains available until JourneyDeck closes.'); }
      return updated;
    });
  }, [layoutClass]);
  return {
    placements,
    move: (id: HomeWidgetId, offset: number) => offset && update(moveHomeWidget(placements, id, offset)),
    resize: (id: HomeWidgetId, span?: number) => update(span === undefined ? cycleHomeWidgetSpan(placements, id) : resizeHomeWidget(placements, id, span)),
    toggle: (id: HomeWidgetId) => update(toggleHomeWidget(placements, id)),
    reset: () => update(defaultHomeWidgetLayout(layoutClass, includeFiftyStates, includeAsk)),
  };
}

export function HomeLayoutToolbar({ editing, onEditing, onReset }: { editing: boolean; onEditing: (value: boolean) => void; onReset: () => void }) {
  const theme = useAppTheme();
  return <View style={styles.toolbar}>
    <Pressable accessibilityRole="button" accessibilityLabel={editing ? 'Finish editing Home layout' : 'Customize Home layout'} onPress={() => onEditing(!editing)} style={[styles.toolbarButton, { borderColor: theme.palette.line, backgroundColor: theme.palette.card }]}>
      <SymbolView name={editing ? 'checkmark' : 'slider.horizontal.3'} tintColor={theme.palette.accent} size={17} /><Text style={{ color: theme.palette.text }}>{editing ? 'Done' : 'Customize'}</Text>
    </Pressable>
    {editing && <Pressable accessibilityRole="button" accessibilityLabel="Restore default Home layout" onPress={onReset} style={[styles.toolbarButton, { borderColor: theme.palette.line }]}><Text style={{ color: theme.palette.accent }}>Restore Default</Text></Pressable>}
  </View>;
}

export function HomeGridCell({ placement, title, editing, movable = true, width, onMove, onResize, onToggle, onStartEditing, children }: {
  placement: HomeWidgetPlacement; title: string; editing: boolean; movable?: boolean; width: ViewStyle['width'];
  onMove: (offset: number) => void; onResize: (span?: number) => void; onToggle: () => void; onStartEditing: () => void; children: ReactNode;
}) {
  const theme = useAppTheme();
  const x = useSharedValue(0), y = useSharedValue(0);
  const cellWidth = useSharedValue(0);
  const commitMove = useCallback((dx: number, dy: number) => onMove(homeWidgetMoveOffset(dx, dy, I18nManager.isRTL)), [onMove]);
  const gesture = useMemo(() => {
    const pan = Gesture.Pan().enabled(movable).minDistance(8).maxPointers(1);
    if (!editing) pan.activateAfterLongPress(HOME_WIDGET_HOLD_MS);
    return pan
    .onStart(() => { scheduleOnRN(onStartEditing); })
    .onUpdate(event => { x.set(event.translationX); y.set(event.translationY); })
    .onEnd((event, success) => { if (success) scheduleOnRN(commitMove, event.translationX, event.translationY); })
    .onFinalize(() => {
      x.set(withSpring(0, { duration: 400, dampingRatio: 0.8, reduceMotion: ReduceMotion.System }));
      y.set(withSpring(0, { duration: 400, dampingRatio: 0.8, reduceMotion: ReduceMotion.System }));
    });
  }, [commitMove, editing, movable, onStartEditing, x, y]);
  const dragStyle = useAnimatedStyle(() => ({ transform: [{ translateX: x.get() }, { translateY: y.get() }], zIndex: x.get() || y.get() ? 4 : 0 }));
  const actions = editing ? [
    ...(movable ? [{ name: 'moveEarlier', label: 'Move earlier' }, { name: 'moveLater', label: 'Move later' }] : []),
    { name: 'resize', label: 'Resize' }, { name: placement.hidden ? 'show' : 'hide', label: placement.hidden ? 'Show' : 'Hide' },
  ] : [{ name: 'customize', label: 'Customize Home layout' }];
  return <GestureDetector gesture={gesture}><Reanimated.View
    testID={`home-grid-${placement.id}`}
    accessibilityRole={editing ? 'adjustable' : undefined}
    accessibilityLabel={`${title}, ${placement.span} of 12 columns${placement.hidden ? ', hidden' : ''}`}
    accessibilityActions={actions}
    accessibilityHint={editing ? 'Drag to move. Drag either edge to resize.' : 'Hold for one second to customize Home.'}
    onLayout={event => cellWidth.set(event.nativeEvent.layout.width)}
    onAccessibilityAction={event => {
      const name = event.nativeEvent.actionName;
      if (name === 'customize') onStartEditing(); else if (name === 'moveEarlier') onMove(-1); else if (name === 'moveLater') onMove(1); else if (name === 'resize') onResize(); else if (name === 'hide' || name === 'show') onToggle();
    }}
    style={[styles.cell, { width }, placement.hidden && !editing && styles.hidden, placement.hidden && editing && styles.dimmed, editing && { borderColor: theme.palette.accent }, dragStyle]}
  >
    {editing && <View style={styles.controls}>
      <Text style={[styles.span, { color: theme.palette.accent }]}>{placement.span} COL</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={`${placement.hidden ? 'Show' : 'Hide'} ${title}`} onPress={onToggle} hitSlop={6} style={styles.control}><SymbolView name={placement.hidden ? 'eye' : 'eye.slash'} tintColor={theme.palette.accent} size={17} /></Pressable>
    </View>}
    <View pointerEvents={editing ? 'none' : 'auto'}>{children}</View>
    {editing && (['left', 'right'] as const).map(edge => <ResizeEdge key={edge} edge={edge} placement={placement} cellWidth={cellWidth} parentGesture={gesture} onResize={onResize} />)}
  </Reanimated.View></GestureDetector>;
}

function ResizeEdge({ edge, placement, cellWidth, parentGesture, onResize }: {
  edge: 'left' | 'right'; placement: HomeWidgetPlacement;
  cellWidth: ReturnType<typeof useSharedValue<number>>;
  parentGesture: ReturnType<typeof Gesture.Pan>; onResize: (span?: number) => void;
}) {
  const theme = useAppTheme();
  const offset = useSharedValue(0), startWidth = useSharedValue(0);
  const commit = useCallback((dx: number, measuredWidth: number) => {
    onResize(homeWidgetResizeSpan(placement.id, placement.span, measuredWidth, dx, edge));
  }, [edge, onResize, placement.id, placement.span]);
  const gesture = useMemo(() => Gesture.Pan().minDistance(8).maxPointers(1).blocksExternalGesture(parentGesture)
    .onBegin(() => { startWidth.set(cellWidth.get()); })
    .onUpdate(event => { offset.set(event.translationX); })
    .onEnd((event, success) => { if (success) scheduleOnRN(commit, event.translationX, startWidth.get()); })
    .onFinalize(() => { offset.set(0); }), [cellWidth, commit, offset, parentGesture, startWidth]);
  const feedback = useAnimatedStyle(() => ({ transform: [{ translateX: offset.get() }] }));
  return <GestureDetector gesture={gesture}><Reanimated.View testID={`home-resize-${placement.id}-${edge}`} style={[styles.resizeEdge, { [edge]: 0 }, feedback]}>
    <View style={[styles.resizeGrip, { [edge]: 0, backgroundColor: theme.palette.accent }]} />
  </Reanimated.View></GestureDetector>;
}

const styles = StyleSheet.create({
  toolbar: { minHeight: 44, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-end', gap: 10 },
  toolbarLabel: { flex: 1, minWidth: 150, fontSize: 12 },
  toolbarButton: { minHeight: 44, borderWidth: 1, borderRadius: 14, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  cell: { padding: 6, flexGrow: 0, flexShrink: 0, borderRadius: 26, borderWidth: 1, borderColor: 'transparent', borderStyle: 'dashed' },
  hidden: { display: 'none' }, dimmed: { opacity: 0.42 },
  controls: { height: 34, flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 6 },
  span: { fontSize: 11, fontWeight: '800', letterSpacing: 0.8, marginRight: 'auto' },
  control: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  resizeEdge: { position: 'absolute', top: 38, bottom: 0, width: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center', zIndex: 5 },
  resizeGrip: { position: 'absolute', width: 4, height: 28, borderRadius: 2 },
});

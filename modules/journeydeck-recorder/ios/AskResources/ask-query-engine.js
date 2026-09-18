/* Versioned, bounded, read-only query plans. Shared by JavaScriptCore and Node.
 * Model output is untrusted input. No SQL, code evaluation, model prose or I/O here.
 */
(function (root) {
  'use strict';
  const DAY = 86400000;
  const choices = {
    decision: ['answer', 'clarify', 'unsupported'],
    domain: ['journeys', 'music', 'memories', 'markers', 'places'],
    operation: ['total', 'average', 'latest', 'first', 'largest', 'smallest', 'list', 'rank', 'compare'],
    metric: ['count', 'miles', 'minutes', 'songPlays', 'photos', 'voiceMemos'],
    period: ['available', 'allTime', 'today', 'yesterday', 'thisWeek', 'lastWeek', 'thisMonth', 'lastMonth', 'thisYear', 'lastYear', 'lastDays', 'date', 'between'],
    groupBy: ['none', 'day', 'month', 'year', 'artist', 'track', 'album', 'place'],
    dayType: ['all', 'weekday', 'weekend'],
    timeOfDay: ['all', 'day', 'night'],
    selection: ['history', 'previous'],
  };
  const defaults = { version: 1, decision: 'answer', domain: 'journeys', operation: 'total', metric: 'count',
    period: 'available', days: 0, startDate: '', endDate: '', comparePeriod: 'none', groupBy: 'none',
    dayType: 'all', timeOfDay: 'all', artist: '', track: '', album: '', place: '', minMiles: 0, maxMiles: 0,
    selection: 'history', limit: 5 };
  const date = ms => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const reply = (status, text) => ({ status, text, evidence: [], context: null });
  const clarify = () => reply('clarify', 'Please ask one specific question about saved journeys, recorded music, Memories, markers, or recorded arrivals. Include the period and what you want to count, find, or compare.');
  const unavailable = () => reply('unavailable', 'Some local history could not be read completely. Open JourneyDeck and try again.');
  const finite = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  const textFilter = s => typeof s === 'string' && s.length <= 160 && !/[\x00-\x1f]/.test(s);
  function validate(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    if (Object.keys(raw).some(k => !Object.prototype.hasOwnProperty.call(defaults, k))) return null;
    const p = Object.assign({}, defaults, raw);
    if (p.version !== 1 || Object.entries(choices).some(([k, values]) => !values.includes(p[k]))) return null;
    if (!['none', 'today', 'yesterday', 'thisWeek', 'lastWeek', 'thisMonth', 'lastMonth', 'thisYear', 'lastYear'].includes(p.comparePeriod)) return null;
    if (!Number.isInteger(p.days) || p.days < 0 || p.days > 999 || !Number.isInteger(p.limit) || p.limit < 1 || p.limit > 20) return null;
    if (!['artist', 'track', 'album', 'place', 'startDate', 'endDate'].every(k => textFilter(p[k]))) return null;
    if (!finite(p.minMiles) || !finite(p.maxMiles) || p.minMiles > 100000 || p.maxMiles > 100000 || (p.maxMiles && p.maxMiles < p.minMiles)) return null;
    if ((p.operation === 'compare') !== (p.comparePeriod !== 'none')) return null;
    if ((p.operation === 'rank') !== (p.groupBy !== 'none')) return null;
    const metrics = { journeys: ['count', 'miles', 'minutes', 'songPlays'], music: ['count'],
      memories: ['count', 'photos'], markers: ['count', 'photos', 'voiceMemos'], places: ['count'] };
    if (!metrics[p.domain].includes(p.metric)) return null;
    if (['largest', 'smallest', 'average'].includes(p.operation) && p.metric === 'count') return null;
    if (['artist', 'track', 'album'].includes(p.groupBy) && p.domain !== 'music') return null;
    if (p.groupBy === 'place' && p.domain !== 'places') return null;
    if (p.operation === 'rank' && p.selection === 'previous') return null;
    if ((p.period === 'lastDays') !== (p.days > 0)) return null;
    if (p.period !== 'date' && p.period !== 'between' && (p.startDate || p.endDate)) return null;
    if (p.period === 'date' && p.endDate) return null;
    if (p.domain === 'memories' && (p.dayType !== 'all' || p.timeOfDay !== 'all' || p.minMiles || p.maxMiles || p.place || p.artist || p.track || p.album)) return null;
    return p;
  }
  function localDate(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m || +m[1] < 1970 || +m[1] > 2100) return null;
    const d = new Date(+m[1], +m[2] - 1, +m[3]);
    return d.getFullYear() === +m[1] && d.getMonth() === +m[2] - 1 && d.getDate() === +m[3] ? d : null;
  }
  function range(p, input, override) {
    const now = input.now, d = new Date(now), today = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const y = d.getFullYear(), m = d.getMonth(), day = today.getDate();
    const week = new Date(y, m, day - (today.getDay() + 6) % 7);
    const key = override || p.period;
    const choices = {
      available: [input.cutoff, now + 1, 'in your available history'],
      allTime: [0, now + 1, 'across all time'],
      today: [+today, +new Date(y, m, day + 1), 'today'],
      yesterday: [+new Date(y, m, day - 1), +today, 'yesterday'],
      thisWeek: [+week, now + 1, 'this week'],
      lastWeek: [+new Date(week.getFullYear(), week.getMonth(), week.getDate() - 7), +week, 'last week'],
      thisMonth: [+new Date(y, m, 1), now + 1, 'this month'],
      lastMonth: [+new Date(y, m - 1, 1), +new Date(y, m, 1), 'last month'],
      thisYear: [+new Date(y, 0, 1), now + 1, 'this year'],
      lastYear: [+new Date(y - 1, 0, 1), +new Date(y, 0, 1), 'last year'],
      lastDays: [now - p.days * DAY, now + 1, 'in the last ' + p.days + ' days'],
    };
    if (choices[key]) return { start: choices[key][0], end: choices[key][1], label: choices[key][2] };
    const start = localDate(p.startDate), end = localDate(p.endDate || p.startDate);
    if (!start || !end || end < start) return null;
    return { start: +start, end: +new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1),
      label: key === 'date' ? 'on ' + date(+start) : 'from ' + date(+start) + ' through ' + date(+end) };
  }
  function safeText(value, input, fallback) {
    if (!textFilter(value) || !value.trim() || /https?:|file:|@|\d{1,3}\.\d{3,}|\d+\s+\S+\s+(?:street|st|road|rd|avenue|ave|lane|ln|drive|dr|court|ct|way)\b/i.test(value)) return fallback;
    if ((input.sensitiveLabels || []).some(l => l.label && value.toLowerCase().includes(l.label.toLowerCase()))) return fallback;
    return value.trim();
  }
  const includes = (a, b) => !b || (typeof a === 'string' && a.toLowerCase().includes(b.toLowerCase()));
  function execute(raw, input, previous) {
    const p = validate(raw);
    if (!p || p.decision !== 'answer') return clarify();
    if (!input || !finite(input.now) || !finite(input.cutoff)) return unavailable();
    const required = ['journeys', 'music', 'memories', 'markers', 'places', 'memoryJourneys', 'sensitiveLabels'];
    if (required.some(k => !Array.isArray(input[k]) || input[k].length > 20000)) return unavailable();
    const r = range(p, input), comparison = p.operation === 'compare' ? range(p, input, p.comparePeriod) : null;
    if (!r || (p.operation === 'compare' && !comparison) || r.start > input.now || (comparison && comparison.start > input.now)) return clarify();
    if ([r, comparison].filter(Boolean).some(v => v.start < input.cutoff)) return reply('historyLimited', 'That period includes history outside your current access. Choose a later period.');
    if (input.journeys.some(j => !finite(j.miles) || !finite(j.minutes) || !Number.isFinite(Date.parse(j.startedAt)))) return unavailable();
    const old = previous && [1, 2].includes(previous.version) && previous.expiresAt > input.now ? previous : null;
    if (p.selection === 'previous' && (!old || !old.journeyIds || !old.journeyIds.length)) return reply('clarify', 'First find a specific journey, then ask about that journey.');
    const selected = p.selection === 'previous' ? new Set(old.journeyIds) : null;
    const musicMatches = m => includes(m.artist, p.artist) && includes(m.track, p.track) && includes(m.album, p.album);
    const matchesMusic = new Set(input.music.filter(musicMatches).map(m => m.journeyId));
    const placeMatches = new Set(input.places.filter(l => l.kind === 'geocoded' && safeText(l.label, input, '') && includes(l.label, p.place)).map(l => l.id));
    // Private saved locations may be selected by category, never by their labels.
    if (p.place && /^(home|work)$/i.test(p.place)) for (const l of input.places) if (l.kind === p.place.toLowerCase()) placeMatches.add(l.id);
    const journeyFilter = j => {
      const d = new Date(j.startedAt), weekend = [0, 6].includes(d.getDay()), night = d.getHours() < 6 || d.getHours() >= 18;
      return (!selected || selected.has(j.id)) && (p.dayType === 'all' || weekend === (p.dayType === 'weekend'))
        && (p.timeOfDay === 'all' || night === (p.timeOfDay === 'night')) && j.miles >= p.minMiles && (!p.maxMiles || j.miles <= p.maxMiles)
        && (!(p.artist || p.track || p.album) || matchesMusic.has(j.id)) && (!p.place || placeMatches.has(j.startPlaceId) || placeMatches.has(j.endPlaceId));
    };
    const validJourneys = input.journeys.filter(journeyFilter), ids = new Set(validJourneys.map(j => j.id));
    const songCounts = new Map();
    for (const m of input.music) songCounts.set(m.journeyId, (songCounts.get(m.journeyId) || 0) + 1);
    function rowsFor(period) {
      const inside = s => { const ms = Date.parse(s); return Number.isFinite(ms) && ms >= period.start && ms < period.end && ms <= input.now; };
      if (p.domain === 'journeys') return validJourneys.filter(j => inside(j.startedAt)).map(j => ({ ...j, at: j.startedAt, journeyId: j.id, songPlays: songCounts.get(j.id) || 0 }));
      if (p.domain === 'music') return input.music.filter(m => ids.has(m.journeyId) && inside(m.playedAt) && musicMatches(m)).map(m => ({ ...m, at: m.playedAt }));
      if (p.domain === 'markers') return input.markers.filter(m => ids.has(m.journeyId) && inside(m.capturedAt)).map(m => ({ ...m, at: m.capturedAt }));
      if (p.domain === 'memories') {
        const linked = new Set(input.memoryJourneys.filter(m => ids.has(m.journeyId)).map(m => m.memoryId));
        return input.memories.filter(m => inside(m.createdAt) && (!selected || linked.has(m.id))).map(m => ({ ...m, at: m.createdAt }));
      }
      const places = new Map(input.places.map(l => [l.id, l]));
      return validJourneys.filter(j => inside(j.endedAt) && places.has(j.endPlaceId) && (!p.place || placeMatches.has(j.endPlaceId)))
        .map(j => ({ id: j.id, journeyId: j.id, at: j.endedAt, place: places.get(j.endPlaceId) }));
    }
    const rows = rowsFor(r), unit = { count: p.domain === 'music' ? 'recorded song plays' : p.domain === 'places' ? 'recorded arrivals' : p.domain,
      miles: 'miles', minutes: 'minutes', songPlays: 'recorded song plays', photos: 'photos', voiceMemos: 'voice memos' }[p.metric];
    const value = row => p.metric === 'count' ? 1 : row[p.metric];
    const total = data => data.reduce((n, row) => n + value(row), 0);
    if (rows.some(row => !finite(value(row)))) return unavailable();
    const format = n => ['miles', 'minutes'].includes(p.metric) || p.operation === 'average' ? n.toFixed(1) : String(n);
    const ranked = [...rows].sort((a, b) => {
      if (['largest', 'smallest'].includes(p.operation)) return (value(b) - value(a)) * (p.operation === 'smallest' ? -1 : 1) || String(a.id).localeCompare(String(b.id));
      return (Date.parse(b.at) - Date.parse(a.at)) * (p.operation === 'first' ? -1 : 1) || String(a.id).localeCompare(String(b.id));
    });
    const jMap = new Map(input.journeys.map(j => [j.id, j]));
    const isSelection = ['first', 'latest', 'largest', 'smallest', 'list'].includes(p.operation);
    const selectedRows = ['first', 'latest', 'largest', 'smallest'].includes(p.operation) ? ranked.slice(0, 1) : ranked.slice(0, p.limit);
    const evidence = [], evidenceKeys = new Set();
    function add(kind, id, label) {
      if (evidence.length < 5 && !evidenceKeys.has(kind + id)) { evidence.push({ kind, id, label }); evidenceKeys.add(kind + id); }
    }
    for (const row of selectedRows) {
      if (p.domain === 'memories') add('memory', row.id, 'Memory created ' + date(Date.parse(row.at)));
      else {
        const j = jMap.get(row.journeyId);
        if (j) add('journey', j.id, 'Journey on ' + date(Date.parse(j.startedAt)) + ' · ' + j.miles.toFixed(1) + ' mi');
      }
    }
    let numeric = total(rows), text, groups = null, compared = null;
    const scope = r.label + (p.dayType === 'all' ? '' : ', ' + p.dayType + ' starts') + (p.timeOfDay === 'all' ? '' : ', ' + p.timeOfDay + ' starts')
      + ['artist', 'track', 'album', 'place'].filter(k => p[k]).map(k => ', ' + k + ' matching ' + safeText(p[k], input, 'your private filter')).join('')
      + (p.minMiles ? ', at least ' + p.minMiles + ' miles' : '') + (p.maxMiles ? ', at most ' + p.maxMiles + ' miles' : '')
      + (selected ? ', within the previously selected journeys' : '');
    if (p.operation === 'compare') {
      const other = rowsFor(comparison);
      if (other.some(row => !finite(value(row)))) return unavailable();
      compared = total(other);
      text = format(numeric) + ' ' + unit + ' ' + scope + ', compared with ' + format(compared) + ' ' + comparison.label
        + '. Difference: ' + (numeric >= compared ? '+' : '') + format(numeric - compared) + ' ' + unit + '.';
    } else if (p.operation === 'average') {
      numeric = rows.length ? numeric / rows.length : null;
      text = numeric === null ? 'No matching records ' + scope + '.' : 'Average: ' + format(numeric) + ' ' + unit + ' across ' + rows.length + ' records ' + scope + '.';
    } else if (p.operation === 'rank') {
      // A general supporting-record sample is not evidence for a winning group.
      evidence.length = 0;
      const map = new Map();
      for (const row of rows) {
        let key, label;
        if (['artist', 'track', 'album'].includes(p.groupBy)) {
          const raw = row[p.groupBy];
          if (!raw || !raw.trim()) continue;
          key = JSON.stringify([raw.trim().toLowerCase(), p.groupBy === 'track' || p.groupBy === 'album' ? (row.artist || '').trim().toLowerCase() : '']);
          label = safeText(raw, input, 'Private music metadata');
          if (p.groupBy === 'track' || p.groupBy === 'album') label += ' by ' + safeText(row.artist, input, 'Private artist');
        } else if (p.groupBy === 'place') {
          key = row.place.id;
          label = row.place.kind === 'geocoded' ? safeText(row.place.label, input, 'Private place') : 'Saved private place';
        } else {
          const d = new Date(row.at), y = String(d.getFullYear()), m = String(d.getMonth() + 1).padStart(2, '0');
          key = p.groupBy === 'year' ? y : p.groupBy === 'month' ? y + '-' + m : y + '-' + m + '-' + String(d.getDate()).padStart(2, '0');
          label = key;
        }
        const group = map.get(key) || { key, label, value: 0 };
        group.value += value(row); map.set(key, group);
      }
      const all = [...map.values()].sort((a, b) => b.value - a.value || a.key.localeCompare(b.key));
      groups = all.slice(0, p.limit).map(g => ({ label: g.label, value: g.value }));
      const tied = all.length > 1 && all[0].value === all[1].value;
      text = groups.length ? groups.map(g => g.label + ': ' + format(g.value) + ' ' + unit).join('; ') + ' ' + scope + '.' + (tied ? ' The top result is tied.' : '') : 'No matching metadata ' + scope + '.';
    } else if (['first', 'latest', 'largest', 'smallest', 'list'].includes(p.operation)) {
      numeric = selectedRows.length && p.metric !== 'count' ? value(selectedRows[0]) : rows.length;
      text = selectedRows.length ? selectedRows.map(row => {
        const name = p.domain === 'music' ? safeText(row.track, input, 'Private song') + ' by ' + safeText(row.artist, input, 'Private artist') : { journeys: 'journey', memories: 'memory', markers: 'marker', places: 'recorded arrival' }[p.domain];
        return name + ' on ' + date(Date.parse(row.at)) + (p.metric !== 'count' ? ': ' + format(value(row)) + ' ' + unit : '');
      }).join('; ') + '. ' + rows.length + ' matching records ' + scope + '.' : 'No matching records ' + scope + '.';
    } else text = format(numeric) + ' ' + unit + ' across ' + rows.length + ' matching records ' + scope + '.';
    text += ' Saved on this device only.';
    if (p.timeOfDay !== 'all') text += ' Night starts are before 6 AM or from 6 PM, using this device’s time zone.';
    const journeyIds = !isSelection ? [] : [...new Set(selectedRows.flatMap(row => p.domain === 'memories'
      ? input.memoryJourneys.filter(m => m.memoryId === row.id).map(m => m.journeyId) : [row.journeyId]).filter(id => jMap.has(id)))].slice(0, 20);
    return { status: 'answered', text, evidence, facts: { value: numeric, comparedValue: compared, recordCount: rows.length, unit, groups },
      context: { version: 2, plan: p, journeyIds, expiresAt: input.now + 300000 } };
  }
  function modelContext(previous, now) {
    if (!previous || previous.expiresAt <= now) return null;
    if (previous.version === 2) {
      const p = validate(previous.plan);
      // No record IDs, raw records or user labels go to the model.
      return p ? { plan: p, hasJourneySelection: Boolean(previous.journeyIds && previous.journeyIds.length) } : null;
    }
    if (previous.version === 1) return { metric: previous.metric, period: previous.range.label, hasJourneySelection: Boolean(previous.journeyIds && previous.journeyIds.length) };
    return null;
  }
  function entities(input) {
    if (!input || !Array.isArray(input.journeys) || !Array.isArray(input.memories)) return [];
    return [
      ...input.journeys.filter(j => finite(j.miles) && finite(j.minutes)).map(j => ({
        kind: 'journey', id: j.id, date: j.startedAt, title: 'Journey on ' + date(Date.parse(j.startedAt)),
        summary: j.miles.toFixed(1) + ' miles · ' + j.minutes.toFixed(0) + ' minutes',
      })),
      ...input.memories.map(m => ({ kind: 'memory', id: m.id, date: m.createdAt,
        title: 'Memory created ' + date(Date.parse(m.createdAt)), summary: 'Saved Memory' })),
    ].sort((a, b) => Date.parse(b.date) - Date.parse(a.date) || String(a.id).localeCompare(String(b.id))).slice(0, 500);
  }
  const api = { choices, defaults, validate, range, execute, modelContext, entities };
  if (typeof module !== 'undefined') module.exports = api;
  root.JourneyDeckQueryEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

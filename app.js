(() => {
  'use strict';

  const APP_VERSION = '3.6.3';
  const PIN_ICON = '<svg viewBox="0 0 24 24" width="20" height="20"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M12 21s-7-6.5-7-11a7 7 0 0114 0c0 4.5-7 11-7 11z"/><circle cx="12" cy="10" r="2.5" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
  const STORAGE_PREFIX = 'rkt:';
  const ORS_BASE = 'https://api.openrouteservice.org';

  const DEFAULTS = {
    trips: [],
    locations: [],
    vehicles: [],
    objekte: [],
    noteSuggestions: [
      { id: 'default-1', text: 'Wohnungsübergabe' },
      { id: 'default-2', text: 'Wohnungsbesichtigung' },
      { id: 'default-3', text: 'Ankaufs-Besichtigung' }
    ],
    routeCache: {},
    rates: [],
    immoRates: [],
    settings: { orsApiKey: '', homeLocationId: null, workLocationId: null }
  };

  const RATE_TYPE_LABELS = { pauschal: 'Pauschal', tatsaechlich: 'Tatsächliche Kosten', tabelle: 'Tabelle' };

  function loadKey(key) {
    try {
      const raw = localStorage.getItem(STORAGE_PREFIX + key);
      return raw ? JSON.parse(raw) : JSON.parse(JSON.stringify(DEFAULTS[key]));
    } catch (e) {
      return JSON.parse(JSON.stringify(DEFAULTS[key]));
    }
  }

  function saveKey(key) {
    try {
      localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(state[key]));
    } catch (e) { /* localStorage unavailable */ }
    if (!applyingRemoteUpdate && CLOUD_SYNCED_KEYS.includes(key)) pushToCloud(key);
  }

  const state = {
    trips: loadKey('trips'),
    locations: loadKey('locations'),
    vehicles: loadKey('vehicles'),
    objekte: loadKey('objekte'),
    noteSuggestions: loadKey('noteSuggestions'),
    routeCache: loadKey('routeCache'),
    rates: loadKey('rates'),
    immoRates: loadKey('immoRates'),
    settings: loadKey('settings')
  };

  function loadContext() {
    try { return localStorage.getItem(STORAGE_PREFIX + 'currentContext') || 'pendeln'; }
    catch (e) { return 'pendeln'; }
  }

  let currentView = 'new';
  let currentContext = loadContext(); // 'pendeln' | 'immobilien' — persisted locally, unlike currentView
  let editingTripId = null;
  let draft = makeEmptyDraft();
  const draftsByContext = {}; // stashes each context's in-progress new-trip draft while the other is active

  function makeEmptyDraft() {
    const now = new Date();
    now.setMinutes(Math.floor(now.getMinutes() / 5) * 5, 0, 0); // matches the 5-minute time picker steps
    // Pendeln only: prefill Start/Ziel from the "Zuhause"/"Arbeit" defaults
    // in den Einstellungen, if set and the referenced address still exists.
    const homeLoc = currentContext === 'pendeln' && state.settings.homeLocationId ? findLocation(state.settings.homeLocationId) : null;
    const workLoc = currentContext === 'pendeln' && state.settings.workLocationId ? findLocation(state.settings.workLocationId) : null;
    const d = {
      context: currentContext,
      startLocationId: homeLoc ? homeLoc.id : null,
      endLocationId: workLoc ? workLoc.id : null,
      waypoints: currentContext === 'immobilien' ? [null, null] : undefined, // Immobilien only, replaces start/end
      distanceKm: null,
      distanceStatus: (homeLoc && workLoc) ? 'pending' : 'empty', // empty | pending | ok
      distanceError: null,
      startDateTime: toDatetimeLocalValue(now),
      endDateTime: '',
      vehiclePlate: '',
      objektKuerzel: '',
      note: '',
      ratePerKm: null,
      rateSource: 'auto', // auto | manual
      rateType: null, // Immobilien only: pauschal | tatsaechlich | tabelle
      cost: null
    };
    computeCost(d);
    if (homeLoc && workLoc) {
      calcDistance(d).then(() => { if (d === draft) render(); });
    }
    return d;
  }

  function setContext(ctx) {
    if (ctx === currentContext) return;
    const proceed = () => {
      // Keep whatever's been typed into an unsaved new-trip draft so it's
      // still there when the user switches back — only a discarded edit
      // (handled below, before editingTripId is cleared) isn't kept.
      if (!editingTripId) draftsByContext[currentContext] = draft;
      currentContext = ctx;
      try { localStorage.setItem(STORAGE_PREFIX + 'currentContext', ctx); } catch (e) { /* localStorage unavailable */ }
      document.body.dataset.context = ctx;
      editingTripId = null;
      draft = draftsByContext[ctx] || makeEmptyDraft();
      const root = document.getElementById('view-root');
      root.classList.remove('context-transition');
      void root.offsetWidth; // restart the CSS animation
      root.classList.add('context-transition');
      render();
    };
    if (editingTripId) {
      confirmDialog('Bearbeitung abbrechen? Ungespeicherte Änderungen gehen verloren.', 'Verwerfen').then((ok) => { if (ok) proceed(); });
    } else {
      proceed();
    }
  }

  function uid() {
    return (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('id-' + Date.now() + '-' + Math.random().toString(16).slice(2));
  }

  function nowIso() { return new Date().toISOString(); }

  function pad(n) { return String(n).padStart(2, '0'); }

  function toDatetimeLocalValue(date) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function formatDateTime(value) {
    if (!value) return '';
    const d = new Date(value);
    if (isNaN(d)) return value;
    return d.toLocaleString('de-CH', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  // Pure display helper — Tage/Std/Min zwischen Start und Rückkehr, '' wenn
  // eine Zeit fehlt oder die Rückkehr nicht nach dem Start liegt.
  function formatDuration(startIso, endIso) {
    if (!startIso || !endIso) return '';
    const start = new Date(startIso);
    const end = new Date(endIso);
    if (isNaN(start) || isNaN(end)) return '';
    let mins = Math.round((end - start) / 60000);
    if (mins <= 0) return '';
    const days = Math.floor(mins / 1440);
    mins -= days * 1440;
    const hours = Math.floor(mins / 60);
    mins -= hours * 60;
    const parts = [];
    if (days) parts.push(`${days} Tag${days === 1 ? '' : 'e'}`);
    if (hours) parts.push(`${hours} Std`);
    if (mins || !parts.length) parts.push(`${mins} Min`);
    return parts.join(' ');
  }

  function formatEuro(amount) {
    if (amount == null || isNaN(amount)) return '';
    return amount.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
  }

  function formatEuroPerKm(amount) {
    if (amount == null || isNaN(amount)) return '';
    return `${amount.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €/km`;
  }

  function formatDateOnly(dayStr) {
    if (!dayStr) return '';
    const [y, m, d] = dayStr.split('-');
    return `${d}.${m}.${y}`;
  }

  function splitDateTime(v) {
    if (!v) return { date: '', time: '' };
    const [date, time] = v.split('T');
    return { date: date || '', time: time || '' };
  }

  function combineDateTime(date, time) {
    if (!date) return '';
    return `${date}T${time || '00:00'}`;
  }

  function describeGeocodeError(e) {
    if (e && e.message === 'Quota exceeded') return 'Tageskontingent der Adress-Suche erschöpft — bitte später erneut versuchen oder unten manuell eingeben.';
    if (e && e.message === 'no-key') return 'Kein API-Key hinterlegt — bitte unten manuell eingeben.';
    return 'Live-Suche momentan nicht verfügbar — bitte unten manuell eingeben.';
  }

  function buildAddressFromParts(street, housenumber, ortLabel) {
    const streetPart = [street, housenumber].filter(s => s && s.trim()).join(' ');
    return [streetPart, ortLabel].filter(s => s && s.trim()).join(', ');
  }

  // Wires a text input to a live-search dropdown. `layers`/`getFocus`/`getBoundary`
  // shape the geocode/autocomplete request; `onSelect(result)` fires on pick.
  // Best-effort, silent-fail location bias so short place queries (e.g. "Zü") rank
  // the geographically nearby match first instead of an arbitrary global one.
  let ambientFocus = null;
  function requestAmbientFocus() {
    if (ambientFocus || !navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => { ambientFocus = { lat: pos.coords.latitude, lon: pos.coords.longitude }; },
      () => { /* denied/unavailable: searches simply stay unbiased */ },
      { maximumAge: 10 * 60 * 1000, timeout: 5000 }
    );
  }

  function attachAutocomplete(inputEl, listEl, { layers, getFocus, getBoundary, getBoundaryGid, dedupeKey, renderLabel, onSelect }) {
    let debounceTimer = null;
    let requestToken = 0;
    inputEl.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      const query = inputEl.value.trim();
      if (query.length < 2) { listEl.innerHTML = ''; listEl.hidden = true; return; }
      debounceTimer = setTimeout(async () => {
        const myToken = ++requestToken;
        let results;
        try {
          const focus = getFocus ? getFocus() : null;
          const boundary = getBoundary ? getBoundary() : null;
          const boundaryGid = getBoundaryGid ? getBoundaryGid() : null;
          results = await geocodeAutocomplete(query, {
            layers,
            focusLat: focus ? focus.lat : null, focusLon: focus ? focus.lon : null,
            boundaryGid,
            boundaryLat: boundaryGid ? null : (boundary ? boundary.lat : null),
            boundaryLon: boundaryGid ? null : (boundary ? boundary.lon : null),
            boundaryRadiusKm: boundary ? boundary.radiusKm : null
          });
        } catch (e) {
          if (myToken === requestToken) listEl.hidden = true;
          return;
        }
        if (myToken !== requestToken) return; // a newer keystroke already superseded this
        if (dedupeKey) {
          const seen = new Set();
          results = results.filter(r => {
            const k = dedupeKey(r);
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
          });
        }
        if (!results.length) {
          listEl.innerHTML = state.settings.orsApiKey ? `<div class="hint" style="padding:8px 4px;">Keine Treffer</div>` : `<div class="hint" style="padding:8px 4px;">Kein API-Key hinterlegt — Adresse manuell eingeben</div>`;
          listEl.hidden = false;
          return;
        }
        listEl.innerHTML = results.map((r, i) => `<button type="button" class="sheet-item" data-idx="${i}">${escapeHtml(renderLabel ? renderLabel(r) : r.label)}</button>`).join('');
        listEl.hidden = false;
        listEl.querySelectorAll('[data-idx]').forEach(btn => {
          btn.addEventListener('click', () => {
            onSelect(results[Number(btn.getAttribute('data-idx'))]);
            listEl.innerHTML = '';
            listEl.hidden = true;
          });
        });
      }, 350);
    });
  }

  function todayDateStr() {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------- Toast ----------
  let toastTimer = null;
  function toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
  }

  // Full-screen double-flicker, e.g. as "cleared" feedback that needs no
  // confirmation and no dismissal. A short delay before it starts makes it
  // read as "this was processed" rather than an instant button reaction.
  let flashTimer = null;
  function flashScreen() {
    const el = document.getElementById('flash-overlay');
    if (!el) return;
    clearTimeout(flashTimer);
    el.classList.remove('flash');
    el.hidden = true;
    flashTimer = setTimeout(() => {
      el.hidden = false;
      void el.offsetWidth; // ensure the animation (re)starts cleanly
      el.classList.add('flash');
      el.addEventListener('animationend', () => {
        el.hidden = true;
        el.classList.remove('flash');
      }, { once: true });
    }, 160);
  }

  // ---------- Offline badge ----------
  function updateOnlineBadge() {
    document.getElementById('offline-badge').hidden = navigator.onLine;
  }
  window.addEventListener('online', () => { updateOnlineBadge(); retryAllPending(); });
  window.addEventListener('offline', updateOnlineBadge);

  // ---------- Locations / vehicles lookup ----------
  function findLocation(id) { return state.locations.find(l => l.id === id); }
  // Locations saved before the verified flag existed have verified===undefined.
  // Heuristic for those legacy entries: a real autocomplete/GPS pick always
  // produces a comma-separated "street, place" or Pelias "place, country"
  // label; a bare word (like a hand-typed "Rotenburg") never does.
  function isUnverifiedLocation(loc) {
    if (loc.verified === true) return false;
    if (loc.verified === false) return true;
    return !loc.address.includes(',');
  }

  function locationLabelHtml(id) {
    const loc = findLocation(id);
    return loc ? escapeHtml(loc.label) : '<span class="warn-text">gelöschter Ort</span>';
  }

  // Generalizes over Pendeln's fixed start/end pair and Immobilien's
  // variable-length waypoints list (falling back to start/end for legacy
  // Immobilien trips saved before waypoints existed).
  function tripLocationIds(trip) {
    if (trip.context === 'immobilien' && Array.isArray(trip.waypoints) && trip.waypoints.length) return trip.waypoints;
    return [trip.startLocationId, trip.endLocationId];
  }

  function sortedByRecency(list) {
    return [...list].sort((a, b) => (b.lastUsedAt || '').localeCompare(a.lastUsedAt || ''));
  }

  function bumpUsage(startLoc, endLoc, vehicle) {
    const t = nowIso();
    if (startLoc) { startLoc.usageCount = (startLoc.usageCount || 0) + 1; startLoc.lastUsedAt = t; }
    if (endLoc) { endLoc.usageCount = (endLoc.usageCount || 0) + 1; endLoc.lastUsedAt = t; }
    if (vehicle) { vehicle.usageCount = (vehicle.usageCount || 0) + 1; vehicle.lastUsedAt = t; }
    saveKey('locations');
    saveKey('vehicles');
  }

  function bumpObjektUsage(kuerzel) {
    const obj = state.objekte.find(o => o.kuerzel === kuerzel);
    if (!obj) return;
    obj.usageCount = (obj.usageCount || 0) + 1;
    obj.lastUsedAt = nowIso();
    saveKey('objekte');
  }

  function bumpWaypointUsage(waypoints) {
    const t = nowIso();
    let changed = false;
    for (const locId of waypoints) {
      const loc = findLocation(locId);
      if (loc) { loc.usageCount = (loc.usageCount || 0) + 1; loc.lastUsedAt = t; changed = true; }
    }
    if (changed) saveKey('locations');
  }

  // ---------- Kilometersatz / Kosten ----------
  function findApplicableRate(dateTimeStr, ratesArray = state.rates) {
    const day = (dateTimeStr || '').slice(0, 10);
    if (!day) return null;
    const sorted = [...ratesArray].sort((a, b) => a.validFrom.localeCompare(b.validFrom));
    let applicable = null;
    for (const r of sorted) {
      if (r.validFrom <= day) applicable = r; else break;
    }
    return applicable;
  }

  // Mutates `entry` (a trip or the draft): resolves ratePerKm (unless manually overridden)
  // and (re)computes cost from the current distanceKm. Safe to call any time. Pendeln and
  // Immobilien keep separate, independent rate histories (state.rates / state.immoRates).
  function computeCost(entry) {
    const isImmo = entry.context === 'immobilien';
    const ratesArray = isImmo ? state.immoRates : state.rates;
    if (entry.rateSource !== 'manual') {
      const r = findApplicableRate(entry.startDateTime, ratesArray);
      entry.ratePerKm = r ? r.amount : null;
      entry.rateSource = 'auto';
      if (isImmo) entry.rateType = r ? r.rateType : null;
    }
    if (entry.distanceStatus === 'ok' && entry.distanceKm != null && entry.ratePerKm != null) {
      entry.cost = Math.round(entry.distanceKm * entry.ratePerKm * 100) / 100;
    } else {
      entry.cost = null;
    }
  }

  // Trips whose auto-resolved rate changes because of `rate` (already inserted into ratesArray).
  function affectedTripsForRate(rate, ratesArray, context) {
    const sorted = [...ratesArray].sort((a, b) => a.validFrom.localeCompare(b.validFrom));
    const idx = sorted.findIndex(r => r.id === rate.id);
    const windowStart = rate.validFrom;
    const windowEnd = sorted[idx + 1] ? sorted[idx + 1].validFrom : null;
    return state.trips.filter(t => {
      if ((t.context || 'pendeln') !== context) return false;
      if (t.rateSource === 'manual') return false; // missing rateSource (older trips) counts as auto
      const day = (t.startDateTime || '').slice(0, 10);
      if (!day || day < windowStart) return false;
      if (windowEnd && day >= windowEnd) return false;
      return t.ratePerKm !== rate.amount;
    });
  }

  async function addRate() {
    const dateVal = document.getElementById('new-rate-date').value;
    const amountVal = parseFloat(document.getElementById('new-rate-amount').value.replace(',', '.'));
    if (!dateVal || isNaN(amountVal) || amountVal <= 0) {
      toast('Bitte gültiges Datum und Betrag angeben');
      return;
    }
    const existingIdx = state.rates.findIndex(r => r.validFrom === dateVal);
    const rate = { id: existingIdx >= 0 ? state.rates[existingIdx].id : uid(), validFrom: dateVal, amount: amountVal };
    if (existingIdx >= 0) state.rates[existingIdx] = rate; else state.rates.push(rate);
    saveKey('rates');

    const affected = affectedTripsForRate(rate, state.rates, 'pendeln');
    if (affected.length) {
      const n = affected.length;
      const msg = `${n} bereits erfasste ${n === 1 ? 'Fahrt fällt' : 'Fahrten fallen'} in den Zeitraum ab ${formatDateOnly(dateVal)}. Auf ${formatEuroPerKm(amountVal)} aktualisieren?`;
      const ok = await confirmDialog(msg, 'Aktualisieren');
      for (const t of affected) {
        if (ok) {
          computeCost(t); // auto: re-resolves and picks up the new rate
        } else {
          t.rateSource = 'manual'; // pin at the previous rate, don't let future changes touch it
        }
      }
      saveKey('trips');
    }
    toast('Pendlerpauschale gespeichert');
    render();
  }

  async function deleteRate(id) {
    const ok = await confirmDialog('Diese Pendlerpauschale löschen?');
    if (!ok) return;
    state.rates = state.rates.filter(r => r.id !== id);
    saveKey('rates');
    for (const t of state.trips) {
      if ((t.context || 'pendeln') === 'pendeln' && t.rateSource === 'auto') computeCost(t);
    }
    saveKey('trips');
    render();
  }

  async function addImmoRate() {
    const dateVal = document.getElementById('new-immo-rate-date').value;
    const amountVal = parseFloat(document.getElementById('new-immo-rate-amount').value.replace(',', '.'));
    const rateType = document.getElementById('new-immo-rate-type').value;
    if (!dateVal || isNaN(amountVal) || amountVal <= 0) {
      toast('Bitte gültiges Datum und Betrag angeben');
      return;
    }
    const existingIdx = state.immoRates.findIndex(r => r.validFrom === dateVal);
    const rate = { id: existingIdx >= 0 ? state.immoRates[existingIdx].id : uid(), validFrom: dateVal, amount: amountVal, rateType };
    if (existingIdx >= 0) state.immoRates[existingIdx] = rate; else state.immoRates.push(rate);
    saveKey('immoRates');

    const affected = affectedTripsForRate(rate, state.immoRates, 'immobilien');
    if (affected.length) {
      const n = affected.length;
      const msg = `${n} bereits erfasste ${n === 1 ? 'Fahrt fällt' : 'Fahrten fallen'} in den Zeitraum ab ${formatDateOnly(dateVal)}. Auf ${formatEuroPerKm(amountVal)} aktualisieren?`;
      const ok = await confirmDialog(msg, 'Aktualisieren');
      for (const t of affected) {
        if (ok) {
          computeCost(t);
        } else {
          t.rateSource = 'manual';
        }
      }
      saveKey('trips');
    }
    toast('Kilometersatz gespeichert');
    render();
  }

  async function deleteImmoRate(id) {
    const ok = await confirmDialog('Diesen Kilometersatz löschen?');
    if (!ok) return;
    state.immoRates = state.immoRates.filter(r => r.id !== id);
    saveKey('immoRates');
    for (const t of state.trips) {
      if ((t.context || 'pendeln') === 'immobilien' && t.rateSource === 'auto') computeCost(t);
    }
    saveKey('trips');
    render();
  }

  // ---------- Routing (OpenRouteService) ----------
  function routeKey(startId, endId) { return startId + '->' + endId; }

  async function geocodeAddress(address) {
    const key = state.settings.orsApiKey;
    if (!key) { const e = new Error('no-key'); throw e; }
    const url = `${ORS_BASE}/geocode/search?api_key=${encodeURIComponent(key)}&text=${encodeURIComponent(address)}&size=1`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('geocode-failed');
    const data = await res.json();
    const feat = data.features && data.features[0];
    if (!feat) throw new Error('geocode-empty');
    const [lon, lat] = feat.geometry.coordinates;
    return { lat, lon, label: feat.properties.label };
  }

  async function fetchRouteKm(startCoord, endCoord) {
    const key = state.settings.orsApiKey;
    if (!key) { const e = new Error('no-key'); throw e; }
    const url = `${ORS_BASE}/v2/directions/driving-car?api_key=${encodeURIComponent(key)}&start=${startCoord.lon},${startCoord.lat}&end=${endCoord.lon},${endCoord.lat}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('directions-failed');
    const data = await res.json();
    const feat = data.features && data.features[0];
    if (!feat) throw new Error('directions-empty');
    const meters = feat.properties.summary.distance;
    return Math.round((meters / 1000) * 10) / 10;
  }

  // Session-lifetime cache: identical autocomplete requests (same text, same
  // stage/scope) are common while typing, backspacing and retyping, or during
  // testing - avoid re-spending quota on a query already answered.
  const autocompleteCache = new Map();

  async function geocodeAutocomplete(text, opts = {}) {
    const key = state.settings.orsApiKey;
    if (!key || !text || text.trim().length < 2) return [];
    const params = new URLSearchParams({ api_key: key, text: text.trim(), size: String(opts.size || 6) });
    if (opts.layers) params.set('layers', opts.layers);
    if (opts.focusLat != null) {
      params.set('focus.point.lat', opts.focusLat);
      params.set('focus.point.lon', opts.focusLon);
    }
    if (opts.boundaryGid) {
      params.set('boundary.gid', opts.boundaryGid);
    } else if (opts.boundaryLat != null) {
      params.set('boundary.circle.lat', opts.boundaryLat);
      params.set('boundary.circle.lon', opts.boundaryLon);
      params.set('boundary.circle.radius', String(opts.boundaryRadiusKm || 20));
    }
    if (opts.boundaryCountry) params.set('boundary.country', opts.boundaryCountry);
    const cacheKey = params.toString();
    if (autocompleteCache.has(cacheKey)) return autocompleteCache.get(cacheKey);
    const res = await fetch(`${ORS_BASE}/geocode/autocomplete?${params.toString()}`);
    if (!res.ok) {
      let msg = 'autocomplete-failed';
      try { const errBody = await res.json(); if (errBody && errBody.error) msg = errBody.error; } catch (e2) { /* keep generic message */ }
      throw new Error(msg);
    }
    const data = await res.json();
    const results = (data.features || []).map(f => ({
      label: f.properties.label,
      lat: f.geometry.coordinates[1],
      lon: f.geometry.coordinates[0],
      layer: f.properties.layer,
      gid: f.properties.gid,
      street: f.properties.street || '',
      housenumber: f.properties.housenumber || ''
    }));
    autocompleteCache.set(cacheKey, results);
    return results;
  }

  async function geocodeReverse(lat, lon) {
    const key = state.settings.orsApiKey;
    if (!key) { const e = new Error('no-key'); throw e; }
    const params = new URLSearchParams({ api_key: key, 'point.lat': lat, 'point.lon': lon, size: '1' });
    const res = await fetch(`${ORS_BASE}/geocode/reverse?${params.toString()}`);
    if (!res.ok) throw new Error('reverse-failed');
    const data = await res.json();
    const feat = data.features && data.features[0];
    if (!feat) throw new Error('reverse-empty');
    const p = feat.properties;
    return {
      label: p.label,
      street: p.street || '',
      housenumber: p.housenumber || '',
      postalcode: p.postalcode || '',
      locality: p.locality || p.county || p.region || '',
      lat: feat.geometry.coordinates[1],
      lon: feat.geometry.coordinates[0]
    };
  }

  async function ensureLocationGeocoded(loc) {
    if (loc.lat != null && loc.lon != null) return loc;
    const coords = await geocodeAddress(loc.address);
    loc.lat = coords.lat;
    loc.lon = coords.lon;
    loc.resolvedLabel = coords.label;
    saveKey('locations');
    return loc;
  }

  // Mutates `entry` (a trip or the draft) in place. Caller persists if needed.
  async function calcDistance(entry) {
    const start = findLocation(entry.startLocationId);
    const end = findLocation(entry.endLocationId);
    if (!start || !end) {
      entry.distanceStatus = 'empty';
      entry.distanceKm = null;
      entry.distanceError = null;
      computeCost(entry);
      return;
    }
    const key = routeKey(entry.startLocationId, entry.endLocationId);
    const cached = state.routeCache[key];
    if (cached) {
      entry.distanceKm = cached.km;
      entry.distanceStatus = 'ok';
      entry.distanceError = null;
      computeCost(entry);
      return;
    }
    entry.distanceStatus = 'pending';
    entry.distanceError = null;
    try {
      await ensureLocationGeocoded(start);
      await ensureLocationGeocoded(end);
      const km = await fetchRouteKm(start, end);
      state.routeCache[key] = { km, calculatedAt: nowIso() };
      saveKey('routeCache');
      entry.distanceKm = km;
      entry.distanceStatus = 'ok';
      entry.distanceError = null;
    } catch (e) {
      entry.distanceStatus = 'pending';
      entry.distanceKm = null;
      entry.distanceError = (e && e.message === 'no-key') ? 'Kein API-Key hinterlegt' : 'Distanz konnte nicht berechnet werden';
    }
    computeCost(entry);
  }

  // Single ORS call for all legs of a route at once (saves quota vs. one
  // call per pair). Falls back to sequential fetchRouteKm calls if it fails
  // (different ORS deployments/keys can differ in what's enabled).
  async function fetchRouteLegsKm(locs) {
    const key = state.settings.orsApiKey;
    if (!key) { const e = new Error('no-key'); throw e; }
    const coordinates = locs.map(l => [l.lon, l.lat]);
    const res = await fetch(`${ORS_BASE}/v2/directions/driving-car/geojson?api_key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ coordinates })
    });
    if (!res.ok) throw new Error('directions-failed');
    const data = await res.json();
    const feat = data.features && data.features[0];
    const segments = feat && feat.properties && feat.properties.segments;
    if (!segments || segments.length !== locs.length - 1) throw new Error('directions-empty');
    return segments.map(s => Math.round((s.distance / 1000) * 10) / 10);
  }

  // Immobilien only: sums the distance across an ordered list of waypoints
  // (entry.waypoints, length >= 2) instead of a single start/end pair.
  // Mutates `entry` in place. Reuses routeCache per consecutive pair, so a
  // leg already known from a Pendeln trip (or another route) costs nothing.
  async function calcWaypointDistance(entry) {
    const locs = entry.waypoints.map(id => findLocation(id));
    if (!locs.length || locs.some(l => !l)) {
      entry.distanceStatus = 'empty';
      entry.distanceKm = null;
      entry.distanceError = null;
      entry.legs = null;
      computeCost(entry);
      return;
    }
    const pairs = [];
    for (let i = 0; i < entry.waypoints.length - 1; i++) pairs.push([entry.waypoints[i], entry.waypoints[i + 1]]);
    const cachedLegs = pairs.map(([a, b]) => state.routeCache[routeKey(a, b)]);
    if (cachedLegs.every(Boolean)) {
      entry.legs = cachedLegs.map(c => c.km);
      entry.distanceKm = Math.round(entry.legs.reduce((a, b) => a + b, 0) * 10) / 10;
      entry.distanceStatus = 'ok';
      entry.distanceError = null;
      computeCost(entry);
      return;
    }
    entry.distanceStatus = 'pending';
    entry.distanceError = null;
    try {
      for (const l of locs) await ensureLocationGeocoded(l);
      let legsKm;
      try {
        legsKm = await fetchRouteLegsKm(locs);
      } catch (e) {
        legsKm = [];
        for (let i = 0; i < locs.length - 1; i++) legsKm.push(await fetchRouteKm(locs[i], locs[i + 1]));
      }
      const calculatedAt = nowIso();
      pairs.forEach(([a, b], i) => { state.routeCache[routeKey(a, b)] = { km: legsKm[i], calculatedAt }; });
      saveKey('routeCache');
      entry.legs = legsKm;
      entry.distanceKm = Math.round(legsKm.reduce((a, b) => a + b, 0) * 10) / 10;
      entry.distanceStatus = 'ok';
      entry.distanceError = null;
    } catch (e) {
      entry.distanceStatus = 'pending';
      entry.distanceKm = null;
      entry.distanceError = (e && e.message === 'no-key') ? 'Kein API-Key hinterlegt' : 'Distanz konnte nicht berechnet werden';
    }
    computeCost(entry);
  }

  // Dispatches to the right distance calculator depending on whether `entry`
  // is an Immobilien trip/draft using the newer waypoints model.
  function calcEntryDistance(entry) {
    return (entry.context === 'immobilien' && Array.isArray(entry.waypoints))
      ? calcWaypointDistance(entry)
      : calcDistance(entry);
  }

  async function retryAllPending() {
    const pending = state.trips.filter(t => t.distanceStatus === 'pending');
    if (!pending.length) return;
    for (const trip of pending) {
      await calcEntryDistance(trip);
    }
    saveKey('trips');
    if (currentView === 'trips') render();
  }

  async function setDraftLocation(role, locId) {
    if (role === 'start') draft.startLocationId = locId; else draft.endLocationId = locId;
    if (!(draft.startLocationId && draft.endLocationId)) {
      draft.distanceKm = null;
      draft.distanceStatus = 'empty';
      draft.distanceError = null;
      render();
      return;
    }
    const p = calcDistance(draft);
    render();
    await p;
    render();
  }

  // Immobilien only: sets one stop in the ordered waypoints list.
  async function setDraftWaypoint(index, locId) {
    draft.waypoints[index] = locId;
    if (!draft.waypoints.every((id) => id)) {
      draft.distanceKm = null;
      draft.distanceStatus = 'empty';
      draft.distanceError = null;
      draft.legs = null;
      render();
      return;
    }
    const p = calcWaypointDistance(draft);
    render();
    await p;
    render();
  }

  function addDraftWaypoint() {
    if (draft.waypoints.length === 2 && draft.waypoints[0]) {
      // First extra stop: assume a round trip back to Start (the common
      // case) by appending a fresh copy of it as the new Ziel. Whatever was
      // in Ziel before — filled or still empty — simply becomes the first
      // Zwischenstopp, since it's no longer the last slot; nothing is lost
      // or needs retyping, and it's still one tap away from changing.
      draft.waypoints.push(draft.waypoints[0]);
    } else {
      // Later stops: insert a new empty slot right before Ziel, which by
      // now stays anchored as the last element and is never moved again.
      draft.waypoints.splice(draft.waypoints.length - 1, 0, null);
    }
    draft.distanceKm = null;
    draft.distanceStatus = 'empty';
    draft.distanceError = null;
    draft.legs = null;
    render();
  }

  async function removeDraftWaypoint(index) {
    if (draft.waypoints.length <= 2) return;
    draft.waypoints.splice(index, 1);
    if (!draft.waypoints.every((id) => id)) {
      draft.distanceKm = null;
      draft.distanceStatus = 'empty';
      draft.distanceError = null;
      draft.legs = null;
      render();
      return;
    }
    const p = calcWaypointDistance(draft);
    render();
    await p;
    render();
  }

  // Dispatches an address chosen in openAddressSearch to wherever it belongs:
  // the in-progress trip draft ('start'/'end'/'waypoint-N'), or a
  // Settings-level default ('settings-home'/'settings-work'), which just
  // needs to be saved & re-rendered.
  function resolveLocationForRole(role, locId) {
    if (role === 'settings-home') {
      state.settings.homeLocationId = locId;
      saveKey('settings');
      render();
    } else if (role === 'settings-work') {
      state.settings.workLocationId = locId;
      saveKey('settings');
      render();
    } else if (role.startsWith('waypoint-')) {
      setDraftWaypoint(Number(role.slice('waypoint-'.length)), locId);
    } else {
      setDraftLocation(role, locId);
    }
  }

  async function retryDraftDistance() {
    if (draft.context === 'immobilien' && Array.isArray(draft.waypoints)) {
      if (!draft.waypoints.every((id) => id)) return;
      const p = calcWaypointDistance(draft);
      render();
      await p;
      render();
      return;
    }
    if (!(draft.startLocationId && draft.endLocationId)) return;
    const p = calcDistance(draft);
    render();
    await p;
    render();
  }

  async function retryTripDistance(tripId) {
    const trip = state.trips.find(t => t.id === tripId);
    if (!trip) return;
    await calcEntryDistance(trip);
    saveKey('trips');
    render();
  }

  // ---------- Confirm dialog (custom - window.confirm is unreliable in iOS standalone PWAs) ----------
  function confirmDialog(message, confirmLabel) {
    return new Promise((resolve) => {
      closeSheet();
      const backdrop = document.createElement('div');
      backdrop.id = 'sheet-backdrop';
      backdrop.className = 'sheet-backdrop';
      backdrop.innerHTML = `
        <div class="sheet" role="dialog">
          <div class="sheet-handle"></div>
          <div style="padding: 6px 20px 20px; font-size: 15px; line-height: 1.5;">${escapeHtml(message)}</div>
          <div style="display:flex; gap:10px; padding: 0 20px 4px;">
            <button class="btn-secondary" id="confirm-cancel" style="flex:1;">Abbrechen</button>
            <button class="btn-primary" id="confirm-ok" style="flex:1; background: var(--danger); color: #fff;">${escapeHtml(confirmLabel || 'Löschen')}</button>
          </div>
        </div>
      `;
      appendSheet(backdrop);
      const cleanup = (result) => { closeSheet(); resolve(result); };
      backdrop.querySelector('#confirm-cancel').addEventListener('click', () => cleanup(false));
      backdrop.querySelector('#confirm-ok').addEventListener('click', () => cleanup(true));
      backdrop.addEventListener('click', (e) => { if (e.target === backdrop) cleanup(false); });
    });
  }

  // Small dialog offering two labels to pick between (used when merging two
  // addresses that both have a custom Bezeichnung). Resolves 'a', 'b', or
  // null if cancelled.
  function chooseLabelDialog(labelA, labelB) {
    return new Promise((resolve) => {
      closeSheet();
      const backdrop = document.createElement('div');
      backdrop.id = 'sheet-backdrop';
      backdrop.className = 'sheet-backdrop';
      backdrop.innerHTML = `
        <div class="sheet" role="dialog">
          <div class="sheet-handle"></div>
          <div class="sheet-header">
            <h2>Welche Bezeichnung behalten?</h2>
          </div>
          <div style="padding: 0 20px 20px; display:flex; flex-direction:column; gap:10px;">
            <button class="btn-secondary" id="label-choice-a" style="width:100%;">${escapeHtml(labelA)}</button>
            <button class="btn-secondary" id="label-choice-b" style="width:100%;">${escapeHtml(labelB)}</button>
            <button class="btn-text" id="label-choice-cancel" style="width:100%;">Abbrechen</button>
          </div>
        </div>
      `;
      appendSheet(backdrop);
      const cleanup = (result) => { closeSheet(); resolve(result); };
      backdrop.querySelector('#label-choice-a').addEventListener('click', () => cleanup('a'));
      backdrop.querySelector('#label-choice-b').addEventListener('click', () => cleanup('b'));
      backdrop.querySelector('#label-choice-cancel').addEventListener('click', () => cleanup(null));
      backdrop.addEventListener('click', (e) => { if (e.target === backdrop) cleanup(null); });
    });
  }

  // ---------- Trip CRUD ----------
  function validateDraft() {
    const hasRoute = (draft.context === 'immobilien' && Array.isArray(draft.waypoints))
      ? draft.waypoints.length >= 2 && draft.waypoints.every((id) => id)
      : !!(draft.startLocationId && draft.endLocationId);
    if (!hasRoute || !draft.startDateTime || !draft.vehiclePlate) return false;
    if (draft.context === 'immobilien' && !draft.objektKuerzel) return false;
    return true;
  }

  async function saveTrip() {
    if (!validateDraft()) {
      const isImmoWaypoints = draft.context === 'immobilien' && Array.isArray(draft.waypoints);
      toast(isImmoWaypoints ? 'Bitte alle Stopps, Datum, Fahrzeug und Objekt angeben' : (draft.context === 'immobilien' ? 'Bitte Start, Ziel, Datum, Fahrzeug und Objekt angeben' : 'Bitte Start, Ziel, Datum und Fahrzeug angeben'));
      return;
    }
    const isImmoWaypoints = draft.context === 'immobilien' && Array.isArray(draft.waypoints);
    const startLoc = isImmoWaypoints ? null : findLocation(draft.startLocationId);
    const endLoc = isImmoWaypoints ? null : findLocation(draft.endLocationId);
    const veh = state.vehicles.find(v => v.plate === draft.vehiclePlate);

    if (editingTripId) {
      const trip = state.trips.find(t => t.id === editingTripId);
      const routeChanged = trip.startLocationId !== draft.startLocationId || trip.endLocationId !== draft.endLocationId ||
        JSON.stringify(trip.waypoints || null) !== JSON.stringify(draft.waypoints || null);
      Object.assign(trip, {
        startLocationId: draft.startLocationId,
        endLocationId: draft.endLocationId,
        waypoints: draft.waypoints ? [...draft.waypoints] : null,
        legs: draft.legs || null,
        startDateTime: draft.startDateTime,
        endDateTime: draft.endDateTime,
        vehiclePlate: draft.vehiclePlate,
        objektKuerzel: draft.objektKuerzel || null,
        note: draft.note,
        ratePerKm: draft.ratePerKm,
        rateSource: draft.rateSource,
        rateType: draft.rateType || null,
        updatedAt: nowIso()
      });
      if (routeChanged) {
        trip.distanceKm = null;
        trip.distanceStatus = 'pending';
        trip.distanceError = null;
      }
      bumpUsage(startLoc, endLoc, veh);
      if (isImmoWaypoints) bumpWaypointUsage(draft.waypoints);
      if (trip.context === 'immobilien') bumpObjektUsage(trip.objektKuerzel);
      computeCost(trip);
      saveKey('trips');
      if (trip.distanceStatus !== 'ok') {
        await calcEntryDistance(trip);
        saveKey('trips');
      }
      editingTripId = null;
    } else {
      const trip = {
        id: uid(),
        context: draft.context || currentContext,
        startLocationId: draft.startLocationId,
        endLocationId: draft.endLocationId,
        waypoints: draft.waypoints ? [...draft.waypoints] : null,
        legs: draft.legs || null,
        distanceKm: draft.distanceKm,
        distanceStatus: draft.distanceStatus === 'ok' ? 'ok' : 'pending',
        distanceError: null,
        startDateTime: draft.startDateTime,
        endDateTime: draft.endDateTime,
        vehiclePlate: draft.vehiclePlate,
        objektKuerzel: draft.objektKuerzel || null,
        note: draft.note,
        ratePerKm: draft.ratePerKm,
        rateSource: draft.rateSource,
        rateType: draft.rateType || null,
        cost: draft.cost,
        createdAt: nowIso(),
        updatedAt: nowIso()
      };
      state.trips.push(trip);
      bumpUsage(startLoc, endLoc, veh);
      if (isImmoWaypoints) bumpWaypointUsage(draft.waypoints);
      if (trip.context === 'immobilien') bumpObjektUsage(trip.objektKuerzel);
      computeCost(trip);
      saveKey('trips');
      if (trip.distanceStatus !== 'ok') {
        await calcEntryDistance(trip);
        saveKey('trips');
      }
    }

    draft = makeEmptyDraft();
    toast('Reise gespeichert');
    currentView = 'trips';
    render();
  }

  function startEditTrip(id) {
    const trip = state.trips.find(t => t.id === id);
    if (!trip) return;
    editingTripId = id;
    draft = {
      context: trip.context || 'pendeln',
      startLocationId: trip.startLocationId,
      endLocationId: trip.endLocationId,
      // Legacy Immobilien trips saved before waypoints existed (Phase 1-4)
      // only have startLocationId/endLocationId — migrate them into a
      // 2-stop waypoints list on first edit.
      waypoints: trip.context === 'immobilien'
        ? (Array.isArray(trip.waypoints) && trip.waypoints.length >= 2 ? [...trip.waypoints] : [trip.startLocationId || null, trip.endLocationId || null])
        : undefined,
      legs: trip.legs || null,
      distanceKm: trip.distanceKm,
      distanceStatus: trip.distanceStatus,
      distanceError: trip.distanceError,
      startDateTime: trip.startDateTime,
      endDateTime: trip.endDateTime,
      vehiclePlate: trip.vehiclePlate,
      objektKuerzel: trip.objektKuerzel || '',
      note: trip.note,
      ratePerKm: trip.ratePerKm != null ? trip.ratePerKm : null,
      rateSource: trip.rateSource || 'auto',
      rateType: trip.rateType || null,
      cost: trip.cost != null ? trip.cost : null
    };
    currentView = 'new';
    render();
  }

  function cancelEdit() {
    editingTripId = null;
    draft = makeEmptyDraft();
    flashScreen();
    render();
  }

  async function deleteTrip(id) {
    const ok = await confirmDialog('Diese Reise wirklich löschen?');
    if (!ok) return;
    state.trips = state.trips.filter(t => t.id !== id);
    saveKey('trips');
    toast('Reise gelöscht');
    render();
  }

  // ---------- Picker sheet ----------
  function closeSheet() {
    const el = document.getElementById('sheet-backdrop');
    if (el) el.remove();
    document.body.style.overflow = '';
  }

  // Locks background scroll while a sheet is open. On iOS, having both the
  // page and the sheet independently scrollable is what causes the on-screen
  // keyboard's focus/cursor positioning to desync from the visible input.
  function appendSheet(backdrop) {
    document.body.appendChild(backdrop);
    document.body.style.overflow = 'hidden';
  }

  function openPicker({ title, searchPlaceholder, items, matches, renderItem, onSelect, onCreate }) {
    closeSheet();
    const backdrop = document.createElement('div');
    backdrop.id = 'sheet-backdrop';
    backdrop.className = 'sheet-backdrop';
    backdrop.innerHTML = `
      <div class="sheet" role="dialog">
        <div class="sheet-handle"></div>
        <div class="sheet-header">
          <h2>${escapeHtml(title)}</h2>
          <button class="btn-text" id="sheet-close">Fertig</button>
        </div>
        <div class="sheet-search">
          <div class="text-input-wrap">
            <input type="text" id="sheet-search-input" placeholder="${escapeHtml(searchPlaceholder)}" autocomplete="off" autocapitalize="words" enterkeyhint="done">
            <button type="button" class="input-clear" data-clear-target="sheet-search-input" aria-label="Eingabe löschen">×</button>
          </div>
        </div>
        <div class="sheet-list" id="sheet-list"></div>
      </div>
    `;
    appendSheet(backdrop);

    const listEl = backdrop.querySelector('#sheet-list');
    const searchEl = backdrop.querySelector('#sheet-search-input');

    function renderList() {
      const q = searchEl.value.trim().toLowerCase();
      const filtered = q ? items.filter(it => matches(it, q)) : items;
      let html = '';
      if (!filtered.length && !q) {
        html += `<div class="sheet-empty">Noch nichts gespeichert. Tippe oben, um Neues anzulegen.</div>`;
      }
      html += filtered.map(it => {
        const r = renderItem(it);
        return `<button class="sheet-item" data-id="${escapeHtml(it.__id)}">
          <span>${escapeHtml(r.primary)}</span>
          ${r.secondary ? `<span class="sub">${escapeHtml(r.secondary)}</span>` : ''}
        </button>`;
      }).join('');
      listEl.innerHTML = html;

      listEl.querySelectorAll('.sheet-item[data-id]').forEach(btn => {
        btn.addEventListener('click', () => {
          const item = items.find(it => it.__id === btn.getAttribute('data-id'));
          if (item) onSelect(item);
        });
      });
    }

    // Shared by Enter and the "Fertig" button: pick the one matching saved
    // item, or hand the typed text to onCreate (which itself decides
    // whether to reuse an existing record or create a new one).
    function submitQuery() {
      const q = searchEl.value.trim();
      if (!q) { closeSheet(); return; }
      const qLower = q.toLowerCase();
      const filtered = items.filter(it => matches(it, qLower));
      if (filtered.length === 1) {
        onSelect(filtered[0]);
      } else if (onCreate) {
        onCreate(q);
      }
    }

    searchEl.addEventListener('input', renderList);
    searchEl.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      submitQuery();
    });
    backdrop.querySelector('#sheet-close').addEventListener('click', () => {
      if (onCreate && searchEl.value.trim()) submitQuery();
      else closeSheet();
    });
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeSheet(); });

    renderList();
    setTimeout(() => searchEl.focus(), 50);
  }

  // Single-sheet address search: type a place, pick it, keep typing (in the
  // same sheet) to find a street within it, optionally add a house number.
  // Already-saved locations are offered inline alongside live place matches.
  function openAddressSearch(role, gpsPrefill) {
    closeSheet();
    let stage = 'place'; // 'place' | 'street'
    let stagePlace = null; // {label, lat, lon, gid}
    let streetIsManual = true; // false once a real street suggestion (or GPS) is used, untouched since

    const backdrop = document.createElement('div');
    backdrop.id = 'sheet-backdrop';
    backdrop.className = 'sheet-backdrop';
    backdrop.innerHTML = `
      <div class="sheet" role="dialog">
        <div class="sheet-handle"></div>
        <div class="sheet-header">
          <h2>${{ start: 'Startort wählen', end: 'Ziel wählen', 'settings-home': 'Zuhause festlegen', 'settings-work': 'Arbeitsort festlegen' }[role] || 'Ort wählen'}</h2>
          <button class="btn-text" id="sheet-close">Abbrechen</button>
        </div>
        <div id="addr-chip-row" class="sheet-search" hidden>
          <span class="chip"><span id="addr-chip-label"></span><button type="button" id="addr-chip-clear" aria-label="Ort ändern">×</button></span>
        </div>
        <div class="sheet-search">
          <div class="text-input-wrap">
            <input type="text" id="addr-search-input" placeholder="Ort eingeben" autocomplete="off" autocapitalize="words" enterkeyhint="search">
            <button type="button" class="input-clear" data-clear-target="addr-search-input" aria-label="Eingabe löschen">×</button>
          </div>
        </div>
        <div class="sheet-list" id="addr-results"></div>
        <div id="addr-confirm-row" style="padding: 4px 18px 4px;" hidden>
          <div class="field">
            <div class="text-input-wrap">
              <input type="text" id="addr-housenumber-input" placeholder="Hausnummer (optional)" inputmode="numeric" enterkeyhint="done">
              <button type="button" class="input-clear" data-clear-target="addr-housenumber-input" aria-label="Eingabe löschen">×</button>
            </div>
          </div>
          <button type="button" class="btn-text" id="addr-label-toggle">+ Bezeichnung hinzufügen</button>
          <div class="field" id="addr-label-field" hidden>
            <div class="text-input-wrap">
              <input type="text" id="addr-label-input" placeholder="z. B. Büro Zürich" enterkeyhint="done">
              <button type="button" class="input-clear" data-clear-target="addr-label-input" aria-label="Eingabe löschen">×</button>
            </div>
          </div>
          <button type="button" class="btn-primary" id="addr-confirm-btn" style="width:100%; margin-top:10px;">Übernehmen</button>
        </div>
      </div>
    `;
    appendSheet(backdrop);
    backdrop.querySelector('#sheet-close').addEventListener('click', closeSheet);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeSheet(); });

    const searchInput = backdrop.querySelector('#addr-search-input');
    const resultsEl = backdrop.querySelector('#addr-results');
    const chipRow = backdrop.querySelector('#addr-chip-row');
    const chipLabel = backdrop.querySelector('#addr-chip-label');
    const confirmRow = backdrop.querySelector('#addr-confirm-row');
    const houseInput = backdrop.querySelector('#addr-housenumber-input');
    const labelToggle = backdrop.querySelector('#addr-label-toggle');
    const labelField = backdrop.querySelector('#addr-label-field');
    const labelInput = backdrop.querySelector('#addr-label-input');
    const confirmBtn = backdrop.querySelector('#addr-confirm-btn');

    searchInput.addEventListener('focus', requestAmbientFocus, { once: true });

    function goToStreetStage(place) {
      stage = 'street';
      stagePlace = place;
      chipLabel.textContent = place.label;
      chipRow.hidden = false;
      searchInput.value = '';
      searchInput.placeholder = 'Straße eingeben';
      resultsEl.innerHTML = '';
      confirmRow.hidden = true;
      searchInput.focus();
    }

    backdrop.querySelector('#addr-chip-clear').addEventListener('click', () => {
      stage = 'place';
      stagePlace = null;
      chipRow.hidden = true;
      searchInput.value = '';
      searchInput.placeholder = 'Ort eingeben';
      resultsEl.innerHTML = '';
      confirmRow.hidden = true;
      searchInput.focus();
    });

    function finalizeNewLocation(address, labelOverride, verified) {
      const normalized = address.trim().toLowerCase();
      const existing = state.locations.find(l => l.address.trim().toLowerCase() === normalized);
      if (existing) {
        toast('Adresse bereits gespeichert — wird wiederverwendet');
        closeSheet();
        resolveLocationForRole(role, existing.id);
        return;
      }
      const label = (labelOverride || '').trim() || address;
      const loc = { id: uid(), label, address, lat: null, lon: null, usageCount: 0, lastUsedAt: null, verified: !!verified };
      state.locations.push(loc);
      saveKey('locations');
      closeSheet();
      resolveLocationForRole(role, loc.id);
    }

    labelToggle.addEventListener('click', () => {
      labelField.hidden = false;
      labelToggle.hidden = true;
      labelInput.focus();
    });

    confirmBtn.addEventListener('click', () => {
      const street = searchInput.value.trim();
      if (!street) { toast('Bitte eine Straße eingeben'); return; }
      const address = buildAddressFromParts(street, houseInput.value.trim(), stagePlace ? stagePlace.label : '');
      finalizeNewLocation(address, labelInput.value, !streetIsManual);
    });

    function renderPlaceResults(query, saved, places, errorHint) {
      let html = saved.map(l => `<button type="button" class="sheet-item" data-saved="${escapeHtml(l.id)}"><span>${escapeHtml(l.label)}</span>${l.label !== l.address ? `<span class="sub">${escapeHtml(l.address)}</span>` : ''}</button>`).join('');
      html += places.map((p, i) => `<button type="button" class="sheet-item" data-place="${i}">${escapeHtml(p.label)}</button>`).join('');
      if (errorHint) html += `<div class="hint" style="padding:8px 4px; color:var(--warn);">${escapeHtml(errorHint)}</div>`;
      if (query) {
        html += `<button type="button" class="sheet-item new-item" id="addr-manual-use">„${escapeHtml(query)}" manuell als Ort verwenden</button>`;
      } else if (!html) {
        html = `<div class="hint" style="padding:10px 4px;">Noch keine Adressen gespeichert. Ort eingeben, um zu suchen.</div>`;
      }
      resultsEl.innerHTML = html;
      resultsEl.querySelectorAll('[data-saved]').forEach(btn => {
        btn.addEventListener('click', () => {
          const loc = state.locations.find(l => l.id === btn.getAttribute('data-saved'));
          if (loc) { closeSheet(); resolveLocationForRole(role, loc.id); }
        });
      });
      resultsEl.querySelectorAll('[data-place]').forEach(btn => {
        btn.addEventListener('click', () => goToStreetStage(places[Number(btn.getAttribute('data-place'))]));
      });
      const manualBtn = resultsEl.querySelector('#addr-manual-use');
      if (manualBtn) manualBtn.addEventListener('click', () => finalizeNewLocation(query, '', false));
    }

    function renderStreetResults(query, streets, errorHint) {
      let html = streets.map((r, i) => `<button type="button" class="sheet-item" data-street="${i}">${escapeHtml(r.street || r.label.split(',')[0].trim())}</button>`).join('');
      if (errorHint) html += `<div class="hint" style="padding:8px 4px; color:var(--warn);">${escapeHtml(errorHint)}</div>`;
      html += `<button type="button" class="sheet-item new-item" id="addr-street-manual">„${escapeHtml(query)}" übernehmen</button>`;
      resultsEl.innerHTML = html;
      resultsEl.querySelectorAll('[data-street]').forEach(btn => {
        btn.addEventListener('click', () => {
          const r = streets[Number(btn.getAttribute('data-street'))];
          searchInput.value = r.street || r.label.split(',')[0].trim();
          streetIsManual = false;
          confirmRow.hidden = false;
          houseInput.focus();
        });
      });
      resultsEl.querySelector('#addr-street-manual').addEventListener('click', () => {
        streetIsManual = true;
        confirmRow.hidden = false;
        houseInput.focus();
      });
    }

    let debounceTimer = null;
    let requestToken = 0;
    searchInput.addEventListener('input', () => {
      confirmRow.hidden = true;
      if (stage === 'street') streetIsManual = true; // editing invalidates a prior pick
      clearTimeout(debounceTimer);
      const query = searchInput.value.trim();
      if (query.length < 2) {
        if (stage === 'place' && !query) renderPlaceResults('', sortedByRecency(state.locations), []);
        else resultsEl.innerHTML = '';
        return;
      }
      debounceTimer = setTimeout(async () => {
        const myToken = ++requestToken;
        if (stage === 'place') {
          const qLower = query.toLowerCase();
          const saved = sortedByRecency(state.locations)
            .filter(l => (l.label + ' ' + l.address).toLowerCase().includes(qLower))
            .slice(0, 5);
          let places = [];
          let errorHint = null;
          if (!state.settings.orsApiKey) {
            errorHint = describeGeocodeError({ message: 'no-key' });
          } else {
            try {
              places = await geocodeAutocomplete(query, {
                layers: 'locality,localadmin',
                focusLat: ambientFocus ? ambientFocus.lat : null, focusLon: ambientFocus ? ambientFocus.lon : null,
                boundaryCountry: 'DE,AT,CH'
              });
            } catch (e) { errorHint = describeGeocodeError(e); }
          }
          if (myToken !== requestToken) return;
          renderPlaceResults(query, saved, places, errorHint);
        } else {
          let streets = [];
          let errorHint = null;
          if (!state.settings.orsApiKey) {
            errorHint = describeGeocodeError({ message: 'no-key' });
          } else {
            try {
              streets = await geocodeAutocomplete(query, {
                layers: 'street',
                size: 15,
                focusLat: stagePlace ? stagePlace.lat : null, focusLon: stagePlace ? stagePlace.lon : null,
                boundaryGid: stagePlace ? stagePlace.gid : null,
                boundaryLat: (stagePlace && !stagePlace.gid) ? stagePlace.lat : null,
                boundaryLon: (stagePlace && !stagePlace.gid) ? stagePlace.lon : null,
                boundaryRadiusKm: 15
              });
              // Some place gids (e.g. independent cities like Stuttgart) don't
              // contain any street-layer records in the underlying admin-
              // boundary data, even though the streets exist — retry with a
              // radius search around the place instead of leaving zero results.
              if (!streets.length && stagePlace && stagePlace.gid) {
                streets = await geocodeAutocomplete(query, {
                  layers: 'street',
                  size: 15,
                  focusLat: stagePlace.lat, focusLon: stagePlace.lon,
                  boundaryLat: stagePlace.lat, boundaryLon: stagePlace.lon,
                  boundaryRadiusKm: 15
                });
              }
            } catch (e) { errorHint = describeGeocodeError(e); }
          }
          if (myToken !== requestToken) return;
          const seen = new Set();
          streets = streets.filter(r => {
            const k = (r.street || r.label.split(',')[0].trim()).toLowerCase();
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
          });
          renderStreetResults(query, streets, errorHint);
        }
      }, 300);
    });

    if (gpsPrefill) {
      goToStreetStage(gpsPrefill.place);
      searchInput.value = gpsPrefill.street;
      streetIsManual = !gpsPrefill.street;
      houseInput.value = gpsPrefill.housenumber;
      confirmRow.hidden = false;
    } else {
      renderPlaceResults('', sortedByRecency(state.locations), []);
      setTimeout(() => searchInput.focus(), 50);
    }
  }

  async function useGpsForRole(role) {
    if (!navigator.geolocation) { toast('Standortbestimmung wird von diesem Gerät nicht unterstützt'); return; }
    toast('Standort wird ermittelt…');
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          const r = await geocodeReverse(pos.coords.latitude, pos.coords.longitude);
          const ortLabel = [r.postalcode, r.locality || r.label].filter(Boolean).join(' ');
          openAddressSearch(role, {
            place: { label: ortLabel, lat: r.lat, lon: r.lon, gid: null },
            street: r.street || '',
            housenumber: r.housenumber || ''
          });
        } catch (err) {
          toast(err && err.message === 'no-key' ? 'Kein API-Key hinterlegt' : 'Standort konnte nicht aufgelöst werden');
        }
      },
      () => { toast('Standortzugriff nicht möglich oder abgelehnt'); },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }

  function openVehiclePicker() {
    const items = sortedByRecency(state.vehicles).map(v => ({ ...v, __id: v.plate }));
    openPicker({
      title: 'Fahrzeug wählen',
      searchPlaceholder: 'Kennzeichen suchen oder neu eingeben',
      items,
      matches: (it, q) => it.plate.toLowerCase().includes(q),
      renderItem: (it) => ({ primary: it.plate, secondary: '' }),
      onSelect: (it) => { closeSheet(); draft.vehiclePlate = it.plate; render(); },
      onCreate: (query) => {
        const plate = query.toUpperCase();
        let veh = state.vehicles.find(v => v.plate === plate);
        if (!veh) {
          veh = { plate, usageCount: 0, lastUsedAt: null };
          state.vehicles.push(veh);
          saveKey('vehicles');
        }
        closeSheet();
        draft.vehiclePlate = veh.plate;
        render();
      }
    });
  }

  function openObjektPicker() {
    const items = sortedByRecency(state.objekte).map(o => ({ ...o, __id: o.kuerzel }));
    openPicker({
      title: 'Objekt wählen',
      searchPlaceholder: 'Objekt suchen oder neu eingeben',
      items,
      matches: (it, q) => it.kuerzel.toLowerCase().includes(q),
      renderItem: (it) => ({ primary: it.kuerzel, secondary: '' }),
      onSelect: (it) => { closeSheet(); draft.objektKuerzel = it.kuerzel; render(); },
      onCreate: (query) => {
        const kuerzel = query.trim();
        let obj = state.objekte.find(o => o.kuerzel === kuerzel);
        if (!obj) {
          obj = { kuerzel, usageCount: 0, lastUsedAt: null };
          state.objekte.push(obj);
          saveKey('objekte');
        }
        closeSheet();
        draft.objektKuerzel = obj.kuerzel;
        render();
      }
    });
  }

  function openTimeEditor(role) {
    closeSheet();
    const current = role === 'start' ? draft.startDateTime : draft.endDateTime;
    const { time } = splitDateTime(current);
    const [curH, curMRaw] = time ? time.split(':') : ['', ''];
    // Round down to the 5-minute mark for display, in case the stored value (e.g. from an
    // older entry) isn't already on one - avoids silently snapping to a later time if left untouched.
    const curM = curMRaw ? pad(Math.floor(Number(curMRaw) / 5) * 5) : '';
    const hourOptions = Array.from({ length: 24 }, (_, i) => pad(i));
    const minuteOptions = Array.from({ length: 12 }, (_, i) => pad(i * 5));
    const backdrop = document.createElement('div');
    backdrop.id = 'sheet-backdrop';
    backdrop.className = 'sheet-backdrop';
    backdrop.innerHTML = `
      <div class="sheet" role="dialog">
        <div class="sheet-handle"></div>
        <div class="sheet-header">
          <h2>Uhrzeit ${role === 'start' ? '(Start)' : '(Rückkehr)'}</h2>
          <button class="btn-text" id="sheet-close">Abbrechen</button>
        </div>
        <div style="padding: 10px 18px 24px; display:flex; gap:10px; align-items:center; justify-content:center;">
          <select id="time-hour" style="text-align:center; flex:1; font-size:18px;">
            ${hourOptions.map(h => `<option value="${h}" ${h === curH ? 'selected' : ''}>${h}</option>`).join('')}
          </select>
          <span style="font-size:22px; font-weight:700; color:var(--text-dim);">:</span>
          <select id="time-minute" style="text-align:center; flex:1; font-size:18px;">
            ${minuteOptions.map(m => `<option value="${m}" ${m === curM ? 'selected' : ''}>${m}</option>`).join('')}
          </select>
        </div>
        <div style="padding:0 18px 4px;">
          <button type="button" class="btn-primary" id="time-save" style="width:100%;">Übernehmen</button>
        </div>
      </div>
    `;
    appendSheet(backdrop);
    backdrop.querySelector('#sheet-close').addEventListener('click', closeSheet);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeSheet(); });
    backdrop.querySelector('#time-save').addEventListener('click', () => {
      const h = backdrop.querySelector('#time-hour').value;
      const m = backdrop.querySelector('#time-minute').value;
      const datePart = splitDateTime(current).date || todayDateStr();
      const newVal = `${datePart}T${h}:${m}`;
      if (role === 'start') {
        draft.startDateTime = newVal;
        computeCost(draft);
      } else {
        draft.endDateTime = newVal;
      }
      closeSheet();
      render();
    });
  }

  function openRateEditor(opts) {
    const isImmo = !!(opts && opts.immo);
    closeSheet();
    const backdrop = document.createElement('div');
    backdrop.id = 'sheet-backdrop';
    backdrop.className = 'sheet-backdrop';
    const currentVal = draft.ratePerKm != null ? String(draft.ratePerKm).replace('.', ',') : '';
    backdrop.innerHTML = `
      <div class="sheet" role="dialog">
        <div class="sheet-handle"></div>
        <div class="sheet-header">
          <h2>${isImmo ? 'Kilometersatz für diese Fahrt' : 'Pendlerpauschale für diese Fahrt'}</h2>
          <button class="btn-text" id="sheet-close">Abbrechen</button>
        </div>
        <form id="rate-form" style="padding: 4px 18px 20px;">
          <div class="field">
            <label for="rate-amount-input">Betrag pro Kilometer</label>
            <div class="input-suffix has-clear"><input type="text" inputmode="decimal" id="rate-amount-input" placeholder="0,40" value="${escapeHtml(currentVal)}" enterkeyhint="done"><button type="button" class="input-clear" data-clear-target="rate-amount-input" aria-label="Eingabe löschen">×</button><span class="suffix">€/km</span></div>
          </div>
          ${isImmo ? `
          <div class="field">
            <label for="rate-type-input">Art</label>
            <select id="rate-type-input">
              <option value="pauschal" ${draft.rateType === 'pauschal' ? 'selected' : ''}>Pauschal</option>
              <option value="tatsaechlich" ${draft.rateType === 'tatsaechlich' ? 'selected' : ''}>Tatsächliche Kosten</option>
              <option value="tabelle" ${draft.rateType === 'tabelle' ? 'selected' : ''}>Tabelle</option>
            </select>
          </div>` : ''}
          <button type="submit" class="btn-primary" id="rate-save">Speichern</button>
          ${draft.rateSource === 'manual' ? '<button type="button" class="btn-secondary" id="rate-reset" style="width:100%;margin-top:10px;">Automatisch verwenden</button>' : ''}
        </form>
      </div>
    `;
    appendSheet(backdrop);
    backdrop.querySelector('#sheet-close').addEventListener('click', closeSheet);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeSheet(); });
    backdrop.querySelector('#rate-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const val = parseFloat(backdrop.querySelector('#rate-amount-input').value.replace(',', '.'));
      if (isNaN(val) || val <= 0) { toast('Bitte einen gültigen Betrag angeben'); return; }
      draft.ratePerKm = val;
      draft.rateSource = 'manual';
      if (isImmo) draft.rateType = backdrop.querySelector('#rate-type-input').value;
      computeCost(draft);
      closeSheet();
      render();
    });
    const resetBtn = backdrop.querySelector('#rate-reset');
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        draft.rateSource = 'auto';
        computeCost(draft);
        closeSheet();
        render();
      });
    }
    setTimeout(() => backdrop.querySelector('#rate-amount-input').focus(), 50);
  }

  // ---------- Backup ----------
  function exportBackup() {
    const backup = {
      exportedAt: nowIso(),
      appVersion: APP_VERSION,
      trips: state.trips,
      locations: state.locations,
      vehicles: state.vehicles,
      objekte: state.objekte,
      noteSuggestions: state.noteSuggestions,
      rates: state.rates,
      immoRates: state.immoRates,
      routeCache: state.routeCache,
      settings: state.settings
    };
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const d = new Date();
    const backupDateStr = `${pad(d.getFullYear() % 100)}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
    a.download = `${backupDateStr}_reisekosten-backup.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('Backup wird heruntergeladen');
  }

  async function importBackupFile(file) {
    const cloudNote = currentUser ? ' Da du angemeldet bist, wird dies auch mit all deinen anderen angemeldeten Geräten synchronisiert.' : '';
    const ok = await confirmDialog(`Dies ersetzt ALLE aktuellen Daten (Reisen, Adressen, Fahrzeuge, Objekte, Anlass-Vorschläge, Sätze, API-Key) durch den Inhalt der Backup-Datei.${cloudNote} Fortfahren?`, 'Ersetzen');
    if (!ok) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!data || typeof data !== 'object') throw new Error('invalid');
      state.trips = Array.isArray(data.trips) ? data.trips : [];
      state.locations = Array.isArray(data.locations) ? data.locations : [];
      state.vehicles = Array.isArray(data.vehicles) ? data.vehicles : [];
      state.objekte = Array.isArray(data.objekte) ? data.objekte : [];
      state.noteSuggestions = Array.isArray(data.noteSuggestions) ? data.noteSuggestions : JSON.parse(JSON.stringify(DEFAULTS.noteSuggestions));
      state.rates = Array.isArray(data.rates) ? data.rates : [];
      state.immoRates = Array.isArray(data.immoRates) ? data.immoRates : [];
      state.routeCache = (data.routeCache && typeof data.routeCache === 'object') ? data.routeCache : {};
      state.settings = (data.settings && typeof data.settings === 'object') ? data.settings : { orsApiKey: '' };
      saveKey('trips');
      saveKey('locations');
      saveKey('vehicles');
      saveKey('objekte');
      saveKey('noteSuggestions');
      saveKey('rates');
      saveKey('immoRates');
      saveKey('routeCache');
      saveKey('settings');
      toast('Backup importiert');
      render();
    } catch (e) {
      toast('Backup-Datei konnte nicht gelesen werden');
    }
  }

  // ---------- Cloud sync (Firebase) ----------
  const CLOUD_SYNCED_KEYS = ['trips', 'locations', 'vehicles', 'objekte', 'noteSuggestions', 'rates', 'immoRates', 'settings']; // not routeCache: regenerable, no data-loss risk

  const firebaseConfig = {
    apiKey: 'AIzaSyDLfAXQUAWnv31czdwS_u4OZ_FnTlTolbI',
    authDomain: 'reisekosten-tracker.firebaseapp.com',
    projectId: 'reisekosten-tracker',
    storageBucket: 'reisekosten-tracker.firebasestorage.app',
    messagingSenderId: '234123683497',
    appId: '1:234123683497:web:8127fbc2b126583188ebb8'
  };

  let fbAuth = null;
  let fbDb = null;
  try {
    if (window.firebase) {
      firebase.initializeApp(firebaseConfig);
      fbAuth = firebase.auth();
      fbDb = firebase.firestore();
      fbDb.enablePersistence().catch(() => { /* multiple open tabs, or unsupported browser - falls back to network-only */ });
    }
  } catch (e) { /* Firebase SDK failed to load (e.g. offline on first load) - app still works fully offline/local */ }

  let currentUser = null;
  let cloudSyncStatus = 'signed-out'; // 'signed-out' | 'syncing' | 'synced' | 'error'
  let cloudUnsubscribers = [];
  let applyingRemoteUpdate = false;

  function cloudSyncStatusText() {
    if (cloudSyncStatus === 'syncing') return 'Wird synchronisiert…';
    if (cloudSyncStatus === 'error') return 'Sync-Fehler — Daten bleiben lokal gespeichert';
    if (cloudSyncStatus === 'synced') return 'Synchronisiert';
    return '';
  }

  function keyToDocData(key) {
    return key === 'settings' ? state.settings : { items: state[key] };
  }

  function applyDocDataToKey(key, data) {
    if (key === 'settings') {
      state.settings = (data && typeof data === 'object') ? data : { orsApiKey: '' };
    } else {
      state[key] = (data && Array.isArray(data.items)) ? data.items : [];
    }
  }

  function pushToCloud(key) {
    if (!currentUser || !fbDb) return;
    fbDb.collection('users').doc(currentUser.uid).collection('data').doc(key)
      .set(keyToDocData(key))
      .catch(() => { /* offline - Firestore queues the write and retries automatically */ });
  }

  function detachCloudListeners() {
    cloudUnsubscribers.forEach((unsub) => { try { unsub(); } catch (e) { /* already detached */ } });
    cloudUnsubscribers = [];
  }

  function attachCloudListeners(userDocsRef) {
    detachCloudListeners();
    CLOUD_SYNCED_KEYS.forEach((key) => {
      const unsub = userDocsRef.doc(key).onSnapshot(
        (snap) => {
          if (snap.metadata.hasPendingWrites) return; // echo of our own just-sent write
          applyingRemoteUpdate = true;
          applyDocDataToKey(key, snap.exists ? snap.data() : null);
          saveKey(key);
          applyingRemoteUpdate = false;
          if (key === 'rates') {
            for (const t of state.trips) computeCost(t);
          }
          render();
        },
        () => { cloudSyncStatus = 'error'; render(); }
      );
      cloudUnsubscribers.push(unsub);
    });
  }

  const CLOUD_LINKED_UID_KEY = STORAGE_PREFIX + 'cloudLinkedUid';

  async function handleSignedIn(user) {
    currentUser = user;
    cloudSyncStatus = 'syncing';
    render();
    const userDocsRef = fbDb.collection('users').doc(user.uid).collection('data');
    try {
      // Once this device has been linked to this account, treat every later
      // app start as "already synced" and go straight to live listeners —
      // the migration prompts below are only for the one-time first link.
      const alreadyLinked = localStorage.getItem(CLOUD_LINKED_UID_KEY) === user.uid;
      if (!alreadyLinked) {
        const settingsSnap = await userDocsRef.doc('settings').get();
        const cloudHasData = settingsSnap.exists;
        const localHasData = state.trips.length || state.locations.length || state.vehicles.length || state.rates.length;

        if (!cloudHasData && localHasData) {
          const ok = await confirmDialog('Lokale Daten in die Cloud hochladen? Damit stehen sie auch auf deinen anderen Geräten zur Verfügung.', 'Hochladen');
          if (ok) {
            for (const key of CLOUD_SYNCED_KEYS) {
              await userDocsRef.doc(key).set(keyToDocData(key));
            }
          }
        } else if (cloudHasData && localHasData) {
          const ok = await confirmDialog('In der Cloud sind bereits Daten von einem anderen Gerät vorhanden. Jetzt laden? Die lokalen Daten auf diesem Gerät werden dabei ersetzt.', 'Cloud-Daten laden');
          if (ok) {
            for (const key of CLOUD_SYNCED_KEYS) {
              const snap = await userDocsRef.doc(key).get();
              applyingRemoteUpdate = true;
              applyDocDataToKey(key, snap.exists ? snap.data() : null);
              saveKey(key);
              applyingRemoteUpdate = false;
            }
          }
        }
        try { localStorage.setItem(CLOUD_LINKED_UID_KEY, user.uid); } catch (e) { /* localStorage unavailable */ }
      }
      attachCloudListeners(userDocsRef);
      cloudSyncStatus = 'synced';
    } catch (e) {
      cloudSyncStatus = 'error';
    }
    render();
  }

  async function signInWithGoogle() {
    if (!fbAuth) { toast('Cloud-Anmeldung nicht verfügbar'); return; }
    const provider = new firebase.auth.GoogleAuthProvider();
    try {
      await fbAuth.signInWithPopup(provider);
    } catch (e) {
      // auth/cancelled-popup-request / auth/popup-closed-by-user: user just backed out, no need to alarm them
      if (e && (e.code === 'auth/cancelled-popup-request' || e.code === 'auth/popup-closed-by-user')) return;
      toast('Google-Anmeldung fehlgeschlagen' + (e && e.code ? ' (' + e.code + ')' : ''));
    }
  }

  function signOutCloud() {
    detachCloudListeners();
    currentUser = null;
    cloudSyncStatus = 'signed-out';
    if (fbAuth) fbAuth.signOut();
    render();
  }

  function initCloudAuth() {
    if (!fbAuth) return;
    fbAuth.onAuthStateChanged((user) => {
      if (user) {
        handleSignedIn(user);
      } else {
        currentUser = null;
        cloudSyncStatus = 'signed-out';
        detachCloudListeners();
        if (currentView === 'settings') render();
      }
    });
  }

  // ---------- Settings ----------
  function saveApiKey() {
    const input = document.getElementById('ors-key-input');
    state.settings.orsApiKey = input.value.trim();
    saveKey('settings');
    toast('API-Key gespeichert');
    retryAllPending();
  }

  async function deleteLocation(id) {
    const ok = await confirmDialog('Diese Adresse löschen?');
    if (!ok) return;
    state.locations = state.locations.filter(l => l.id !== id);
    saveKey('locations');
    toast('Adresse gelöscht');
    render();
  }

  function hasCustomLabel(loc) {
    return !!(loc && loc.label && loc.label !== loc.address);
  }

  function mergeLocations(sourceId, targetId, finalLabel) {
    for (const t of state.trips) {
      if (t.startLocationId === sourceId) t.startLocationId = targetId;
      if (t.endLocationId === sourceId) t.endLocationId = targetId;
      if (Array.isArray(t.waypoints)) {
        t.waypoints = t.waypoints.map((id) => id === sourceId ? targetId : id);
      }
    }
    saveKey('trips');
    const source = findLocation(sourceId);
    const target = findLocation(targetId);
    if (source && target) {
      target.usageCount = (target.usageCount || 0) + (source.usageCount || 0);
      if (source.lastUsedAt && (!target.lastUsedAt || source.lastUsedAt > target.lastUsedAt)) {
        target.lastUsedAt = source.lastUsedAt;
      }
      if (finalLabel !== undefined) {
        target.label = finalLabel;
      }
    }
    state.locations = state.locations.filter(l => l.id !== sourceId);
    saveKey('locations');
  }

  function openMergeTargetPicker(sourceId) {
    const source = findLocation(sourceId);
    if (!source) return;
    const items = sortedByRecency(state.locations)
      .filter(l => l.id !== sourceId)
      .map(l => ({ ...l, __id: l.id }));
    if (!items.length) { toast('Keine weitere Adresse zum Zusammenführen vorhanden'); return; }
    openPicker({
      title: 'Mit welcher Adresse zusammenführen?',
      searchPlaceholder: 'Adresse suchen',
      items,
      matches: (it, q) => (it.label + ' ' + it.address).toLowerCase().includes(q),
      renderItem: (it) => ({ primary: it.label, secondary: it.label !== it.address ? it.address : '' }),
      onSelect: async (it) => {
        closeSheet();
        const target = findLocation(it.id);
        if (!target) return;
        const sourceLabeled = hasCustomLabel(source);
        const targetLabeled = hasCustomLabel(target);
        let finalLabel; // undefined = keep target's current label
        if (sourceLabeled && !targetLabeled) {
          finalLabel = source.label;
        } else if (sourceLabeled && targetLabeled && source.label !== target.label) {
          const choice = await chooseLabelDialog(source.label, target.label);
          if (!choice) return;
          finalLabel = choice === 'a' ? source.label : target.label;
        }
        const resultLabel = finalLabel !== undefined ? finalLabel : target.label;
        const ok = await confirmDialog(`„${source.label}" mit „${target.label}" zusammenführen? Alle Reisen, die „${source.label}" nutzen, werden auf „${resultLabel}" umgestellt. „${source.label}" wird danach gelöscht.`, 'Zusammenführen');
        if (!ok) return;
        mergeLocations(sourceId, target.id, finalLabel);
        toast('Adressen zusammengeführt');
        render();
      }
    });
  }

  function openLocationEditor(id) {
    const loc = findLocation(id);
    if (!loc) return;
    closeSheet();
    const backdrop = document.createElement('div');
    backdrop.id = 'sheet-backdrop';
    backdrop.className = 'sheet-backdrop';
    backdrop.innerHTML = `
      <div class="sheet" role="dialog">
        <div class="sheet-handle"></div>
        <div class="sheet-header">
          <h2>Adresse bearbeiten</h2>
          <button class="btn-text" id="sheet-close">Abbrechen</button>
        </div>
        <form id="edit-loc-form" style="padding: 4px 18px 20px;">
          <div class="field">
            <label for="edit-loc-label">Bezeichnung (optional)</label>
            <div class="text-input-wrap">
              <input type="text" id="edit-loc-label" value="${escapeHtml(loc.label === loc.address ? '' : loc.label)}" placeholder="z. B. Büro Zürich" enterkeyhint="next">
              <button type="button" class="input-clear" data-clear-target="edit-loc-label" aria-label="Eingabe löschen">×</button>
            </div>
          </div>
          <div class="field">
            <label for="edit-loc-address">Adresse</label>
            <div class="text-input-wrap">
              <input type="text" id="edit-loc-address" value="${escapeHtml(loc.address)}" placeholder="Straße, PLZ Ort" enterkeyhint="done">
              <button type="button" class="input-clear" data-clear-target="edit-loc-address" aria-label="Eingabe löschen">×</button>
            </div>
          </div>
          <button type="submit" class="btn-primary" id="edit-loc-save" style="width:100%;">Speichern</button>
        </form>
      </div>
    `;
    appendSheet(backdrop);
    backdrop.querySelector('#sheet-close').addEventListener('click', closeSheet);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeSheet(); });
    backdrop.querySelector('#edit-loc-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const newAddress = backdrop.querySelector('#edit-loc-address').value.trim();
      if (!newAddress) { toast('Bitte eine Adresse angeben'); return; }
      const newLabelInput = backdrop.querySelector('#edit-loc-label').value.trim();
      loc.label = newLabelInput || newAddress;
      if (newAddress !== loc.address) {
        loc.address = newAddress;
        loc.lat = null;
        loc.lon = null;
        loc.resolvedLabel = null;
        loc.verified = false; // manually edited, no longer confirmed via autocomplete
      }
      saveKey('locations');
      closeSheet();
      toast('Adresse aktualisiert');
      render();
    });
    setTimeout(() => backdrop.querySelector('#edit-loc-label').focus(), 50);
  }

  async function deleteVehicle(plate) {
    const ok = await confirmDialog('Dieses Kennzeichen löschen?');
    if (!ok) return;
    state.vehicles = state.vehicles.filter(v => v.plate !== plate);
    saveKey('vehicles');
    toast('Kennzeichen gelöscht');
    render();
  }

  async function deleteObjekt(kuerzel) {
    const ok = await confirmDialog('Dieses Objekt löschen?');
    if (!ok) return;
    state.objekte = state.objekte.filter(o => o.kuerzel !== kuerzel);
    saveKey('objekte');
    toast('Objekt gelöscht');
    render();
  }

  function addNoteSuggestion(text) {
    const trimmed = text.trim();
    if (!trimmed) { toast('Bitte einen Text angeben'); return; }
    if (state.noteSuggestions.some(s => s.text.toLowerCase() === trimmed.toLowerCase())) {
      toast('Dieser Vorschlag ist bereits gespeichert');
      return;
    }
    state.noteSuggestions.push({ id: uid(), text: trimmed });
    saveKey('noteSuggestions');
    toast('Vorschlag gespeichert');
    render();
  }

  function openNoteSuggestionEditor(id) {
    const suggestion = state.noteSuggestions.find(s => s.id === id);
    if (!suggestion) return;
    closeSheet();
    const backdrop = document.createElement('div');
    backdrop.id = 'sheet-backdrop';
    backdrop.className = 'sheet-backdrop';
    backdrop.innerHTML = `
      <div class="sheet" role="dialog">
        <div class="sheet-handle"></div>
        <div class="sheet-header">
          <h2>Anlass-Vorschlag bearbeiten</h2>
          <button class="btn-text" id="sheet-close">Abbrechen</button>
        </div>
        <form id="edit-suggestion-form" style="padding: 4px 18px 20px;">
          <div class="field">
            <label for="edit-suggestion-input">Text</label>
            <div class="text-input-wrap">
              <input type="text" id="edit-suggestion-input" value="${escapeHtml(suggestion.text)}" maxlength="80" enterkeyhint="done">
              <button type="button" class="input-clear" data-clear-target="edit-suggestion-input" aria-label="Eingabe löschen">×</button>
            </div>
          </div>
          <button type="submit" class="btn-primary" id="edit-suggestion-save" style="width:100%;">Speichern</button>
        </form>
      </div>
    `;
    appendSheet(backdrop);
    backdrop.querySelector('#sheet-close').addEventListener('click', closeSheet);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeSheet(); });
    backdrop.querySelector('#edit-suggestion-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const newText = backdrop.querySelector('#edit-suggestion-input').value.trim();
      if (!newText) { toast('Bitte einen Text angeben'); return; }
      suggestion.text = newText;
      saveKey('noteSuggestions');
      closeSheet();
      toast('Vorschlag aktualisiert');
      render();
    });
    setTimeout(() => backdrop.querySelector('#edit-suggestion-input').focus(), 50);
  }

  async function deleteNoteSuggestion(id) {
    const ok = await confirmDialog('Diesen Anlass-Vorschlag löschen?');
    if (!ok) return;
    state.noteSuggestions = state.noteSuggestions.filter(s => s.id !== id);
    saveKey('noteSuggestions');
    toast('Vorschlag gelöscht');
    render();
  }

  // ---------- Views ----------
  function distanceBoxHtml(entry, retryAction) {
    const isWaypointEntry = entry.context === 'immobilien' && Array.isArray(entry.waypoints);
    const hasAllStops = isWaypointEntry ? entry.waypoints.every((id) => id) : !!(entry.startLocationId && entry.endLocationId);
    if (!hasAllStops) {
      return `<div class="distance-box"><span class="distance-value pending">${isWaypointEntry ? 'Alle Stopps wählen' : 'Start und Ziel wählen'}</span></div>`;
    }
    if (entry.distanceStatus === 'ok') {
      const legsLine = (isWaypointEntry && Array.isArray(entry.legs) && entry.legs.length > 1)
        ? `<div class="hint">${entry.legs.map((km) => `${km} km`).join(' + ')} = ${entry.distanceKm} km</div>`
        : '';
      return `<div class="distance-box"><span class="distance-value">${entry.distanceKm} km</span></div>${legsLine}`;
    }
    if (entry.distanceStatus === 'pending' && entry.distanceError) {
      return `<div class="distance-box">
        <span class="distance-value error">${escapeHtml(entry.distanceError)}</span>
        <button class="retry-btn" data-action="${retryAction}">Erneut versuchen</button>
      </div>`;
    }
    return `<div class="distance-box"><span class="distance-value pending">Wird berechnet…</span></div>`;
  }

  function rateBoxHtml(entry) {
    const typeTag = entry.context === 'immobilien' && entry.rateType ? ` · ${RATE_TYPE_LABELS[entry.rateType] || entry.rateType}` : '';
    const label = entry.ratePerKm != null
      ? `${formatEuroPerKm(entry.ratePerKm)} <span class="hint" style="margin:0;display:inline;">(${entry.rateSource === 'manual' ? 'manuell' : 'automatisch'}${typeTag})</span>`
      : '<span class="placeholder">Kein Satz hinterlegt</span>';
    const costLine = entry.cost != null ? `<div class="hint">Kosten dieser Fahrt: ${formatEuro(entry.cost)}</div>` : '';
    return `<div class="distance-box">
        <span class="distance-value">${label}</span>
        <button class="retry-btn" id="btn-edit-rate">Ändern</button>
      </div>${costLine}`;
  }

  function waypointFieldsHtml() {
    const waypoints = draft.waypoints || [null, null];
    return waypoints.map((locId, i) => {
      const loc = locId ? findLocation(locId) : null;
      const label = i === 0 ? 'Start' : (i === waypoints.length - 1 ? 'Ziel' : `Zwischenstopp ${i}`);
      return `
        <div class="field">
          <label>${label}</label>
          <div class="trigger-row">
            <button class="picker-trigger" data-pick-waypoint="${i}">
              <span class="${loc ? '' : 'placeholder'}">${loc ? escapeHtml(loc.label) : label + ' wählen'}</span>
              <span class="chev">›</span>
            </button>
            ${waypoints.length > 2 ? `<button type="button" class="icon-btn" data-remove-waypoint="${i}" aria-label="Stopp entfernen">×</button>` : ''}
          </div>
        </div>`;
    }).join('') + `
        <button type="button" class="btn-text" id="btn-add-waypoint" style="margin: 4px 0 12px 4px;">+ Nächster Stopp</button>`;
  }

  function renderNewView() {
    const startLoc = draft.startLocationId ? findLocation(draft.startLocationId) : null;
    const endLoc = draft.endLocationId ? findLocation(draft.endLocationId) : null;

    return `
      <div class="section-title">${editingTripId ? 'Reise bearbeiten' : 'Neue Reise'}</div>
      <div class="card">
        ${currentContext === 'immobilien' ? waypointFieldsHtml() : `
        <div class="field">
          <label>Start</label>
          <div class="trigger-row">
            <button class="picker-trigger" id="btn-pick-start">
              <span class="${startLoc ? '' : 'placeholder'}">${startLoc ? escapeHtml(startLoc.label) : 'Startort wählen'}</span>
              <span class="chev">›</span>
            </button>
            <button type="button" class="icon-btn" id="btn-gps-start" title="Standort verwenden" aria-label="Standort verwenden">${PIN_ICON}</button>
          </div>
        </div>
        <div class="field">
          <label>Ziel</label>
          <div class="trigger-row">
            <button class="picker-trigger" id="btn-pick-end">
              <span class="${endLoc ? '' : 'placeholder'}">${endLoc ? escapeHtml(endLoc.label) : 'Ziel wählen'}</span>
              <span class="chev">›</span>
            </button>
            <button type="button" class="icon-btn" id="btn-gps-end" title="Standort verwenden" aria-label="Standort verwenden">${PIN_ICON}</button>
          </div>
        </div>`}
        <div class="field">
          <label>Entfernung</label>
          ${distanceBoxHtml(draft, 'retry-draft')}
        </div>
        <div class="field">
          <label>Start</label>
          <div class="two-col">
            <input type="date" id="input-start-date" value="${escapeHtml(splitDateTime(draft.startDateTime).date)}">
            <button type="button" class="picker-trigger" id="btn-pick-start-time">
              <span class="${splitDateTime(draft.startDateTime).time ? '' : 'placeholder'}">${splitDateTime(draft.startDateTime).time || 'Uhrzeit'}</span>
              <span class="chev">›</span>
            </button>
          </div>
        </div>
        <div class="field">
          <label>Rückkehr (optional)</label>
          <div class="two-col">
            <input type="date" id="input-end-date" value="${escapeHtml(splitDateTime(draft.endDateTime).date)}">
            <button type="button" class="picker-trigger" id="btn-pick-end-time">
              <span class="${splitDateTime(draft.endDateTime).time ? '' : 'placeholder'}">${splitDateTime(draft.endDateTime).time || 'Uhrzeit'}</span>
              <span class="chev">›</span>
            </button>
          </div>
        </div>
        <div class="field">
          <label>${currentContext === 'immobilien' ? 'Kilometersatz' : 'Pendlerpauschale'}</label>
          ${rateBoxHtml(draft)}
        </div>
        <div class="field">
          <label>Fahrzeug</label>
          <button class="picker-trigger" id="btn-pick-vehicle">
            <span class="${draft.vehiclePlate ? '' : 'placeholder'}">${draft.vehiclePlate ? escapeHtml(draft.vehiclePlate) : 'Kennzeichen wählen'}</span>
            <span class="chev">›</span>
          </button>
        </div>
        ${currentContext === 'immobilien' ? `
        <div class="field">
          <label>Objekt</label>
          <button class="picker-trigger" id="btn-pick-objekt">
            <span class="${draft.objektKuerzel ? '' : 'placeholder'}">${draft.objektKuerzel ? escapeHtml(draft.objektKuerzel) : 'Objekt wählen'}</span>
            <span class="chev">›</span>
          </button>
        </div>` : ''}
        <div class="field">
          <label>${currentContext === 'immobilien' ? 'Anlass (optional)' : 'Notiz (optional)'}</label>
          ${currentContext === 'immobilien' && state.noteSuggestions.length ? `
          <div class="chip-row">
            ${state.noteSuggestions.map(s => `<button type="button" class="chip-suggestion" data-note-suggestion="${escapeHtml(s.text)}">${escapeHtml(s.text)}</button>`).join('')}
          </div>` : ''}
          <div class="text-input-wrap textarea-wrap">
            <textarea id="input-note" maxlength="1000" placeholder="z. B. Anlass der Reise">${escapeHtml(draft.note)}</textarea>
            <button type="button" class="input-clear" data-clear-target="input-note" aria-label="Eingabe löschen">×</button>
          </div>
          <div class="char-count"><span id="note-count">${draft.note.length}</span> / 1000</div>
        </div>
        ${formatDuration(draft.startDateTime, draft.endDateTime) ? `<div class="hint" style="padding:0 4px;">Dauer: ${escapeHtml(formatDuration(draft.startDateTime, draft.endDateTime))}</div>` : ''}
      </div>
      <button class="btn-primary" id="btn-save-trip">${editingTripId ? 'Änderungen speichern' : 'Reise speichern'}</button>
      <button class="btn-secondary" id="btn-cancel-edit" style="width:100%;margin-top:10px;">Abbrechen</button>
    `;
  }

  function attachNewViewHandlers() {
    const pickStartBtn = document.getElementById('btn-pick-start');
    if (pickStartBtn) pickStartBtn.addEventListener('click', () => openAddressSearch('start'));
    const pickEndBtn = document.getElementById('btn-pick-end');
    if (pickEndBtn) pickEndBtn.addEventListener('click', () => openAddressSearch('end'));
    const gpsStartBtn = document.getElementById('btn-gps-start');
    if (gpsStartBtn) gpsStartBtn.addEventListener('click', () => useGpsForRole('start'));
    const gpsEndBtn = document.getElementById('btn-gps-end');
    if (gpsEndBtn) gpsEndBtn.addEventListener('click', () => useGpsForRole('end'));
    document.querySelectorAll('[data-pick-waypoint]').forEach((btn) => {
      btn.addEventListener('click', () => openAddressSearch(`waypoint-${btn.getAttribute('data-pick-waypoint')}`));
    });
    document.querySelectorAll('[data-remove-waypoint]').forEach((btn) => {
      btn.addEventListener('click', () => removeDraftWaypoint(Number(btn.getAttribute('data-remove-waypoint'))));
    });
    const addWaypointBtn = document.getElementById('btn-add-waypoint');
    if (addWaypointBtn) addWaypointBtn.addEventListener('click', addDraftWaypoint);
    document.getElementById('btn-pick-vehicle').addEventListener('click', openVehiclePicker);
    const pickObjektBtn = document.getElementById('btn-pick-objekt');
    if (pickObjektBtn) pickObjektBtn.addEventListener('click', openObjektPicker);
    document.getElementById('btn-save-trip').addEventListener('click', saveTrip);
    const cancelBtn = document.getElementById('btn-cancel-edit');
    if (cancelBtn) cancelBtn.addEventListener('click', cancelEdit);

    const startDateEl = document.getElementById('input-start-date');
    startDateEl.addEventListener('change', () => {
      draft.startDateTime = combineDateTime(startDateEl.value, splitDateTime(draft.startDateTime).time);
      computeCost(draft);
      render();
    });
    document.getElementById('btn-pick-start-time').addEventListener('click', () => openTimeEditor('start'));

    const endDateEl = document.getElementById('input-end-date');
    endDateEl.addEventListener('change', () => {
      draft.endDateTime = combineDateTime(endDateEl.value, splitDateTime(draft.endDateTime).time);
      render();
    });
    document.getElementById('btn-pick-end-time').addEventListener('click', () => openTimeEditor('end'));
    const editRateBtn = document.getElementById('btn-edit-rate');
    if (editRateBtn) editRateBtn.addEventListener('click', () => openRateEditor({ immo: currentContext === 'immobilien' }));
    const noteEl = document.getElementById('input-note');
    noteEl.addEventListener('input', (e) => {
      draft.note = e.target.value;
      document.getElementById('note-count').textContent = draft.note.length;
    });
    document.querySelectorAll('[data-note-suggestion]').forEach(btn => {
      btn.addEventListener('click', () => {
        draft.note = btn.getAttribute('data-note-suggestion');
        noteEl.value = draft.note;
        document.getElementById('note-count').textContent = draft.note.length;
        noteEl.focus();
      });
    });

    const retryBtn = document.querySelector('[data-action="retry-draft"]');
    if (retryBtn) retryBtn.addEventListener('click', retryDraftDistance);
  }

  function renderTripsView() {
    const tripsInContext = state.trips.filter(t => (t.context || 'pendeln') === currentContext);
    if (!tripsInContext.length) {
      const label = currentContext === 'immobilien' ? 'Immobilien-Reisen' : 'Reisen';
      return `<div class="empty-state">Noch keine ${escapeHtml(label)} erfasst.<br>Nutze „Neu", um deine erste Reise einzutragen.</div>`;
    }
    const sorted = [...tripsInContext].sort((a, b) => (b.startDateTime || '').localeCompare(a.startDateTime || ''));
    let html = '';

    // Group by year first so each year's header can show its total.
    const years = [];
    const byYear = {};
    for (const trip of sorted) {
      const year = trip.startDateTime ? trip.startDateTime.slice(0, 4) : '—';
      if (!byYear[year]) { byYear[year] = []; years.push(year); }
      byYear[year].push(trip);
    }

    for (const year of years) {
      const tripsOfYear = byYear[year];
      const sum = tripsOfYear.reduce((acc, t) => acc + (t.cost != null ? t.cost : 0), 0);
      const missing = tripsOfYear.filter(t => t.cost == null).length;
      const sumText = missing < tripsOfYear.length
        ? `Summe: ${formatEuro(sum)}${missing ? ` (${missing} ohne Kosten)` : ''}`
        : 'Summe: —';
      html += `<div class="section-title" style="display:flex; justify-content:space-between; align-items:baseline;"><span>${escapeHtml(year)}</span><span>${sumText}</span></div>`;

      for (const trip of tripsOfYear) {
        const distText = trip.distanceStatus === 'ok'
          ? `${trip.distanceKm} km${trip.cost != null ? ' · ' + formatEuro(trip.cost) : ''}`
          : (trip.distanceStatus === 'pending' ? '…' : '');
        html += `
          <div class="trip-card">
            <div class="trip-row-top">
              <span class="trip-route">${tripLocationIds(trip).map((id) => locationLabelHtml(id)).join(' → ')}</span>
              <span class="trip-km">${distText}</span>
            </div>
            <div class="trip-meta">${formatDateTime(trip.startDateTime)}${trip.endDateTime ? ' – ' + formatDateTime(trip.endDateTime) : ' · <span class="warn-text">keine Rückkehrzeit</span>'}</div>
            ${formatDuration(trip.startDateTime, trip.endDateTime) ? `<div class="trip-meta">Dauer: ${escapeHtml(formatDuration(trip.startDateTime, trip.endDateTime))}</div>` : ''}
            ${trip.context === 'immobilien' && trip.objektKuerzel ? `<div class="trip-meta">Objekt: ${escapeHtml(trip.objektKuerzel)}</div>` : ''}
            <div class="trip-meta">${escapeHtml(trip.vehiclePlate)}${trip.ratePerKm != null ? ' · ' + formatEuroPerKm(trip.ratePerKm) : ''}</div>
            ${trip.note ? `<div class="trip-note">${escapeHtml(trip.note)}</div>` : ''}
            ${trip.distanceStatus === 'pending' ? `<div class="hint">${escapeHtml(trip.distanceError || 'Distanz wird nachgeholt, sobald Internet verfügbar ist.')}</div>` : ''}
            ${(trip.context || 'pendeln') === 'pendeln' && trip.distanceStatus === 'ok' && trip.cost == null ? `<div class="hint">Keine Pendlerpauschale für dieses Datum hinterlegt.</div>` : ''}
            ${trip.context === 'immobilien' && trip.distanceStatus === 'ok' && trip.cost == null ? `<div class="hint">Kein Kilometersatz für dieses Datum hinterlegt.</div>` : ''}
            ${tripLocationIds(trip).map((id) => findLocation(id)).some(l => l && isUnverifiedLocation(l)) ? `<div class="hint warn-text">Manuell erfasste Adresse — bitte Genauigkeit prüfen</div>` : ''}
            <div class="trip-actions">
              <button class="btn-text" data-edit="${escapeHtml(trip.id)}">Bearbeiten</button>
              ${trip.distanceStatus === 'pending' ? `<button class="btn-text" data-retry="${escapeHtml(trip.id)}">Distanz erneut versuchen</button>` : ''}
              <button class="btn-danger" data-delete="${escapeHtml(trip.id)}">Löschen</button>
            </div>
          </div>
        `;
      }
    }
    return html;
  }

  function attachTripsViewHandlers() {
    document.querySelectorAll('[data-edit]').forEach(btn => {
      btn.addEventListener('click', () => startEditTrip(btn.getAttribute('data-edit')));
    });
    document.querySelectorAll('[data-delete]').forEach(btn => {
      btn.addEventListener('click', () => deleteTrip(btn.getAttribute('data-delete')));
    });
    document.querySelectorAll('[data-retry]').forEach(btn => {
      btn.addEventListener('click', () => retryTripDistance(btn.getAttribute('data-retry')));
    });
  }

  function renderSettingsView() {
    const locRows = state.locations.length
      ? sortedByRecency(state.locations).map(l => `
        <div class="manage-row" style="flex-direction:column; align-items:stretch; gap:8px;">
          <div>
            <div>${escapeHtml(l.label)}</div>
            <div class="sub">${escapeHtml(l.address)}</div>
            ${isUnverifiedLocation(l) ? `<div class="sub warn-text">manuell erfasst${l.resolvedLabel ? ' · aufgelöst als: ' + escapeHtml(l.resolvedLabel) : ''}</div>` : ''}
          </div>
          <div style="display:flex; gap:16px;">
            <button class="btn-text" data-edit-loc="${escapeHtml(l.id)}">Bearbeiten</button>
            <button class="btn-text" data-merge-loc="${escapeHtml(l.id)}">Zusammenführen</button>
            <button class="btn-danger" data-del-loc="${escapeHtml(l.id)}">Löschen</button>
          </div>
        </div>`).join('')
      : `<div class="hint">Noch keine Adressen gespeichert.</div>`;

    const vehRows = state.vehicles.length
      ? sortedByRecency(state.vehicles).map(v => `
        <div class="manage-row">
          <div>${escapeHtml(v.plate)}</div>
          <button class="btn-danger" data-del-veh="${escapeHtml(v.plate)}">Löschen</button>
        </div>`).join('')
      : `<div class="hint">Noch keine Kennzeichen gespeichert.</div>`;

    const objRows = state.objekte.length
      ? sortedByRecency(state.objekte).map(o => `
        <div class="manage-row">
          <div>${escapeHtml(o.kuerzel)}</div>
          <button class="btn-danger" data-del-obj="${escapeHtml(o.kuerzel)}">Löschen</button>
        </div>`).join('')
      : `<div class="hint">Noch keine Objekte gespeichert.</div>`;

    const suggestionRows = state.noteSuggestions.length
      ? state.noteSuggestions.map(s => `
        <div class="manage-row">
          <div>${escapeHtml(s.text)}</div>
          <div style="display:flex; gap:16px;">
            <button class="btn-text" data-edit-suggestion="${escapeHtml(s.id)}">Bearbeiten</button>
            <button class="btn-danger" data-del-suggestion="${escapeHtml(s.id)}">Löschen</button>
          </div>
        </div>`).join('')
      : `<div class="hint">Noch keine Anlass-Vorschläge gespeichert.</div>`;

    const rateRows = state.rates.length
      ? [...state.rates].sort((a, b) => b.validFrom.localeCompare(a.validFrom)).map(r => `
        <div class="manage-row">
          <div>ab ${formatDateOnly(r.validFrom)} <span class="sub">${formatEuroPerKm(r.amount)}</span></div>
          <button class="btn-danger" data-del-rate="${escapeHtml(r.id)}">Löschen</button>
        </div>`).join('')
      : `<div class="hint">Noch keine Pendlerpauschale hinterlegt. Ohne Satz werden keine Kosten berechnet.</div>`;

    const immoRateRows = state.immoRates.length
      ? [...state.immoRates].sort((a, b) => b.validFrom.localeCompare(a.validFrom)).map(r => `
        <div class="manage-row">
          <div>ab ${formatDateOnly(r.validFrom)} <span class="sub">${formatEuroPerKm(r.amount)} · ${escapeHtml(RATE_TYPE_LABELS[r.rateType] || r.rateType)}</span></div>
          <button class="btn-danger" data-del-immo-rate="${escapeHtml(r.id)}">Löschen</button>
        </div>`).join('')
      : `<div class="hint">Noch kein Kilometersatz hinterlegt. Ohne Satz werden keine Kosten berechnet.</div>`;

    const homeLoc = state.settings.homeLocationId ? findLocation(state.settings.homeLocationId) : null;
    const workLoc = state.settings.workLocationId ? findLocation(state.settings.workLocationId) : null;

    return `
      <div class="section-title">Cloud-Synchronisation</div>
      <div class="card">
        ${currentUser ? `
          <div class="hint" style="margin:0 0 14px;">Angemeldet als ${escapeHtml(currentUser.email || currentUser.displayName || '')} · ${cloudSyncStatusText()}</div>
          <button class="btn-secondary" id="btn-cloud-signout" style="width:100%;">Abmelden</button>
        ` : `
          <div class="hint" style="margin:0 0 14px;">Melde dich an, um Reisen, Adressen, Fahrzeuge und Kilometersätze automatisch zwischen iPhone, iPad und Mac zu synchronisieren.</div>
          <button class="btn-primary" id="btn-cloud-signin" style="width:100%;">Mit Google anmelden</button>
        `}
      </div>

      <div class="section-title">Backup</div>
      <div class="card">
        <div class="hint" style="margin-top:0; margin-bottom:14px;">Alle Daten liegen ausschließlich lokal auf diesem Gerät. Wird die App vom Home-Bildschirm gelöscht, können Reisen, Adressen und Einstellungen unwiederbringlich verloren gehen. Erstelle daher regelmäßig ein Backup und sichere die Datei z. B. in iCloud Drive oder per Mail.</div>
        <button class="btn-secondary" id="btn-export-backup" style="width:100%; margin-bottom:10px;">Backup exportieren</button>
        <button class="btn-secondary" id="btn-import-backup" style="width:100%;">Backup importieren</button>
        <input type="file" id="import-backup-input" accept="application/json,.json" hidden>
      </div>

      ${currentContext === 'pendeln' ? `
      <div class="section-title">Pendlerpauschale</div>
      <div class="card">
        ${rateRows}
        <div class="field" style="margin-top:16px;">
          <label>Neuer Satz</label>
          <div class="two-col">
            <input type="date" id="new-rate-date" value="${escapeHtml(todayDateStr())}">
            <div class="input-suffix"><input type="text" inputmode="decimal" id="new-rate-amount" placeholder="0,40"><span class="suffix">€/km</span></div>
          </div>
          <div class="hint">Betrag in Euro pro Kilometer, gültig ab dem gewählten Datum. Bei rückwirkenden Änderungen fragen wir nach, ob bereits erfasste Fahrten angepasst werden sollen.</div>
        </div>
        <button class="btn-secondary" id="btn-add-rate">Satz speichern</button>
      </div>

      <div class="section-title">Pendeln-Adressen</div>
      <div class="card">
        <div class="field">
          <label>Zuhause (optional)</label>
          <div class="trigger-row">
            <button class="picker-trigger" id="btn-pick-home">
              <span class="${homeLoc ? '' : 'placeholder'}">${homeLoc ? escapeHtml(homeLoc.label) : 'Nicht festgelegt'}</span>
              <span class="chev">›</span>
            </button>
            ${homeLoc ? `<button type="button" class="icon-btn" id="btn-clear-home" aria-label="Zuhause entfernen">×</button>` : ''}
          </div>
        </div>
        <div class="field">
          <label>Arbeit (optional)</label>
          <div class="trigger-row">
            <button class="picker-trigger" id="btn-pick-work">
              <span class="${workLoc ? '' : 'placeholder'}">${workLoc ? escapeHtml(workLoc.label) : 'Nicht festgelegt'}</span>
              <span class="chev">›</span>
            </button>
            ${workLoc ? `<button type="button" class="icon-btn" id="btn-clear-work" aria-label="Arbeit entfernen">×</button>` : ''}
          </div>
        </div>
        <div class="hint">Werden beim Anlegen einer neuen Pendeln-Reise automatisch als Start bzw. Ziel vorgeschlagen — bleiben pro Reise änderbar.</div>
      </div>` : ''}

      <div class="section-title">Routing</div>
      <div class="card">
        <div class="field">
          <label for="ors-key-input">OpenRouteService API-Key</label>
          <div class="text-input-wrap">
            <input type="password" id="ors-key-input" placeholder="API-Key einfügen" value="${escapeHtml(state.settings.orsApiKey)}" autocomplete="off">
            <button type="button" class="input-clear" data-clear-target="ors-key-input" aria-label="Eingabe löschen">×</button>
          </div>
          <div class="hint">Wird nur auf diesem Gerät gespeichert (lokal im Browser) und ausschließlich für die Distanzberechnung genutzt. Kostenlosen Key auf openrouteservice.org erstellen.</div>
        </div>
        <button class="btn-secondary" id="btn-save-key">Speichern</button>
      </div>

      <div class="section-title">Gespeicherte Adressen</div>
      <div class="card">${locRows}</div>

      <div class="section-title">Gespeicherte Kennzeichen</div>
      <div class="card">${vehRows}</div>

      ${currentContext === 'immobilien' ? `
      <div class="section-title">Gespeicherte Objekte</div>
      <div class="card">${objRows}</div>

      <div class="section-title">Kilometersatz (Immobilien)</div>
      <div class="card">
        ${immoRateRows}
        <div class="field" style="margin-top:16px;">
          <label>Neuer Satz</label>
          <div class="two-col">
            <input type="date" id="new-immo-rate-date" value="${escapeHtml(todayDateStr())}">
            <div class="input-suffix"><input type="text" inputmode="decimal" id="new-immo-rate-amount" placeholder="0,40"><span class="suffix">€/km</span></div>
          </div>
          <div class="field" style="margin-top:10px;">
            <label for="new-immo-rate-type">Art</label>
            <select id="new-immo-rate-type">
              <option value="pauschal">Pauschal</option>
              <option value="tatsaechlich">Tatsächliche Kosten</option>
              <option value="tabelle">Tabelle</option>
            </select>
          </div>
          <div class="hint">Betrag in Euro pro Kilometer, gültig ab dem gewählten Datum. Alle drei Arten funktionieren aktuell technisch gleich (manueller Betrag) — die Unterscheidung bereitet spätere automatische Berechnung vor.</div>
        </div>
        <button class="btn-secondary" id="btn-add-immo-rate">Satz speichern</button>
      </div>

      <div class="section-title">Anlass-Vorschläge</div>
      <div class="card">
        ${suggestionRows}
        <div class="field" style="margin-top:16px;">
          <label>Neuer Vorschlag</label>
          <div class="text-input-wrap">
            <input type="text" id="new-suggestion-input" placeholder="z. B. Rücknahme" maxlength="80">
            <button type="button" class="input-clear" data-clear-target="new-suggestion-input" aria-label="Eingabe löschen">×</button>
          </div>
        </div>
        <button class="btn-secondary" id="btn-add-suggestion">Vorschlag speichern</button>
      </div>` : ''}

      <div class="hint" style="margin-top:18px; padding: 0 4px;">${currentUser ? 'Deine Daten werden mit deinem Google-Konto synchronisiert und stehen auf all deinen angemeldeten Geräten zur Verfügung.' : 'Alle Daten (Reisen, Adressen, Fahrzeuge) liegen ausschließlich lokal in diesem Browser auf diesem Gerät. Mit Cloud-Synchronisation (oben) stehen sie auch auf deinen anderen Geräten zur Verfügung.'}</div>
    `;
  }

  function attachSettingsViewHandlers() {
    const cloudSignInBtn = document.getElementById('btn-cloud-signin');
    if (cloudSignInBtn) cloudSignInBtn.addEventListener('click', signInWithGoogle);
    const cloudSignOutBtn = document.getElementById('btn-cloud-signout');
    if (cloudSignOutBtn) cloudSignOutBtn.addEventListener('click', signOutCloud);
    document.getElementById('btn-export-backup').addEventListener('click', exportBackup);
    const importInput = document.getElementById('import-backup-input');
    document.getElementById('btn-import-backup').addEventListener('click', () => importInput.click());
    importInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) importBackupFile(file);
      e.target.value = '';
    });
    document.getElementById('btn-save-key').addEventListener('click', saveApiKey);
    document.querySelectorAll('[data-del-loc]').forEach(btn => {
      btn.addEventListener('click', () => deleteLocation(btn.getAttribute('data-del-loc')));
    });
    document.querySelectorAll('[data-edit-loc]').forEach(btn => {
      btn.addEventListener('click', () => openLocationEditor(btn.getAttribute('data-edit-loc')));
    });
    document.querySelectorAll('[data-merge-loc]').forEach(btn => {
      btn.addEventListener('click', () => openMergeTargetPicker(btn.getAttribute('data-merge-loc')));
    });
    document.querySelectorAll('[data-del-veh]').forEach(btn => {
      btn.addEventListener('click', () => deleteVehicle(btn.getAttribute('data-del-veh')));
    });
    document.querySelectorAll('[data-del-obj]').forEach(btn => {
      btn.addEventListener('click', () => deleteObjekt(btn.getAttribute('data-del-obj')));
    });
    const addSuggestionBtn = document.getElementById('btn-add-suggestion');
    if (addSuggestionBtn) {
      addSuggestionBtn.addEventListener('click', () => {
        const input = document.getElementById('new-suggestion-input');
        addNoteSuggestion(input.value);
      });
    }
    document.querySelectorAll('[data-edit-suggestion]').forEach(btn => {
      btn.addEventListener('click', () => openNoteSuggestionEditor(btn.getAttribute('data-edit-suggestion')));
    });
    document.querySelectorAll('[data-del-suggestion]').forEach(btn => {
      btn.addEventListener('click', () => deleteNoteSuggestion(btn.getAttribute('data-del-suggestion')));
    });
    const addRateBtn = document.getElementById('btn-add-rate');
    if (addRateBtn) addRateBtn.addEventListener('click', addRate);
    document.querySelectorAll('[data-del-rate]').forEach(btn => {
      btn.addEventListener('click', () => deleteRate(btn.getAttribute('data-del-rate')));
    });
    const addImmoRateBtn = document.getElementById('btn-add-immo-rate');
    if (addImmoRateBtn) addImmoRateBtn.addEventListener('click', addImmoRate);
    document.querySelectorAll('[data-del-immo-rate]').forEach(btn => {
      btn.addEventListener('click', () => deleteImmoRate(btn.getAttribute('data-del-immo-rate')));
    });
    const pickHomeBtn = document.getElementById('btn-pick-home');
    if (pickHomeBtn) pickHomeBtn.addEventListener('click', () => openAddressSearch('settings-home'));
    const pickWorkBtn = document.getElementById('btn-pick-work');
    if (pickWorkBtn) pickWorkBtn.addEventListener('click', () => openAddressSearch('settings-work'));
    const clearHomeBtn = document.getElementById('btn-clear-home');
    if (clearHomeBtn) clearHomeBtn.addEventListener('click', () => { state.settings.homeLocationId = null; saveKey('settings'); render(); });
    const clearWorkBtn = document.getElementById('btn-clear-work');
    if (clearWorkBtn) clearWorkBtn.addEventListener('click', () => { state.settings.workLocationId = null; saveKey('settings'); render(); });
  }

  // ---------- Router / render ----------
  function render() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-view') === currentView);
    });
    document.querySelectorAll('.context-btn').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-context') === currentContext);
    });
    const root = document.getElementById('view-root');
    if (currentView === 'new') {
      root.innerHTML = renderNewView();
      attachNewViewHandlers();
    } else if (currentView === 'trips') {
      root.innerHTML = renderTripsView();
      attachTripsViewHandlers();
    } else {
      root.innerHTML = renderSettingsView();
      attachSettingsViewHandlers();
    }
    updateOnlineBadge();
  }

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (editingTripId && btn.getAttribute('data-view') !== 'new') {
        const ok = await confirmDialog('Bearbeitung abbrechen? Ungespeicherte Änderungen gehen verloren.', 'Verwerfen');
        if (!ok) return;
        editingTripId = null;
        draft = makeEmptyDraft();
      }
      currentView = btn.getAttribute('data-view');
      render();
    });
  });

  document.querySelectorAll('.context-btn').forEach(btn => {
    btn.addEventListener('click', () => setContext(btn.getAttribute('data-context')));
  });

  // ---------- Clearable text fields ----------
  // Delegated on document so it works for every current and future sheet
  // without each one needing its own listener wiring.
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.input-clear');
    if (!btn) return;
    const input = document.getElementById(btn.getAttribute('data-clear-target'));
    if (!input) return;
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
  });

  // ---------- Service worker ----------
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => { /* offline shell unavailable, app still works online */ });
    });
  }

  document.getElementById('app-version').textContent = 'v' + APP_VERSION;
  document.body.dataset.context = currentContext;

  // Backfill cost for trips saved before the rate feature existed, or before a rate was configured.
  (function backfillCosts() {
    let changed = false;
    for (const t of state.trips) {
      if (t.rateSource !== 'manual' && t.cost == null) {
        computeCost(t);
        if (t.cost != null) changed = true;
      }
    }
    if (changed) saveKey('trips');
  })();

  render();
  retryAllPending();
  initCloudAuth();
})();

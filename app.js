(() => {
  'use strict';

  const APP_VERSION = '1.4.1';
  const STORAGE_PREFIX = 'rkt:';
  const ORS_BASE = 'https://api.openrouteservice.org';

  const DEFAULTS = {
    trips: [],
    locations: [],
    vehicles: [],
    routeCache: {},
    rates: [],
    settings: { orsApiKey: '' }
  };

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
  }

  const state = {
    trips: loadKey('trips'),
    locations: loadKey('locations'),
    vehicles: loadKey('vehicles'),
    routeCache: loadKey('routeCache'),
    rates: loadKey('rates'),
    settings: loadKey('settings')
  };

  let currentView = 'new';
  let editingTripId = null;
  let draft = makeEmptyDraft();

  function makeEmptyDraft() {
    const d = {
      startLocationId: null,
      endLocationId: null,
      distanceKm: null,
      distanceStatus: 'empty', // empty | pending | ok
      distanceError: null,
      startDateTime: toDatetimeLocalValue(new Date()),
      endDateTime: '',
      vehiclePlate: '',
      note: '',
      ratePerKm: null,
      rateSource: 'auto', // auto | manual
      cost: null
    };
    computeCost(d);
    return d;
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

  // ---------- Offline badge ----------
  function updateOnlineBadge() {
    document.getElementById('offline-badge').hidden = navigator.onLine;
  }
  window.addEventListener('online', () => { updateOnlineBadge(); retryAllPending(); });
  window.addEventListener('offline', updateOnlineBadge);

  // ---------- Locations / vehicles lookup ----------
  function findLocation(id) { return state.locations.find(l => l.id === id); }
  function locationLabel(id) {
    const loc = findLocation(id);
    return loc ? loc.label : '(gelöschte Adresse)';
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

  // ---------- Kilometersatz / Kosten ----------
  function findApplicableRate(dateTimeStr) {
    const day = (dateTimeStr || '').slice(0, 10);
    if (!day) return null;
    const sorted = [...state.rates].sort((a, b) => a.validFrom.localeCompare(b.validFrom));
    let applicable = null;
    for (const r of sorted) {
      if (r.validFrom <= day) applicable = r; else break;
    }
    return applicable;
  }

  // Mutates `entry` (a trip or the draft): resolves ratePerKm (unless manually overridden)
  // and (re)computes cost from the current distanceKm. Safe to call any time.
  function computeCost(entry) {
    if (entry.rateSource !== 'manual') {
      const r = findApplicableRate(entry.startDateTime);
      entry.ratePerKm = r ? r.amount : null;
      entry.rateSource = 'auto';
    }
    if (entry.distanceStatus === 'ok' && entry.distanceKm != null && entry.ratePerKm != null) {
      entry.cost = Math.round(entry.distanceKm * entry.ratePerKm * 100) / 100;
    } else {
      entry.cost = null;
    }
  }

  // Trips whose auto-resolved rate changes because of `rate` (already inserted into state.rates).
  function affectedTripsForRate(rate) {
    const sorted = [...state.rates].sort((a, b) => a.validFrom.localeCompare(b.validFrom));
    const idx = sorted.findIndex(r => r.id === rate.id);
    const windowStart = rate.validFrom;
    const windowEnd = sorted[idx + 1] ? sorted[idx + 1].validFrom : null;
    return state.trips.filter(t => {
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

    const affected = affectedTripsForRate(rate);
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
    toast('Kilometersatz gespeichert');
    render();
  }

  async function deleteRate(id) {
    const ok = await confirmDialog('Diesen Kilometersatz löschen?');
    if (!ok) return;
    state.rates = state.rates.filter(r => r.id !== id);
    saveKey('rates');
    for (const t of state.trips) {
      if (t.rateSource === 'auto') computeCost(t);
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
    return { lat, lon };
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
    const res = await fetch(`${ORS_BASE}/geocode/autocomplete?${params.toString()}`);
    if (!res.ok) throw new Error('autocomplete-failed');
    const data = await res.json();
    return (data.features || []).map(f => ({
      label: f.properties.label,
      lat: f.geometry.coordinates[1],
      lon: f.geometry.coordinates[0],
      layer: f.properties.layer,
      gid: f.properties.gid,
      street: f.properties.street || '',
      housenumber: f.properties.housenumber || ''
    }));
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

  async function retryAllPending() {
    const pending = state.trips.filter(t => t.distanceStatus === 'pending');
    if (!pending.length) return;
    for (const trip of pending) {
      await calcDistance(trip);
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

  async function retryDraftDistance() {
    if (!(draft.startLocationId && draft.endLocationId)) return;
    const p = calcDistance(draft);
    render();
    await p;
    render();
  }

  async function retryTripDistance(tripId) {
    const trip = state.trips.find(t => t.id === tripId);
    if (!trip) return;
    await calcDistance(trip);
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
      document.body.appendChild(backdrop);
      const cleanup = (result) => { backdrop.remove(); resolve(result); };
      backdrop.querySelector('#confirm-cancel').addEventListener('click', () => cleanup(false));
      backdrop.querySelector('#confirm-ok').addEventListener('click', () => cleanup(true));
      backdrop.addEventListener('click', (e) => { if (e.target === backdrop) cleanup(false); });
    });
  }

  // ---------- Trip CRUD ----------
  function validateDraft() {
    return !!(draft.startLocationId && draft.endLocationId && draft.startDateTime && draft.vehiclePlate);
  }

  async function saveTrip() {
    if (!validateDraft()) {
      toast('Bitte Start, Ziel, Datum und Fahrzeug angeben');
      return;
    }
    const startLoc = findLocation(draft.startLocationId);
    const endLoc = findLocation(draft.endLocationId);
    const veh = state.vehicles.find(v => v.plate === draft.vehiclePlate);

    if (editingTripId) {
      const trip = state.trips.find(t => t.id === editingTripId);
      const routeChanged = trip.startLocationId !== draft.startLocationId || trip.endLocationId !== draft.endLocationId;
      Object.assign(trip, {
        startLocationId: draft.startLocationId,
        endLocationId: draft.endLocationId,
        startDateTime: draft.startDateTime,
        endDateTime: draft.endDateTime,
        vehiclePlate: draft.vehiclePlate,
        note: draft.note,
        ratePerKm: draft.ratePerKm,
        rateSource: draft.rateSource,
        updatedAt: nowIso()
      });
      if (routeChanged) {
        trip.distanceKm = null;
        trip.distanceStatus = 'pending';
        trip.distanceError = null;
      }
      bumpUsage(startLoc, endLoc, veh);
      computeCost(trip);
      saveKey('trips');
      if (trip.distanceStatus !== 'ok') {
        await calcDistance(trip);
        saveKey('trips');
      }
      editingTripId = null;
    } else {
      const trip = {
        id: uid(),
        startLocationId: draft.startLocationId,
        endLocationId: draft.endLocationId,
        distanceKm: draft.distanceKm,
        distanceStatus: draft.distanceStatus === 'ok' ? 'ok' : 'pending',
        distanceError: null,
        startDateTime: draft.startDateTime,
        endDateTime: draft.endDateTime,
        vehiclePlate: draft.vehiclePlate,
        note: draft.note,
        ratePerKm: draft.ratePerKm,
        rateSource: draft.rateSource,
        cost: draft.cost,
        createdAt: nowIso(),
        updatedAt: nowIso()
      };
      state.trips.push(trip);
      bumpUsage(startLoc, endLoc, veh);
      computeCost(trip);
      saveKey('trips');
      if (trip.distanceStatus !== 'ok') {
        await calcDistance(trip);
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
      startLocationId: trip.startLocationId,
      endLocationId: trip.endLocationId,
      distanceKm: trip.distanceKm,
      distanceStatus: trip.distanceStatus,
      distanceError: trip.distanceError,
      startDateTime: trip.startDateTime,
      endDateTime: trip.endDateTime,
      vehiclePlate: trip.vehiclePlate,
      note: trip.note,
      ratePerKm: trip.ratePerKm != null ? trip.ratePerKm : null,
      rateSource: trip.rateSource || 'auto',
      cost: trip.cost != null ? trip.cost : null
    };
    currentView = 'new';
    render();
  }

  function cancelEdit() {
    editingTripId = null;
    draft = makeEmptyDraft();
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
          <input type="text" id="sheet-search-input" placeholder="${escapeHtml(searchPlaceholder)}" autocomplete="off" autocapitalize="words" enterkeyhint="done">
        </div>
        <div class="sheet-list" id="sheet-list"></div>
      </div>
    `;
    document.body.appendChild(backdrop);

    const listEl = backdrop.querySelector('#sheet-list');
    const searchEl = backdrop.querySelector('#sheet-search-input');

    function renderList() {
      const q = searchEl.value.trim().toLowerCase();
      const filtered = q ? items.filter(it => matches(it, q)) : items;
      let html = '';
      const exact = q && items.some(it => matches(it, q) && matches.exact && matches.exact(it, q));
      if (q && onCreate) {
        html += `<button class="sheet-item new-item" data-action="create">+ „${escapeHtml(searchEl.value.trim())}" hinzufügen</button>`;
      }
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
      const createBtn = listEl.querySelector('.sheet-item[data-action="create"]');
      if (createBtn) {
        createBtn.addEventListener('click', () => onCreate(searchEl.value.trim()));
      }
    }

    searchEl.addEventListener('input', renderList);
    searchEl.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const q = searchEl.value.trim();
      if (!q) return;
      const qLower = q.toLowerCase();
      const filtered = items.filter(it => matches(it, qLower));
      if (filtered.length === 1) {
        onSelect(filtered[0]);
      } else if (onCreate) {
        onCreate(q);
      }
    });
    backdrop.querySelector('#sheet-close').addEventListener('click', closeSheet);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeSheet(); });

    renderList();
    setTimeout(() => searchEl.focus(), 50);
  }

  function openLocationPicker(role) {
    const items = sortedByRecency(state.locations).map(l => ({ ...l, __id: l.id }));
    openPicker({
      title: role === 'start' ? 'Startort wählen' : 'Ziel wählen',
      searchPlaceholder: 'Adresse suchen oder neu eingeben',
      items,
      matches: (it, q) => (it.label + ' ' + it.address).toLowerCase().includes(q),
      renderItem: (it) => ({ primary: it.label, secondary: it.label !== it.address ? it.address : '' }),
      onSelect: (it) => { closeSheet(); setDraftLocation(role, it.id); },
      onCreate: (query) => openLocationCreateForm(role, query)
    });
  }

  function openLocationCreateForm(role, prefillQuery) {
    closeSheet();
    const backdrop = document.createElement('div');
    backdrop.id = 'sheet-backdrop';
    backdrop.className = 'sheet-backdrop';
    backdrop.innerHTML = `
      <div class="sheet" role="dialog">
        <div class="sheet-handle"></div>
        <div class="sheet-header">
          <h2>Neue Adresse</h2>
          <button class="btn-text" id="sheet-close">Abbrechen</button>
        </div>
        <div style="padding: 0 18px 4px;">
          <button type="button" class="btn-primary" id="btn-use-location" style="width:100%;">Aktuellen Standort verwenden</button>
          <div class="hint" id="gps-result-hint" hidden></div>
        </div>
        <form id="new-loc-form" style="padding: 16px 18px 20px;">
          <div class="field">
            <label for="new-loc-label">Bezeichnung (optional)</label>
            <input type="text" id="new-loc-label" placeholder="z. B. Büro Zürich" enterkeyhint="next">
          </div>
          <div class="field">
            <label for="new-loc-place">Ort</label>
            <input type="text" id="new-loc-place" placeholder="z. B. Zürich" autocomplete="off" autocapitalize="words" enterkeyhint="next">
            <div class="autocomplete-list" id="new-loc-place-list" hidden></div>
          </div>
          <div class="field">
            <label for="new-loc-street">Straße</label>
            <input type="text" id="new-loc-street" placeholder="Erst Ort wählen" autocomplete="off" autocapitalize="words" enterkeyhint="next" disabled>
            <div class="autocomplete-list" id="new-loc-street-list" hidden></div>
          </div>
          <div class="field">
            <label for="new-loc-housenumber">Hausnummer (optional)</label>
            <input type="text" id="new-loc-housenumber" placeholder="1" inputmode="numeric" enterkeyhint="done">
          </div>
          <button type="submit" class="btn-primary" id="new-loc-save">Adresse speichern & auswählen</button>
        </form>
      </div>
    `;
    document.body.appendChild(backdrop);
    backdrop.querySelector('#sheet-close').addEventListener('click', closeSheet);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeSheet(); });

    let selectedPlace = null; // {label, lat, lon} once a suggestion was picked
    const placeInput = backdrop.querySelector('#new-loc-place');
    const placeList = backdrop.querySelector('#new-loc-place-list');
    const streetInput = backdrop.querySelector('#new-loc-street');
    const streetList = backdrop.querySelector('#new-loc-street-list');
    const houseInput = backdrop.querySelector('#new-loc-housenumber');

    function setStreetEnabled(enabled) {
      streetInput.disabled = !enabled;
      streetInput.placeholder = enabled ? 'z. B. Bahnhofstrasse' : 'Erst Ort wählen';
    }

    placeInput.addEventListener('input', () => {
      selectedPlace = null;
      setStreetEnabled(false);
    });
    placeInput.addEventListener('focus', requestAmbientFocus, { once: true });

    attachAutocomplete(placeInput, placeList, {
      layers: 'locality,localadmin',
      getFocus: () => ambientFocus,
      onSelect: (r) => {
        placeInput.value = r.label;
        selectedPlace = r;
        setStreetEnabled(true);
        streetInput.value = '';
        streetInput.focus();
      }
    });

    attachAutocomplete(streetInput, streetList, {
      layers: 'street,address',
      getFocus: () => selectedPlace ? { lat: selectedPlace.lat, lon: selectedPlace.lon } : null,
      getBoundaryGid: () => selectedPlace ? selectedPlace.gid : null,
      getBoundary: () => (selectedPlace && !selectedPlace.gid) ? { lat: selectedPlace.lat, lon: selectedPlace.lon, radiusKm: 15 } : null,
      dedupeKey: (r) => (r.street || r.label.split(',')[0].trim()).toLowerCase(),
      renderLabel: (r) => r.street || r.label.split(',')[0].trim(),
      onSelect: (r) => {
        streetInput.value = r.street || r.label.split(',')[0].trim();
      }
    });

    backdrop.querySelector('#btn-use-location').addEventListener('click', (e) => {
      const btn = e.currentTarget;
      if (!navigator.geolocation) { toast('Standortbestimmung wird von diesem Gerät nicht unterstützt'); return; }
      btn.disabled = true;
      btn.textContent = 'Standort wird ermittelt…';
      const reset = () => { btn.disabled = false; btn.textContent = 'Aktuellen Standort verwenden'; };
      navigator.geolocation.getCurrentPosition(
        async (pos) => {
          try {
            const r = await geocodeReverse(pos.coords.latitude, pos.coords.longitude);
            const ortLabel = [r.postalcode, r.locality || r.label].filter(Boolean).join(' ');
            placeInput.value = ortLabel;
            selectedPlace = { label: ortLabel, lat: r.lat, lon: r.lon, gid: null };
            setStreetEnabled(true);
            streetInput.value = r.street || '';
            houseInput.value = r.housenumber || '';
            const hintEl = backdrop.querySelector('#gps-result-hint');
            hintEl.hidden = false;
            hintEl.textContent = `Vorschlag: ${buildAddressFromParts(r.street, r.housenumber, ortLabel)} — bitte prüfen, v. a. die Hausnummer`;
          } catch (err) {
            toast(err && err.message === 'no-key' ? 'Kein API-Key hinterlegt' : 'Standort konnte nicht aufgelöst werden');
          } finally {
            reset();
          }
        },
        () => { toast('Standortzugriff nicht möglich oder abgelehnt'); reset(); },
        { enableHighAccuracy: true, timeout: 10000 }
      );
    });

    backdrop.querySelector('#new-loc-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const ortLabel = selectedPlace ? selectedPlace.label : placeInput.value.trim();
      const address = buildAddressFromParts(streetInput.value.trim(), houseInput.value.trim(), ortLabel);
      if (!address) { toast('Bitte mindestens einen Ort angeben'); return; }
      const label = backdrop.querySelector('#new-loc-label').value.trim() || address;
      const loc = { id: uid(), label, address, lat: null, lon: null, usageCount: 0, lastUsedAt: null };
      state.locations.push(loc);
      saveKey('locations');
      closeSheet();
      setDraftLocation(role, loc.id);
    });

    if (prefillQuery) {
      placeInput.value = prefillQuery;
      placeInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
    setTimeout(() => placeInput.focus(), 50);
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

  function openTimeEditor(role) {
    closeSheet();
    const current = role === 'start' ? draft.startDateTime : draft.endDateTime;
    const { time } = splitDateTime(current);
    const [curH, curM] = time ? time.split(':') : ['', ''];
    const hourOptions = Array.from({ length: 24 }, (_, i) => pad(i));
    const minuteOptions = Array.from({ length: 60 }, (_, i) => pad(i));
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
    document.body.appendChild(backdrop);
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

  function openRateEditor() {
    closeSheet();
    const backdrop = document.createElement('div');
    backdrop.id = 'sheet-backdrop';
    backdrop.className = 'sheet-backdrop';
    const currentVal = draft.ratePerKm != null ? String(draft.ratePerKm).replace('.', ',') : '';
    backdrop.innerHTML = `
      <div class="sheet" role="dialog">
        <div class="sheet-handle"></div>
        <div class="sheet-header">
          <h2>Kilometersatz für diese Fahrt</h2>
          <button class="btn-text" id="sheet-close">Abbrechen</button>
        </div>
        <form id="rate-form" style="padding: 4px 18px 20px;">
          <div class="field">
            <label for="rate-amount-input">Betrag pro Kilometer</label>
            <div class="input-suffix"><input type="text" inputmode="decimal" id="rate-amount-input" placeholder="0,40" value="${escapeHtml(currentVal)}" enterkeyhint="done"><span class="suffix">€/km</span></div>
          </div>
          <button type="submit" class="btn-primary" id="rate-save">Speichern</button>
          ${draft.rateSource === 'manual' ? '<button type="button" class="btn-secondary" id="rate-reset" style="width:100%;margin-top:10px;">Automatisch verwenden</button>' : ''}
        </form>
      </div>
    `;
    document.body.appendChild(backdrop);
    backdrop.querySelector('#sheet-close').addEventListener('click', closeSheet);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeSheet(); });
    backdrop.querySelector('#rate-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const val = parseFloat(backdrop.querySelector('#rate-amount-input').value.replace(',', '.'));
      if (isNaN(val) || val <= 0) { toast('Bitte einen gültigen Betrag angeben'); return; }
      draft.ratePerKm = val;
      draft.rateSource = 'manual';
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

  async function deleteVehicle(plate) {
    const ok = await confirmDialog('Dieses Kennzeichen löschen?');
    if (!ok) return;
    state.vehicles = state.vehicles.filter(v => v.plate !== plate);
    saveKey('vehicles');
    toast('Kennzeichen gelöscht');
    render();
  }

  // ---------- Views ----------
  function distanceBoxHtml(entry, retryAction) {
    if (!entry.startLocationId || !entry.endLocationId) {
      return `<div class="distance-box"><span class="distance-value pending">Start und Ziel wählen</span></div>`;
    }
    if (entry.distanceStatus === 'ok') {
      return `<div class="distance-box"><span class="distance-value">${entry.distanceKm} km</span></div>`;
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
    const label = entry.ratePerKm != null
      ? `${formatEuroPerKm(entry.ratePerKm)} <span class="hint" style="margin:0;display:inline;">(${entry.rateSource === 'manual' ? 'manuell' : 'automatisch'})</span>`
      : '<span class="placeholder">Kein Satz hinterlegt</span>';
    const costLine = entry.cost != null ? `<div class="hint">Kosten dieser Fahrt: ${formatEuro(entry.cost)}</div>` : '';
    return `<div class="distance-box">
        <span class="distance-value">${label}</span>
        <button class="retry-btn" id="btn-edit-rate">Ändern</button>
      </div>${costLine}`;
  }

  function renderNewView() {
    const startLoc = draft.startLocationId ? findLocation(draft.startLocationId) : null;
    const endLoc = draft.endLocationId ? findLocation(draft.endLocationId) : null;

    return `
      <div class="section-title">${editingTripId ? 'Reise bearbeiten' : 'Neue Reise'}</div>
      <div class="card">
        <div class="field">
          <label>Start</label>
          <button class="picker-trigger" id="btn-pick-start">
            <span class="${startLoc ? '' : 'placeholder'}">${startLoc ? escapeHtml(startLoc.label) : 'Startort wählen'}</span>
            <span class="chev">›</span>
          </button>
        </div>
        <div class="field">
          <label>Ziel</label>
          <button class="picker-trigger" id="btn-pick-end">
            <span class="${endLoc ? '' : 'placeholder'}">${endLoc ? escapeHtml(endLoc.label) : 'Ziel wählen'}</span>
            <span class="chev">›</span>
          </button>
        </div>
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
          <label>Kilometersatz</label>
          ${rateBoxHtml(draft)}
        </div>
        <div class="field">
          <label>Fahrzeug</label>
          <button class="picker-trigger" id="btn-pick-vehicle">
            <span class="${draft.vehiclePlate ? '' : 'placeholder'}">${draft.vehiclePlate ? escapeHtml(draft.vehiclePlate) : 'Kennzeichen wählen'}</span>
            <span class="chev">›</span>
          </button>
        </div>
        <div class="field">
          <label>Notiz (optional)</label>
          <textarea id="input-note" maxlength="1000" placeholder="z. B. Anlass der Reise">${escapeHtml(draft.note)}</textarea>
          <div class="char-count"><span id="note-count">${draft.note.length}</span> / 1000</div>
        </div>
      </div>
      <button class="btn-primary" id="btn-save-trip">${editingTripId ? 'Änderungen speichern' : 'Reise speichern'}</button>
      ${editingTripId ? '<button class="btn-secondary" id="btn-cancel-edit" style="width:100%;margin-top:10px;">Abbrechen</button>' : ''}
    `;
  }

  function attachNewViewHandlers() {
    document.getElementById('btn-pick-start').addEventListener('click', () => openLocationPicker('start'));
    document.getElementById('btn-pick-end').addEventListener('click', () => openLocationPicker('end'));
    document.getElementById('btn-pick-vehicle').addEventListener('click', openVehiclePicker);
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
    document.getElementById('btn-edit-rate').addEventListener('click', openRateEditor);
    const noteEl = document.getElementById('input-note');
    noteEl.addEventListener('input', (e) => {
      draft.note = e.target.value;
      document.getElementById('note-count').textContent = draft.note.length;
    });

    const retryBtn = document.querySelector('[data-action="retry-draft"]');
    if (retryBtn) retryBtn.addEventListener('click', retryDraftDistance);
  }

  function renderTripsView() {
    if (!state.trips.length) {
      return `<div class="empty-state">Noch keine Reisen erfasst.<br>Nutze „Neu", um deine erste Reise einzutragen.</div>`;
    }
    const sorted = [...state.trips].sort((a, b) => (b.startDateTime || '').localeCompare(a.startDateTime || ''));
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
              <span class="trip-route">${escapeHtml(locationLabel(trip.startLocationId))} → ${escapeHtml(locationLabel(trip.endLocationId))}</span>
              <span class="trip-km">${distText}</span>
            </div>
            <div class="trip-meta">${formatDateTime(trip.startDateTime)}${trip.endDateTime ? ' – ' + formatDateTime(trip.endDateTime) : ''} · ${escapeHtml(trip.vehiclePlate)}${trip.ratePerKm != null ? ' · ' + formatEuroPerKm(trip.ratePerKm) : ''}</div>
            ${trip.note ? `<div class="trip-note">${escapeHtml(trip.note)}</div>` : ''}
            ${trip.distanceStatus === 'pending' ? `<div class="hint">${escapeHtml(trip.distanceError || 'Distanz wird nachgeholt, sobald Internet verfügbar ist.')}</div>` : ''}
            ${trip.distanceStatus === 'ok' && trip.cost == null ? `<div class="hint">Kein Kilometersatz für dieses Datum hinterlegt.</div>` : ''}
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
        <div class="manage-row">
          <div><div>${escapeHtml(l.label)}</div><div class="sub">${escapeHtml(l.address)}</div></div>
          <button class="btn-danger" data-del-loc="${escapeHtml(l.id)}">Löschen</button>
        </div>`).join('')
      : `<div class="hint">Noch keine Adressen gespeichert.</div>`;

    const vehRows = state.vehicles.length
      ? sortedByRecency(state.vehicles).map(v => `
        <div class="manage-row">
          <div>${escapeHtml(v.plate)}</div>
          <button class="btn-danger" data-del-veh="${escapeHtml(v.plate)}">Löschen</button>
        </div>`).join('')
      : `<div class="hint">Noch keine Kennzeichen gespeichert.</div>`;

    const rateRows = state.rates.length
      ? [...state.rates].sort((a, b) => b.validFrom.localeCompare(a.validFrom)).map(r => `
        <div class="manage-row">
          <div>ab ${formatDateOnly(r.validFrom)} <span class="sub">${formatEuroPerKm(r.amount)}</span></div>
          <button class="btn-danger" data-del-rate="${escapeHtml(r.id)}">Löschen</button>
        </div>`).join('')
      : `<div class="hint">Noch kein Kilometersatz hinterlegt. Ohne Satz werden keine Kosten berechnet.</div>`;

    return `
      <div class="section-title">Kilometersatz</div>
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

      <div class="section-title">Routing</div>
      <div class="card">
        <div class="field">
          <label for="ors-key-input">OpenRouteService API-Key</label>
          <input type="password" id="ors-key-input" placeholder="API-Key einfügen" value="${escapeHtml(state.settings.orsApiKey)}" autocomplete="off">
          <div class="hint">Wird nur auf diesem Gerät gespeichert (lokal im Browser) und ausschließlich für die Distanzberechnung genutzt. Kostenlosen Key auf openrouteservice.org erstellen.</div>
        </div>
        <button class="btn-secondary" id="btn-save-key">Speichern</button>
      </div>

      <div class="section-title">Gespeicherte Adressen</div>
      <div class="card">${locRows}</div>

      <div class="section-title">Gespeicherte Kennzeichen</div>
      <div class="card">${vehRows}</div>

      <div class="hint" style="margin-top:18px; padding: 0 4px;">Alle Daten (Reisen, Adressen, Fahrzeuge) liegen ausschließlich lokal in diesem Browser auf diesem Gerät. Es gibt aktuell keinen Abgleich zwischen mehreren Geräten.</div>
    `;
  }

  function attachSettingsViewHandlers() {
    document.getElementById('btn-save-key').addEventListener('click', saveApiKey);
    document.querySelectorAll('[data-del-loc]').forEach(btn => {
      btn.addEventListener('click', () => deleteLocation(btn.getAttribute('data-del-loc')));
    });
    document.querySelectorAll('[data-del-veh]').forEach(btn => {
      btn.addEventListener('click', () => deleteVehicle(btn.getAttribute('data-del-veh')));
    });
    document.getElementById('btn-add-rate').addEventListener('click', addRate);
    document.querySelectorAll('[data-del-rate]').forEach(btn => {
      btn.addEventListener('click', () => deleteRate(btn.getAttribute('data-del-rate')));
    });
  }

  // ---------- Router / render ----------
  function render() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-view') === currentView);
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

  // ---------- Service worker ----------
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => { /* offline shell unavailable, app still works online */ });
    });
  }

  document.getElementById('app-version').textContent = 'v' + APP_VERSION;

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
})();

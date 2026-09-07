(() => {
  'use strict';

  const STORAGE_PREFIX = 'rkt:';
  const ORS_BASE = 'https://api.openrouteservice.org';

  const DEFAULTS = {
    trips: [],
    locations: [],
    vehicles: [],
    routeCache: {},
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
    settings: loadKey('settings')
  };

  let currentView = 'new';
  let editingTripId = null;
  let draft = makeEmptyDraft();

  function makeEmptyDraft() {
    return {
      startLocationId: null,
      endLocationId: null,
      distanceKm: null,
      distanceStatus: 'empty', // empty | pending | ok
      distanceError: null,
      startDateTime: toDatetimeLocalValue(new Date()),
      endDateTime: '',
      vehiclePlate: '',
      note: ''
    };
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
      return;
    }
    const key = routeKey(entry.startLocationId, entry.endLocationId);
    const cached = state.routeCache[key];
    if (cached) {
      entry.distanceKm = cached.km;
      entry.distanceStatus = 'ok';
      entry.distanceError = null;
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
        updatedAt: nowIso()
      });
      if (routeChanged) {
        trip.distanceKm = null;
        trip.distanceStatus = 'pending';
        trip.distanceError = null;
      }
      bumpUsage(startLoc, endLoc, veh);
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
        createdAt: nowIso(),
        updatedAt: nowIso()
      };
      state.trips.push(trip);
      bumpUsage(startLoc, endLoc, veh);
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
      note: trip.note
    };
    currentView = 'new';
    render();
  }

  function cancelEdit() {
    editingTripId = null;
    draft = makeEmptyDraft();
    render();
  }

  function deleteTrip(id) {
    if (!confirm('Diese Reise wirklich löschen?')) return;
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
          <input type="text" id="sheet-search-input" placeholder="${escapeHtml(searchPlaceholder)}" autocomplete="off" autocapitalize="words">
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

  function openLocationCreateForm(role, prefillAddress) {
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
        <div style="padding: 4px 18px 20px;">
          <div class="field">
            <label for="new-loc-label">Bezeichnung (optional)</label>
            <input type="text" id="new-loc-label" placeholder="z. B. Büro Zürich">
          </div>
          <div class="field">
            <label for="new-loc-address">Adresse</label>
            <input type="text" id="new-loc-address" placeholder="Straße, PLZ, Ort" value="${escapeHtml(prefillAddress || '')}">
          </div>
          <button class="btn-primary" id="new-loc-save">Adresse speichern & auswählen</button>
        </div>
      </div>
    `;
    document.body.appendChild(backdrop);
    backdrop.querySelector('#sheet-close').addEventListener('click', closeSheet);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeSheet(); });
    backdrop.querySelector('#new-loc-save').addEventListener('click', () => {
      const address = backdrop.querySelector('#new-loc-address').value.trim();
      if (!address) { toast('Bitte eine Adresse eingeben'); return; }
      const label = backdrop.querySelector('#new-loc-label').value.trim() || address;
      const loc = { id: uid(), label, address, lat: null, lon: null, usageCount: 0, lastUsedAt: null };
      state.locations.push(loc);
      saveKey('locations');
      closeSheet();
      setDraftLocation(role, loc.id);
    });
    setTimeout(() => backdrop.querySelector('#new-loc-address').focus(), 50);
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

  // ---------- Settings ----------
  function saveApiKey() {
    const input = document.getElementById('ors-key-input');
    state.settings.orsApiKey = input.value.trim();
    saveKey('settings');
    toast('API-Key gespeichert');
    retryAllPending();
  }

  function deleteLocation(id) {
    if (!confirm('Diese Adresse löschen?')) return;
    state.locations = state.locations.filter(l => l.id !== id);
    saveKey('locations');
    render();
  }

  function deleteVehicle(plate) {
    if (!confirm('Dieses Kennzeichen löschen?')) return;
    state.vehicles = state.vehicles.filter(v => v.plate !== plate);
    saveKey('vehicles');
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
        <div class="two-col">
          <div class="field">
            <label>Start</label>
            <input type="datetime-local" id="input-start-dt" value="${escapeHtml(draft.startDateTime)}">
          </div>
          <div class="field">
            <label>Rückkehr</label>
            <input type="datetime-local" id="input-end-dt" value="${escapeHtml(draft.endDateTime)}">
          </div>
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

    document.getElementById('input-start-dt').addEventListener('change', (e) => { draft.startDateTime = e.target.value; });
    document.getElementById('input-end-dt').addEventListener('change', (e) => { draft.endDateTime = e.target.value; });
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
    let lastYear = null;
    for (const trip of sorted) {
      const year = trip.startDateTime ? trip.startDateTime.slice(0, 4) : '—';
      if (year !== lastYear) {
        html += `<div class="section-title">${escapeHtml(year)}</div>`;
        lastYear = year;
      }
      const distText = trip.distanceStatus === 'ok'
        ? `${trip.distanceKm} km`
        : (trip.distanceStatus === 'pending' ? '…' : '');
      html += `
        <div class="trip-card">
          <div class="trip-row-top">
            <span class="trip-route">${escapeHtml(locationLabel(trip.startLocationId))} → ${escapeHtml(locationLabel(trip.endLocationId))}</span>
            <span class="trip-km">${distText}</span>
          </div>
          <div class="trip-meta">${formatDateTime(trip.startDateTime)}${trip.endDateTime ? ' – ' + formatDateTime(trip.endDateTime) : ''} · ${escapeHtml(trip.vehiclePlate)}</div>
          ${trip.note ? `<div class="trip-note">${escapeHtml(trip.note)}</div>` : ''}
          ${trip.distanceStatus === 'pending' ? `<div class="hint">${escapeHtml(trip.distanceError || 'Distanz wird nachgeholt, sobald Internet verfügbar ist.')}</div>` : ''}
          <div class="trip-actions">
            <button class="btn-text" data-edit="${escapeHtml(trip.id)}">Bearbeiten</button>
            ${trip.distanceStatus === 'pending' ? `<button class="btn-text" data-retry="${escapeHtml(trip.id)}">Distanz erneut versuchen</button>` : ''}
            <button class="btn-danger" data-delete="${escapeHtml(trip.id)}">Löschen</button>
          </div>
        </div>
      `;
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

    return `
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
    btn.addEventListener('click', () => {
      if (editingTripId && btn.getAttribute('data-view') !== 'new') {
        if (!confirm('Bearbeitung abbrechen? Ungespeicherte Änderungen gehen verloren.')) return;
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

  render();
  retryAllPending();
})();

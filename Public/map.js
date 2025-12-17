// map.js (safe singleton, no geocoding, no global 'map' const)
(function(){
  const MAP_ID = 'map';
  const DEFAULT_VIEW = { center: [39.5, -98.35], zoom: 4 };

  if (!window.DS) window.DS = {};
  if (!window.DS.map) {
    const el = document.getElementById(MAP_ID);
    if (!el) return;
    window.DS.map = L.map(el, { worldCopyJump: true }).setView(DEFAULT_VIEW.center, DEFAULT_VIEW.zoom);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap'
    }).addTo(window.DS.map);
  }
  
  // ===== Config =====
const API_BASE = 'http://127.0.0.1:8080'; // or http://localhost:8080

// Map init (keep your existing map init)
const map = window.DS.map;

// --- Tile layer (keep yours) ---
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19
}).addTo(map);

// ===== Marker registry so we can update after saves =====
const markersById = new Map();

// ===== Status -> icon filename mapping (adjust to your files in public/icons) =====
function iconForStatus(status) {
  const s = (status || '').toLowerCase();
  let file = 'marker-icon-grey.png'; // default
  if (s === 'converted') file = 'marker-icon-green.png';
  else if (s === 'hot') file = 'marker-icon-red.png';
  else if (s === 'warm') file = 'marker-icon-orange.png';
  else if (s === 'cold') file = 'marker-icon-blue.png';
  else if (s === 'research') file = 'marker-icon-grey.png';
  else if (s === 'followup' || s === 'follow-up') file = 'marker-icon-violet.png';

  return L.icon({
    iconUrl: `/icons/${file}`,
    shadowUrl: '/icons/marker-shadow.png',
    iconSize:    [25, 41],
    iconAnchor:  [12, 41],
    popupAnchor: [1, -34],
    shadowSize:  [41, 41]
  });
}

// ===== Popup form template (no inline JS) =====
function renderPopup(lead) {
  const {
    id, name = '', company = '', city = '', state = '',
    status = '', tags = '', notes = '', website = '',
    latitude = '', longitude = '', arr = ''
  } = lead || {};

  // Simple, compact form in the popup
  return `
    <form class="lead-form" data-lead-id="${id}">
      <div class="row">
        <label>Name</label>
        <input name="name" value="${escapeHtml(name)}" />
      </div>
      <div class="row">
        <label>Company</label>
        <input name="company" value="${escapeHtml(company)}" />
      </div>
      <div class="row cols">
        <div>
          <label>City</label>
          <input name="city" value="${escapeHtml(city)}" />
        </div>
        <div>
          <label>State</label>
          <input name="state" value="${escapeHtml(state)}" />
        </div>
      </div>
      <div class="row">
        <label>Status</label>
        <select name="status">
          ${renderStatusOption('converted', status)}
          ${renderStatusOption('hot', status)}
          ${renderStatusOption('warm', status)}
          ${renderStatusOption('cold', status)}
          ${renderStatusOption('research', status)}
          ${renderStatusOption('followup', status)}
        </select>
      </div>
      <div class="row">
        <label>Tags (comma-separated)</label>
        <input name="tags" value="${escapeHtml(tags)}" />
      </div>
      <div class="row">
        <label>Website</label>
        <input name="website" value="${escapeHtml(website)}" />
      </div>
      <div class="row">
        <label>Notes</label>
        <textarea name="notes" rows="3">${escapeHtml(notes)}</textarea>
      </div>
      <div class="row cols">
        <div>
          <label>Latitude</label>
          <input name="latitude" type="number" step="0.000001" value="${latitude ?? ''}" />
        </div>
        <div>
          <label>Longitude</label>
          <input name="longitude" type="number" step="0.000001" value="${longitude ?? ''}" />
        </div>
      </div>
      <div class="row">
        <label>ARR</label>
        <input name="arr" type="number" step="0.01" value="${arr ?? ''}" />
      </div>
      <div class="row actions">
        <button type="submit">💾 Save</button>
        <button type="button" class="cancel-btn">✖️ Cancel</button>
      </div>
      <div class="save-status" aria-live="polite"></div>
    </form>
  `;
}

function renderStatusOption(value, current) {
  const selected = (current || '').toLowerCase() === value ? 'selected' : '';
  const labelMap = {
    converted: '🏆 Converted',
    hot: '🔥 Hot',
    warm: '🌞 Warm',
    cold: '🧊 Cold',
    research: '🔍 Research',
    followup: '⏳ Follow-Up'
  };
  return `<option value="${value}" ${selected}>${labelMap[value] || value}</option>`;
}

// Basic XSS guard for text nodes
function escapeHtml(s) {
  return String(s ?? '')
    .replaceAll('&','&amp;')
    .replaceAll('<','&lt;')
    .replaceAll('>','&gt;')
    .replaceAll('"','&quot;')
    .replaceAll("'","&#039;");
}

// ===== Create/attach marker with editable popup =====
function createLeadMarker(lead) {
  if (!lead || !lead.id) return;

  const lat = Number(lead.latitude);
  const lng = Number(lead.longitude);
  if (Number.isNaN(lat) || Number.isNaN(lng)) return; // skip if missing coords

  const marker = L.marker([lat, lng], { icon: iconForStatus(lead.status) })
    .bindPopup(renderPopup(lead), { maxWidth: 360 });

  marker.addTo(map);
  markersById.set(lead.id, { marker, lead });
}

// ===== Load your leads (use your existing fetch; sample below) =====
async function loadLeads() {
  const res = await fetch(`${API_BASE}/summary`);
  const payload = await res.json();

  // Accept either array or { data: [...] } shapes
  const leads = Array.isArray(payload) ? payload : (payload.data || payload.leads || []);

  console.log('[DS] leads loaded:', leads.length); // quick sanity check
  leads.forEach(createLeadMarker);
}
loadLeads();

// ===== Delegated handlers for popup forms =====
map.on('popupopen', (e) => {
  const popupEl = e.popup.getElement();

  // Save (submit)
  popupEl.addEventListener('submit', async (ev) => {
    if (!ev.target.classList.contains('lead-form')) return;
    ev.preventDefault();

    const form = ev.target;
    const id = form.dataset.leadId;
    const formData = new FormData(form);
    const payload = Object.fromEntries(formData.entries());

    // Normalize types
    payload.arr = payload.arr === '' ? null : Number(payload.arr);
    payload.latitude = payload.latitude === '' ? null : Number(payload.latitude);
    payload.longitude = payload.longitude === '' ? null : Number(payload.longitude);

    // Optimistic UI: show saving…
    const statusEl = form.querySelector('.save-status');
    statusEl.textContent = 'Saving…';

    try {
const res = await fetch(`${API_BASE}/update-lead/${id}`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
});

      if (!res.ok) {
        const err = await res.text();
        throw new Error(err || 'Save failed');
      }

      const updated = await res.json();

      // Update local registry
      const entry = markersById.get(updated.id);
      if (entry) {
        entry.lead = updated;
        // Update icon if status changed
        entry.marker.setIcon(iconForStatus(updated.status));
        // Move marker if lat/lng changed
        if (updated.latitude && updated.longitude) {
          entry.marker.setLatLng([updated.latitude, updated.longitude]);
        }
        // Re-render popup with normalized/saved values
        entry.marker.setPopupContent(renderPopup(updated));
      }

      statusEl.textContent = 'Saved ✅';
      // Optional: close popup after a short pause
      setTimeout(() => {
        const m = markersById.get(updated.id)?.marker;
        if (m && m.isPopupOpen()) m.closePopup();
      }, 600);
    } catch (err) {
      statusEl.textContent = `Error: ${err.message}`;
    }
  });

  // Cancel button
  popupEl.addEventListener('click', (ev) => {
    const btn = ev.target.closest('.cancel-btn');
    if (!btn) return;
    // just close
    map.closePopup();
  });
});
  
})();

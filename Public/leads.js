/* Deli Sandwich – Functional Map (filters + clustering + stats) */

(() => {
// ---------- API BASE ----------
const API_BASE = window.DELI_API_BASE || '';

// Centralized map loader – use /map/summary (stable) and fall back to /summary
async function loadMapData() {
  async function fetchJson(path) {
    try {
      const res = await fetch(path, { cache: 'no-cache' });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  // Primary: full lead list (all leads — pin or no pin)
  let payload = await fetchJson(`${API_BASE}/leads/all`);
  if (payload && payload.data) return payload;

  // Fallback: geocoded map-only leads
  return await fetchJson(`${API_BASE}/map/summary`) || { data: [] };
}




window.refreshLeads = async function refreshLeads() {
  const payload = await loadMapData();
  DS.state.rawRows = unwrapData(payload);
  populateFilterOptions();
  computeFiltered();
  renderMarkers();
  updateStats();
};




  // ---------- DOM ----------
  const MAP_ID = 'map';
  const els = {
    dashboard:       () => document.getElementById('dashboard'),
    tagFilter:       () => document.getElementById('tagFilter'),
    typeFilter:      () => document.getElementById('typeFilter'),
    cadenceFilter:   () => document.getElementById('cadenceFilter'),
    stateFilter:     () => document.getElementById('stateFilter'),
	industryFilter:  () => document.getElementById('industryFilter'),
    statusChecks:    () => Array.from(document.querySelectorAll('#dashboard .status-checkbox input[type="checkbox"]')),
    startDate:       () => document.getElementById('startDate'),
    endDate:         () => document.getElementById('endDate'),
    clusterToggle:   () => document.getElementById('clusterToggle'),
    resetFilters:    () => document.getElementById('resetFilters'),
    openSummaryBtn:  () => document.querySelector('#dashboard a[href*="launch-summary"], #openSummaryBtn'),
    statsSummary:    () => document.getElementById('statsSummary'),
    pinCount:        () => document.getElementById('pinCount'),
  };

  // ---------- ICONS ----------
  const ICON_BASE = 'images/';
  const STATUS_ICON = {
    converted:   'marker-icon-green.png',
    hot:         'marker-icon-red.png',
    warm:        'marker-icon-orange.png',
    cold:        'marker-icon-blue.png',
    research:    'marker-icon-violet.png',
    'follow-up': 'marker-icon-yellow.png',
    unspecified: 'marker-icon-grey.png',
    _default:    'marker-icon-gold.png'
  };

  // ------- Dropdown option sets (for edit popup) -------
  const INDUSTRY_OPTIONS = [
    'FinTech','Manufacturing','Healthcare','Logistics','Construction','Retail',
    'Hospitality','Real Estate','Education','Government','Nonprofit','Other'
  ];
  const FORECAST_MONTH_OPTIONS = [
    'January','February','March','April','May','June',
    'July','August','September','October','November','December'
  ];
  const LEAD_TYPE_OPTIONS = ['Customer','Channel Partner'];

  // ---------- STATE ----------
  const DS = (window.DS = window.DS || {});
  DS.state = {
    rawRows: [],
    filtered: [],
    markers: [],
    cluster: null,
    markersLayer: null,
    markerById: new Map(),
  };

  // ---------- UTIL ----------
  const toNumber = (v) => (v == null)
    ? NaN
    : (typeof v === 'number')
      ? v
      : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);

  function clampCoord(lat,lng){
    const a=toNumber(lat), b=toNumber(lng);
    if(!Number.isFinite(a)||!Number.isFinite(b)) return null;
    if(a<-90||a>90||b<-180||b>180) return null;
    return [a,b];
  }

  function normalizeCoords(row){
    const keys = Object.keys(row||{});
    const pick = (cands)=>{ for(const k of cands){ const hit=keys.find(kk=>kk.toLowerCase()===k.toLowerCase()); if(hit) return row[hit]; } };
    const rawLat = pick(['latitude','lat']);
    const rawLng = pick(['longitude','lng','long']);
    return clampCoord(rawLat, rawLng);
  }

  function statusKey(s){
    if(!s||typeof s!=='string') return 'unspecified';
    const k=s.trim().toLowerCase();
    if(k.includes('convert')) return 'converted';
    if(k.includes('hot')) return 'hot';
    if(k.includes('warm')) return 'warm';
    if(k.includes('cold')) return 'cold';
    if(k.includes('research')) return 'research';
    if(k.includes('follow')) return 'follow-up';
    return 'unspecified';
  }

  function iconForStatus(status){
    const file = STATUS_ICON[statusKey(status)] || STATUS_ICON._default;
    return L.icon({
      iconUrl: ICON_BASE + file,
      iconSize: [25,41],
      iconAnchor: [12,41],
      popupAnchor: [1,-34],
      shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
      shadowSize: [41,41],
      shadowAnchor: [12,41]
    });
  }

  function escapeHtml(s) {
    return String(s ?? '')
      .replaceAll('&','&amp;').replaceAll('<','&lt;')
      .replaceAll('>','&gt;').replaceAll('"','&quot;')
      .replaceAll("'","&#039;");
  }

  function prettyStatus(s) {
    const k = statusKey(s);
    return {
      'converted':  '🏆 Converted',
      'hot':        '🔥 Hot',
      'warm':       '🌞 Warm',
      'cold':       '🧊 Cold',
      'research':   '🔍 Research',
      'follow-up':  '⏳ Follow-Up',
      'unspecified':'• Unspecified'
    }[k];
  }

function unwrapData(payload){
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.data))  return payload.data;   // /map/summary
  if (payload && Array.isArray(payload.leads)) return payload.leads;  // /summary
  return [];
}

  // ---------- MAP BOOT (singleton-safe) ----------
  const DEFAULT_VIEW = { center: [39.5, -98.35], zoom: 4 };

  function ensureMap() {
    const mapEl = document.getElementById(MAP_ID);
    if (!mapEl) { console.error(`#${MAP_ID} not found`); return null; }

    if (window.DS.map) {
      try { window.DS.map.remove(); } catch(e){}
      window.DS.map = null;
    }
    if (mapEl._leaflet_id) {
      const fresh = mapEl.cloneNode(false);
      mapEl.parentNode.replaceChild(fresh, mapEl);
    }
    const mapNode = document.getElementById(MAP_ID);
    const map = L.map(mapNode, { worldCopyJump: true }).setView(DEFAULT_VIEW.center, DEFAULT_VIEW.zoom);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{ attribution:'&copy; OpenStreetMap' }).addTo(map);
    window.DS.map = map;

    // Layers
    DS.state.markersLayer = L.layerGroup().addTo(map);
    DS.state.cluster = L.markerClusterGroup ? L.markerClusterGroup() : null;
    return map;
  }

  // ---------- FILTERING ----------
  function getSelectedStatuses(){
    return els.statusChecks().filter(cb => cb.checked).map(cb => cb.value.toLowerCase());
  }

  function withinDateRange(row, startStr, endStr){
    if(!startStr && !endStr) return true;
    const get=(key)=>{ const hit=Object.keys(row).find(k=>k.toLowerCase()===key.toLowerCase()); return hit?row[hit]:null; };
    const v = get('last_touched') || get('lasttouched') || get('updated_at') || get('created_at');
    if(!v) return false;
    const d = new Date(v);
    if(isNaN(d)) return false;
    if(startStr && d < new Date(startStr)) return false;
    if(endStr) {
      const e = new Date(endStr);
      e.setHours(23,59,59,999);
      if(d > e) return false;
    }
    return true;
  }

  function includesToken(fieldVal, selected){
    if(!selected || selected === 'All') return true;
    if(!fieldVal) return false;
    const norm = (''+fieldVal).toLowerCase();
    const want = (''+selected).toLowerCase();
    // for Tags, allow comma-separated contains
    return norm.split(',').map(t=>t.trim()).includes(want) || norm.includes(want);
  }

  function computeFiltered() {
    const rows = DS.state.rawRows || [];
    const tagSel      = els.tagFilter()?.value ?? 'All';
    const typeSel     = els.typeFilter()?.value ?? 'All';
    const cadenceSel  = els.cadenceFilter()?.value ?? 'All';
    const stateSel    = els.stateFilter()?.value ?? 'All';
    const industrySel = els.industryFilter()?.value ?? 'All';
    const statuses    = getSelectedStatuses();
    const startStr    = els.startDate()?.value || '';
    const endStr      = els.endDate()?.value || '';

    const filtered = [];

    for (const r of rows) {
      // ❌ DO NOT require coords here anymore
      // const coords = normalizeCoords(r);
      // if (!coords) continue;

      // Case-insensitive getter
      const get = (key) => {
        const hit = Object.keys(r).find(
          (k) => k.toLowerCase() === key.toLowerCase()
        );
        return hit ? r[hit] : null;
      };

      // Status filter (supports "Warm" and "warm")
      const sKey = statusKey(get('status'));
      if (
        !statuses.includes(sKey.charAt(0).toUpperCase() + sKey.slice(1)) &&
        !statuses.includes(sKey)
      ) {
        if (!statuses.includes(sKey)) continue;
      }

      // Tag / type / cadence / state / industry filters
      if (!includesToken(get('tags'), tagSel)) continue;

      if (!includesToken(get('type') || get('lead_type'), typeSel)) continue;

      if (
        !includesToken(get('cadence_name'), cadenceSel) &&
        !includesToken(get('cadence'), cadenceSel)
      ) continue;

      if (
        !(stateSel === 'All' ||
          (get('state') || '').toLowerCase() === stateSel.toLowerCase())
      ) continue;

      if (
        industrySel !== 'All' &&
        (get('industry') || '').toLowerCase() !== industrySel.toLowerCase()
      ) continue;

      // Date filter
      if (!withinDateRange(r, startStr, endStr)) continue;

      // ✅ Keep this row even if it has no lat/lon
      filtered.push(r);
    }

    DS.state.filtered = filtered;
    return filtered;
  }


  // ---------- RENDER ----------
  function clearLayers() {
    if (DS.state.markersLayer) DS.state.markersLayer.clearLayers();
    if (DS.state.cluster) DS.state.cluster.clearLayers();
    DS.state.markers = [];
    DS.state.markerById.clear();
  }

  function renderMarkers() {
    const map = window.DS.map || ensureMap();
    if (!map) return;

    clearLayers();

    const useCluster = !!els.clusterToggle()?.checked && !!DS.state.cluster;
    if (useCluster && !map.hasLayer(DS.state.cluster)) {
      map.addLayer(DS.state.cluster);
    }
    if (!useCluster && map.hasLayer(DS.state.cluster)) {
      map.removeLayer(DS.state.cluster);
    }

    const bounds = [];
    for (const row of DS.state.filtered) {
      const coords = normalizeCoords(row);
      if (!coords) continue;
      const [lat, lng] = coords;

      // Create marker WITHOUT binding the legacy popup
      const m = L.marker([lat, lng], { icon: iconForStatus(row.status || row.Status) });

      // ✅ Step 2 — Marker click opens the new preview popup
      m.on("click", (e) => {
        DS_CURRENT_LEAD = row;          // remember which lead
        DS_CURRENT_LEAD._marker = m;    // back-reference for updating color later
        openLeadPopup("preview", e.latlng);
      });

      DS.state.markers.push(m);
      const leadId = row.id || row.uuid;
      if (leadId) DS.state.markerById.set(leadId, m);

      if (useCluster) {
        DS.state.cluster.addLayer(m);
      } else {
        DS.state.markersLayer.addLayer(m);
      }
      bounds.push([lat, lng]);
    }

    if (bounds.length) {
      map.fitBounds(bounds, { padding: [20, 20] });
    }
  }

  function updateStats() {
    const allRows = DS.state.rawRows || [];
    const filtered = DS.state.filtered || [];

    // Total = every lead in the DB payload
    const total = allRows.length;

    // Shown = every lead that passes filters (map pins + no-pin leads)
    const shown = filtered.length;

    // Status breakdown is based on filtered leads (what you’re currently “working”)
    const breakdown = filtered.reduce((acc, r) => {
      const k = statusKey(r.status || r.Status);
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {});

    const order = [
      'converted',
      'hot',
      'warm',
      'follow-up',
      'cold',
      'research',
      'unspecified'
    ];

    const meta = {
      converted:  { label: 'Converted',  icon: '🏆' },
      hot:        { label: 'Hot',        icon: '🔥' },
      warm:       { label: 'Warm',       icon: '🌞' },
      'follow-up':{ label: 'Follow-Up',  icon: '⏳' },
      cold:       { label: 'Cold',       icon: '🧊' },
      research:   { label: 'Research',   icon: '🔍' },
      unspecified:{ label: 'Unspecified',icon: '⚪' }
    };

    const rowsHtml = order
      .filter(k => breakdown[k])
      .map(k => {
        const { label, icon } = meta[k];
        const count = breakdown[k];
        return `
          <div class="status-chip">
            <span class="icon">${icon}</span>
            <span>${label}</span>
            <strong>${count}</strong>
          </div>
        `;
      })
      .join('');

    if (els.statsSummary()) {
      if (rowsHtml) {
        els.statsSummary().innerHTML = `
          <div style="font-weight:600; margin-bottom:4px;">Status Breakdown</div>
          <div class="status-list">
            ${rowsHtml}
          </div>
        `;
      } else {
        els.statsSummary().textContent = 'Status Breakdown: (no results)';
      }
    }

    // Bottom-left footer
    if (els.pinCount()) {
      els.pinCount().textContent = `Displaying ${shown} of ${total} leads`;
    }
  }



  function populateFilterOptions() {
    const rows = DS.state.rawRows || [];
    const uniqueFrom = (key) => Array.from(new Set(
      rows.map(r => {
        const hit = Object.keys(r).find(k => k.toLowerCase() === key.toLowerCase());
        return hit ? (r[hit] || '') : '';
      }).filter(Boolean)
    )).sort((a,b)=>(''+a).localeCompare((''+b)));

    const setOpts = (el, values) => {
      if (!el) return;
      el.innerHTML = '<option value="All">All</option>' + values.map(v=>`<option value="${v}">${v}</option>`).join('');
    };

    setOpts(els.tagFilter(),     Array.from(new Set(rows.flatMap(r => {
      const hit = Object.keys(r).find(k => k.toLowerCase() === 'tags');
      const val = hit ? r[hit] : '';
      return (val ? (''+val).split(',').map(s=>s.trim()).filter(Boolean) : []);
    })) ).sort((a,b)=>a.localeCompare(b)));

    const types = Array.from(new Set([ ...uniqueFrom('type'), ...uniqueFrom('lead_type') ]))
      .filter(Boolean)
      .sort((a,b)=>(''+a).localeCompare((''+b)));
    setOpts(els.typeFilter(), types);

    setOpts(els.cadenceFilter(), uniqueFrom('cadence_name') || uniqueFrom('cadence'));
    setOpts(els.stateFilter(),   uniqueFrom('state'));
	setOpts(els.industryFilter(), uniqueFrom('industry'));
  }

  function wireDashboard() {
    const rerender = () => { computeFiltered(); renderMarkers(); updateStats(); };

    [els.tagFilter(), els.typeFilter(), els.cadenceFilter(), els.stateFilter(),els.industryFilter(), els.startDate(), els.endDate()]
      .forEach(el => el && el.addEventListener('change', rerender));

    els.statusChecks().forEach(cb => cb.addEventListener('change', rerender));
    if (els.clusterToggle()) els.clusterToggle().addEventListener('change', rerender);

    if (els.resetFilters()) els.resetFilters().addEventListener('click', () => {
      if (els.tagFilter()) els.tagFilter().value = 'All';
      if (els.typeFilter()) els.typeFilter().value = 'All';
      if (els.cadenceFilter()) els.cadenceFilter().value = 'All';
      if (els.stateFilter()) els.stateFilter().value = 'All';
      if (els.startDate()) els.startDate().value = '';
      if (els.endDate()) els.endDate().value = '';
      els.statusChecks().forEach(cb => cb.checked = true);
      if (els.clusterToggle()) els.clusterToggle().checked = true;
      rerender();
    });

    // Ensure "Open Today's Summary" hits the correct backend base
    const a = els.openSummaryBtn();
    if (a) {
      a.addEventListener('click', (evt) => {
        evt.preventDefault();
        window.open(`${API_BASE}/launch-summary`, '_blank');
      });
    }
  }

  // =========================
  // NEW PREVIEW/EDIT POPUPS
  // =========================

  // ——— State ———
  let DS_CURRENT_LEAD = null;
  let DS_SAVE_IN_FLIGHT = false;
  let DS_DELETE_IN_FLIGHT = false;


  // Keep one Leaflet popup instance so we can swap content without reopening
  const dsPopup = L.popup({ maxWidth: 420, closeButton: true });

  // Utility: tiny HTML escaper
  const esc = (s = "") => String(s).replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));

  // Normalizers for numeric fields
  const toNum = v => {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(String(v).replace(/[, ]+/g, ""));
    return Number.isFinite(n) ? n : null;
  };
  
  
  
  // Normalize website URLs for links (add https:// if missing)
function normalizeWebsite(url) {
  if (!url) return "";

  let cleaned = String(url).trim();

  // remove ALL leading slashes
  cleaned = cleaned.replace(/^\/+/, "");

  // if still missing protocol, add https://
  if (!/^https?:\/\//i.test(cleaned)) {
    cleaned = "https://" + cleaned;
  }

  return cleaned;
}




  // Status emoji for preview header
  const STATUS_EMOJI = {
    converted:"🏆", hot:"🔥", warm:"🌞", cold:"🧊",
    research:"🔍", "follow-up":"⏳", unspecified:"•"
  };

  // ——— Preview template ———
  function renderPreviewPopup(lead) {
    const s = statusKey(lead.status || "unspecified");

    const email = (lead.email || "").trim();
    const emailHtml = email
      ? `<a href="mailto:${esc(email)}">${esc(email)}</a>`
      : "—";

    const website = (lead.website || "").trim();
    const websiteHtml = website
      ? `<a href="#"
            class="ds-website-link"
            data-url="${esc(website)}">${esc(website)}</a>`
      : "—";


    return `
      <div class="ds-popup p-2" style="font:14px/1.3 system-ui,Segoe UI,Arial">
        <div style="display:flex;gap:.5rem;align-items:center;margin-bottom:.25rem">
          <div style="font-size:20px">${STATUS_EMOJI[s] || "•"}</div>
          <div>
            <div style="font-weight:600">${esc(lead.company || "(Company)")}</div>
            <div style="color:#666">${esc(lead.city || "")}${lead.state ? ", " + esc(lead.state) : ""}</div>
          </div>
        </div>

        <div style="display:grid;grid-template-columns:110px 1fr;gap:.25rem .5rem;margin:.25rem 0">
          <div style="color:#666">Name</div><div>${esc(lead.name || "")}</div>
          <div style="color:#666">Email</div><div>${emailHtml}</div>
          <div style="color:#666">Status</div><div>${esc(prettyStatus(lead.status))}</div>
          <div style="color:#666">Industry</div><div>${esc(lead.industry || "—")}</div>
          <div style="color:#666">Forecast</div><div>${esc(lead.forecast_month || "—")}</div>
          <div style="color:#666">Type</div><div>${esc(lead.lead_type || "—")}</div>
          <div style="color:#666">Website</div><div>${websiteHtml}</div>
          <div style="color:#666">ARR</div><div>${lead.arr != null ? `$${Number(lead.arr).toLocaleString()}` : "—"}</div>
          <div style="color:#666">AP Spend</div><div>${lead.ap_spend != null ? `$${Number(lead.ap_spend).toLocaleString()}` : "—"}</div>
          <div style="color:#666">Tags</div><div>${esc(Array.isArray(lead.tags)? lead.tags.join(", ") : (lead.tags||"—"))}</div>
          <div style="color:#666">Notes</div><div>${esc(lead.notes || "—")}</div>
        </div>

        <div style="display:flex;gap:.5rem;justify-content:flex-end;margin-top:.5rem">
          <button class="ds-btn-edit" style="padding:.4rem .7rem;border:1px solid #ddd;border-radius:8px;cursor:pointer;background:#f8f8f8">Edit</button>
          <button class="ds-btn-close" style="padding:.4rem .7rem;border:1px solid #ddd;border-radius:8px;cursor:pointer;background:white">Close</button>
        </div>
      </div>
    `;
  }

  
  

  // ——— Edit template ———
  function renderEditPopup(lead) {
    const opt = (v, cur) => `<option value="${esc(v)}" ${String(cur||"")===String(v)?"selected":""}>${esc(v)}</option>`;
    const numberVal = v => (v ?? "") === null ? "" : String(v ?? "");
    return `
      <div class="ds-popup p-2" style="font:14px/1.3 system-ui,Segoe UI,Arial">
        <div style="font-weight:600;margin-bottom:.5rem">Edit Lead</div>

        <form class="ds-edit-form" style="display:grid;gap:.5rem">
          <input type="hidden" name="id" value="${esc(lead.id)}"/>

          <label style="display:grid;gap:.25rem">
            <span style="color:#555">Name</span>
            <input name="name" value="${esc(lead.name || "")}" />
          </label>

          <label style="display:grid;gap:.25rem">
            <span style="color:#555">Company</span>
            <input name="company" value="${esc(lead.company || "")}" />
          </label>
		  
		  <label style="display:grid;gap:.25rem">
  <span style="color:#555">Website</span>
  <input name="website" value="${esc(lead.website || "")}" />
</label>


          <div style="display:grid;grid-template-columns:1fr 80px;gap:.5rem;align-items:end">
  <label style="display:grid;gap:.25rem">
    <span style="color:#555">City</span>
    <input name="city" style="width:100%" value="${esc(lead.city || "")}" />
  </label>
  <label style="display:grid;gap:.25rem">
    <span style="color:#555">State</span>
    <input name="state" style="width:100%;text-transform:uppercase;text-align:center" maxlength="2" value="${esc(lead.state || "")}" />
  </label>
</div>

          <label style="display:grid;gap:.25rem">
            <span style="color:#555">Status</span>
            <select name="status">
              ${["converted","hot","warm","cold","research","follow-up","unspecified"].map(s => opt(s, statusKey(lead.status))).join("")}
            </select>
          </label>

          <label style="display:grid;gap:.25rem">
            <span style="color:#555">Industry</span>
            <select name="industry">
              <option value=""></option>
              ${INDUSTRY_OPTIONS.map(v => opt(v, lead.industry)).join("")}
            </select>
          </label>

          <label style="display:grid;gap:.25rem">
            <span style="color:#555">Forecast Month</span>
            <select name="forecast_month">
              <option value=""></option>
              ${FORECAST_MONTH_OPTIONS.map(v => opt(v, lead.forecast_month)).join("")}
            </select>
          </label>

          <label style="display:grid;gap:.25rem">
            <span style="color:#555">Type</span>
            <select name="lead_type">
              <option value=""></option>
              ${LEAD_TYPE_OPTIONS.map(v => opt(v, lead.lead_type)).join("")}
            </select>
          </label>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:.5rem">
            <label style="display:grid;gap:.25rem">
              <span style="color:#555">ARR ($)</span>
              <input name="arr" inputmode="decimal" value="${esc(numberVal(lead.arr))}" />
            </label>
            <label style="display:grid;gap:.25rem">
              <span style="color:#555">AP Spend ($)</span>
              <input name="ap_spend" inputmode="decimal" value="${esc(numberVal(lead.ap_spend))}" />
            </label>
          </div>

          <label style="display:grid;gap:.25rem">
            <span style="color:#555">Tags (comma-separated)</span>
            <input name="tags" value="${esc(Array.isArray(lead.tags)? lead.tags.join(", "):(lead.tags||""))}" />
          </label>

          <label style="display:grid;gap:.25rem">
            <span style="color:#555">Notes</span>
            <textarea name="notes" rows="3">${esc(lead.notes || "")}</textarea>
          </label>

        <div style="display:flex;gap:.5rem;justify-content:flex-end;margin-top:.5rem">
          <button class="ds-btn-edit"
                  style="padding:.4rem .7rem;border:1px solid #ddd;border-radius:8px;cursor:pointer;background:#f8f8f8">
            Edit
          </button>

          <button class="ds-btn-delete"
                  style="padding:.4rem .7rem;border-radius:8px;border:1px solid #f5b5b5;cursor:pointer;background:#fff;color:#b00020">
            Delete
          </button>

          <button class="ds-btn-close"
                  style="padding:.4rem .7rem;border:1px solid #ddd;border-radius:8px;cursor:pointer;background:white">
            Close
          </button>
        </div>
      </div>
    `;
  }


  // ——— Popup open/swap ———
  function openLeadPopup(mode, latlng) {
    if (!DS_CURRENT_LEAD) return;
    const html = mode === "edit" ? renderEditPopup(DS_CURRENT_LEAD) : renderPreviewPopup(DS_CURRENT_LEAD);
    dsPopup.setLatLng(latlng).setContent(html).openOn(window.map); // window.map is set in boot()
  }

  // ——— Attach one-time document listeners (call from boot()) ———
  function attachPopupEventDelegates() {
    // Edit / Close / Delete in preview
    document.addEventListener("click", async (e) => {
      const node = e.target;

      if (node.classList?.contains("ds-btn-edit")) {
        e.preventDefault();
        const latlng = dsPopup.getLatLng();
        openLeadPopup("edit", latlng);
      }
	  
	        // Open website links from the popup
      if (node.classList?.contains("ds-website-link")) {
        e.preventDefault();
        const raw = node.getAttribute("data-url") || "";
        const url = normalizeWebsite(raw);
        if (url) {
          window.open(url, "_blank", "noopener");
        }
      }

	  

      if (node.classList?.contains("ds-btn-close")) {
        e.preventDefault();
        window.map.closePopup(dsPopup);
      }

      if (node.classList?.contains("ds-btn-cancel")) {
        e.preventDefault();
        const latlng = dsPopup.getLatLng();
        openLeadPopup("preview", latlng);
      }

      if (node.classList?.contains("ds-btn-delete")) {
        e.preventDefault();
        if (!DS_CURRENT_LEAD || !DS_CURRENT_LEAD.id) return;
        if (DS_DELETE_IN_FLIGHT) return;

        const label =
          DS_CURRENT_LEAD.company ||
          DS_CURRENT_LEAD.name ||
          "this lead";

        const ok = window.confirm(
          `Delete "${label}"? This cannot be undone.`
        );
        if (!ok) return;

        try {
          DS_DELETE_IN_FLIGHT = true;
          node.disabled = true;
          node.textContent = "Deleting…";

          const res = await fetch(
            `${API_BASE}/leads/${encodeURIComponent(DS_CURRENT_LEAD.id)}`,
            { method: "DELETE" }
          );

          if (!res.ok) {
            const msg = await res.text().catch(() => "");
            throw new Error(msg || `Delete failed (${res.status})`);
          }

          // Close popup and refresh map + list
          window.map.closePopup(dsPopup);
          if (window.refreshLeads) {
            await window.refreshLeads();
          }
        } catch (err) {
          console.error("Delete failed", err);
          alert("Delete failed: " + (err.message || err));
        } finally {
          DS_DELETE_IN_FLIGHT = false;
          node.disabled = false;
          node.textContent = "Delete";
		  
		  
        }
      }
    });


    // Save submit
    document.addEventListener("submit", async (e) => {
      const form = e.target;
      if (!form.classList?.contains("ds-edit-form")) return;
      e.preventDefault();
      if (DS_SAVE_IN_FLIGHT) return;

      const fd = new FormData(form);
      const payload = {
        name: fd.get("name")?.trim() || null,
        company: fd.get("company")?.trim() || null,
		website: (fd.get("website") || "").trim() || null,
        city: fd.get("city")?.trim() || null,
        state: fd.get("state")?.trim().toUpperCase() || null,
        status: statusKey((fd.get("status") || "unspecified").trim()),
        industry: (fd.get("industry") || "").trim() || null,
        forecast_month: (fd.get("forecast_month") || "").trim() || null,
        lead_type: (fd.get("lead_type") || "").trim() || null,
        arr: toNum(fd.get("arr")),
        ap_spend: toNum(fd.get("ap_spend")),
        tags: (fd.get("tags") || "").split(",").map(t => t.trim()).filter(Boolean),
        notes: fd.get("notes") || null
      };

      const id = DS_CURRENT_LEAD.id;
      const saveBtn = form.querySelector(".ds-btn-edit");
      try {
        DS_SAVE_IN_FLIGHT = true;
        saveBtn.disabled = true;
        saveBtn.textContent = "Saving…";

        const res = await fetch(`${API_BASE}/update-lead/${encodeURIComponent(id)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        if (!res.ok) {
          const text = await res.text().catch(()=>"");
          throw new Error(`Save failed (${res.status}) ${text}`);
        }

        // Response can be the updated row; merge into memory
        const updated = await res.json().catch(()=> ({}));
        const freshLead = updated.lead || updated || {};
        Object.assign(DS_CURRENT_LEAD, payload, freshLead);

        // Update marker UI and position if needed
        const marker = DS_CURRENT_LEAD._marker || DS.state.markerById.get(DS_CURRENT_LEAD.id);
        if (marker) {
          marker.setIcon(iconForStatus(DS_CURRENT_LEAD.status));
          if (Number.isFinite(DS_CURRENT_LEAD.latitude) && Number.isFinite(DS_CURRENT_LEAD.longitude)) {
            marker.setLatLng([DS_CURRENT_LEAD.latitude, DS_CURRENT_LEAD.longitude]);
          }
        }

        // Replace the row in rawRows
        const idx = DS.state.rawRows.findIndex(r => (r.id || r.uuid) === DS_CURRENT_LEAD.id);
        if (idx >= 0) DS.state.rawRows[idx] = { ...DS.state.rawRows[idx], ...DS_CURRENT_LEAD };

        // Swap back to preview
        const latlng = dsPopup.getLatLng();
        openLeadPopup("preview", latlng);

        // Recompute filters/stats in case status changed
        computeFiltered();
        updateStats();
      } catch (err) {
        console.error(err);
        alert(`Couldn't save: ${err.message}`);
        saveBtn.disabled = false;
        saveBtn.textContent = "Save";
      } finally {
        DS_SAVE_IN_FLIGHT = false;
      }
    });
  }

  // ---------- BOOT ----------
  async function boot() {
    const map = ensureMap();
    if (!map) return;

    // Make map globally accessible to the popup helper
    window.map = map;
    attachPopupEventDelegates();   // new preview/edit system

    // Fetch + render using centralized loader (full /summary preferred)
    let payload;
    try {
      payload = await loadMapData();
    } catch (err) {
      console.error('Failed to load leads:', err);
      return;
    }

    DS.state.rawRows = unwrapData(payload);
    populateFilterOptions();
    wireDashboard();
    computeFiltered();
    renderMarkers();
    updateStats();
  }


  // Auto-run boot once when the page loads
  if (!DS.leadsBootBound) {
    document.addEventListener('DOMContentLoaded', boot);
    DS.leadsBootBound = true;
  }
})();

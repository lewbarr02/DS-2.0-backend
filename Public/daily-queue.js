// public/js/daily-queue.js
document.addEventListener('DOMContentLoaded', () => {

const activeListEl = document.getElementById('dq-active-list');
const doneListEl = document.getElementById('dq-done-list');
const doneWrapperEl = document.getElementById('dq-done-wrapper');
const doneCountEl = document.getElementById('dq-done-count');

const doneToggleBtn = document.getElementById('dq-done-toggle');
const doneToggleLabelEl = document.getElementById('dq-done-toggle-label');
const doneChevronEl = document.getElementById('dq-done-chevron');



  // Daily goals (Finexio targets)
  const CALL_GOAL = 50;
  const EMAIL_GOAL = 30;
  const SOCIAL_GOAL = 10;
  const emptyEl = document.getElementById('dq-empty-state');
  const finishedEl = document.getElementById('dq-finished-state');
  const progressBarEl = document.getElementById('dq-progress-bar');
  const progressLabelEl = document.getElementById('dq-progress-label');
  const totalEl = document.getElementById('dq-total');
  const doneEl = document.getElementById('dq-done');
  const remainingEl = document.getElementById('dq-remaining');
  const loadingPillEl = document.getElementById('dq-loading-pill');
  const newBatchBtn = document.getElementById('new-batch-btn');
  const todayDateEl = document.getElementById('dq-today-date');

  // Daily goal bar elements
  const callsBarEl = document.getElementById('dq-goal-calls-bar');
  const emailsBarEl = document.getElementById('dq-goal-emails-bar');
  const socialBarEl = document.getElementById('dq-goal-social-bar');

  const callsCountEl = document.getElementById('dq-goal-calls-count');
  const emailsCountEl = document.getElementById('dq-goal-emails-count');
  const socialCountEl = document.getElementById('dq-goal-social-count');

  let currentBatch = null;
  let items = [];

  // Read any query parameters (e.g. /daily-queue?autostart=1&tag=AFP%20Event)
  const urlParams = new URLSearchParams(window.location.search);
  const autoStart = urlParams.get('autostart') === '1';

  // 🔹 If this page was opened in Event Mode, lock the Daily Queue
  // to that single tag for the entire session (all batches).
  const batchTagRaw = urlParams.get('tag');
  const batchTag = batchTagRaw && batchTagRaw.trim() ? batchTagRaw.trim() : null;


  // ———————————————————————
  // Helpers
  // ———————————————————————
  
  // ------------------------------
// TIME ZONE HELPERS (Daily Queue)
// ------------------------------
const DQ_TIMEZONE_MAP = {
  ET: ["ME","NH","VT","MA","RI","CT","NY","NJ","PA","DE","MD","DC","VA","WV","NC","SC","GA","FL","OH","MI","IN","KY","TN"],
  CT: ["AL","AR","IA","IL","KS","LA","MN","MO","MS","ND","NE","OK","SD","TX","WI"],
  MT: ["AZ","CO","ID","MT","NM","UT","WY"],
  PT: ["CA","NV","OR","WA"]
};

function getTimezoneByState(state) {
  if (!state) return "UNKNOWN";
  const s = String(state).trim().toUpperCase();
  for (const zone in DQ_TIMEZONE_MAP) {
    if (DQ_TIMEZONE_MAP[zone].includes(s)) return zone;
  }
  return "UNKNOWN";
}

function getLocationParts(item) {
  return {
    city: item.city || item.City || '',
    state: item.state || item.State || ''
  };
}

// Returns SAFE HTML (we escape user data)
function renderLocationHtml(item) {
  const { city, state } = getLocationParts(item);

  const citySafe = city ? escapeHtml(city) : '';
  const stateSafe = state ? escapeHtml(state) : '';

  if (!citySafe && !stateSafe) return 'Location N/A';

  if (stateSafe) {
    const zone = getTimezoneByState(stateSafe);
    const pill = `<span class="dq-state-pill dq-tz-${zone}">${stateSafe}</span>`;
    if (citySafe) return `${citySafe}, ${pill}`;
    return pill;
  }

  return citySafe;
}

  
  // Done Today collapse state (remembered per session)
const DONE_COLLAPSE_KEY = 'dq_done_collapsed';

function setDoneCollapsed(collapsed) {
  if (!doneListEl || !doneToggleBtn || !doneToggleLabelEl || !doneChevronEl) return;

  doneListEl.style.display = collapsed ? 'none' : 'block';
  doneToggleBtn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  doneToggleLabelEl.textContent = collapsed ? 'Expand' : 'Collapse';
  doneChevronEl.textContent = collapsed ? '▸' : '▾';

  try {
    sessionStorage.setItem(DONE_COLLAPSE_KEY, collapsed ? '1' : '0');
  } catch (_) {}
}

function getDoneCollapsed() {
  try {
    return sessionStorage.getItem(DONE_COLLAPSE_KEY) === '1';
  } catch (_) {
    return false;
  }
}

// Toggle click
if (doneToggleBtn) {
  doneToggleBtn.addEventListener('click', () => {
    const next = !getDoneCollapsed();
    setDoneCollapsed(next);
  });
}

  
  function setTodayText() {
    const d = new Date();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    todayDateEl.textContent = `${mm}/${dd}`;
  }

  function toggleLoading(isLoading) {
    if (loadingPillEl) {
      loadingPillEl.style.display = isLoading ? 'inline-flex' : 'none';
    }
    if (newBatchBtn) {
      newBatchBtn.disabled = isLoading;
    }
  }

  function escapeHtml(str) {
    if (!str && str !== 0) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
  


  // ------------------------------
  // Contact Rhythm (Daily Queue)
  // ------------------------------
  const DQ_CR_META = {
    office_call_no_contact: { icon: '📞', label: 'Office call (no contact)' },
    office_gatekeeper:      { icon: '🧑‍💼', label: 'Office gatekeeper' },
    cell_call_no_answer:    { icon: '📱', label: 'Cell call (no answer)' },
    cell_voicemail:         { icon: '📱💬', label: 'Cell voicemail' },
  };

  function dqCrFormatTs(ts) {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleString([], { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' });
  }

  async function dqCrFetchLast(leadId) {
    const res = await fetch(`/api/leads/${encodeURIComponent(leadId)}/contact-rhythm?limit=1`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `contact_rhythm_read_failed (${res.status})`);
    const events = Array.isArray(data.events) ? data.events : [];
    return events[0] || null;
  }

  async function dqCrLogEvent(leadId, touch_type) {
    const res = await fetch(`/api/leads/${encodeURIComponent(leadId)}/contact-rhythm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ touch_type })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `contact_rhythm_write_failed (${res.status})`);
    return data.event || null;
  }

  function dqCrUpdateCardUI(cardEl, evt) {
    if (!cardEl) return;
    const lastEl = cardEl.querySelector('[data-dq-cr-last]');
    if (!lastEl) return;

    if (!evt) {
      lastEl.textContent = '—';
      lastEl.title = 'No Contact Rhythm yet';
      return;
    }

    const meta = DQ_CR_META[evt.touch_type] || { icon: '•', label: evt.touch_type };
    const when = dqCrFormatTs(evt.touched_at);
    lastEl.textContent = `${meta.icon} ${when}`;
    lastEl.title = `${meta.label} — ${when}`;
  }

  function dqCrRefreshCard(cardEl) {
    const leadId = cardEl?.dataset?.leadId;
    if (!leadId) return;

    dqCrFetchLast(leadId)
      .then(evt => dqCrUpdateCardUI(cardEl, evt))
      .catch(err => {
        console.error(err);
        dqCrUpdateCardUI(cardEl, null);
      });
  }

  // ------------------------------
  // Toasts (Daily Queue)
  // ------------------------------
  function ensureDqToastHost() {
    let host = document.getElementById('dq-toast-host');
    if (host) return host;

    host = document.createElement('div');
    host.id = 'dq-toast-host';
    host.style.position = 'fixed';
    host.style.right = '16px';
    host.style.bottom = '16px';
    host.style.zIndex = '9999';
    host.style.display = 'flex';
    host.style.flexDirection = 'column';
    host.style.gap = '8px';
    host.style.pointerEvents = 'none';
    document.body.appendChild(host);
    return host;
  }

  function showDqToast(message, type) {
    const host = ensureDqToastHost();
    const el = document.createElement('div');
    el.textContent = message || '';
    el.style.pointerEvents = 'none';
    el.style.padding = '10px 12px';
    el.style.borderRadius = '12px';
    el.style.boxShadow = '0 8px 24px rgba(0,0,0,0.12)';
    el.style.fontSize = '13px';
    el.style.fontWeight = '600';
    el.style.maxWidth = '320px';
    el.style.lineHeight = '1.2';
    el.style.opacity = '0';
    el.style.transform = 'translateY(6px)';
    el.style.transition = 'opacity 160ms ease, transform 160ms ease';

    // Type styling
    if (type === 'error') {
      el.style.background = '#fee2e2'; // red-100
      el.style.border = '1px solid #fecaca'; // red-200
      el.style.color = '#7f1d1d'; // red-900
    } else {
      el.style.background = '#dcfce7'; // green-100
      el.style.border = '1px solid #bbf7d0'; // green-200
      el.style.color = '#14532d'; // green-900
    }

    host.appendChild(el);

    // animate in
    requestAnimationFrame(() => {
      el.style.opacity = '1';
      el.style.transform = 'translateY(0)';
    });

    // remove after
    window.setTimeout(() => {
      el.style.opacity = '0';
      el.style.transform = 'translateY(6px)';
      window.setTimeout(() => {
        try { el.remove(); } catch (_) {}
      }, 180);
    }, 1400);
  }

function normalizeWebsite(url) {
  if (!url) return '';
  let cleaned = String(url).trim();
  cleaned = cleaned.replace(/^\/+/, '');
  if (!/^https?:\/\//i.test(cleaned)) {
    cleaned = 'https://' + cleaned;
  }
  return cleaned;
}


  function formatDate(value) {
    if (!value) return '—';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '—';
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${mm}/${dd}`;
  }

function fmtMoney(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return '$' + Math.round(n).toLocaleString();
}

// NEW: Format values as rounded millions, e.g. 27,720,000 → "$28M"
function fmtMillions(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  const m = Math.round(n / 1_000_000);
  return `$${m}M`;
}



  function formatLocation(item) {
    const city = item.city || item.City;
    const state = item.state || item.State;
    if (city && state) return `${city}, ${state}`;
    if (city || state) return city || state;
    return 'Location N/A';
  }

  // Helper: choose the best "last touch" timestamp
  function formatLastTouch(item) {
    const ts =
      item.last_activity_at ||
      item.last_touch_at ||
      item.last_touch ||
      (item.lead && (item.lead.last_activity_at || item.lead.last_touch_at));

    return formatDate(ts);
  }

  // Helper: choose the best "next touch" timestamp
  function formatNextTouch(item) {
    const ts =
      item.next_touch_at ||
      item.next_action_at ||
      item.next_touch ||
      (item.lead && (item.lead.next_touch_at || item.lead.next_action_at));

    return formatDate(ts);
  }

  function computeIsDone(item) {
    // Prefer backend flags if present
    if (typeof item.is_done === 'boolean') return item.is_done || !!item.is_skipped;
    if (typeof item.is_completed === 'boolean') {
      // Count skipped as "done" for progress too
      return item.is_completed || !!item.is_skipped;
    }

    const s = (item.status || item.lead_status || '').toString().toLowerCase();
    if (!s) return false;
    return ['converted', 'no fit', 'no_fit', 'retired', 'done', 'completed'].includes(s);
  }

  // 🔹 NEW: always show active leads first, then completed/skipped ones
  function sortItemsForDisplay() {
    if (!Array.isArray(items)) return;

    items.sort((a, b) => {
      const aDone = computeIsDone(a) ? 1 : 0;
      const bDone = computeIsDone(b) ? 1 : 0;

      // Incomplete first, then done ones
      if (aDone !== bDone) {
        return aDone - bDone;
      }

      // Keep natural order within each group if positions exist
      const aPos = a.position ?? a.item_position ?? 0;
      const bPos = b.position ?? b.item_position ?? 0;
      return aPos - bPos;
    });
  }

function mapStatusClass(statusRaw) {
  const s0 = (statusRaw || '').toString().trim().toLowerCase();
  const s = s0.replace(/_/g, '-'); // follow_up -> follow-up

  if (s === 'hot') return 'dq-status-hot';
  if (s === 'warm') return 'dq-status-warm';
  if (s === 'cold') return 'dq-status-cold';
  if (s === 'follow-up' || s === 'follow up' || s === 'followup') return 'dq-status-followup';
  if (s === 'converted') return 'dq-status-converted';
  if (s === 'research') return 'dq-status-research';
  return 'dq-status-unspecified';
}


  // Make a status label look nice for the pill (e.g. "follow-up" -> "Follow-Up")
  function formatStatusLabelForDisplay(raw) {
    if (!raw) return 'Unspecified';
    const s = raw.toString().toLowerCase().replace(/_/g, ' ');
    return s.replace(/\b\w/g, (c) => c.toUpperCase());
  }


// ———————————————————————
// Inline Role/Status edit helpers (kept aligned with List View + Lead 360)
// ———————————————————————
function normalizeStatusValue(raw) {
  if (!raw) return '';
  return String(raw)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/-/g, '_');
}

function normalizeRoleValue(raw) {
  if (!raw) return '';
  return String(raw).trim();
}

function renderRoleOptions(item) {
  const current = normalizeRoleValue(item.role || item.title || '');
  const roles = ['', 'CFO', 'Controller', 'Finance', 'Treasury', 'AP'];
  return roles.map((r) => {
    const label = r ? r : '—';
    const sel = current === r ? 'selected' : '';
    return `<option value="${escapeHtml(r)}" ${sel}>${escapeHtml(label)}</option>`;
  }).join('');
}

function renderStatusOptions(item) {
  const current = normalizeStatusValue(item.status || item.lead_status || 'unspecified') || 'unspecified';
  const options = [
    { v: 'unspecified', label: 'Unspecified' },
    { v: 'converted',   label: 'Converted' },
    { v: 'hot',         label: 'Hot' },
    { v: 'warm',        label: 'Warm' },
    { v: 'follow_up',   label: 'Follow-Up' },
    { v: 'cold',        label: 'Cold' },
    { v: 'research',    label: 'Research' },
    { v: 'no_fit',      label: 'No Fit' },
  ];
  return options.map((o) => {
    const sel = current === o.v ? 'selected' : '';
    return `<option value="${o.v}" ${sel}>${escapeHtml(o.label)}</option>`;
  }).join('');
}

async function inlineUpdateLead(leadId, patch) {
  const res = await fetch(`/update-lead/${encodeURIComponent(leadId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch || {}),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(txt || 'update_failed');
  }

  const data = await res.json().catch(() => null);
  return data && data.lead ? data.lead : data;
}

function dispatchLeadUpdated(leadId, patch) {
  try {
    window.dispatchEvent(new CustomEvent('deli:lead-updated', {
      detail: { id: leadId, patch: patch || {} },
    }));
  } catch (_) {}
}

// Cross-page broadcast (Daily Queue is a different page than index.html)
// storage events DO fire across tabs/windows.
const DS_LEAD_PATCH_BROADCAST_KEY = 'DS_LEAD_PATCH_BROADCAST_V1';

function broadcastLeadPatch(leadId, patch) {
  try {
    const payload = { id: String(leadId), patch: patch || {}, ts: Date.now() };
    localStorage.setItem(DS_LEAD_PATCH_BROADCAST_KEY, JSON.stringify(payload));
  } catch (_) {}
}


  function focusFirstActiveCard() {
    const cards = activeListEl.querySelectorAll('.dq-queue-card');
    let firstActive = null;

    cards.forEach((card) => {
      // Clear any previous "active" state
      card.classList.remove('dq-queue-card--active');

      // Remember the first card that is NOT done
      if (!firstActive && !card.classList.contains('dq-queue-card--done')) {
        firstActive = card;
      }
    });

    if (firstActive) {
      firstActive.classList.add('dq-queue-card--active');
      firstActive.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });
    }
  }

  // Smoothly collapse a card out of the active queue before moving it
  function animateCardDone(cardEl, onFinished) {
    if (!cardEl) {
      if (typeof onFinished === 'function') onFinished();
      return;
    }

    // If browser doesn't support transitions, just finish instantly
    const supportsTransition =
      'ontransitionend' in window || 'onwebkittransitionend' in window;

    if (!supportsTransition) {
      if (typeof onFinished === 'function') onFinished();
      return;
    }

    // Add collapsing class → triggers CSS animation
    cardEl.classList.add('dq-queue-card--collapsing');

    const handler = (event) => {
      // We only care about the max-height transition on THIS card
      if (event.target !== cardEl || event.propertyName !== 'max-height') return;

      cardEl.removeEventListener('transitionend', handler);
      cardEl.classList.remove('dq-queue-card--collapsing');

      if (typeof onFinished === 'function') {
        onFinished();
      }
    };

    cardEl.addEventListener('transitionend', handler);
  }

  // ———————————————————————
  // Render
  // ———————————————————————
function renderBatch() {
  const total = items.length;

  if (!total) {
    activeListEl.innerHTML = '';
    doneListEl.innerHTML = '';
    emptyEl.style.display = 'block';
    if (finishedEl) finishedEl.style.display = 'none';

    doneWrapperEl.style.display = 'none';
    doneCountEl.textContent = '0';

    updateProgress();
    return;
  }

  emptyEl.style.display = 'none';

  activeListEl.innerHTML = '';
  doneListEl.innerHTML = '';

  const activeItems = items.filter(i => !computeIsDone(i));
  const doneItems = items.filter(i => computeIsDone(i));

  activeItems.forEach(item => activeListEl.appendChild(renderCard(item)));
  doneItems.forEach(item => doneListEl.appendChild(renderCard(item)));

if (doneItems.length > 0) {
  doneWrapperEl.style.display = 'block';
  doneCountEl.textContent = String(doneItems.length);

  // Respect saved collapse state
  setDoneCollapsed(getDoneCollapsed());
} else {
  doneWrapperEl.style.display = 'none';
  doneCountEl.textContent = '0';
}


  updateProgress();
  focusFirstActiveCard();
}




  // Handle clicks inside a card (activate card + Done/Skip buttons)
  function onCardClick(event) {
    const cardEl = event.currentTarget;
    if (!cardEl) return;

    // Contact Rhythm buttons (one-click)
    const crBtn = event.target.closest('.dq-cr-btn');
    if (crBtn) {
      event.preventDefault();
      event.stopPropagation();

      const touch = crBtn.getAttribute('data-cr-touch');
      const leadId =
        crBtn.closest('[data-lead-id]')?.getAttribute('data-lead-id') ||
        cardEl.dataset.leadId;

      if (!touch || !leadId) return;

      crBtn.disabled = true;
      const oldText = crBtn.textContent;
      crBtn.textContent = 'Logging…';

      dqCrLogEvent(leadId, touch)
        .then((evt) => {
          dqCrUpdateCardUI(cardEl, evt);

          // Optimistic: update "Last touch" if present
          try {
            const lastSpan = cardEl.querySelector('[data-dq-last-touch]');
            if (lastSpan) lastSpan.textContent = formatDate(new Date().toISOString());
          } catch (_) {}
        })
        .catch((err) => {
          console.error(err);
          alert('Contact Rhythm log failed.');
        })
        .finally(() => {
          crBtn.disabled = false;
          crBtn.textContent = oldText;
        });

      return;
    }


    // If the click was on a Done / Skip button, handle that first
    const actionButton = event.target.closest('button[data-action]');
    if (actionButton) {
      const action = actionButton.dataset.action;
      const itemId = cardEl.dataset.itemId;
      if (!itemId) return;

      if (action === 'done') {
        event.preventDefault();
        event.stopPropagation();
        markItemDone(itemId, cardEl);
        return;
      }

      if (action === 'skip') {
        event.preventDefault();
        event.stopPropagation();
        markItemSkip(itemId, cardEl);
        return;
      }
    }

    // Otherwise, just set this card as the active card
    const cards = activeListEl.querySelectorAll('.dq-queue-card');
    cards.forEach((c) => c.classList.remove('dq-queue-card--active'));
    cardEl.classList.add('dq-queue-card--active');
  }

  function renderCard(item) {
    const isDone = computeIsDone(item);
    const statusLabel = item.status || item.lead_status || 'Unspecified';
    const statusClass = mapStatusClass(statusLabel);
	
	const websiteRaw =
  item.website ||
  item.Website ||
  (item.lead && (item.lead.website || item.lead.Website)) ||
  item.company_website ||
  item.companyWebsite ||
  item.website_url ||
  item.url ||
  '';


    const card = document.createElement('div');
    card.className = 'dq-queue-card' + (isDone ? ' dq-queue-card--done' : '');

// Timezone class (for left-border accent)
const { state: _dqState } = getLocationParts(item);
const _dqTz = getTimezoneByState(_dqState);
card.classList.add(`dq-tzcard-${_dqTz}`);

    card.dataset.itemId = item.item_id || item.id || '';
	
	card.dataset.leadId =
  item.lead_id ||
  item.id ||
  (item.lead && item.lead.id) ||
  '';


    card.innerHTML = `
      <div class="dq-card-header">
        <div class="dq-card-main">
          <div class="dq-company">
            ${escapeHtml(item.company || item.Company || 'No company')}
          </div>
          <div class="dq-contact">
            ${escapeHtml(item.name || item.contact_name || 'No contact name')}
          </div>
        </div>
        <span class="dq-status-pill ${statusClass}">
          ${escapeHtml(statusLabel)}
        </span>
      </div>

<div class="dq-card-body">
  <div class="dq-meta-line">
    <span>📍 ${renderLocationHtml(item)}</span>
    <span>🏷️ ${escapeHtml(item.industry || item.Industry || 'No industry')}</span>
  </div>


  <div class="dq-meta-line dq-inline-edits">
    <span>
      <span class="dq-control-label" style="margin-right:6px;">Role</span>
      <select class="dq-inline-role" data-prev-role="${escapeHtml(normalizeRoleValue(item.role || item.title || ''))}" ${isDone ? 'disabled' : ''} style="padding:3px 6px; font-size:12px; border:1px solid #e5e7eb; border-radius:8px; background:#fff;">
        ${renderRoleOptions(item)}
      </select>
    </span>
    <span>
      <span class="dq-control-label" style="margin-right:6px;">Status</span>
      <select class="dq-inline-status" data-prev-status="${escapeHtml(normalizeStatusValue(item.status || item.lead_status || 'unspecified') || 'unspecified')}" ${isDone ? 'disabled' : ''} style="padding:3px 6px; font-size:12px; border:1px solid #e5e7eb; border-radius:8px; background:#fff;">
        ${renderStatusOptions(item)}
      </select>
    </span>
  </div>
  <div class="dq-meta-line">
    <span>
      🌐 ${
  websiteRaw
    ? `<a href="${normalizeWebsite(websiteRaw)}"
         class="dq-website-link"
         target="_blank"
         rel="noopener noreferrer">
         ${escapeHtml(websiteRaw)}
       </a>`
    : '—'
}
    </span>
  </div>

  <div class="dq-meta-line">
    <span>Last touch: <span data-dq-last-touch>${escapeHtml(formatLastTouch(item))}</span></span>
    <span>Next touch: ${escapeHtml(formatNextTouch(item))}</span>
  </div>
</div>
	  
<!-- ⭐ CONTACT RHYTHM STRIP -->
<div class="dq-cr-strip" data-lead-id="${escapeHtml(
       String(item.lead_id || item.id || (item.lead && item.lead.id) || '')
     )}">
  <div class="dq-cr-left">
    <div class="dq-cr-title">Contact Rhythm</div>
    <div class="dq-cr-last" data-dq-cr-last title="Last Contact Rhythm log">—</div>
  </div>

  <div class="dq-cr-btns">
    <button class="dq-cr-btn" type="button" data-cr-touch="office_call_no_contact" title="Office call (no contact)">📞</button>
    <button class="dq-cr-btn" type="button" data-cr-touch="office_gatekeeper" title="Office gatekeeper">🧑‍💼</button>
    <button class="dq-cr-btn" type="button" data-cr-touch="cell_call_no_answer" title="Cell call (no answer)">📱</button>
    <button class="dq-cr-btn" type="button" data-cr-touch="cell_voicemail" title="Cell voicemail">📱💬</button>
  </div>
</div>
<!-- ⭐ END CONTACT RHYTHM STRIP -->




      <!-- ⭐ HORIZONTAL OPTION B CONTROLS -->
      <div class="dq-card-controls">
        <div class="dq-controls-main">

          <div class="dq-control-group">
            <span class="dq-control-label">Activity</span>
            <select class="dq-done-activity">
              <option value="">Select type…</option>
              <option value="call">Call</option>
              <option value="email">Email</option>
              <option value="social">Social</option>
            </select>
          </div>

          <div class="dq-control-group">
            <span class="dq-control-label">Status</span>
            <select class="dq-done-status">
              <option value="">Keep current</option>
              <option value="converted">Converted</option>
              <option value="hot">Hot</option>
              <option value="warm">Warm</option>
              <option value="follow-up">Follow-Up</option>
              <option value="cold">Cold</option>
              <option value="research">Research</option>
              <option value="no_fit">No Fit</option>
            </select>
          </div>

          <div class="dq-control-group dq-control-next-touch">
            <span class="dq-control-label">Next touch</span>
            <select class="dq-done-next-touch">
              <option value="">No change</option>
              <option value="tomorrow">Tomorrow</option>
              <option value="3_days">In 3 days</option>
              <option value="next_week">Next week</option>
              <option value="later_this_month">Later this month</option>
              <option value="custom">Pick date…</option>
            </select>
            <input type="date" class="dq-done-custom-date" />
          </div>




          <div class="dq-control-notes">
            <input
              type="text"
              class="dq-done-notes"
              placeholder="Notes for this touch…"
            />
          </div>

        </div>

        <div class="dq-card-actions">
          <button class="dq-card-btn" data-action="skip">⏭ Skip</button>
          <button class="dq-card-btn dq-card-btn-primary" data-action="done">✅ Done</button>
        </div>
      </div>
    `;
	
	// ===== CURRENT NOTES VIEW (READ-ONLY) =====
// Pull canonical notes (same notes field used by Lead 360 / List View)
const currentNotesRaw =
  (item && (item.notes || (item.lead && item.lead.notes))) || '';

const controlsMainEl =
  card.querySelector('.dq-controls-main') ||
  card.querySelector('.dq-controls') ||
  card; // final fallback

// In some builds the notes input isn't wrapped in .dq-control-notes.
// We anchor off the actual input so this survives markup drift.
const notesInputEl = card.querySelector('.dq-done-notes');
if (!controlsMainEl || !notesInputEl) return;


const notesViewWrapper = document.createElement('div');
notesViewWrapper.className = 'dq-current-notes-wrapper';

const safeHtml =
  currentNotesRaw
    ? escapeHtml(String(currentNotesRaw)).replace(/
/g, '<br>')
    : '<span style="color:#9ca3af;">No notes yet.</span>';

notesViewWrapper.innerHTML = `
  <div class="dq-current-notes-header">
    <button type="button" class="dq-current-notes-toggle">📄 Show Current Notes</button>
  </div>
  <div class="dq-current-notes-body" style="display:none;">
    <div class="dq-current-notes-content">${safeHtml}</div>
  </div>
`;

const toggleBtn = notesViewWrapper.querySelector('.dq-current-notes-toggle');
const notesBody = notesViewWrapper.querySelector('.dq-current-notes-body');

if (toggleBtn && notesBody) {
  toggleBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();

    const isOpen = notesBody.style.display === 'block';
    notesBody.style.display = isOpen ? 'none' : 'block';
    toggleBtn.textContent = isOpen ? '📄 Show Current Notes' : '📄 Hide Current Notes';
  });
}

// Insert viewer right above the Notes input (or its wrapper if present)
const notesAnchor = notesInputEl.closest('.dq-control-notes') || notesInputEl;
controlsMainEl.insertBefore(notesViewWrapper, notesAnchor);



    // Disable Contact Rhythm buttons for done cards
    if (isDone) {
      card.querySelectorAll('.dq-cr-btn').forEach((btn) => { btn.disabled = true; });
    }

    // Load last Contact Rhythm event for this lead
    dqCrRefreshCard(card);

    card.addEventListener('click', onCardClick);
    return card;
  }

  function getDqTodayIsoKey() {
    // Used only for local UI persistence (not a server source of truth)
    try {
      return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    } catch (_) {
      return 'unknown-date';
    }
  }

  const ACTION_TYPE_STORE_PREFIX = 'dq_action_type_v1:'; // bump if schema changes

  function getActionTypeStorageKey(itemId) {
    return `${ACTION_TYPE_STORE_PREFIX}${getDqTodayIsoKey()}:${itemId}`;
  }

  function hydrateActionTypesFromStorage() {
    // If backend doesn't return action_type for completed items yet,
    // restore it from localStorage so the goals tracker doesn't reset.
    try {
      items.forEach((item) => {
        const id = item && (item.item_id || item.id);
        if (!id) return;

        const finished = item.is_completed || item.is_done;
        if (!finished || item.is_skipped) return;

        const existingType =
          item.activity_type ||
          item.action_type ||
          item.actionType ||
          item.completed_action_type ||
          item.completedActionType;

        if (existingType) return;

        const stored = localStorage.getItem(getActionTypeStorageKey(id));
        if (stored) {
          item.activity_type = stored;
        }
      });
    } catch (_) {}
  }

  function updateActivityGoals() {
    let calls = 0;
    let emails = 0;
    let socials = 0;

    // Count only items we actually completed (not skipped)
    items.forEach((item) => {
      if (!item) return;

      // 🔹 NEW: treat both is_completed and is_done as "finished"
      const finished = item.is_completed || item.is_done;
      if (!finished || item.is_skipped) return;

      // Backend may return this as action_type (or other variants).
const t = (
  item.activity_type ||
  item.action_type ||
  item.actionType ||
  item.completed_action_type ||
  item.completedActionType ||
  ''
)
  .toString()
  .toLowerCase();
      if (t === 'call') calls += 1;
      else if (t === 'email') emails += 1;
      else if (t === 'social') socials += 1;
    });

    // Update labels
    if (callsCountEl) {
      callsCountEl.textContent = `${calls}/${CALL_GOAL}`;
    }
    if (emailsCountEl) {
      emailsCountEl.textContent = `${emails}/${EMAIL_GOAL}`;
    }
    if (socialCountEl) {
      socialCountEl.textContent = `${socials}/${SOCIAL_GOAL}`;
    }

    // Update bar widths (clamp to 100%)
    if (callsBarEl) {
      const pct = CALL_GOAL ? Math.min(100, Math.round((calls / CALL_GOAL) * 100)) : 0;
      callsBarEl.style.width = `${pct}%`;
    }
    if (emailsBarEl) {
      const pct = EMAIL_GOAL ? Math.min(100, Math.round((emails / EMAIL_GOAL) * 100)) : 0;
      emailsBarEl.style.width = `${pct}%`;
    }
    if (socialBarEl) {
      const pct = SOCIAL_GOAL ? Math.min(100, Math.round((socials / SOCIAL_GOAL) * 100)) : 0;
      socialBarEl.style.width = `${pct}%`;
    }
  }

  function updateProgress() {
    const total = items.length;
    const doneCount = items.filter((i) => computeIsDone(i)).length;
    const remaining = Math.max(total - doneCount, 0);
    const pct = total ? Math.round((doneCount / total) * 100) : 0;

    totalEl.textContent = total;
    doneEl.textContent = doneCount;
    remainingEl.textContent = remaining;

    progressBarEl.style.width = `${pct}%`;

    if (total > 0 && remaining === 0) {
      progressLabelEl.textContent = '100% complete — You’re finished with this batch 🎉';
      if (finishedEl) finishedEl.style.display = 'flex';

      // Hide all Done/Skip buttons when batch is finished
      const buttons = document.querySelectorAll('.dq-card-actions');
      buttons.forEach((btn) => {
        btn.style.display = 'none';
      });
    } else {
      progressLabelEl.textContent = `${pct}% complete`;
      if (finishedEl) finishedEl.style.display = 'none';

      // Ensure actions reappear when new batch loads
      const buttons = document.querySelectorAll('.dq-card-actions');
      buttons.forEach((btn) => {
        btn.style.display = 'flex';
      });
    }

    // 🔹 Also refresh the Calls / Emails / Social goal bars
    updateActivityGoals();
  }

  async function markItemDone(itemId, cardEl) {
    // Pull values from the controls on this specific card
    const activitySelect = cardEl.querySelector('.dq-done-activity');
    const statusSelect = cardEl.querySelector('.dq-done-status');
    const notesInput = cardEl.querySelector('.dq-done-notes');
    const nextTouchSelect = cardEl.querySelector('.dq-done-next-touch');
    const customDateInput = cardEl.querySelector('.dq-done-custom-date');

    let activity_type = null;
    let new_status = null;
    let notes = null;
    let next_touch_choice = null;
    let next_touch_at = null;

    if (activitySelect && activitySelect.value) {
      activity_type = activitySelect.value; // "call" | "email" | "social"
    }

    // Soft require: must choose an activity type to log Done
    if (!activity_type) {
      alert('Pick an Activity Type (Call / Email / Social) before marking this item as Done.');
      return;
    }

    if (statusSelect && statusSelect.value) {
      new_status = statusSelect.value; // e.g. "warm", "follow-up", "converted"
    }

    if (notesInput) {
      const v = String(notesInput.value || '').trim();
      if (v) notes = v;
    }


    if (nextTouchSelect && nextTouchSelect.value) {
      const choice = nextTouchSelect.value;

      if (choice === 'custom') {
        if (customDateInput && customDateInput.value) {
          next_touch_choice = 'custom';
          next_touch_at = customDateInput.value; // e.g. "2025-11-30"
        }
      } else {
        next_touch_choice = choice;
      }
    }

    try {
      const res = await fetch(`/api/daily-queue/item/${encodeURIComponent(itemId)}/done`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          new_status,
          action_type: activity_type, // Activity Type (Call/Email/Social)
          notes, // ✅ Daily Queue touch note (append-only; backend no-ops on blank)
          next_touch_choice,
          next_touch_at,
        }),
      });

      if (!res.ok) {
        console.error('Failed to mark item done', await res.text());
        alert('Could not mark this item as done. Check console for details.');
        return;
      }

      const data = await res.json().catch(() => ({}));
      const updatedLead = data && data.lead ? data.lead : null;

      // 🔄 Notify other views (Lead 360 / List View) that this lead changed
      dispatchLeadUpdated(cardEl.dataset.leadId, {
        status: new_status || undefined,
        notes: (updatedLead && Object.prototype.hasOwnProperty.call(updatedLead, 'notes')) ? (updatedLead.notes || '') : (notes || undefined),
      });

      // Cross-page broadcast (so index.html updates immediately)
      try { broadcastLeadPatch(cardEl.dataset.leadId, { status: new_status || undefined, notes: (updatedLead && Object.prototype.hasOwnProperty.call(updatedLead, 'notes')) ? (updatedLead.notes || '') : undefined }); } catch(_) {}



      // Update local data model and status pill
      const item = items.find((i) => String(i.item_id || i.id) === String(itemId));
      if (item) {
        item.is_completed = true;
        item.is_done = true;
        item.is_skipped = false;
        item.activity_type = activity_type; // remember how we completed this

        // Persist activity type locally so goals tracker survives navigation
        try {
          localStorage.setItem(getActionTypeStorageKey(itemId), String(activity_type || '').toLowerCase());
        } catch (_) {}


        if (new_status) {
          item.status = new_status;

          const pill = cardEl.querySelector('.dq-status-pill');
          if (pill) {
            const displayLabel = formatStatusLabelForDisplay(new_status);
            pill.textContent = displayLabel;
            pill.className = 'dq-status-pill ' + mapStatusClass(new_status);
          }
        }
      }

      // Visually mark as done…
      cardEl.classList.add('dq-queue-card--done');

      // …then animate collapse, and only after that move it to the bottom
animateCardDone(cardEl, () => {
  // Move into Done Today section
  doneListEl.appendChild(cardEl);

  // Make sure the Done Today header is visible + count is correct
doneWrapperEl.style.display = 'block';
const doneNow = items.filter((i) => computeIsDone(i)).length;
doneCountEl.textContent = String(doneNow);

// 🔹 Re-apply collapse preference immediately
setDoneCollapsed(getDoneCollapsed());

updateProgress();
focusFirstActiveCard();

});

    } catch (err) {
      console.error('Error marking done', err);
      alert('Error reaching the server while marking this item as done.');
    }
  }

  async function markItemSkip(itemId, cardEl) {
    try {
      const res = await fetch(`/api/daily-queue/item/${encodeURIComponent(itemId)}/skip`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reason: 'skipped_from_daily_queue',
        }),
      });

      if (!res.ok) {
        console.error('Failed to skip item', await res.text());
        alert('Could not skip this item. Check console for details.');
        return;
      }

      // Update local data model
      const item = items.find((i) => String(i.item_id || i.id) === String(itemId));
      if (item) {
        item.is_skipped = true;
        item.is_completed = false;
        item.is_done = false;

        // If we skip it, clear any stored activity type
        try {
          localStorage.removeItem(getActionTypeStorageKey(itemId));
        } catch (_) {}

      }

      // Grey it out + move to bottom
cardEl.classList.add('dq-queue-card--done');

// Move into Done Today section
doneListEl.appendChild(cardEl);

// Make sure the Done Today header is visible + count is correct
doneWrapperEl.style.display = 'block';
const doneNow = items.filter((i) => computeIsDone(i)).length;
doneCountEl.textContent = String(doneNow);

// 🔹 Re-apply collapse preference immediately
setDoneCollapsed(getDoneCollapsed());

updateProgress();
focusFirstActiveCard();


    } catch (err) {
      console.error('Error skipping item', err);
      alert('Error reaching the server while skipping this item.');
    }
  }

  // ———————————————————————
  // Keyboard navigation helpers
  // ———————————————————————
function getQueueCards() {
  if (!activeListEl) return [];
  return Array.from(activeListEl.querySelectorAll('.dq-queue-card'));
}


  function getActiveCardInfo() {
    const cards = getQueueCards();
    if (!cards.length) return { cards, index: -1, card: null };

    let index = -1;
    let card = null;

    cards.forEach((c, i) => {
      if (c.classList.contains('dq-queue-card--active')) {
        index = i;
        card = c;
      }
    });

    return { cards, index, card };
  }

  function moveActiveCard(delta) {
    const { cards, index } = getActiveCardInfo();
    if (!cards.length) return;

    let newIndex = index;

    if (index === -1) {
      // If nothing is active yet, pick the first non-done
      const firstNonDone = cards.findIndex(
        (c) => !c.classList.contains('dq-queue-card--done')
      );
      newIndex = firstNonDone !== -1 ? firstNonDone : 0;
    } else {
      newIndex = index + delta;
      if (newIndex < 0) newIndex = 0;
      if (newIndex >= cards.length) newIndex = cards.length - 1;
    }

    // Clear and set new active
    cards.forEach((c) => c.classList.remove('dq-queue-card--active'));
    const newCard = cards[newIndex];
    if (newCard) {
      newCard.classList.add('dq-queue-card--active');
      newCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  // ———————————————————————
  // Keyboard shortcuts: D = Done, S = Skip, arrows = move
  // ———————————————————————
  document.addEventListener('keydown', (event) => {
    // Don't hijack keys while typing in inputs / selects / textareas
    const tag = (event.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

    const key = event.key;

    // If there are no cards, ignore
    const { cards, index, card } = getActiveCardInfo();
    if (!cards.length) return;

    // Arrow navigation
    if (key === 'ArrowDown') {
      event.preventDefault();
      moveActiveCard(+1);
      return;
    }
    if (key === 'ArrowUp') {
      event.preventDefault();
      moveActiveCard(-1);
      return;
    }

    // For Done/Skip, we need an active, not-already-done card
    const activeCard = card || cards.find((c) => !c.classList.contains('dq-queue-card--done'));
    if (!activeCard) return;

    const itemId = activeCard.dataset.itemId;
    if (!itemId) return;

    // D = Done
    if (key === 'd' || key === 'D') {
      event.preventDefault();
      markItemDone(itemId, activeCard);
      return;
    }

    // S = Skip
    if (key === 's' || key === 'S') {
      event.preventDefault();
      markItemSkip(itemId, activeCard);
      return;
    }
  });

  // ———————————————————————
  // Custom date dropdown behavior
  // ———————————————————————
  document.addEventListener('change', (event) => {
    const select = event.target.closest('.dq-done-next-touch');
    if (!select) return;

    const card = select.closest('.dq-queue-card');
    if (!card) return;

    const customDateInput = card.querySelector('.dq-done-custom-date');
    if (!customDateInput) {
      return;
    }

    if (select.value === 'custom') {
      customDateInput.style.display = 'inline-block';
    } else {
      customDateInput.style.display = 'none';
      customDateInput.value = '';
    }
  });



// Inline Role/Status edits (save immediately + keep UI in sync)
document.addEventListener('change', async (event) => {
  const roleSel = event.target.closest('.dq-inline-role');
  const statusSel = event.target.closest('.dq-inline-status');
  const sel = roleSel || statusSel;
  if (!sel) return;

  const card = sel.closest('.dq-queue-card');
  if (!card) return;

  const leadId = card.dataset.leadId;
  if (!leadId) return;

  // Prevent double-submits (lock per-card)
  if (card.dataset.inlineSaving === '1') return;

  const patch = {};
  if (roleSel) {
    const next = normalizeRoleValue(roleSel.value);
    const prev = normalizeRoleValue(roleSel.dataset.prevRole || '');
    if (next === prev) return;
    patch.role = next || null;
  }

  if (statusSel) {
    const next = normalizeStatusValue(statusSel.value || '');
    const prev = normalizeStatusValue(statusSel.dataset.prevStatus || '');
    if (next === prev) return;
    patch.status = next || 'unspecified';
  }

  if (!Object.keys(patch).length) return;

  card.dataset.inlineSaving = '1';

  // Disable BOTH inline dropdowns while saving (prevents double edits / race)
  const roleEl = card.querySelector('.dq-inline-role');
  const statusEl = card.querySelector('.dq-inline-status');
  const roleWasDisabled = roleEl ? roleEl.disabled : null;
  const statusWasDisabled = statusEl ? statusEl.disabled : null;
  if (roleEl) roleEl.disabled = true;
  if (statusEl) statusEl.disabled = true;

  try {
    await inlineUpdateLead(leadId, patch);

    // Update local data model (so the Daily Queue UI won't "snap back")
    const itemId = card.dataset.itemId;
    const item = items.find((i) => String(i.item_id || i.id) === String(itemId))
      || items.find((i) => String(i.lead_id || i.id) === String(leadId));

    if (item) {
      if ('role' in patch) item.role = patch.role;
      if ('status' in patch) item.status = patch.status;
    }

    // Update pill immediately if status changed
    if ('status' in patch) {
      const pill = card.querySelector('.dq-status-pill');
      if (pill) {
        const displayLabel = formatStatusLabelForDisplay(patch.status);
        pill.textContent = displayLabel;
        pill.className = 'dq-status-pill ' + mapStatusClass(patch.status);
      }
      if (statusEl) statusEl.dataset.prevStatus = patch.status;
    }

    if ('role' in patch) {
      if (roleEl) roleEl.dataset.prevRole = patch.role || '';
    }

    // Broadcast for any other open UI that cares (List View / Lead 360)
    dispatchLeadUpdated(leadId, patch);

    showDqToast('Saved', 'success');

  } catch (err) {
    console.error('Inline update failed', err);

    // Revert UI selection
    if (roleEl) roleEl.value = roleEl.dataset.prevRole || '';
    if (statusEl) statusEl.value = statusEl.dataset.prevStatus || 'unspecified';

    showDqToast('Failed — reverted', 'error');
  } finally {
    card.dataset.inlineSaving = '0';

    // Restore prior disabled state (unless card is done, in which case keep disabled)
    const isDone = card.classList.contains('dq-queue-card--done');
    if (roleEl) roleEl.disabled = isDone ? true : (roleWasDisabled === true ? true : false);
    if (statusEl) statusEl.disabled = isDone ? true : (statusWasDisabled === true ? true : false);
  }
});


  // ———————————————————————
  // API calls
  // ———————————————————————
  async function loadCurrentBatch() {
    // 🎯 Special case: Event Mode with autostart
    // If we came here via /daily-queue?autostart=1&tag=..., do NOT reuse
    // whatever "current" batch exists. Instead, force a fresh tag-locked batch.
    //  if (batchTag && autoStart) {
    //  await generateNewBatch();
    //    return;
    //   }

    toggleLoading(true);
    try {
      const res = await fetch('/api/daily-queue/current', {
        method: 'GET',
      });

      if (!res.ok) {
        console.error('Failed to load current batch', await res.text());
        alert('Unable to load current Daily Queue. Check console for details.');
        return;
      }

      const data = await res.json();
      currentBatch = data.batch || null;
      items = data.items || [];

      // Restore activity types (Call/Email/Social) for completed cards
      hydrateActionTypesFromStorage();


      sortItemsForDisplay();
      renderBatch();

    } catch (err) {
      console.error('Error loading current batch', err);
      alert('Error reaching the server while loading your Daily Queue.');
    } finally {
      toggleLoading(false);
    }
  }


  async function generateNewBatch() {
    toggleLoading(true);
    try {
      // For now, fixed 20 as you requested.
      // If batchTag is set, this becomes "Event Mode" (tag-only leads).
      const res = await fetch('/api/daily-queue/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          batch_size: 20,
          industries: null,
          tag: batchTag,   // 🔹 NEW: optional tag filter for Event Mode
        }),
      });


      if (!res.ok) {
        console.error('Failed to generate batch', await res.text());
        alert('Unable to generate a new Daily Queue batch. Check console for details.');
        return;
      }

      const data = await res.json();
      currentBatch = data.batch || null;
      items = data.items || [];

      // Restore activity types (Call/Email/Social) for completed cards
      hydrateActionTypesFromStorage();


      // 🔹 NEW: consistent ordering for new batches too
      sortItemsForDisplay();

      renderBatch();
    } catch (err) {
      console.error('Error generating batch', err);
      alert('Error reaching the server while generating your Daily Queue.');
    } finally {
      toggleLoading(false);
    }
  }

  // ———————————————————————
  // Init
  // ———————————————————————
if (newBatchBtn) {
  newBatchBtn.addEventListener('click', async () => {
    await generateNewBatch();
  });
}



  setTodayText();
  loadCurrentBatch();
});

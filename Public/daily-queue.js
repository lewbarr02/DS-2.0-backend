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


// ———————————————————————
// AP Snapshot helpers (Midpoint row)
// ———————————————————————
function getApSnapshotFromItem(item) {
  const src = item && item.lead ? item.lead : item;

  return {
    status: src?.ap_snapshot_status ?? null,
    run_at: src?.ap_snapshot_run_at ?? null,
    arr: src?.ap_snapshot_arr ?? null,
    arr_confidence: src?.ap_snapshot_arr_confidence ?? null,
    suppliers: src?.ap_snapshot_suppliers ?? null,
    ap_spend: src?.ap_snapshot_ap_spend ?? null,
    source: src?.ap_snapshot_source ?? null,
    notes: src?.ap_snapshot_notes ?? null,
  };
}

function fmtInt(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return Math.round(n).toLocaleString();
}

function renderApSnapshotBadges(item) {
  const snap = getApSnapshotFromItem(item);

  // Distinct “not found”
  if (snap.status === 'not_found' ||
      (snap.status && String(snap.status).toLowerCase() === 'not_found')) {
    return `
      <span class="dq-ap-snap-badge not-found">ARR: Not found</span>
      <span class="dq-ap-snap-badge">Suppliers: —</span>
      <span class="dq-ap-snap-badge">AP Spend: —</span>
    `;
  }

  const conf = snap.arr_confidence
    ? String(snap.arr_confidence).toUpperCase()
    : null;

// ARR as $XM
const arrLabel =
  snap.arr != null ? `${fmtMillions(snap.arr)}${conf ? ` (${conf})` : ''}` : '—';

// Suppliers keep exact integer formatting
const suppliersLabel = snap.suppliers != null ? fmtInt(snap.suppliers) : '—';

// AP Spend as $XM
const apSpendLabel = snap.ap_spend != null ? fmtMillions(snap.ap_spend) : '—';


  return `
    <span class="dq-ap-snap-badge">ARR: ${escapeHtml(arrLabel)}</span>
    <span class="dq-ap-snap-badge">Suppliers: ${escapeHtml(suppliersLabel)}</span>
    <span class="dq-ap-snap-badge">AP Spend: ${escapeHtml(apSpendLabel)}</span>
  `;
}

function setApSnapshotOnItem(item, leadPayload) {
  if (!item || !leadPayload) return;

  const apply = (obj) => {
    if (!obj) return;
    obj.ap_snapshot_status = leadPayload.ap_snapshot_status ?? obj.ap_snapshot_status ?? null;
    obj.ap_snapshot_run_at = leadPayload.ap_snapshot_run_at ?? obj.ap_snapshot_run_at ?? null;
    obj.ap_snapshot_arr = leadPayload.ap_snapshot_arr ?? obj.ap_snapshot_arr ?? null;
    obj.ap_snapshot_arr_confidence = leadPayload.ap_snapshot_arr_confidence ?? obj.ap_snapshot_arr_confidence ?? null;
    obj.ap_snapshot_suppliers = leadPayload.ap_snapshot_suppliers ?? obj.ap_snapshot_suppliers ?? null;
    obj.ap_snapshot_ap_spend = leadPayload.ap_snapshot_ap_spend ?? obj.ap_snapshot_ap_spend ?? null;
    obj.ap_snapshot_source = leadPayload.ap_snapshot_source ?? obj.ap_snapshot_source ?? null;
    obj.ap_snapshot_notes = leadPayload.ap_snapshot_notes ?? obj.ap_snapshot_notes ?? null;
  };

  apply(item);
  if (item.lead) apply(item.lead);
}

function refreshApSnapshotRow(cardEl, item) {
  if (!cardEl) return;
  const row = cardEl.querySelector('.dq-ap-snap');
  if (!row) return;

  const valuesEl = row.querySelector('.dq-ap-snap-values');
  if (valuesEl) valuesEl.innerHTML = renderApSnapshotBadges(item);

  const btn = row.querySelector('button[data-action="ap-snapshot"]');
  if (btn) {
    const snap = getApSnapshotFromItem(item);
    btn.textContent = snap.run_at ? 'Re-run' : 'Run';
  }
}

async function runApSnapshot(leadId, cardEl) {
  if (!leadId) return;

  const btn = cardEl?.querySelector('button[data-action="ap-snapshot"]');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Running...';
  }

  try {
    const res = await fetch(`/api/leads/${encodeURIComponent(leadId)}/ap-snapshot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    if (!res.ok) {
      console.error('AP Snapshot failed:', await res.text());
      alert('AP Snapshot failed. Check console for details.');
      return;
    }

    const data = await res.json();
    const leadPayload = data?.lead || null;

    const itemId = cardEl?.dataset?.itemId;
    const item = items.find((i) => String(i.item_id || i.id) === String(itemId));

    if (item && leadPayload) {
      setApSnapshotOnItem(item, leadPayload);
      refreshApSnapshotRow(cardEl, item);
    } else if (cardEl && leadPayload) {
      refreshApSnapshotRow(cardEl, { lead: leadPayload });
    }
  } catch (err) {
    console.error('AP Snapshot error:', err);
    alert('AP Snapshot error. Check console for details.');
  } finally {
    if (btn) btn.disabled = false;
  }
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
    const s = (statusRaw || '').toString().toLowerCase();
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
	  
	  // ⭐ NEW: AP Snapshot button
if (action === 'ap-snapshot') {
  event.preventDefault();
  event.stopPropagation();

  // Prefer dataset lead_id → fallback → lookup item model
  let leadId =
    cardEl.dataset.leadId ||
    (cardEl.querySelector('.dq-ap-snap')?.dataset?.leadId) ||
    null;

  if (!leadId) {
    const item = items.find((i) =>
      String(i.item_id || i.id) === String(itemId)
    );
    leadId = item?.lead_id || item?.id || (item?.lead && item.lead.id) || null;
  }

  if (!leadId) {
    console.error('AP Snapshot: no valid leadId for card', cardEl);
    return;
  }

  runApSnapshot(leadId, cardEl);
  return;   // important: stop further click processing
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
    <span>📍 ${escapeHtml(formatLocation(item))}</span>
    <span>🏷️ ${escapeHtml(item.industry || item.Industry || 'No industry')}</span>
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
    <span>Last touch: ${escapeHtml(formatLastTouch(item))}</span>
    <span>Next touch: ${escapeHtml(formatNextTouch(item))}</span>
  </div>
</div>
	  
<!-- ⭐ AP SNAPSHOT MIDPOINT ROW -->
<div class="dq-ap-snap"
     data-lead-id="${escapeHtml(
       String(item.lead_id || item.id || (item.lead && item.lead.id) || '')
     )}">
  
  <div class="dq-ap-snap-left">
    <div class="dq-ap-snap-title">AP Snapshot</div>
    <div class="dq-ap-snap-values">
      ${renderApSnapshotBadges(item)}
    </div>
  </div>

  <button class="dq-ap-snap-btn"
          type="button"
          data-action="ap-snapshot">
    ${getApSnapshotFromItem(item).run_at ? 'Re-run' : 'Run'}
  </button>
</div>
<!-- ⭐ END AP SNAPSHOT ROW -->



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
    let notes = '';
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

    if (notesInput && notesInput.value.trim() !== '') {
      notes = notesInput.value.trim();
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
          notes,
          next_touch_choice,
          next_touch_at,
        }),
      });

      if (!res.ok) {
        console.error('Failed to mark item done', await res.text());
        alert('Could not mark this item as done. Check console for details.');
        return;
      }

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
    if (!customDateInput) return;

    if (select.value === 'custom') {
      customDateInput.style.display = 'inline-block';
    } else {
      customDateInput.style.display = 'none';
      customDateInput.value = '';
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
    newBatchBtn.addEventListener('click', () => {
      alert('Daily Queue is manual-only. Add leads from Map or List view.');
    });
  }


  setTodayText();
  loadCurrentBatch();
});

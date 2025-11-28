// public/js/daily-queue.js
document.addEventListener('DOMContentLoaded', () => {
  const listEl = document.getElementById('dq-list');
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

  // Read any query parameters (e.g., /daily-queue?autostart=1)
  const urlParams = new URLSearchParams(window.location.search);
  const autoStart = urlParams.get('autostart') === '1';

  // ———————————————————————
  // Helpers
  // ———————————————————————
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

  function formatDate(value) {
    if (!value) return '—';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '—';
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${mm}/${dd}`;
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
  
    // Short money helpers for ARR/AP Spend (e.g. "25M", "2.5B", "750K")
  function formatShortMoney(value) {
    if (value == null) return '';
    const n = Number(value);
    if (!Number.isFinite(n)) return '';

    const abs = Math.abs(n);

    const fmt = (val) => {
      // 10M -> "10", 2.5M -> "2.5"
      return val >= 10 ? Math.round(val).toString()
                       : (Math.round(val * 10) / 10).toString();
    };

    if (abs >= 1_000_000_000) return fmt(n / 1_000_000_000) + 'B';
    if (abs >= 1_000_000)     return fmt(n / 1_000_000)     + 'M';
    if (abs >= 1_000)         return fmt(n / 1_000)         + 'K';
    return n.toString();
  }

  function parseShortMoneyClient(v) {
    if (v == null) return null;

    let s = String(v).trim();
    if (!s) return null;

    // strip $ and commas, normalize to lowercase
    s = s.replace(/[\$,]/g, '').toLowerCase();

    // allow K / M / MM / B suffix
    const match = s.match(/^([\d.,]+)(k|m{1,2}|b)?$/);
    if (!match) {
      const n = Number(s.replace(/,/g, ''));
      return Number.isFinite(n) ? n : null;
    }

    let num = parseFloat(match[1].replace(/,/g, ''));
    if (!Number.isFinite(num)) return null;

    const suffix = match[2];
    if (suffix === 'k') {
      num *= 1_000;
    } else if (suffix === 'm' || suffix === 'mm') {
      num *= 1_000_000;
    } else if (suffix === 'b') {
      num *= 1_000_000_000;
    }

    return num;
  }

  // Shared month options for inline Forecast Month dropdown
  const FORECAST_MONTH_OPTIONS = [
    'January','February','March','April','May','June',
    'July','August','September','October','November','December'
  ];


  function computeIsDone(item) {
    // Prefer backend flags if present
    if (typeof item.is_done === 'boolean') return item.is_done;
    if (typeof item.is_completed === 'boolean') {
      // Count skipped as "done" for progress too
      return item.is_completed || !!item.is_skipped;
    }

    const s = (item.status || item.lead_status || '').toString().toLowerCase();
    if (!s) return false;
    return ['converted', 'no fit', 'no_fit', 'retired', 'done', 'completed'].includes(s);
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
    const cards = listEl.querySelectorAll('.dq-queue-card');
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

    // If browser doesn't support transitions for some reason, just finish instantly
    const supportsTransition =
      'ontransitionend' in window || 'onwebkittransitionend' in window;

    if (!supportsTransition) {
      if (typeof onFinished === 'function') onFinished();
      return;
    }

    // Add collapsing class → triggers CSS animation (max-height → 0, fade, slight lift)
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
      listEl.innerHTML = '';
      emptyEl.style.display = 'block';
      if (finishedEl) finishedEl.style.display = 'none';
      updateProgress();
      return;
    }

    emptyEl.style.display = 'none';
    listEl.innerHTML = '';

    items.forEach((item) => {
      const cardEl = renderCard(item);
      listEl.appendChild(cardEl);
    });

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

      if (action === 'save-lead') {
        event.preventDefault();
        event.stopPropagation();
        saveLeadInline(itemId, cardEl);
        return;
      }

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
    const cards = listEl.querySelectorAll('.dq-queue-card');
    cards.forEach((c) => c.classList.remove('dq-queue-card--active'));
    cardEl.classList.add('dq-queue-card--active');
  }
 

  function renderCard(item) {
    const isDone = computeIsDone(item);
    const statusLabel = item.status || item.lead_status || 'Unspecified';
    const statusClass = mapStatusClass(statusLabel);

    const card = document.createElement('div');
    card.className = 'dq-queue-card' + (isDone ? ' dq-queue-card--done' : '');
    card.dataset.itemId = item.item_id || item.id || '';

    // Pre-format money + month values
    const arrDisplay = item.arr != null ? formatShortMoney(item.arr) : '';
    const apDisplay = item.ap_spend != null ? formatShortMoney(item.ap_spend) : '';
    const currentForecast = item.forecast_month || '';

    const monthOptionsHtml = `
      <option value="">Forecast…</option>
      ${FORECAST_MONTH_OPTIONS.map(m => `
        <option value="${escapeHtml(m)}" ${m === currentForecast ? 'selected' : ''}>
          ${escapeHtml(m)}
        </option>
      `).join('')}
    `;

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
          <span>Last touch: ${escapeHtml(formatLastTouch(item))}</span>
          <span>Next touch: ${escapeHtml(formatNextTouch(item))}</span>
        </div>
      </div>

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

          <!-- 🔹 Inline lead fields (Forecast / ARR / AP Spend) -->
          <div class="dq-control-group dq-control-lead-fields">
            <span class="dq-control-label">Lead</span>
            <select class="dq-edit-forecast-month">
              ${monthOptionsHtml}
            </select>
            <input
              type="text"
              class="dq-edit-arr"
              placeholder="ARR (e.g. 25M)"
              value="${escapeHtml(arrDisplay)}"
            />
            <input
              type="text"
              class="dq-edit-ap-spend"
              placeholder="AP Spend (e.g. 40M)"
              value="${escapeHtml(apDisplay)}"
            />
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
          <button class="dq-card-btn" data-action="save-lead">💾 Save</button>
          <button class="dq-card-btn" data-action="skip">⏭ Skip</button>
          <button class="dq-card-btn dq-card-btn-primary" data-action="done">✅ Done</button>
        </div>
      </div>
    `;

    card.addEventListener('click', onCardClick);
    return card;
  }



  function updateActivityGoals() {
    let calls = 0;
    let emails = 0;
    let socials = 0;

    // Count only items we actually completed (not skipped)
    items.forEach((item) => {
      if (!item || !item.is_completed || item.is_skipped) return;
      const t = (item.activity_type || '').toString().toLowerCase();
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

      // NEW → Hide all Done/Skip buttons when batch is finished
      const buttons = document.querySelectorAll('.dq-card-actions');
      buttons.forEach(btn => {
        btn.style.display = 'none';
      });

    } else {
      progressLabelEl.textContent = `${pct}% complete`;
      if (finishedEl) finishedEl.style.display = 'none';

      // Ensure actions reappear when new batch loads
      const buttons = document.querySelectorAll('.dq-card-actions');
      buttons.forEach(btn => {
        btn.style.display = 'flex';
      });
    }

    // 🔹 Also refresh the Calls / Emails / Social goal bars
    updateActivityGoals();
  }
  
  async function saveLeadInline(itemId, cardEl) {
    const item = items.find((i) => String(i.item_id || i.id) === String(itemId));
    if (!item) {
      alert('Could not find this lead in the current batch.');
      return;
    }

    const leadId = item.lead_id || item.id;
    if (!leadId) {
      alert('Missing lead id for this item.');
      return;
    }

    const forecastSelect = cardEl.querySelector('.dq-edit-forecast-month');
    const arrInput = cardEl.querySelector('.dq-edit-arr');
    const apInput = cardEl.querySelector('.dq-edit-ap-spend');

    const forecastRaw = forecastSelect ? forecastSelect.value : '';
    const arrRaw = arrInput ? arrInput.value : '';
    const apRaw = apInput ? apInput.value : '';

    // 🔹 Only include fields the user actually typed/selected
    const payload = {};
    if (forecastRaw) {
      payload.forecast_month = forecastRaw;
    }
    if (arrRaw.trim() !== '') {
      payload.arr = arrRaw.trim();          // backend will parse short money
    }
    if (apRaw.trim() !== '') {
      payload.ap_spend = apRaw.trim();      // backend will parse short money
    }

    // If nothing was changed, bail early
    if (!Object.keys(payload).length) {
      alert('No lead changes to save.');
      return;
    }

    try {
      const res = await fetch(`/update-lead/${encodeURIComponent(leadId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        console.error('Failed to save lead inline', await res.text());
        alert('Could not save lead updates. Check console for details.');
        return;
      }

      const updated = await res.json();

      // Update in-memory item so UI + future logic stay in sync
      if ('forecast_month' in updated) {
        item.forecast_month = updated.forecast_month;
        if (item.lead) item.lead.forecast_month = updated.forecast_month;
      }
      if ('arr' in updated) {
        item.arr = updated.arr;
        if (item.lead) item.lead.arr = updated.arr;
      }
      if ('ap_spend' in updated) {
        item.ap_spend = updated.ap_spend;
        if (item.lead) item.lead.ap_spend = updated.ap_spend;
      }

      // Refresh the display values in the inputs
      if (forecastSelect && 'forecast_month' in updated) {
        forecastSelect.value = updated.forecast_month || '';
      }
      if (arrInput && 'arr' in updated) {
        arrInput.value =
          updated.arr != null ? formatShortMoney(updated.arr) : '';
      }
      if (apInput && 'ap_spend' in updated) {
        apInput.value =
          updated.ap_spend != null ? formatShortMoney(updated.ap_spend) : '';
      }

      // Tiny UX touch: flash the Save button text
      const saveBtn = cardEl.querySelector('button[data-action="save-lead"]');
      if (saveBtn) {
        const original = saveBtn.textContent;
        saveBtn.textContent = '✅ Saved';
        setTimeout(() => {
          saveBtn.textContent = original;
        }, 900);
      }
    } catch (err) {
      console.error('Error saving lead inline', err);
      alert('Error reaching the server while saving this lead.');
    }
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
      const choice = nextTouchSelect.value; // "tomorrow", "3_days", "next_week", "later_this_month", "custom"

      if (choice === 'custom') {
        if (customDateInput && customDateInput.value) {
          next_touch_choice = 'custom';
          // send raw date string; backend can interpret as a date
          next_touch_at = customDateInput.value; // e.g. "2025-11-30"
        }
      } else {
        // Non-custom options: we just send the symbolic choice
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
        item.activity_type = activity_type; // 🔹 remember how we completed this

        if (new_status) {
          // update in-memory status so future logic sees it
          item.status = new_status;

          // update the pill on this card immediately
          const pill = cardEl.querySelector('.dq-status-pill');
          if (pill) {
            const displayLabel = formatStatusLabelForDisplay(new_status);
            pill.textContent = displayLabel;
            pill.className = 'dq-status-pill ' + mapStatusClass(new_status);
          }
        }
      }

      // 🔹 Visually mark as done (for grey styling)…
      cardEl.classList.add('dq-queue-card--done');

      // …then animate collapse, and only after that move it to the bottom
      animateCardDone(cardEl, () => {
        listEl.appendChild(cardEl);
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
      }

      // Grey it out + move to bottom
      cardEl.classList.add('dq-queue-card--done');
      listEl.appendChild(cardEl);

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
    if (!listEl) return [];
    return Array.from(listEl.querySelectorAll('.dq-queue-card'));
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
// Custom date dropdown behavior (Step 2)
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
    toggleLoading(true);
    try {
      const res = await fetch('/api/daily-queue/current', {
        method: 'GET',
      });

      if (res.status === 404) {
        // No active batch yet
        currentBatch = null;
        items = [];
        renderBatch();

        // If this page was opened with ?autostart=1, immediately generate a new batch
        if (autoStart) {
          await generateNewBatch();
        }
        return;
      }

      if (!res.ok) {
        console.error('Failed to load current batch', await res.text());
        alert('Unable to load current Daily Queue. Check console for details.');
        return;
      }

      const data = await res.json();
      currentBatch = data.batch || null;
      items = data.items || [];

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
      const res = await fetch('/api/daily-queue/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          batch_size: 20,
          industries: null,
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
      generateNewBatch();
    });
  }

  setTodayText();
  loadCurrentBatch();
});

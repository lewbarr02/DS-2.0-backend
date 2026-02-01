// Public/daily-execute.js
document.addEventListener('DOMContentLoaded', () => {
  const listEl = document.getElementById('dex_list');
  const todayEl = document.getElementById('dex_today');

  const btnLoad = document.getElementById('dex_load_sample');
  const btnDone = document.getElementById('dex_mark_done');
  const btnClear = document.getElementById('dex_clear');

  const actionEl = document.getElementById('dex_action');
  const outcomeEl = document.getElementById('dex_outcome');
  const planLineEl = document.getElementById('dex_plan_line');

  const activeLabelEl = document.getElementById('dex_active_label');
  const notesEl = document.getElementById('dex_notes');
  const doneCountEl = document.getElementById('dex_done_count');

  // Block controls
  const blockRoleEl = document.getElementById('dex_block_role');
  const btnStartBlock = document.getElementById('dex_start_block');
  const btnEndBlock = document.getElementById('dex_end_block');
  const blockLabelEl = document.getElementById('dex_block_label');
  const blockDotEl = document.getElementById('dex_block_dot');
  const kpiEligibleEl = document.getElementById('dex_kpi_eligible');
  const kpiRemainingEl = document.getElementById('dex_kpi_remaining');

  let items = [];              // all daily queue items from API
  let activeItemId = null;
  let doneCount = 0;

  // Block state
  let blockActive = false;
  let blockRole = 'any';
  let blockItemIds = [];       // ordered list of item_ids in the active block

  function mmdd(d) {
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${mm}/${dd}`;
  }

  function escapeHtml(s) {
    return String(s ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function normStatus(s) {
    const v = String(s || '').trim().toLowerCase();
    if (!v) return 'unspecified';
    if (v === 'followup') return 'follow-up';
    if (v === 'no fit') return 'no_fit';
    return v;
  }

  function normRole(s) {
    const v = String(s || '').trim();
    if (!v) return '';
    // Keep it simple: match your locked enum case
    // (CFO / Controller / Finance / Treasury)
    return v;
  }

  function getActiveItem() {
    return items.find(x => String(x.item_id) === String(activeItemId)) || null;
  }

  // ----------------------------
  // Outcome → Plan (status + next touch)
  // ----------------------------
  function computePlan(item, outcome) {
    const current = normStatus(item?.status);

    let new_status = current;
    let next_touch_choice = null;

    switch (String(outcome || '').toLowerCase()) {
      case 'meeting_set':
        new_status = 'hot';
        next_touch_choice = 'next_week';
        break;

      case 'converted':
        new_status = 'converted';
        next_touch_choice = null;
        break;

      case 'no_answer':
        new_status = 'follow-up';
        next_touch_choice = 'tomorrow';
        break;

      case 'not_interested':
        new_status = 'no_fit';
        next_touch_choice = null;
        break;

      case 'touched':
      default:
        if (['unspecified', 'cold', 'research'].includes(current)) {
          new_status = 'warm';
        } else {
          new_status = current;
        }
        next_touch_choice = '3_days';
        break;
    }

    return { new_status, next_touch_choice };
  }

  function formatPlanLine(plan) {
    const s = plan?.new_status ? String(plan.new_status) : '—';
    const t = plan?.next_touch_choice ? String(plan.next_touch_choice) : '—';
    return `Status → ${s} • Next touch → ${t}`;
  }

  function refreshPlanUI() {
    const item = getActiveItem();
    if (!item) {
      planLineEl.textContent = 'Select a lead to see the plan.';
      return;
    }
    const outcome = outcomeEl ? outcomeEl.value : 'touched';
    const plan = computePlan(item, outcome);
    planLineEl.textContent = formatPlanLine(plan);
  }

  // ----------------------------
  // Eligibility (role-based) + null-safe
  // ----------------------------
  function isEligibleForRole(item, roleValue) {
    const r = normRole(item?.role);

    // always exclude completed
    if (item?.is_completed) return false;

    if (roleValue === 'any') {
      return true; // includes unassigned
    }
    if (roleValue === 'unassigned') {
      return !r;
    }

    // IMPORTANT: null compensation
    // If the lead has no role yet, we still allow it into the block
    // because you’re filling roles over the next few days.
    if (!r) return true;

    return r === roleValue;
  }

  function getEligibleItems(roleValue) {
    return items.filter(it => isEligibleForRole(it, roleValue));
  }

  // ----------------------------
  // Active selection
  // ----------------------------
  function setActive(itemId) {
    activeItemId = itemId;

    const item = items.find(x => String(x.item_id) === String(itemId));
    activeLabelEl.textContent = item
      ? `${item.company || '—'} • ${item.name || '—'}`
      : 'None selected';

    btnDone.disabled = !item;
    btnClear.disabled = !item;

    // highlight active
    document.querySelectorAll('.dex-lead').forEach(el => {
      el.classList.toggle('is-active', el.dataset.itemId === String(itemId));
    });

    refreshPlanUI();
  }

  function clearActive() {
    activeItemId = null;
    notesEl.value = '';
    activeLabelEl.textContent = 'None selected';
    btnDone.disabled = true;
    btnClear.disabled = true;
    document.querySelectorAll('.dex-lead').forEach(el => el.classList.remove('is-active'));
    refreshPlanUI();
  }

  // ----------------------------
  // Rendering (worklist shows all loaded items, but block flow still works)
  // ----------------------------
  function render() {
    if (!items.length) {
      listEl.innerHTML = `<div class="muted">No items loaded yet.</div>`;
      kpiEligibleEl.textContent = '0';
      kpiRemainingEl.textContent = '0';
      return;
    }

    // KPIs
    const eligible = getEligibleItems(blockRole);
    kpiEligibleEl.textContent = String(eligible.length);

    if (blockActive) {
      const remaining = blockItemIds
        .map(id => items.find(x => String(x.item_id) === String(id)))
        .filter(Boolean)
        .filter(x => !x.is_completed);

      kpiRemainingEl.textContent = String(remaining.length);
    } else {
      kpiRemainingEl.textContent = '0';
    }

    listEl.innerHTML = items.map((x) => {
      const company = escapeHtml(x.company || '—');
      const name = escapeHtml(x.name || '—');
      const loc = escapeHtml([x.city, x.state].filter(Boolean).join(', ') || '—');
      const status = escapeHtml(x.status || 'Unspecified');
      const industry = escapeHtml(x.industry || '—');
      const role = escapeHtml(x.role || '—');

      const completed = !!x.is_completed;
      const opacity = completed ? '0.45' : '1';

      return `
        <div class="lead dex-lead ${String(x.item_id) === String(activeItemId) ? 'is-active' : ''}"
             data-item-id="${escapeHtml(x.item_id)}"
             style="cursor:pointer; opacity:${opacity};">
          <div class="l-main">
            <div class="company">${company}</div>
            <div class="meta">
              <span class="tag">${status}</span>
              <span class="tag">${industry}</span>
              <span class="tag">Role: ${role}</span>
              <span class="muted">${loc}</span>
              <span class="muted">${name}</span>
            </div>
          </div>
          <div class="actions">
            <button class="btn dex_select" data-item-id="${escapeHtml(x.item_id)}">Select</button>
          </div>
        </div>
      `;
    }).join('');

    // attach clicks
    listEl.querySelectorAll('.dex_select').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        setActive(btn.dataset.itemId);
      });
    });

    listEl.querySelectorAll('.dex-lead').forEach(card => {
      card.addEventListener('click', () => setActive(card.dataset.itemId));
    });

    // if we’re in a block and nothing is active, auto-pick the first remaining
    if (blockActive && !activeItemId) {
      const next = findNextBlockItemId();
      if (next) setActive(next);
    }
  }

  // ----------------------------
  // Block flow
  // ----------------------------
  function updateBlockUI() {
    if (blockActive) {
      blockDotEl.classList.add('on');
      blockLabelEl.textContent = `${blockRole === 'any' ? 'Any role' : (blockRole === 'unassigned' ? 'Unassigned only' : blockRole)} • Active`;
      blockRoleEl.disabled = true;
      btnStartBlock.disabled = true;
      btnEndBlock.disabled = false;
    } else {
      blockDotEl.classList.remove('on');
      blockLabelEl.textContent = `Not started`;
      blockRoleEl.disabled = false;
      btnStartBlock.disabled = false;
      btnEndBlock.disabled = true;
    }
  }

  function startBlock() {
    blockRole = blockRoleEl ? blockRoleEl.value : 'any';
    blockActive = true;

    // Build block list from eligible today (simple: keep natural API order)
    const eligible = getEligibleItems(blockRole);
    blockItemIds = eligible.map(x => x.item_id);

    clearActive();
    updateBlockUI();
    render();

    // auto-select first
    const next = findNextBlockItemId();
    if (next) setActive(next);
  }

  function endBlock() {
    blockActive = false;
    blockItemIds = [];
    blockRole = blockRoleEl ? blockRoleEl.value : 'any';
    clearActive();
    updateBlockUI();
    render();
  }

  function findNextBlockItemId() {
    if (!blockActive) return null;

    for (const id of blockItemIds) {
      const it = items.find(x => String(x.item_id) === String(id));
      if (it && !it.is_completed) return it.item_id;
    }
    return null;
  }

  // ----------------------------
  // API calls
  // ----------------------------
  async function loadTodaysQueue() {
    btnLoad.disabled = true;
    btnLoad.textContent = 'Loading…';

    try {
      const res = await fetch('/api/daily-queue/current', { method: 'GET' });
      if (!res.ok) {
        console.error('Failed to load /api/daily-queue/current', await res.text());
        alert('Could not load today’s queue. Check console.');
        return;
      }

      const data = await res.json();
      items = Array.isArray(data.items) ? data.items : [];

      // Ensure required shape (null-safe)
      items = items.map(x => ({
        ...x,
        item_id: x.item_id ?? x.id ?? '',
        company: x.company ?? '—',
        name: x.name ?? '—',
        role: x.role ?? '',     // may be blank
        status: x.status ?? 'Unspecified'
      }));

      clearActive();
      render();
      updateBlockUI();
      refreshPlanUI();
    } catch (err) {
      console.error('Error loading today’s queue', err);
      alert('Error reaching server while loading today’s queue.');
    } finally {
      btnLoad.disabled = false;
      btnLoad.textContent = 'Load Today’s Queue';
    }
  }

  async function markDone() {
    if (!activeItemId) return;

    const item = getActiveItem();
    if (!item) return;

    const actionType = actionEl ? actionEl.value : null;
    const outcome = outcomeEl ? outcomeEl.value : 'touched';
    const notes = notesEl ? notesEl.value : '';

    const plan = computePlan(item, outcome);
    btnDone.disabled = true;

    try {
      const res = await fetch(`/api/daily-queue/item/${encodeURIComponent(activeItemId)}/done`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          new_status: plan.new_status,
          next_touch_choice: plan.next_touch_choice,
          action_type: actionType || null,
          notes: notes || null,
        }),
      });

      if (!res.ok) {
        console.error('Failed mark done', await res.text());
        alert('Could not mark done. Check console.');
        btnDone.disabled = false;
        return;
      }

      // Update local state
      const idx = items.findIndex(x => String(x.item_id) === String(activeItemId));
      if (idx >= 0) {
        items[idx].is_completed = true;
        items[idx].status = plan.new_status;
      }

      doneCount += 1;
      doneCountEl.textContent = String(doneCount);

      // move to next in block if active
      clearActive();

      if (blockActive) {
        const next = findNextBlockItemId();
        render();
        if (next) setActive(next);
      } else {
        render();
      }

    } catch (err) {
      console.error('Error marking done', err);
      alert('Error reaching server while marking done.');
      btnDone.disabled = false;
    }
  }

  // ----------------------------
  // init
  // ----------------------------
  todayEl.textContent = mmdd(new Date());

  btnLoad.addEventListener('click', loadTodaysQueue);
  btnClear.addEventListener('click', clearActive);
  btnDone.addEventListener('click', markDone);

  if (outcomeEl) outcomeEl.addEventListener('change', refreshPlanUI);

  if (btnStartBlock) btnStartBlock.addEventListener('click', startBlock);
  if (btnEndBlock) btnEndBlock.addEventListener('click', endBlock);

  // initial state
  updateBlockUI();

  // Auto-load today’s queue
  loadTodaysQueue();
});

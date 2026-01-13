(function () {
  // Use same-origin backend for both local dev and Railway
  const API = '';

  // ----- Date helpers -----
  const pad = (n) => String(n).padStart(2, "0");
  const fmt = (d) =>
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  function thisWeekRange() {
    const now = new Date();
    const day = now.getDay(); // 0=Sun..6=Sat
    const diffToMon = day === 0 ? -6 : 1 - day;
    const monday = new Date(now);
    monday.setDate(now.getDate() + diffToMon);
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    return { from: fmt(monday), to: fmt(sunday) };
  }

  // ----- Preset ranges + URL sync -----
  const todayRange = () => {
    const d = new Date();
    const s = fmt(d);
    return { from: s, to: s };
  };

  const yesterdayRange = () => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    const s = fmt(d);
    return { from: s, to: s };
  };

  const lastNDays = (n) => {
    const to = new Date();
    const from = new Date();
    from.setDate(from.getDate() - (n - 1));
    return { from: fmt(from), to: fmt(to) };
  };

  const last7Range = () => lastNDays(7);
  const last30Range = () => lastNDays(30);

  function monthToDate() {
    const now = new Date();
    const from = new Date(now.getFullYear(), now.getMonth(), 1);
    return { from: fmt(from), to: fmt(now) };
  }

  function quarterToDate() {
    const now = new Date();
    const qStartMonth = [0, 3, 6, 9][Math.floor(now.getMonth() / 3)];
    const from = new Date(now.getFullYear(), qStartMonth, 1);
    return { from: fmt(from), to: fmt(now) };
  }
  
    function prevRangeFor(range) {
    const parse = (s) => {
      const [y, m, d] = s.split("-").map(Number);
      return new Date(y, m - 1, d);
    };
    const from = parse(range.from);
    const to = parse(range.to);
    const msDay = 24 * 3600 * 1000;
    const lenDays = Math.round((to - from) / msDay) + 1;
    const prevTo = new Date(from.getTime() - msDay);
    const prevFrom = new Date(prevTo.getTime() - (lenDays - 1) * msDay);
    return { from: fmt(prevFrom), to: fmt(prevTo) };
  }


  const PRESET_FNS = {
    today: todayRange,
    yesterday: yesterdayRange,
    this_week: thisWeekRange,
    last_7: last7Range,
    mtd: monthToDate,
    qtd: quarterToDate,
    last_30: last30Range,
    custom: null, // handled by manual date fields
  };

  function parseUrlRange() {
    const u = new URL(location.href);
    const qp = u.searchParams;
    const rangeKey = qp.get("range");
    const from = qp.get("from");
    const to = qp.get("to");

    if (rangeKey && PRESET_FNS[rangeKey]) {
      return { preset: rangeKey, range: PRESET_FNS[rangeKey]() };
    }
    if (from && to) {
      return { preset: "custom", range: { from, to } };
    }
    // default
    return { preset: "this_week", range: thisWeekRange() };
  }

  function pushUrl(range, preset) {
    const u = new URL(location.href);
    if (preset && preset !== "custom") {
      u.searchParams.set("range", preset);
      u.searchParams.delete("from");
      u.searchParams.delete("to");
    } else {
      u.searchParams.delete("range");
      u.searchParams.set("from", range.from);
      u.searchParams.set("to", range.to);
    }
    history.replaceState({}, "", u.toString());
  }

  // ----- Count mode (leads | accounts) -----
  function getCountModeFromUrl() {
    const u = new URL(location.href);
    const c = u.searchParams.get("count");
    if (c === "accounts") return "accounts";
    if (c === "leads") return "leads";
    // fallback to stored preference or default
    return localStorage.getItem("ds.count_mode") || "leads";
  }

  function setCountModeInUrl(mode) {
    const u = new URL(location.href);
    u.searchParams.set("count", mode);
    history.replaceState({}, "", u.toString());
    localStorage.setItem("ds.count_mode", mode);
  }

  function markActiveCount(mode) {
    document
      .getElementById("modeLeads")
      ?.classList.toggle("active", mode === "leads");
    document
      .getElementById("modeAccounts")
      ?.classList.toggle("active", mode === "accounts");
  }

  function setCountLabels(mode) {
    const lbl = document.getElementById("kpi_contacted_lbl");
    if (lbl) {
      lbl.textContent =
        mode === "accounts" ? "Accounts contacted" : "Leads contacted";
    }
  }

  function markActivePreset(key) {
    document.querySelectorAll(".preset[data-range]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.range === key);
    });
  }

  // ----- DOM -----
  const el = (id) => document.getElementById(id);

  function money(v) {
    if (v == null || isNaN(v)) return "$0";
    return "$" + Number(v).toLocaleString();
  }
  
  function setTrendIcon(id, current, previous) {
    const node = el(id);
    if (!node) return;

    const curr = Number(current || 0);

    // --- Fallback Case 1: NO previous data at all ---
    // If prev undefined/null/empty → show simple fallback trend
    if (previous == null || previous === '' || isNaN(Number(previous))) {
      if (curr > 0) {
        node.textContent = "📈";      // activity > 0 with no baseline → trending up
        node.className = "trend trend-up";
      } else {
        node.textContent = "—";       // nothing happened & no baseline → blank
        node.className = "trend trend-flat";
      }
      return;
    }

    // --- Normal Comparison Case ---
    const prev = Number(previous || 0);
    node.classList.remove("trend-up", "trend-down", "trend-flat");

    if (curr > prev) {
      node.textContent = "📈";
      node.classList.add("trend-up");
    } else if (curr < prev) {
      node.textContent = "📉";
      node.classList.add("trend-down");
    } else {
      node.textContent = "⏺";
      node.classList.add("trend-flat");
    }
  }




  // --- 1-on-1 helpers ---
  function compactMoney(v) {
    const n = Number(v || 0);
    const abs = Math.abs(n);
    if (abs >= 1_000_000_000) return "$" + (n / 1_000_000_000).toFixed(1) + "B";
    if (abs >= 1_000_000) return "$" + (n / 1_000_000).toFixed(1) + "M";
    if (abs >= 1_000) return "$" + (n / 1_000).toFixed(1) + "K";
    return "$" + n.toLocaleString();
  }

  function chip(text) {
    return `<span class="pill">${text}</span>`;
  }

  // --- Horizontal bar renderer for 1-on-1 Summary ---
  function renderBars(containerId, entries) {
    const el = document.getElementById(containerId);
    if (!el) return;

    // Map status → bar color
    const getColor = (label) => {
      const s = label.toLowerCase();

      if (s.includes("convert")) return "#1db954"; // green
      if (s.includes("hot")) return "#ff4d4d"; // red
      if (s.includes("warm")) return "#ffa500"; // orange
      if (s.includes("follow")) return "#ffd700"; // yellow
      if (s.includes("cold")) return "#59a5ff"; // blue
      if (s.includes("research")) return "#9b59b6"; // purple
      return "#808080"; // grey for Unspecified
    };

    el.innerHTML = entries
      .map((e) => {
        const color = getColor(e.label);
        return `
        <div class="barrow">
          <div class="barlabel">${e.label}</div>
          <div class="bartrack">
            <div class="barfill" style="
              width:${Math.max(0, Math.min(100, e.pct))}% ;
              background:${color};
              box-shadow:0 0 6px ${color} inset;
            "></div>
          </div>
          <div class="barvalue">${e.value}</div>
        </div>
      `;
      })
      .join("");
  }
  
  // ===== Next Touch Panel =====
function computeNextTouch(leads) {
  const today = new Date();
  today.setHours(0,0,0,0);

  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);

  let dueToday = 0;
  let dueTomorrow = 0;
  let overdue = 0;
  let noAction = 0;

  for (const l of leads || []) {
    const na = l.next_action_at ? new Date(l.next_action_at) : null;

    if (!na) {
      noAction++;
      continue;
    }

    const d = new Date(na);
    d.setHours(0,0,0,0);

    if (d.getTime() === today.getTime()) {
      dueToday++;
    } 
    else if (d.getTime() === tomorrow.getTime()) {
      dueTomorrow++;
    }
    else if (d.getTime() < today.getTime()) {
      overdue++;
    }
  }

  return { dueToday, dueTomorrow, overdue, noAction };
}

function renderNextTouchPanel(stats) {
  document.getElementById("nt_due_today").textContent     = stats.dueToday;
  document.getElementById("nt_due_tomorrow").textContent  = stats.dueTomorrow;
  document.getElementById("nt_overdue").textContent       = stats.overdue;
  document.getElementById("nt_no_action").textContent     = stats.noAction;
}


  // ----- Computations we derive on the client from leads[] -----
  function topChannelsByConversion(leads, topN = 3) {
    const by = {};
    for (const l of leads) {
      const ch = (l.source_channel || l.channel || l.source || "—").toString();
      const key = ch === "null" ? "—" : ch;
      by[key] = by[key] || { total: 0, conv: 0 };
      by[key].total++;
      const s = (l.status || "").toString().toLowerCase();
      if (s.includes("convert")) by[key].conv++;
    }
    return Object.entries(by)
      .map(([k, v]) => ({
        channel: k,
        total: v.total,
        conv: v.conv,
        rate: v.total ? (100 * v.conv) / v.total : 0,
      }))
      .sort((a, b) => b.rate - a.rate || b.conv - a.conv)
      .slice(0, topN);
  }

  function percentFollowupsOnTime(leads, range) {
    // "On time" = had a next_action_at within window and last_contacted_at >= next_action_at - 24h
    const from = new Date(range.from + "T00:00:00");
    const to = new Date(range.to + "T23:59:59");
    let due = 0;
    let ontime = 0;
    let overdue = 0;

    for (const l of leads) {
      const na = l.next_action_at ? new Date(l.next_action_at) : null;
      if (!na || na < from || na > to) continue;
      due++;
      const lc = l.last_contacted_at ? new Date(l.last_contacted_at) : null;
      if (lc && lc >= new Date(na.getTime() - 24 * 3600 * 1000)) ontime++;
      else overdue++;
    }

    return { percent: due ? Math.round((100 * ontime) / due) : 0, overdue };
  }

  function hotUntouched(leads, days = 7) {
    const cutoff = Date.now() - days * 24 * 3600 * 1000;
    return leads.filter((l) => {
      const s = (l.status || "").toString().toLowerCase();
      if (!s.includes("hot")) return false;
      const lc = l.last_contacted_at
        ? new Date(l.last_contacted_at).getTime()
        : 0;
      return lc < cutoff;
    }).length;
  }

  function approxUpDown(leads, range) {
    const from = new Date(range.from + "T00:00:00");
    const to = new Date(range.to + "T23:59:59");
    let up = 0;
    let down = 0;

    for (const l of leads) {
      const chg = l.last_status_change ? new Date(l.last_status_change) : null;
      if (!chg || chg < from || chg > to) continue;
      const s = (l.status || "").toString().toLowerCase();
      if (s.includes("hot") || s.includes("warm") || s.includes("convert")) {
        up++;
      } else if (s.includes("cold") || s.includes("research")) {
        down++;
      }
    }

    return { up, down };
  }

  function arrAddedThisWindow(leads, range) {
    const from = new Date(range.from + "T00:00:00");
    const to = new Date(range.to + "T23:59:59");
    let sum = 0;

    for (const l of leads) {
      const chg = l.last_status_change ? new Date(l.last_status_change) : null;
      const isNet = l.net_new === true || l.net_new === "true";
      if (isNet && chg && chg >= from && chg <= to) {
        sum += Number(l.arr || 0);
      }
    }

    return sum;
  }

  function percentSelfSourced(leads) {
    const hwc = leads.filter((l) => {
      const s = (l.status || "").toString().toLowerCase();
      return (
        s.includes("hot") || s.includes("warm") || s.includes("convert")
      );
    });
    if (!hwc.length) return 0;
    const ss = hwc.filter(
      (l) => !!l.self_sourced || String(l.self_sourced).toLowerCase() === "true"
    );
    return Math.round((100 * ss.length) / hwc.length);
  }

  // ----- Renderers -----
  function fillTable(tbody, rows, cols) {
    tbody.innerHTML = rows
      .map(
        (r) =>
          `<tr>${cols
            .map((c) => `<td>${c(r)}</td>`)
            .join("")}</tr>`
      )
      .join("");
  }
  
    // ----- ICP Industry Breakdown Panel -----
  function renderIndustryPanel(byInd) {
const buckets = {
  Education:      { leads: 0, convLeads: 0 },
  Healthcare:     { leads: 0, convLeads: 0 },
  Government:     { leads: 0, convLeads: 0 },
  Hospitality:    { leads: 0, convLeads: 0 },
  Construction:   { leads: 0, convLeads: 0 },
  Manufacturing:  { leads: 0, convLeads: 0 },
  Other:          { leads: 0, convLeads: 0 },
};


    for (const r of byInd || []) {
      const name  = String(r.key || "");
      const leads = Number(r.leads || 0);
      const convPct = Number(r.conv_pct || 0); // 0–100 from backend

      if (!leads) continue;

      const s = name.toLowerCase();
      let bucket = "Other";

      if (s.includes("educ")) {
        bucket = "Education";
      } else if (s.includes("health")) {
        bucket = "Healthcare";
      } else if (s.includes("gov")) {
        bucket = "Government";
      } else if (s.includes("hospitality") || s.includes("hotel") || s.includes("lodging")) {
        bucket = "Hospitality";
      } else if (s.includes("construct") || s.includes("contractor") || s.includes("builder")) {
        bucket = "Construction";
      } else if (s.includes("manufact") || s.includes("factory") || s.includes("industrial")) {
        bucket = "Manufacturing";
      }


      const b = buckets[bucket];
      b.leads += leads;
      b.convLeads += (convPct / 100) * leads; // approximate # converted
    }
	
	const totalPipelineLeads = Object.values(buckets).reduce(
  (sum, b) => sum + Number(b.leads || 0),
  0
);


const setTile = (prefix, data) => {
  const leads = data.leads || 0;
  const convPct = leads ? Math.round((100 * data.convLeads) / leads) : 0;

  const sharePct = totalPipelineLeads
    ? Math.round((100 * leads) / totalPipelineLeads)
    : 0;

  const convEl  = el(`ind_${prefix}_conv`);
  const leadsEl = el(`ind_${prefix}_leads`);
  const shareEl = el(`ind_${prefix}_share`);

  if (convEl) {
    convEl.textContent = leads ? `${convPct}%` : "—";
  }
  if (leadsEl) {
    leadsEl.textContent = leads ? `${leads} leads` : "No data";
  }
  if (shareEl) {
    shareEl.textContent = leads ? `${sharePct}% of pipeline` : "—";
  }
};

	
	

setTile("education",      buckets.Education);
setTile("healthcare",     buckets.Healthcare);
setTile("government",     buckets.Government);
setTile("hospitality",    buckets.Hospitality);
setTile("construction",   buckets.Construction);
setTile("manufacturing",  buckets.Manufacturing);
setTile("other",          buckets.Other);
  }


  function setDatePickers(range, activePreset = null) {
    el("from").value = range.from;
    el("to").value = range.to;
    el("dateRangeText").textContent = `${range.from} → ${range.to}`;
    if (activePreset) {
      markActivePreset(activePreset);
    }
  }

  function renderReconcile(summaryJson) {
    // total considered = what your /summary endpoint reports for the window
    const total = Number(
      summaryJson?.metrics?.activity?.total_leads_considered || 0
    );
    // pinned = how many rows we actually render in the page dataset (scoped list)
    const pinned = Array.isArray(summaryJson?.leads)
      ? summaryJson.leads.length
      : 0;
    // unplaced = new field from backend
    const unplaced = Number(summaryJson?.unplaced_count || 0);

    const $ = (id) => document.getElementById(id);
    if ($("rec_total")) $("rec_total").textContent = total.toLocaleString();
    if ($("rec_pinned")) $("rec_pinned").textContent = pinned.toLocaleString();
    if ($("rec_missing"))
      $("rec_missing").textContent = unplaced.toLocaleString();

    const link = document.getElementById("rec_unplaced");
    if (link) {
      link.onclick = (e) => {
        e.preventDefault();
        alert(
          `Unplaced leads: ${unplaced}\n\nNext step: we’ll add a quick table to fix City/State and auto-geocode.`
        );
      };
    }
  }
  
    // ----- Regional Traction Breakdown Panel -----
  function renderRegionalTraction(byState) {
    const tbody = document.querySelector("#tbl_region_traction tbody");
    if (!tbody) return;

    const rows = (byState || [])
      .slice()
      .sort((a, b) => (b.traction_score || 0) - (a.traction_score || 0))
      .slice(0, 20); // top 20 regions

    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="5">No regional traction data yet.</td></tr>`;
      return;
    }

    const tierFor = (score) => {
      const s = Number(score || 0);
      if (s >= 80) return "🏆 A+ Focus";
      if (s >= 60) return "💪 A Strong";
      if (s >= 40) return "📈 B Emerging";
      if (s > 0)   return "🌱 C Nurture";
      return "—";
    };

    tbody.innerHTML = rows
      .map((r) => {
        const name = r.key || "—";
        const ap = r.ap_spend_touched ?? r.ap_spend ?? 0;
        const arr = r.hw_arr ?? 0;
        const score = Number(r.traction_score || 0);
        const tier = tierFor(score);

        return `
          <tr>
            <td>${name}</td>
            <td>${money(ap)}</td>
            <td>${money(arr)}</td>
            <td>${score.toFixed(0)}</td>
            <td>${tier}</td>
          </tr>
        `;
      })
      .join("");
  }


// ===== High-Value Prospects Panel =====
function renderHighValue(leads) {
  const tbody = document.querySelector("#tbl_highvalue tbody");
  if (!tbody) return;

  const cleanDate = (d) => {
    if (!d) return "—";
    const dt = new Date(d);
    if (isNaN(dt)) return "—";
    return dt.toLocaleDateString();
  };

  const hv = leads
    .filter(l => Number(l.ap_spend) > 0)
    .sort((a, b) => Number(b.ap_spend) - Number(a.ap_spend))
    .slice(0, 10);

  tbody.innerHTML = hv.map(l => `
    <tr>
      <td>${l.company || "—"}</td>
      <td>$${Number(l.ap_spend).toLocaleString()}</td>
      <td>${l.status || "—"}</td>
      <td>${cleanDate(l.last_contacted_at || l.last_touch_at)}</td>
    </tr>
  `).join("");
}

// ===== AI Notes by Status Band =====
function renderAiBandNotes(notes) {
  const safe = (v) => {
    if (!v) return "No AI notes for this band yet.";
    const s = String(v).trim();
    return s || "No AI notes for this band yet.";
  };

  const mapping = [
    { id: "ai_note_hot",       key: "hot" },
    { id: "ai_note_warm",      key: "warm" },
    { id: "ai_note_followup",  key: "followup" },
    { id: "ai_note_cold",      key: "cold" },
    { id: "ai_note_research",  key: "research" },
    { id: "ai_note_converted", key: "converted" },
  ];

  mapping.forEach(({ id, key }) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = safe(notes && notes[key]);
  });
}

// ===== Upgrade / Downgrade Detail List =====
function renderStatusChanges(changes) {
  const tbody = document.querySelector("#tbl_status_changes tbody");
  if (!tbody) return;

  const cleanDate = (d) => {
    if (!d) return "—";
    const dt = new Date(d);
    if (isNaN(dt)) return "—";
    return dt.toLocaleDateString();
  };

  // Simple status ranking so we can detect up vs down
  const statusRank = (s) => {
    const v = (s || "").toString().toLowerCase();
    if (v.includes("convert")) return 6;
    if (v.includes("hot")) return 5;
    if (v.includes("warm")) return 4;
    if (v.includes("follow")) return 3;    // follow-up
    if (v.includes("cold")) return 2;
    if (v.includes("research")) return 1;
    if (v.includes("unspecified")) return 0;
    return 0; // unknown / neutral
  };

  const rows = (changes || []).slice(0, 50);

  tbody.innerHTML = rows
    .map((h) => {
      const oldR = statusRank(h.old_status);
      const newR = statusRank(h.new_status);
      let trend = "—";
      if (newR > oldR) trend = "📈";      // upgrade
      else if (newR < oldR) trend = "📉"; // downgrade

      return `
          <tr>
            <td>${cleanDate(h.changed_at)}</td>
            <td>${h.company || "—"}</td>
            <td>${h.old_status || "—"}</td>
            <td>${h.new_status || "—"}</td>
            <td>${trend}</td>
            <td>${h.state || "—"}</td>
            <td>${
              h.ap_spend != null
                ? "$" + Number(h.ap_spend).toLocaleString()
                : "—"
            }</td>
          </tr>
        `;
    })
    .join("");
}

  
    // ===== At-Risk / Dormant Leads =====
  function buildAtRisk(leads) {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const nowMs = Date.now();

    return (leads || [])
      .filter((l) => l.last_contacted_at) // must have at least one touch
      .map((l) => {
        const dt = new Date(l.last_contacted_at);
        if (isNaN(dt)) return null;

        const days = Math.floor((nowMs - dt.getTime()) / DAY_MS);

        let risk = "healthy";
        if (days >= 30) risk = "dormant";   // 🔴 30+ days
        else if (days >= 14) risk = "at-risk"; // 🟠 14–29 days

        return {
          company: l.company || "—",
          ap_spend: Number(l.ap_spend || 0),
          status: l.status || "—",
          state: l.state || l.st || "—",
          days_since: days,
          risk,
        };
      })
      .filter(Boolean)
      .filter((r) => r.risk !== "healthy") // we only care about real risk
      .sort((a, b) => b.ap_spend - a.ap_spend) // highest AP first
      .slice(0, 25); // cap the table
  }

  function renderAtRisk(rows) {
    const body = document.getElementById("at_risk_body");
    if (!body) return;

    if (!rows || rows.length === 0) {
      body.innerHTML = `<tr><td colspan="6">No at-risk leads 🎉</td></tr>`;
      return;
    }

    body.innerHTML = rows
      .map((r) => {
        const riskIcon =
          r.risk === "dormant" ? "🔴" :
          r.risk === "at-risk" ? "🟠" :
          "🟢";

        return `
          <tr>
            <td>${r.company}</td>
            <td>$${Number(r.ap_spend || 0).toLocaleString()}</td>
            <td>${r.days_since} days</td>
            <td>${r.status}</td>
            <td>${r.state}</td>
            <td>${riskIcon} ${r.risk}</td>
          </tr>
        `;
      })
      .join("");
  }





  // ===== 1-on-1 Summary client =====
  function renderOneOnOne(data) {
    const $ = (id) => document.getElementById(id);

    if (!data) {
      if ($("o11_accounts")) $("o11_accounts").textContent = "—";
      if ($("o11_apspend")) $("o11_apspend").textContent = "—";
      if ($("o11_type_mix")) $("o11_type_mix").textContent = "—";
      if ($("o11_status_list")) $("o11_status_list").innerHTML = "";
      if ($("o11_industry_list")) $("o11_industry_list").innerHTML = "";
      return;
    }

    // Big numbers
    if ($("o11_accounts")) {
      $("o11_accounts").textContent = (data.accounts_added || 0).toLocaleString();
    }
    if ($("o11_apspend")) {
      $("o11_apspend").textContent = compactMoney(data.ap_spend_total || 0);
    }

    // Type mix chips (Customers / Partners / Other)
    const c = data.type_mix?.pct?.customers ?? 0;
    const p = data.type_mix?.pct?.partners ?? 0;
    const o = data.type_mix?.pct?.other ?? 0;

    if ($("o11_type_mix")) {
      $("o11_type_mix").innerHTML =
        `<span class="pill" style="border-color:#4a90e2;color:#bcd9ff;">🧱 Customers ${c}%</span>
         <span class="pill" style="border-color:#ffd166;color:#fff0b3;">🤝 Partners ${p}%</span>
         <span class="pill" style="border-color:#4a4a4a;color:#ccc;">🌐 Other ${o}%</span>`;
    }

    // Stage Breakdown -> horizontal bars
    {
      const statuses = (data.status_breakdown || [])
        .sort((a, b) => b.count - a.count)
        .map((s) => ({
          label: String(s.status || "—"),
          pct: Number(s.pct || 0),
          value: `${Number(s.pct || 0)}% (${s.count || 0})`,
        }));
      renderBars("o11_status_list", statuses);
    }

    // Industry Mix (Top 5) -> horizontal bars
    {
      const inds = (data.industries || []).slice(0, 5);
      const maxCnt = Math.max(1, ...inds.map((i) => i.count || 0));
      const rows = inds.map((i) => ({
        label: String(i.industry || "—"),
        pct: Math.round((100 * (i.count || 0)) / maxCnt),
        value: `(${i.count || 0})`,
      }));
      renderBars("o11_industry_list", rows);
    }
  }

  async function loadOneOnOne(range) {
    try {
      const mode = getCountModeFromUrl();
      const url = `${API}/api/oneonone?from=${range.from}&to=${range.to}&pinned_only=1&count_mode=${mode}`;
      const res = await fetch(url, { cache: "no-store" });
      const json = await res.json();
      if (!json.ok) throw new Error("1-on-1 API failed");
      renderOneOnOne(json.data);
    } catch (e) {
      console.warn("loadOneOnOne error", e);
      renderOneOnOne(null);
    }
  }

  // ===== Forecasting Panel client (temporarily disabled) =====
  async function loadForecast(range) {
    // Forecast temporarily disabled while we rebuild the Finexio traction model.
    return;
  }

  // ----- Load + Render -----
  async function loadAndRender(range, presetKey = null) {
    const activePreset =
      presetKey ||
      document.querySelector(".preset.active")?.dataset.range ||
      null;

    setDatePickers(range, activePreset);
    pushUrl(range, activePreset);

    const mode = getCountModeFromUrl();

    const urlCurrent = `${API}/summary?from=${range.from}&to=${range.to}&pinned_only=1&count_mode=${mode}`;
    const prevRange = prevRangeFor(range);
    const urlPrev = `${API}/summary?from=${prevRange.from}&to=${prevRange.to}&pinned_only=1&count_mode=${mode}`;

    let data;
    let prev = null;

    try {
      const [resCurr, resPrev] = await Promise.all([
        fetch(urlCurrent, { cache: "no-store" }),
        fetch(urlPrev, { cache: "no-store" }),
      ]);
      data = await resCurr.json();
      prev = await resPrev.json();
    } catch (err) {
      console.warn("Summary fetch error", err);
      const res = await fetch(urlCurrent, { cache: "no-store" });
      data = await res.json();
    }

    // KPIs from backend (Finexio traction version)
    const act = data.metrics?.activity || {};
    const arr = data.metrics?.arr || {};
    const spend = data.metrics?.ap_spend || {};
    const prevAct = prev?.metrics?.activity || {};
    const prevPip = prev?.metrics?.pipeline || {};
	
	// NEW: Leads added to pipeline (date-gated)
const leadsAdded =
  act.leads_added_window ??
  act.leads_added ??
  0;



    el("kpi_contacted").textContent = act.leads_contacted_window ?? 0;
	    setTrendIcon(
      "kpi_contacted_trend",
      act.leads_contacted_window ?? 0,
      prevAct.leads_contacted_window ?? 0
    );
	
	const addedEl = el("kpi_added");
if (addedEl) {
  addedEl.textContent = leadsAdded;
}



    const touches = act.total_touches ?? 0;
    const touchesEl = el("kpi_touches");
    if (touchesEl) {
      touchesEl.textContent = `Total touches: ${touches}`;
    }
	
	    // Touch breakdown (calls / emails / social)
    const callsEl = el("kpi_calls");
    const emailsEl = el("kpi_emails");
    const socialEl = el("kpi_social");

    if (callsEl) callsEl.textContent = act.calls ?? 0;
    if (emailsEl) emailsEl.textContent = act.emails ?? 0;
    if (socialEl) socialEl.textContent = act.social ?? 0;
	    setTrendIcon("kpi_calls_trend", act.calls ?? 0, prevAct.calls ?? 0);
    setTrendIcon("kpi_emails_trend", act.emails ?? 0, prevAct.emails ?? 0);
    setTrendIcon("kpi_social_trend", act.social ?? 0, prevAct.social ?? 0);






    const leads = Array.isArray(data.leads) ? data.leads : [];
    // Next Touch Panel
    const nt = computeNextTouch(leads);
    renderNextTouchPanel(nt);

    renderHighValue(leads);
    renderStatusChanges(data.status_changes || []);

    // NEW: AI notes by status band
    renderAiBandNotes(data.ai_band_notes || {});

    const atRisk = buildAtRisk(leads);
    renderAtRisk(atRisk);



    // Client-side derivations
    const chTop = topChannelsByConversion(leads, 3);
    fillTable(el("tbl_channels").querySelector("tbody"), chTop, [
      (r) => r.channel,
      (r) => r.conv,
      (r) => r.total,
      (r) => r.rate.toFixed(1) + "%",
    ]);

    const fu = percentFollowupsOnTime(leads, range);
    el("kpi_followup").textContent = `${fu.percent}%`;
    el("kpi_overdue").textContent = `${fu.overdue} overdue`;

    const hu = hotUntouched(leads, 7);
    el("kpi_hot_untouched").textContent = hu;

    const pip = data.metrics?.pipeline || {};
    const ud = approxUpDown(leads, range);

    const upgrades = pip.upgrades != null ? pip.upgrades : ud.up;
    const downgrades = pip.downgrades != null ? pip.downgrades : ud.down;

    el("kpi_up").textContent = upgrades;
    el("kpi_down").textContent = downgrades;
	
	    const prevUpgrades =
      prevPip.upgrades != null ? prevPip.upgrades : null;
    const prevDowngrades =
      prevPip.downgrades != null ? prevPip.downgrades : null;

    setTrendIcon("kpi_up_trend", upgrades, prevUpgrades);
    setTrendIcon("kpi_down_trend", downgrades, prevDowngrades);


    // Tables from backend aggregates
    const byInd = data.metrics?.perf_by_industry || [];
    fillTable(el("tbl_industry").querySelector("tbody"), byInd, [
      (r) => r.key || "—",
      (r) => (r.conv_pct ?? 0) + "%",
      (r) => r.leads ?? "—",
    ]);
    // New: drive ICP Vertical Breakdown KPI tiles
    renderIndustryPanel(byInd);

    const byState = data.metrics?.perf_by_state || [];

    fillTable(el("tbl_state").querySelector("tbody"), byState, [
      (r) => r.key || "—",
      (r) => money(r.ap_spend_touched || r.hw_arr || 0),
    ]);
	
	  // NEW: Regional Traction panel
    renderRegionalTraction(byState);

    const byTag = data.metrics?.perf_by_tag || [];
    fillTable(el("tbl_tag").querySelector("tbody"), byTag, [
      (r) => r.key || "—",
      (r) => r.cnt ?? 0,
    ]);

    // Strongest / weakest regions
    const bestState = [...byState].sort(
      (a, b) => (b.traction_score || 0) - (a.traction_score || 0)
    )[0];

    const weakestState =
      [...byState]
        .filter((r) => (r.traction_score || 0) > 0)
        .sort((a, b) => (a.traction_score || 0) - (b.traction_score || 0))[0] ||
      null;

    const strongEl = el("o11_region_strong");
    const weakEl = el("o11_region_weak");

    if (strongEl) {
      strongEl.textContent = bestState
        ? `${bestState.key} (${money(
            bestState.ap_spend_touched || bestState.hw_arr || 0
          )})`
        : "—";
    }

    if (weakEl) {
      weakEl.textContent = weakestState
        ? `${weakestState.key} (${money(
            weakestState.ap_spend_touched || weakestState.hw_arr || 0
          )})`
        : "—";
    }
	
	
	    // ----- Top Finexio KPI bar (Avg ARR / AP Spend / Regions) -----
    const avgArrVal = arr.avg_arr || arr.avg_deal || 0;
    const avgApVal = spend.avg_ap_spend || 0;

    const avgArrEl = el("kpi_avg_arr");
    if (avgArrEl) {
      avgArrEl.textContent = money(avgArrVal);
    }

    const avgApEl = el("kpi_avg_ap");
    if (avgApEl) {
      avgApEl.textContent = money(avgApVal);
    }

    const strongKpiEl = el("kpi_strong_region");
    if (strongKpiEl) {
      strongKpiEl.textContent = bestState
        ? `${bestState.key} · ${money(
            bestState.ap_spend_touched || bestState.hw_arr || 0
          )}`
        : "—";
    }

    const weakKpiEl = el("kpi_weak_region");
    if (weakKpiEl) {
      weakKpiEl.textContent = weakestState
        ? `${weakestState.key} · ${money(
            weakestState.ap_spend_touched || weakestState.hw_arr || 0
          )}`
        : "—";
    }

	
// ---- REAL AI SUMMARY (from backend) ----
const aiEl = el("aiText");
if (aiEl) {
  const txt = data.ai_summary || "No AI summary available.";
  aiEl.textContent = txt;
}


    // Reconcile panel
    renderReconcile(data);

    // Forecast panel – no-op (does nothing, but also doesn’t hit the API)
    await loadForecast(range);
  }

  // ----- Init -----
  document.addEventListener("DOMContentLoaded", () => {
    const boot = parseUrlRange();
    const mode = getCountModeFromUrl();
    markActiveCount(mode);
    setCountLabels(mode);
    setDatePickers(boot.range, boot.preset);

    loadAndRender(boot.range, boot.preset).catch(console.error);

    // Count toggle buttons
    document.getElementById("modeLeads")?.addEventListener("click", () => {
      setCountModeInUrl("leads");
      markActiveCount("leads");
      setCountLabels("leads");
      const r = parseUrlRange();
      loadAndRender(r.range, r.preset).catch(console.error);
    });

    document.getElementById("modeAccounts")?.addEventListener("click", () => {
      setCountModeInUrl("accounts");
      markActiveCount("accounts");
      setCountLabels("accounts");
      const r = parseUrlRange();
      loadAndRender(r.range, r.preset).catch(console.error);
    });

    // Apply button
    el("applyRange")?.addEventListener("click", () => {
      const from = el("from").value || boot.range.from;
      const to = el("to").value || boot.range.to;
      markActivePreset("custom");
      loadAndRender({ from, to }, "custom").catch(console.error);
    });

    // Preset buttons
    document.querySelectorAll(".preset[data-range]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const key = btn.dataset.range;
        markActivePreset(key);

        if (key === "custom") {
          el("from")?.focus();
          return;
        }

        const r = PRESET_FNS[key]();
        loadAndRender(r, key).catch(console.error);
      });
    });
  });
})();   // <-- THIS IS THE ONLY CLOSING LINE

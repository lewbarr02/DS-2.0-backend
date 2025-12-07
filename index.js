// index.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });  // 👈 NEW
const { parse } = require('csv-parse');
const path = require('path');
const app = express();

// ---- OPENAI SDK ----
const OpenAI = require("openai");
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});


app.use(cors());
app.use(express.json());
app.set('json spaces', 2);

// ---- Static frontend serving ----
// All your HTML/JS/images live in ./Public now
const FRONT_DIR = path.join(__dirname, 'Public');

// Serve everything in /Public (index.html, summary.html, JS, icons, images, etc.)
app.use(express.static(FRONT_DIR));

// Root -> index page
app.get('/', (_req, res) => {
  res.sendFile(path.join(FRONT_DIR, 'index.html'));
});


// Pretty routes that load the same HTML files
app.get('/launch-summary', (_req, res) => {
  res.sendFile(path.join(FRONT_DIR, 'summary.html'));
});

app.get('/daily-queue', (_req, res) => {
  res.sendFile(path.join(FRONT_DIR, 'daily-queue.html'));
});


// === GEO-CODER HELPERS (AUTO LAT/LONG FILLER) ===
const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org/search';
const CONTACT_EMAIL =
  process.env.NOMINATIM_EMAIL || 'lewis.barr@finexio.com';
const USER_AGENT =
  process.env.NOMINATIM_USER_AGENT ||
  `DeliSandwich/1.0 (${CONTACT_EMAIL})`;

/**
 * Make sure our geocode HTTP calls never hang forever.
 * If Nominatim is slow or unreachable, this will abort after `timeoutMs`.
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

// === SINGLE ADDRESS GEOCODER ===
// Calls OpenStreetMap Nominatim and returns { lat, lon } or null
async function geocodeOne({ company, city, state }) {
  // Normalize inputs
  const norm = (v) => {
    if (!v) return null;
    const s = String(v).trim();
    return s === '' ? null : s;
  };

  company = norm(company);
  city = norm(city);
  state = norm(state);

  // If we truly have *no* location info, bail early
  if (!company && !city && !state) {
    console.warn('geocodeOne: no location data at all for lead');
    return null;
  }

  // Try several query shapes from most-specific to least-specific
  const attempts = [];

  // 1) Company + City + State
  if (company || city || state) {
    attempts.push([company, city, state]);
  }
  // 2) City + State
  if (city || state) {
    attempts.push([null, city, state]);
  }
  // 3) City only
  if (city) {
    attempts.push([null, city, null]);
  }
  // 4) State only
  if (state) {
    attempts.push([null, null, state]);
  }

  for (const [cCo, cCi, cSt] of attempts) {
    const parts = [cCo, cCi, cSt].filter(Boolean);
    if (!parts.length) continue;

    const queryStr = parts.join(', ');
    const url = `${NOMINATIM_BASE}?format=json&q=${encodeURIComponent(
      queryStr
    )}&limit=1&addressdetails=0&email=${encodeURIComponent(CONTACT_EMAIL)}`;

    try {
      // ⏱ IMPORTANT: this prevents long hangs → avoids 502s
      const response = await fetchWithTimeout(
        url,
        {
          headers: { 'User-Agent': USER_AGENT }
        },
        8000 // 8s per attempt; 4 attempts max
      );

      if (!response.ok) {
        console.warn(
          'geocodeOne HTTP failure',
          response.status,
          'for query:',
          queryStr
        );
        continue;
      }

      const results = await response.json();
      if (!Array.isArray(results) || results.length === 0) {
        console.log('geocodeOne: no results for query:', queryStr);
        continue;
      }

      const { lat, lon } = results[0] || {};
      if (!lat || !lon) {
        console.log('geocodeOne: missing lat/lon for query:', queryStr);
        continue;
      }

      return { lat: parseFloat(lat), lon: parseFloat(lon) };
    } catch (err) {
      // This will catch timeouts, network errors, etc.
      console.error('geocodeOne error for query:', queryStr, err.message);
      // Try the next attempt
      continue;
    }
  }

  // All attempts failed
  return null;
}



// Uses only `id` (no uuid column needed)
async function geocodeMissingLeads({ limit = 25, delayMs = 1000 } = {}) {
  const client = await pool.connect();
  let success = 0, failed = 0, processed = 0;

  try {
    const selectSql = `
      SELECT id, company, city, state
      FROM leads
      WHERE (latitude IS NULL OR longitude IS NULL)
        AND (COALESCE(city,'') <> '' OR COALESCE(state,'') <> '' OR COALESCE(company,'') <> '')
      ORDER BY updated_at DESC NULLS LAST
      LIMIT $1
    `;
    const { rows } = await client.query(selectSql, [limit]);

    for (const row of rows) {
      processed++;
      try {
        const geo = await geocodeOne({ company: row.company, city: row.city, state: row.state });
        if (geo) {
          await client.query(
            `UPDATE leads SET latitude=$1, longitude=$2, updated_at=NOW() WHERE id=$3`,
            [geo.lat, geo.lon, row.id]
          );
          success++;
        } else {
          failed++;
        }
      } catch {
        failed++;
      }
      await new Promise(r => setTimeout(r, delayMs)); // polite throttle
    }
  } finally {
    client.release();
  }

  return { processed, success, failed };
}
 
// --- PG POOL ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.PG_CONN_STRING,
  ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false }
});

// --- HEALTH ---
app.get('/health', (_req, res) => {
  res.status(200).json({ ok: true, service: 'Deli Sandwich Backend', ts: new Date().toISOString() });
});

// ---- Query param helpers ----
function qpBool(val, defaultVal = false) {
  if (val === undefined || val === null || val === '') return defaultVal;

  const v = String(val).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(v)) return false;

  return defaultVal;
}

function qpCountMode(val) {
  const v = String(val || 'leads').trim().toLowerCase();
  if (v === 'account' || v === 'accounts') return 'accounts';
  return 'leads';
}

// =============================================
// AI SUMMARY GENERATOR (Option B - Narrative AI)
// =============================================
async function generateAISummary(metrics, range, leads) {
  try {
    const prompt = `
You are an expert BDR analyst generating a clear, leadership-ready summary.

Date Range: ${range.from} to ${range.to}

Metrics:
- Total Touches: ${metrics.activity.total_touches}
- Calls: ${metrics.activity.calls}
- Emails: ${metrics.activity.emails}
- Social: ${metrics.activity.social}
- Upgrades: ${metrics.pipeline.upgrades}
- Downgrades: ${metrics.pipeline.downgrades}
- Strongest Region: ${metrics.regions.strongest?.key || "None"}
- Weakest Region: ${metrics.regions.weakest?.key || "None"}

Instructions:
Write a short, polished summary in 4 parts:
1) One opening sentence about traction this period
2) One line about upgrades/downgrades
3) One line about the strongest & weakest regions
4) One paragraph of insights tying everything together

Keep it concise. No markdown. No bullet points. Plain text only.
    `;

    const response = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      temperature: 0.4,
      max_tokens: 300,
      messages: [
        { role: "system", content: "You produce clean, executive-ready summaries." },
        { role: "user", content: prompt }
      ]
    });

    return response.choices[0].message?.content || "";
  } catch (err) {
    console.error("AI Summary Error:", err);
    return "AI summary unavailable.";
  }
}




// === SUMMARY DASHBOARD (Finexio BDR Traction Engine) ===
// GET /summary?from=YYYY-MM-DD&to=YYYY-MM-DD&pinned_only=1&count_mode=leads|accounts
app.get('/summary', async (req, res) => {
  let client;
  try {


    client = await pool.connect();

    const { from, to } = req.query;
    const pinnedOnly = qpBool(req.query.pinned_only, true);
    const countMode  = qpCountMode(req.query.count_mode);
	
	    // 🔹 NEW: Event Mode tag filter (e.g., "AFP Event")
    const eventTagRaw = (req.query.tag || "").trim();
    const eventTag = eventTagRaw.toLowerCase();

    // ----- Date window (inclusive from; "to" treated as same-day, but we query [from, to+1) ) -----
    const today = new Date();
    const end   = to ? new Date(to) : today;
    const start = from ? new Date(from) : new Date(end);
    if (!from) start.setDate(end.getDate() - 7); // default last 7 days

    const pad = (n) => (n < 10 ? '0' + n : '' + n);
    const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

    const fromStr = ymd(start);
    const endExclusive = new Date(end);
    endExclusive.setDate(endExclusive.getDate() + 1); // make 'to' exclusive
    const toStr = ymd(endExclusive);

    // ----- 1) Activities in window -----
    let activities = [];
    try {
      const actSql = `
        SELECT id, lead_id, happened_at, type
        FROM activities
        WHERE happened_at >= $1::date
          AND happened_at <  $2::date
        ORDER BY happened_at ASC
      `;
      const actResult = await client.query(actSql, [fromStr, toStr]);
      activities = actResult.rows;
    } catch (errAct) {
      console.error('SUMMARY: activities query failed (non-fatal):', errAct.message);
      activities = [];
    }


    // Basic activity metrics
    const totalTouches = activities.length;
    const byType = { call: 0, email: 0, social: 0 };
    const leadIdsWithActivity = new Set();

    for (const a of activities) {
      const t = (a.type || '').toString().toLowerCase();
      if (t === 'call') byType.call++;
      else if (t === 'email') byType.email++;
      else if (t === 'social') byType.social++;
      leadIdsWithActivity.add(a.lead_id);
    }

    // ----- 2) Leads that matter for this window -----
    const touchIds = Array.from(leadIdsWithActivity);
    const params = [fromStr, toStr];
    let leadWhere = `
      (created_at >= $1::date AND created_at < $2::date)
    `;

    if (touchIds.length > 0) {
    params.push(touchIds);
    leadWhere = `
    (${leadWhere})
    OR id = ANY($3)
  `;
}


    const leadSql = `
      SELECT *
      FROM leads
      WHERE ${leadWhere}
    `;
    const { rows: allLeadsWindow } = await client.query(leadSql, params);

    // Separate "new this window" for KPI
    const leadsCreatedThisWindow = allLeadsWindow.filter((l) => {
      if (!l.created_at) return false;
      const d = new Date(l.created_at);
      return d >= new Date(fromStr) && d < new Date(toStr);
    });

    // Apply pinned filter for map-related metrics + lead list
let leadsFiltered = allLeadsWindow;

// Optional: only pinned leads
if (pinnedOnly) {
  leadsFiltered = leadsFiltered.filter(
    (l) => l.latitude != null && l.longitude != null
  );
}

// NEW: Event Mode tag filtering (defensive: handles arrays OR strings)
if (eventTag) {
  leadsFiltered = leadsFiltered.filter((l) => {
    if (!l || l.tags == null) return false;

    let tags = l.tags;

    // If it's a string (e.g. "AFP Event,Other"), split it
    if (!Array.isArray(tags)) {
      tags = String(tags)
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
    }

    if (!tags.length) return false;

    return tags.some(
      (t) => String(t).trim().toLowerCase() === eventTag
    );
  });
}

console.log('SUMMARY after tag filter:', {
  totalWindowLeads: allLeadsWindow.length,
  leadsFilteredCount: leadsFiltered.length,
  eventTag,
});



    // Map for quick lookup by id
    const leadById = new Map();
    for (const l of leadsFiltered) {
      leadById.set(l.id, l);
    }

    // Leads that were actually contacted in the window (after pinned filter)
    const leadsContactedList = [];
    const seenContacted = new Set();
    for (const a of activities) {
      const lead = leadById.get(a.lead_id);
      if (!lead) continue;
      if (seenContacted.has(lead.id)) continue;
      seenContacted.add(lead.id);
      leadsContactedList.push(lead);
    }

    // Count mode: leads vs accounts (company)
    const uniqCompany = new Set();
    for (const l of leadsFiltered) {
      if (!l.company) continue;
      uniqCompany.add(l.company.toLowerCase());
    }
    const totalLeadsConsidered =
      countMode === 'accounts' ? uniqCompany.size : leadsFiltered.length;

    const uniqCompanyContacted = new Set();
    for (const l of leadsContactedList) {
      if (!l.company) continue;
      uniqCompanyContacted.add(l.company.toLowerCase());
    }
    const leadsContactedWindow =
      countMode === 'accounts'
        ? uniqCompanyContacted.size
        : leadsContactedList.length;

    // ----- 3) ARR + AP Spend metrics (Finexio style) -----
    function num(v) {
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    }

    const arrValues = [];
    const apValues  = [];

    for (const l of leadsContactedList) {
      if (l.arr != null) arrValues.push(num(l.arr));
      if (l.ap_spend != null) apValues.push(num(l.ap_spend));
    }

    const sum = (arr) => arr.reduce((s, v) => s + v, 0);
    const avg = (arr) => (arr.length ? sum(arr) / arr.length : 0);

    const avgArr      = avg(arrValues);
    const avgApSpend  = avg(apValues);

    // Total "pipeline-ish" value for hot+warm (still handy if you want it)
    const hotWarm = leadsFiltered.filter((l) => {
      const s = normalizeStatus(l.status);
      return s === 'hot' || s === 'warm';
    });
    const corpv = sum(hotWarm.map((l) => num(l.arr)));

    // ----- 4) Status upgrades / downgrades + traction per region -----
    let historyRows = [];
    try {
      const histSql = `
        SELECT
          h.lead_id,
          h.old_status,
          h.new_status,
          h.changed_at,
          l.company,
          l.state,
          l.ap_spend
        FROM lead_status_history h
        JOIN leads l ON l.id = h.lead_id
        WHERE h.changed_at >= $1::date
          AND h.changed_at <  $2::date
        ORDER BY h.changed_at DESC
      `;
      const histResult = await client.query(histSql, [fromStr, toStr]);
      historyRows = histResult.rows;
    } catch (errHist) {
      console.error('SUMMARY: lead_status_history query failed (non-fatal):', errHist.message);
      historyRows = [];
    }



    const STATUS_ORDER = {
      'unspecified': 0,
      'research':    1,
      'cold':        2,
      'follow-up':   3,
      'warm':        4,
      'hot':         5,
      'converted':   6,
      'no fit':      -1,
      'no_fit':      -1
    };

    let upgrades = 0;
    let downgrades = 0;

    const stateStats = new Map(); // key => { warmUp, hotUp, converted, apSpendTouched, tractionScore }
    const ensureState = (rawState) => {
      const key = (rawState || 'Unspecified').toString().toUpperCase();
      if (!stateStats.has(key)) {
        stateStats.set(key, {
          state: key,
          warmUp: 0,
          hotUp: 0,
          converted: 0,
          apSpendTouched: 0,
          tractionScore: 0
        });
      }
      return stateStats.get(key);
    };

    for (const h of historyRows) {
      const oldNorm = normalizeStatus(h.old_status);
      const newNorm = normalizeStatus(h.new_status);
      const oldRank = STATUS_ORDER[oldNorm] ?? 0;
      const newRank = STATUS_ORDER[newNorm] ?? 0;

      if (newRank > oldRank) upgrades++;
      else if (newRank < oldRank) downgrades++;

      const st = ensureState(h.state);

      if (newRank > oldRank) {
        if (newNorm === 'warm') st.warmUp++;
        else if (newNorm === 'hot') st.hotUp++;
        else if (newNorm === 'converted') st.converted++;
      }
    }

    // AP Spend contribution per state = from contacted leads
    for (const l of leadsContactedList) {
      const st = ensureState(l.state);
      st.apSpendTouched += num(l.ap_spend);
    }

    // Traction score per state (success-based: upgrades + AP spend)
    for (const st of stateStats.values()) {
      st.tractionScore =
        st.warmUp * 3 +
        st.hotUp * 5 +
        st.converted * 12 +  // heavy weight for converted
        st.apSpendTouched / 1_000_000; // normalise AP spend
    }

    // Build perf_by_state array
    const perfByState = Array.from(stateStats.values())
      .map((s) => ({
        key: s.state,
        warm_upgrades: s.warmUp,
        hot_upgrades: s.hotUp,
        converted: s.converted,
        ap_spend_touched: s.apSpendTouched,
        traction_score: s.tractionScore,
        // keep hw_arr for backwards compat, but now it represents AP Spend engaged
        hw_arr: s.apSpendTouched
      }))
      .sort((a, b) => b.traction_score - a.traction_score);

    // Strongest / weakest region by traction score (ignore zero-score states)
    const nonZeroStates = perfByState.filter((s) => s.traction_score > 0);
    let strongestRegion = null;
    let weakestRegion = null;

    if (nonZeroStates.length > 0) {
      strongestRegion = nonZeroStates.reduce((best, s) =>
        !best || s.traction_score > best.traction_score ? s : best
      , null);

      weakestRegion = nonZeroStates.reduce((worst, s) =>
        !worst || s.traction_score < worst.traction_score ? s : worst
      , null);
    }
	
	    // Build detail list of status changes for UI panel
    const statusChanges = historyRows
      .map((h) => ({
        lead_id: h.lead_id,
        company: h.company || null,
        old_status: h.old_status,
        new_status: h.new_status,
        changed_at: h.changed_at,
        state: h.state,
        ap_spend: num(h.ap_spend)
      }))
      .sort((a, b) => new Date(b.changed_at) - new Date(a.changed_at))
      .slice(0, 50); // cap to the 50 most recent


    // ----- 5) Industry & Tag performance -----
    const byIndustry = new Map(); // key => { key, leads, converted }
    for (const l of leadsFiltered) {
      const indKey = (l.industry || 'Unspecified').toString();
      if (!byIndustry.has(indKey)) {
        byIndustry.set(indKey, { key: indKey, leads: 0, converted: 0 });
      }
      const bucket = byIndustry.get(indKey);
      bucket.leads++;
      const s = normalizeStatus(l.status);
      if (s === 'converted') bucket.converted++;
    }

    const perfByIndustry = Array.from(byIndustry.values())
      .map((b) => ({
        key: b.key,
        leads: b.leads,
        conv_pct: b.leads ? Math.round((b.converted / b.leads) * 100) : 0
      }))
      .sort((a, b) => b.conv_pct - a.conv_pct);

    // Tags
    const tagCounts = new Map();
    for (const l of leadsFiltered) {
      let tags = l.tags;
      if (Array.isArray(tags)) {
        for (const t of tags) {
          const key = (t || '').toString().trim();
          if (!key) continue;
          tagCounts.set(key, (tagCounts.get(key) || 0) + 1);
        }
      }
    }
    const perfByTag = Array.from(tagCounts.entries())
      .map(([key, cnt]) => ({ key, cnt }))
      .sort((a, b) => b.cnt - a.cnt);

    // ----- 6) Unplaced count (for reconcile panel) -----
    const unplacedSql = `
      SELECT COUNT(*) AS cnt
      FROM leads
      WHERE created_at >= $1::date
        AND created_at <  $2::date
        AND (latitude IS NULL OR longitude IS NULL)
    `;
    const { rows: unplacedRows } = await client.query(unplacedSql, [fromStr, toStr]);
    const unplacedCount = parseInt(unplacedRows[0]?.cnt || '0', 10);

// ----- AI BAND NOTES (Hot / Warm / Cold / Research / Follow-Up / Converted) -----

async function generateBandNotes(leads) {
  const buckets = {
    hot: [], warm: [], cold: [],
    research: [], followup: [], converted: []
  };

  for (const l of leads) {
    const s = normalizeStatus(l.status);
    if (buckets[s]) buckets[s].push(l);
  }

  // Build short prompts for each bucket
  function promptFor(label, items) {
    if (!items.length)
      return `No ${label} leads this period. Return one sentence noting that.`;

    return `
Analyze ${label.toUpperCase()} leads.
Count: ${items.length}
Industries: ${items.map(l => l.industry || "Unspecified").join(", ")}
States: ${items.map(l => l.state || "Unspecified").join(", ")}
AP Spend: ${items.reduce((a,b)=>a+(b.ap_spend||0),0)}
ARR: ${items.reduce((a,b)=>a+(b.arr||0),0)}

Return 2–3 short sentences highlighting:
- ICP patterns
- Opportunities
- Risks
    `.trim();
  }

  async function ask(prompt) {
    try {
      const response = await client.chat.completions.create({
        model: process.env.OPENAI_MODEL || "gpt-4o-mini",
        temperature: 0.5,
        max_tokens: 120,
        messages: [{ role: "user", content: prompt }]
      });

      return response.choices[0].message?.content || "";
    } catch (e) {
      console.error("Band Note AI Err:", e);
      return "(AI note unavailable)";
    }
  }

  return {
    hot: await ask(promptFor("Hot", buckets.hot)),
    warm: await ask(promptFor("Warm", buckets.warm)),
    cold: await ask(promptFor("Cold", buckets.cold)),
    research: await ask(promptFor("Research", buckets.research)),
    followup: await ask(promptFor("Follow-Up", buckets.followup)),
    converted: await ask(promptFor("Converted", buckets.converted)),
  };
}


// ----- Assemble payload -----
let ai_band_notes = {
  hot: "(AI note unavailable)",
  warm: "(AI note unavailable)",
  cold: "(AI note unavailable)",
  research: "(AI note unavailable)",
  followup: "(AI note unavailable)",
  converted: "(AI note unavailable)"
};

try {
  ai_band_notes = await generateBandNotes(leadsFiltered);
} catch (errAI) {
  console.error("SUMMARY: generateBandNotes failed (non-fatal):", errAI);
  // keep the default fallback text above
}

    const metrics = {
      activity: {
        total_touches: totalTouches,
        calls: byType.call,
        emails: byType.email,
        social: byType.social,
        leads_contacted_window: leadsContactedWindow,
        total_leads_considered: totalLeadsConsidered,
        new_leads_added: leadsCreatedThisWindow.length
      },
      arr: {
        // historical naming, but now represents average ARR of contacted prospects
        corpv: corpv,
        avg_deal: avgArr,
        avg_arr: avgArr
      },
      ap_spend: {
        avg_ap_spend: avgApSpend
      },
      pipeline: {
        upgrades,
        downgrades
      },
      perf_by_industry: perfByIndustry,
      perf_by_state: perfByState,
      perf_by_tag: perfByTag,
      regions: {
        strongest: strongestRegion,
        weakest: weakestRegion
      }
    };
	
	// ---- AI NARRATIVE SUMMARY (Option B - second call) ----
let ai_summary = await generateAISummary(metrics, { from: fromStr, to: toStr }, leadsFiltered);


return res.json({
  ok: true,
  range: { from: fromStr, to: toStr },
  metrics,
  status_changes: statusChanges,
  unplaced_count: unplacedCount,
  leads: leadsFiltered,
  ai_band_notes,
  ai_summary
});



  } catch (err) {
    console.error('SUMMARY ERR (Finexio traction handler)', err);
    return res.status(500).json({ ok: false, error: 'summary_failed' });
  } finally {
    if (client) client.release();
  }
});



app.get('/map/summary', async (req, res) => {
  try {
    const pinnedOnly = qpBool(req.query.pinned_only, true);
    const countMode  = qpCountMode(req.query.count_mode);

    const pinnedSqlWhere = pinnedOnly
      ? 'WHERE latitude IS NOT NULL AND longitude IS NOT NULL'
      : '';

    // Build ONE SQL string depending on count mode
    const sql =
      countMode === 'accounts'
        ? `
          SELECT DISTINCT ON (LOWER(company)) *
          FROM leads
          ${pinnedSqlWhere}
          ORDER BY
            LOWER(company),
            updated_at DESC NULLS LAST,
            created_at DESC NULLS LAST
          LIMIT 2000;
        `
        : `
          SELECT *
          FROM leads
          ${pinnedSqlWhere}
          ORDER BY
            updated_at DESC NULLS LAST,
            created_at DESC NULLS LAST
          LIMIT 2000;
        `;

    const { rows } = await pool.query(sql);
    res.json({ count: rows.length, data: rows });
  } catch (err) {
    console.error('MAP SUMMARY ERR:', err);
    res.status(500).json({ error: 'Failed to fetch map rows' });
  }
});

// =======================
// FULL LEAD LIST (no geolocation filter)
// GET /leads/all
// =======================
app.get('/leads/all', async (_req, res) => {
  try {
    const sql = `
      SELECT *
      FROM leads
      ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
      LIMIT 5000;
    `;
    const { rows } = await pool.query(sql);
    return res.json({
      ok: true,
      count: rows.length,
      data: rows
    });
  } catch (err) {
    console.error('ALL LEADS ERR:', err);
    return res.status(500).json({ ok: false, error: 'failed_all_leads' });
  }
});



// ===== 1-on-1 Summary API =====
// GET /api/oneonone?from=YYYY-MM-DD&to=YYYY-MM-DD  (to is exclusive)
app.get('/api/oneonone', async (req, res) => {
  try {
    const { from, to } = req.query;
	const pinnedOnly = qpBool(req.query.pinned_only, true); // default true
	const countMode = qpCountMode(req.query.count_mode);
	// NEW: Event Mode tag filter (e.g. "AFP Event")
    const eventTagRaw = (req.query.tag || "").trim();
    const eventTag = eventTagRaw.toLowerCase();




    // Defaults: last 7 days if not provided
    const today = new Date();
    const end = to ? new Date(to) : today; // we'll make this exclusive
    const start = from ? new Date(from) : new Date(end);
    if (!from) start.setDate(end.getDate() - 7);

    const pad = n => (n < 10 ? '0' + n : '' + n);
    const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

    const fromStr = ymd(start);
    const endExclusive = new Date(end);
    endExclusive.setDate(endExclusive.getDate() + 1); // make 'to' exclusive
    const toStr = ymd(endExclusive);
	
	
console.log("SUMMARY window:", { fromStr, toStr, eventTag, pinnedOnly, countMode });

const baseDedupe = (countMode === 'accounts')
  ? `
    base_final AS (
      SELECT DISTINCT ON (LOWER(company))
             lead_type, industry, status, ap_spend
      FROM (
        SELECT
          COALESCE(lead_type, 'Unspecified') AS lead_type,
          COALESCE(industry, 'Unspecified')  AS industry,
          COALESCE(status, 'Unspecified')    AS status,
          COALESCE(ap_spend, 0)::numeric     AS ap_spend,
          company,
          created_at,
          updated_at
        FROM leads
        WHERE created_at >= $1::date
          AND created_at <  $2::date
          ${pinnedOnly ? 'AND latitude IS NOT NULL AND longitude IS NOT NULL' : ''}
      ) t
      ORDER BY LOWER(company), updated_at DESC NULLS LAST, created_at DESC NULLS LAST
    )
  `
  : `
    base_final AS (
      SELECT
        COALESCE(lead_type, 'Unspecified') AS lead_type,
        COALESCE(industry, 'Unspecified')  AS industry,
        COALESCE(status, 'Unspecified')    AS status,
        COALESCE(ap_spend, 0)::numeric     AS ap_spend
      FROM leads
      WHERE created_at >= $1::date
        AND created_at <  $2::date
        ${pinnedOnly ? 'AND latitude IS NOT NULL AND longitude IS NOT NULL' : ''}
    )
  `;

const unplacedExprO11 = (countMode === 'accounts')
  ? `COUNT(DISTINCT LOWER(company))::int`
  : `COUNT(*)::int`;

const sql = `
  WITH
  ${baseDedupe},
  unplaced AS (
    SELECT ${unplacedExprO11} AS unplaced_count
    FROM leads
    WHERE created_at >= $1::date
      AND created_at <  $2::date
      AND (latitude IS NULL OR longitude IS NULL)
  ),
  type_counts AS (
    SELECT lead_type AS type, COUNT(*)::int AS count
    FROM base_final GROUP BY 1 ORDER BY count DESC
  ),
  industry_counts AS (
    SELECT industry, COUNT(*)::int AS count
    FROM base_final GROUP BY 1 ORDER BY count DESC LIMIT 10
  ),
  status_counts AS (
    SELECT status, COUNT(*)::int AS count
    FROM base_final GROUP BY 1 ORDER BY count DESC
  )
  SELECT
    (SELECT COUNT(*)::int FROM base_final)                     AS accounts_added,
    (SELECT COALESCE(SUM(ap_spend),0)::numeric FROM base_final) AS ap_spend_total,
    (SELECT unplaced_count FROM unplaced)                      AS unplaced_count,
    (SELECT COALESCE(JSON_AGG(tc), '[]'::json) FROM type_counts tc)     AS type_counts,
    (SELECT COALESCE(JSON_AGG(ic), '[]'::json) FROM industry_counts ic) AS industry_counts,
    (SELECT COALESCE(JSON_AGG(sc), '[]'::json) FROM status_counts sc)   AS status_counts;
`;
const { rows } = await pool.query(sql, [fromStr, toStr]);
    const row = rows[0] || {};
    const total = row.accounts_added || 0;
    const pct = n => (total > 0 ? Math.round((n / total) * 100) : 0);

    const typeCounts = Array.isArray(row.type_counts) ? row.type_counts : [];
    const customers = typeCounts.find(t => (t.type || '').toLowerCase() === 'customer')?.count || 0;
    const partners  = typeCounts.find(t => (t.type || '').toLowerCase() === 'channel partner')?.count || 0;

    res.json({
      ok: true,
      data: {
        period: { from: fromStr, to: toStr }, // to = exclusive
        accounts_added: total,
        type_mix: {
          counts: { customers, partners, other: Math.max(total - customers - partners, 0) },
          pct: {
            customers: pct(customers),
            partners:  pct(partners),
            other:     pct(Math.max(total - customers - partners, 0))
          }
        },
        ap_spend_total: row.ap_spend_total || 0,
		unplaced_count: row.unplaced_count || 0,
        industries: Array.isArray(row.industry_counts) ? row.industry_counts : [],
        status_breakdown: (Array.isArray(row.status_counts) ? row.status_counts : []).map(s => ({
          status: s.status, count: s.count, pct: pct(s.count)
        }))
      }
    });
  } catch (err) {
    console.error('GET /api/oneonone error:', err);
    res.status(500).json({ ok: false, error: 'Internal error fetching 1-on-1 summary' });
  }
});

// =========================
// FORECASTING METRICS
// =========================

// GET /api/forecast?from&to
app.get('/api/forecast', async (req, res) => {
  try {
    const { from, to } = req.query;
    const mode = qpCountMode(req.query.count_mode);

    // 1) Determine date window
    const today = new Date();
    const end = to ? new Date(to) : today;
    const start = from ? new Date(from) : new Date(end);
    if (!from) start.setDate(end.getDate() - 7);

    const pad = (n) => (n < 10 ? "0"+n : ""+n);
    const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;

    const fromStr = ymd(start);
    const endExclusive = new Date(end);
    endExclusive.setDate(endExclusive.getDate() + 1);
    const toStr = ymd(endExclusive);

    // 2) Calculate forecasting KPIs
    const SQL = `
      WITH scoped AS (
        SELECT *
        FROM leads
        WHERE created_at >= $1::date
          AND created_at <  $2::date
      )
      SELECT
        COUNT(*) FILTER (WHERE status ILIKE 'hot' OR status ILIKE 'warm') AS hw_count,
        COUNT(*) FILTER (WHERE status ILIKE 'converted') AS conv_count,
        SUM(CASE WHEN status ILIKE 'hot' OR status ILIKE 'warm'
                 THEN COALESCE(arr,0) ELSE 0 END) AS hw_arr,
        SUM(CASE WHEN status ILIKE 'converted'
                 THEN COALESCE(arr,0) ELSE 0 END) AS conv_arr
      FROM scoped;
    `;

    const { rows } = await pool.query(SQL, [fromStr, toStr]);
    const m = rows[0] || {};

    // Finexio quota assumptions (you can change these later)
    const QUOTA_MEETINGS = 10;  // monthly target
    const DAYS_IN_PERIOD = 30;

    const actualMeetings = Number(m.conv_count || 0);
    const conversionRate = m.hw_count ? actualMeetings / m.hw_count : 0;

    const quotaPercent = Math.round((actualMeetings / QUOTA_MEETINGS) * 100);
    const pipelineCoverage = m.hw_arr ? (m.hw_arr / (QUOTA_MEETINGS * 1000)) : 0;

    const dailyRequired = QUOTA_MEETINGS / DAYS_IN_PERIOD;
    const daysElapsed = (end - start) / (1000*3600*24);
    const dailyActual = daysElapsed > 0 ? actualMeetings / daysElapsed : 0;

    let pacing = "on_track";
    if (dailyActual < dailyRequired * 0.7) pacing = "off_pace";
    else if (dailyActual < dailyRequired) pacing = "slightly_behind";

    return res.json({
      ok: true,
      data: {
        quota_percent: quotaPercent,
        meetings_forecast: actualMeetings,
        pipeline_coverage: Number(pipelineCoverage.toFixed(1)),
        conversion_rate: Math.round(conversionRate * 100),
        daily_required: Number(dailyRequired.toFixed(2)),
        daily_required_actual: Number(dailyActual.toFixed(2)),
        pacing
      }
    });
  } catch (err) {
    console.error("FORECAST ERR:", err);
    res.status(500).json({ ok:false, error:"forecast_failed" });
  }
});


// =========================
// DAILY QUEUE ENGINE
// =========================

// Helper: clamp batch size
function normalizeBatchSize(raw) {
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n <= 0) return 20;
  if (n < 5) return 5;
  if (n > 100) return 100;
  return n;
}

app.get('/api/daily-queue/current', async (_req, res) => {
  const client = await pool.connect();      // ✅ use client here
  try {
    const batchSql = `
      SELECT id, created_at, batch_size, is_completed
      FROM daily_batches
      WHERE COALESCE(is_completed, false) = false
      ORDER BY created_at DESC
      LIMIT 1;
    `;
    const { rows: batchRows } = await client.query(batchSql);
    if (!batchRows.length) {
      return res.status(404).json({ ok: false, error: 'no_active_batch' });
    }
    const batch = batchRows[0];

    const itemsSql = `
      SELECT
        dbi.id          AS item_id,
        dbi.batch_id,
        dbi.position,
        dbi.is_completed,
        dbi.completed_at,
        dbi.is_skipped,
        dbi.skipped_reason,
        l.*
      FROM daily_batch_items dbi
      JOIN leads l ON l.id = dbi.lead_id
      WHERE dbi.batch_id = $1
      ORDER BY dbi.position ASC;
    `;
    const { rows } = await client.query(itemsSql, [batch.id]);

    const total   = rows.length;
    const done    = rows.filter(r => r.is_completed).length;
    const skipped = rows.filter(r => r.is_skipped).length;

    const items = rows.map(r => ({
      item_id:        r.item_id,
      batch_id:       r.batch_id,
      lead_id:        r.lead_id,
      position:       r.position,
      is_completed:   r.is_completed,
      is_skipped:     r.is_skipped,
      completed_at:   r.completed_at,
      skipped_reason: r.skipped_reason,

      id:        r.id,
      name:      r.name,
      company:   r.company,
      city:      r.city,
      state:     r.state,
      status:    r.status,
      industry:  r.industry,
      forecast_month: r.forecast_month,
      lead_type:      r.lead_type,
      arr:            r.arr,
      ap_spend:       r.ap_spend,
      last_touch_at:  r.last_touch_at,
      next_touch_at:  r.next_touch_at,
      next_action_at: r.next_action_at,
      last_activity_at: r.last_contacted_at || r.last_touch_at || null,
      lead: {
        id:              r.id,
        name:            r.name,
        company:         r.company,
        city:            r.city,
        state:           r.state,
        status:          r.status,
        industry:        r.industry,
        forecast_month:  r.forecast_month,
        lead_type:       r.lead_type,
        arr:             r.arr,
        ap_spend:        r.ap_spend,
        last_touch_at:   r.last_touch_at,
        next_touch_at:   r.next_touch_at,
        next_action_at:  r.next_action_at,
        last_contacted_at: r.last_contacted_at,
      }
    }));

    return res.json({
      ok: true,
      batch: {
        id:          batch.id,
        created_at:  batch.created_at,
        batch_size:  batch.batch_size,
        is_completed: batch.is_completed,
        progress: {
          total,
          done,
          skipped,
          remaining: Math.max(total - done - skipped, 0),
        },
      },
      items,
    });
  } catch (err) {
    console.error('GET /api/daily-queue/current error', err);
    return res.status(500).json({ ok: false, error: 'current_failed' });
  } finally {
    client.release();
  }
});


// 🔧 FIX: include batch_date so NOT NULL constraint is satisfied
const batchSql = `
  INSERT INTO daily_batches (batch_date, batch_size, is_completed)
  VALUES (CURRENT_DATE, $1, false)
  RETURNING *;
`;
const { rows: batchRows } = await client.query(batchSql, [
  requestedSize,
]);
const batch = batchRows[0];


    const items = [];
    for (let i = 0; i < picked.length; i++) {
      const lead = picked[i];
      const itemSql = `
        INSERT INTO daily_batch_items (batch_id, lead_id, position, is_completed, is_skipped)
        VALUES ($1, $2, $3, false, false)
        RETURNING *;
      `;
      const { rows: itemRows } = await client.query(itemSql, [
        batch.id,
        lead.id,          // UUID
        i + 1,            // position starts at 1
      ]);
      const item = itemRows[0];

      items.push({
        // Batch item metadata
        item_id: item.id,
        batch_id: item.batch_id,
        lead_id: item.lead_id,
        position: item.position,
        is_completed: item.is_completed,
        is_skipped: item.is_skipped,

        // 🔽 Flattened lead fields for Daily Queue cards
        id: lead.id,
        name: lead.name,
        company: lead.company,
        city: lead.city,
        state: lead.state,
        status: lead.status,
        industry: lead.industry,

        // key revenue / planning fields
        forecast_month: lead.forecast_month,
        lead_type:      lead.lead_type,
        arr:            lead.arr,
        ap_spend:       lead.ap_spend,

        // touch fields
        last_touch_at:  lead.last_touch_at,
        next_touch_at:  lead.next_touch_at,
        next_action_at: lead.next_action_at,
        last_activity_at: lead.last_contacted_at || lead.last_touch_at || null,

        // full lead object preserved for future use
        lead,
      });
    }

    await client.query('COMMIT');

    return res.json({
      ok: true,
      batch: {
        id: batch.id,
        created_at: batch.created_at,
        batch_size_requested: requestedSize,
        batch_size_actual: actualSize,
        is_completed: batch.is_completed,
      },
      items,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /api/daily-queue/generate error:', err);
    // keep the helpful debug message
    return res.status(500).json({
      ok: false,
      error: 'generate_failed',
      message: err.message,
    });
  } finally {
    client.release();
  }
});




// GET /api/daily-queue/current
app.get('/api/daily-queue/current', async (_req, res) => {
  const db = await pool.connect();
  try {
    const batchSql = `
      SELECT id, created_at, batch_size, is_completed
      FROM daily_batches
      WHERE COALESCE(is_completed, false) = false
      ORDER BY created_at DESC
      LIMIT 1;
    `;
    const { rows: batchRows } = await client.query(batchSql);
    if (!batchRows.length) {
      return res.status(404).json({ ok: false, error: 'no_active_batch' });
    }
    const batch = batchRows[0];

    const itemsSql = `
      SELECT
        dbi.id          AS item_id,
        dbi.batch_id,
        dbi.position,
        dbi.is_completed,
        dbi.completed_at,
        dbi.is_skipped,
        dbi.skipped_reason,
        l.*
      FROM daily_batch_items dbi
      JOIN leads l ON l.id = dbi.lead_id
      WHERE dbi.batch_id = $1
      ORDER BY dbi.position ASC;
    `;
    const { rows } = await client.query(itemsSql, [batch.id]);

    const total   = rows.length;
    const done    = rows.filter(r => r.is_completed).length;
    const skipped = rows.filter(r => r.is_skipped).length;

    const items = rows.map(r => ({
      // Batch item metadata
      item_id:       r.item_id,
      batch_id:      r.batch_id,
      lead_id:       r.lead_id,
      position:      r.position,
      is_completed:  r.is_completed,
      is_skipped:    r.is_skipped,
      completed_at:  r.completed_at,
      skipped_reason:r.skipped_reason,

      // 🔽 Flattened lead fields for Daily Queue cards
      id:            r.id,
      name:          r.name,
      company:       r.company,
      city:          r.city,
      state:         r.state,
      status:        r.status,
      industry:      r.industry,

      // key revenue / planning fields
      forecast_month:r.forecast_month,
      lead_type:     r.lead_type,
      arr:           r.arr,
      ap_spend:      r.ap_spend,

      // touch fields
      last_touch_at: r.last_touch_at,
      next_touch_at: r.next_touch_at,
      next_action_at:r.next_action_at,
      last_activity_at: r.last_contacted_at || r.last_touch_at || null,

      // keep raw lead in case UI ever needs extras
      lead: {
        id:              r.id,
        name:            r.name,
        company:         r.company,
        city:            r.city,
        state:           r.state,
        status:          r.status,
        industry:        r.industry,
        forecast_month:  r.forecast_month,
        lead_type:       r.lead_type,
        arr:             r.arr,
        ap_spend:        r.ap_spend,
        last_touch_at:   r.last_touch_at,
        next_touch_at:   r.next_touch_at,
        next_action_at:  r.next_action_at,
        last_contacted_at: r.last_contacted_at,
      }
    }));

    return res.json({
      ok: true,
      batch: {
        id:          batch.id,
        created_at:  batch.created_at,
        batch_size:  batch.batch_size,
        is_completed:batch.is_completed,
        progress: {
          total,
          done,
          skipped,
          remaining: Math.max(total - done - skipped, 0),
        },
      },
      items,
    });
  } catch (err) {
    console.error('GET /api/daily-queue/current error:', err);
    return res.status(500).json({ ok: false, error: 'current_failed' });
  } finally {
    client.release();
  }
});


// POST /api/daily-queue/item/:id/done
// Body: { new_status?, action_type?, notes?, next_touch_choice?, next_touch_at? }
app.post('/api/daily-queue/item/:id/done', async (req, res) => {
  const itemId = req.params.id;
  const {
    new_status,
    action_type,
    notes,
    next_touch_choice,
    next_touch_at,
  } = req.body || {};

  const client = await pool.connect();     // ✅ use client

  let activityPayload = null;

  try {
    await client.query('BEGIN');

    const loadSql = `
      SELECT
        dbi.id      AS item_id,
        dbi.batch_id,
        dbi.lead_id,
        l.status    AS old_status
      FROM daily_batch_items dbi
      JOIN leads l ON l.id = dbi.lead_id
      WHERE dbi.id = $1
      FOR UPDATE;
    `;
    const { rows } = await client.query(loadSql, [itemId]);
    if (!rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'item_not_found' });
    }
    const item = rows[0];

    const oldStatus = (item.old_status || '').toString();
    const newStatusRaw = new_status || oldStatus;
    const newStatus = normalizeStatus(newStatusRaw);

    let nextTouch = null;

    if (next_touch_at) {
      const d = new Date(next_touch_at);
      if (!Number.isNaN(d.getTime())) nextTouch = d;
    } else if (next_touch_choice) {
      const base = new Date();
      base.setHours(12, 0, 0, 0);

      let offsetDays = 0;
      switch (next_touch_choice) {
        case 'tomorrow':          offsetDays = 1;  break;
        case '3_days':            offsetDays = 3;  break;
        case 'next_week':         offsetDays = 7;  break;
        case 'later_this_month':  offsetDays = 14; break;
        case 'custom':            offsetDays = 0;  break;
        default:                  offsetDays = 0;
      }

      if (offsetDays > 0) {
        base.setDate(base.getDate() + offsetDays);
        nextTouch = base;
      }
    }

    const isRetired =
      ['converted', 'no fit', 'no_fit'].includes(newStatus.toLowerCase());

    const updateLeadSql = `
      UPDATE leads
      SET
        status        = $1,
        is_retired    = $2,
        last_touch_at = NOW(),
        next_touch_at = COALESCE($3::timestamptz, next_touch_at),
        updated_at    = NOW()
      WHERE id = $4
      RETURNING id;
    `;
    await client.query(updateLeadSql, [
      newStatus,
      isRetired,
      nextTouch,
      item.lead_id,
    ]);

    if (action_type) {
      activityPayload = {
        lead_id: item.lead_id,
        activity_type: action_type,
        notes: notes || null,
        status_before: oldStatus || null,
        status_after: newStatus || null,
      };
    }

    if (oldStatus.toLowerCase() !== newStatus.toLowerCase()) {
      const historySql = `
        INSERT INTO lead_status_history
          (lead_id, old_status, new_status, changed_at, changed_by, note)
        VALUES ($1, $2, $3, NOW(), $4, $5);
      `;
      await client.query(historySql, [
        item.lead_id,
        oldStatus || null,
        newStatus,
        null,
        notes || null,
      ]);
    }

    const updateItemSql = `
      UPDATE daily_batch_items
      SET
        is_completed   = TRUE,
        completed_at   = NOW(),
        is_skipped     = FALSE,
        skipped_reason = NULL
      WHERE id = $1;
    `;
    await client.query(updateItemSql, [itemId]);

    const progressSql = `
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE is_completed OR is_skipped) AS done
      FROM daily_batch_items
      WHERE batch_id = $1;
    `;
    const { rows: progRows } = await client.query(progressSql, [item.batch_id]);
    const prog = progRows[0];
    if (prog && Number(prog.total) > 0 && Number(prog.total) === Number(prog.done)) {
      await client.query(
        'UPDATE daily_batches SET is_completed = TRUE WHERE id = $1;',
        [item.batch_id]
      );
    }

    await client.query('COMMIT');

    if (activityPayload) {
      const pieces = [];

      if (activityPayload.activity_type) {
        pieces.push(activityPayload.activity_type.toString().toUpperCase());
      }

      if (
        activityPayload.status_before &&
        activityPayload.status_after &&
        activityPayload.status_before.toLowerCase() !==
          activityPayload.status_after.toLowerCase()
      ) {
        pieces.push(
          `${activityPayload.status_before} → ${activityPayload.status_after}`
        );
      }

      if (activityPayload.notes) {
        const trimmed = activityPayload.notes.length > 80
          ? activityPayload.notes.slice(0, 77) + '...'
          : activityPayload.notes;
        pieces.push(`“${trimmed}”`);
      }

      const summary = pieces.join(' — ');

      const activitySql = `
        INSERT INTO activities (
          lead_id,
          happened_at,
          type,
          summary
        )
        VALUES ($1, NOW(), $2, $3)
        RETURNING id;
      `;
      const values = [
        activityPayload.lead_id,
        activityPayload.activity_type,
        summary || null,
      ];

      try {
        const { rows: actRows } = await client.query(activitySql, values);
        const activityId = actRows[0] ? actRows[0].id : null;
        console.log('[Daily Queue] Logged activity', {
          activity_id: activityId,
          lead_id: activityPayload.lead_id,
          type: activityPayload.activity_type,
        });
      } catch (activityErr) {
        console.error(
          'Warning: failed to insert activity after done (non-fatal)',
          activityErr
        );
      }
    }

    return res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /api/daily-queue/item/:id/done error:', err);
    return res.status(500).json({ ok: false, error: 'item_done_failed' });
  } finally {
    client.release();
  }
});





// POST /api/daily-queue/item/:id/skip
// Body: { reason? }
app.post('/api/daily-queue/item/:id/skip', async (req, res) => {
  const itemId = req.params.id;
  const { reason } = req.body || {};

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const loadSql = `
      SELECT id, batch_id
      FROM daily_batch_items
      WHERE id = $1
      FOR UPDATE;
    `;
    const { rows } = await client.query(loadSql, [itemId]);
    if (!rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'item_not_found' });
    }
    const item = rows[0];

    const updateItemSql = `
      UPDATE daily_batch_items
      SET
        is_skipped      = TRUE,
        skipped_reason  = $2,
        is_completed    = FALSE,
        completed_at    = NULL
      WHERE id = $1;
    `;
    await client.query(updateItemSql, [itemId, reason || null]);

    // Check if batch is now fully done/skipped
    const progressSql = `
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE is_completed OR is_skipped) AS done
      FROM daily_batch_items
      WHERE batch_id = $1;
    `;
    const { rows: progRows } = await client.query(progressSql, [item.batch_id]);
    const prog = progRows[0];
    if (prog && Number(prog.total) > 0 && Number(prog.total) === Number(prog.done)) {
      await client.query(
        `UPDATE daily_batches SET is_completed = TRUE WHERE id = $1;`,
        [item.batch_id]
      );
    }

    await client.query('COMMIT');
    return res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /api/daily-queue/item/:id/skip error:', err);
    return res.status(500).json({ ok: false, error: 'item_skip_failed' });
  } finally {
    client.release();
  }
});


// =========================
// CSV IMPORT
// =========================

/**
 * Final CSV header order (case-insensitive matching in importer):
 * Name,Email,Company,Industry,Owner,City,State,Status,Tags,Cadence Name,Source,Source Channel,
 * Conversion Stage,ARR,AP Spend,Size,Obstacle,Net New,Self Sourced,Engagement Score,
 * Last Contacted At,Next Action At,Last Status Change,Notes,Latitude,Longitude,Forecast Month,Lead Type,Website
 *
 * Minimal required: Name, Company
 */
const REQUIRED_HEADERS = ['name', 'company'];

// Normalize/clean status strings ("Hot", "hot ", "HOT" → "hot", etc.)
function normalizeStatus(raw) {
  if (!raw) return null;
  return String(raw)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/-/g, '_');
}

// Take a raw CSV row with arbitrary header casing and map into our DB shape
function normalizeRow(rowRaw) {
  const row = {};
  for (const [k, v] of Object.entries(rowRaw)) {
    row[String(k).toLowerCase()] = v;
  }

  const mustExist = (key) => {
    const val = row[key];
    if (val == null || String(val).trim() === '') {
      throw new Error(`Missing required field: ${key}`);
    }
    return String(val).trim();
  };

  const pick = (key) => {
    const val = row[key];
    if (val == null) return null;
    const s = String(val).trim();
    return s === '' ? null : s;
  };

  const toNumber = (key) => {
    const val = row[key];
    if (val == null || String(val).trim() === '') return null;
    const cleaned = String(val).replace(/[$,]/g, '').trim();
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  };

  const toBool = (key) => {
    const val = row[key];
    if (val == null) return false;
    const s = String(val).trim().toLowerCase();
    if (['true', 'yes', '1', 'y'].includes(s)) return true;
    if (['false', 'no', '0', 'n'].includes(s)) return false;
    return false;
  };

  const toDate = (key) => {
    const val = row[key];
    if (!val) return null;
    const d = new Date(val);
    return Number.isNaN(d.getTime()) ? null : d;
  };

  // Required base fields
  const name    = mustExist('name');
  const company = mustExist('company');

  // Tags: either comma-separated string or already an array-ish
  let tags = [];
  const rawTags = row['tags'];
  if (Array.isArray(rawTags)) {
    tags = rawTags
      .map((t) => String(t).trim())
      .filter(Boolean);
  } else if (typeof rawTags === 'string') {
    tags = rawTags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
  }

  return {
    zoominfo_id: pick('zoominfo_id') || pick('zoominfo id') || null,
    name,
    email: pick('email'),
    company,
    industry: pick('industry'),
    owner: pick('owner'),
    city: pick('city'),
    state: pick('state'),
    status: normalizeStatus(pick('status')),
    tags,
    cadence_name: pick('cadence name'),
    source: pick('source'),
    source_channel: pick('source channel'),
    conversion_stage: pick('conversion stage'),
    arr: toNumber('arr'),
    ap_spend: toNumber('ap spend'),
    size: pick('size'),
    obstacle: pick('obstacle'),
    net_new: toBool('net new'),
    self_sourced: toBool('self sourced'),
    engagement_score: toNumber('engagement score'),
    last_contacted_at: toDate('last contacted at'),
    next_action_at: toDate('next action at'),
    last_status_change: toDate('last status change'),
    notes: pick('notes'),
    latitude: toNumber('latitude'),
    longitude: toNumber('longitude'),
    forecast_month: pick('forecast month'),
    lead_type: pick('lead type'),
    website: pick('website'),
  };
}

// Template download (keeps Notes near end; Lat/Lon last-ish)
app.get('/import/template', (_req, res) => {
  const header = [
    'Name','Email','Company','Industry','Owner','City','State','Status','Tags','Cadence Name','Source','Source Channel',
    'Conversion Stage','ARR','AP Spend','Size','Obstacle','Net New','Self Sourced','Engagement Score',
    'Last Contacted At','Next Action At','Last Status Change','Notes','Latitude','Longitude',
    'Forecast Month','Lead Type','Website'
  ].join(',');

  const body = [
    // row 1
    'Jane Doe,jane.doe@example.com,Acme Components,Manufacturing,Lewis Barr,Charlotte,NC,hot,"AP,ERP",Q4 Outreach,ZoomInfo,LinkedIn,Qualified,25000,30000000,MM,Timing gate,true,true,82,2025-11-08 10:00,2025-11-12 09:00,2025-11-08 10:05,"Champion loves Finexio.",35.2271,-80.8431,November,Customer,https://acme.com',
    // row 2
    'John Smith,john.smith@example.com,Blue Pine Hotels,Hospitality,Lewis Barr,Los Angeles,CA,warm,"Hotels,West",Inbound follow-up,CSV Upload,Inbound,Discovery,18000,,ENT,,false,true,,2025-11-07,2025-11-13,,,"",,October,Channel Partner,https://bluepine.example'
  ].join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="deli_import_template.csv"');
  res.send(header + '\n' + body + '\n');
});

// Upload & import CSV (Deli-ready format)
// 🔹 NEW: supports ?default_source=. & ?default_tag=. query params
app.post('/import/csv', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded. Use form field name "file".' });
    }

    // Parse CSV into rows (lower-cased headers)
    const rows = [];
    await new Promise((resolve, reject) => {
      const parser = parse({ columns: true, skip_empty_lines: true, trim: true });

      parser.on('readable', () => {
        let record;
        while ((record = parser.read()) !== null) {
          const lowered = {};
          for (const [k, v] of Object.entries(record)) {
            lowered[String(k).toLowerCase()] = v;
          }
          rows.push(lowered);
        }
      });

      parser.on('error', reject);
      parser.on('end', resolve);

      parser.write(req.file.buffer);
      parser.end();
    });

    if (!rows.length) {
      return res.status(400).json({ error: 'CSV contained no data rows.' });
    }

    // Normalize & validate rows
    const normalized = [];
    let bad = 0;
    const badExamples = [];

    for (const r of rows) {
      try {
        normalized.push(normalizeRow(r));
      } catch (e) {
        bad++;
        if (badExamples.length < 5) badExamples.push({ row: r, reason: e.message });
      }
    }

    if (!normalized.length) {
      return res.status(400).json({ error: 'All rows failed validation.', examples: badExamples });
    }

    // 🔹 NEW: defaults from query string
    const defaultSource = (req.query.default_source || '').trim();
    const defaultTagRaw = (req.query.default_tag || '').trim();
    const defaultTagLower = defaultTagRaw.toLowerCase();

    // ---------- DB transaction ----------
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // fixed column order for insert
      const columns = [
        'name','email','company','industry','owner','city','state','status','tags','cadence_name',
        'source','source_channel','conversion_stage','arr','ap_spend','size','obstacle',
        'net_new','self_sourced','engagement_score','last_contacted_at','next_action_at',
        'last_status_change','notes','latitude','longitude','forecast_month','lead_type',
        'website','created_at','updated_at'
      ];

      const colList = columns.join(', ');
      const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');

      const sql = `
        INSERT INTO leads (${colList})
        VALUES (${placeholders})
        ON CONFLICT DO NOTHING;
      `;

      for (const r of normalized) {
        // 🔹 Start from CSV tags
        let tags = Array.isArray(r.tags) ? [...r.tags] : [];

        // 🔹 Inject default_tag if provided and not already present (case-insensitive)
        if (defaultTagRaw) {
          const hasDefault = tags.some(
            (t) => String(t).trim().toLowerCase() === defaultTagLower
          );
          if (!hasDefault) {
            tags.push(defaultTagRaw);
          }
        }

        // 🔹 Final source: row source > default_source > "csv-import"
        const finalSource = r.source || defaultSource || 'csv-import';

        const values = [
          r.name ?? null,
          r.email ?? null,
          r.company ?? null,
          r.industry ?? null,
          r.owner ?? null,
          r.city ?? null,
          r.state ?? null,
          normalizeStatus(r.status),
          tags,
          r.cadence_name ?? null,
          finalSource,
          r.source_channel ?? null,
          r.conversion_stage ?? null,
          r.arr ?? null,
          r.ap_spend ?? null,
          r.size ?? null,
          r.obstacle ?? null,
          r.net_new ?? false,
          r.self_sourced ?? false,
          r.engagement_score ?? null,
          r.last_contacted_at ?? null,
          r.next_action_at ?? null,
          r.last_status_change ?? null,
          r.notes ?? null,
          r.latitude ?? null,
          r.longitude ?? null,
          r.forecast_month ?? null,
          r.lead_type ?? null,
          r.website ?? null,
          new Date(), // created_at
          new Date()  // updated_at
        ];

        await client.query(sql, values);
      }


      await client.query('COMMIT');

      // 🗺️ Auto-run geocoder after CSV import (fills any missing lat/lon)
      const geoSummary = await geocodeMissingLeads({ limit: 25, delayMs: 1000 });

      return res.json({
        ok: true,
        inserted_or_updated: normalized.length,
        failed: bad,
        failed_examples: badExamples,
        geocoded_processed: geoSummary.processed,
        geocoded_success: geoSummary.success,
        geocoded_failed: geoSummary.failed
      });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('Error inserting CSV rows into leads:', err);
      return res.status(500).json({ error: 'Failed to import CSV into leads table.' });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Error parsing CSV:', err);
    return res.status(500).json({ error: 'Failed to parse CSV.' });
  }
});




// --- UPDATE A LEAD (Safe UPSERT; now logs status history) ---
// PUT /update-lead/:id  — update a single lead, log status change, and return the updated row
app.put('/update-lead/:id', async (req, res) => {
  const id = req.params.id;

  // Helpers
  const strOrNull = (v) =>
    v === '' || v == null ? null : String(v);

  // Parse things like "25000000", "25M", "10k", "1.2B"
  function parseShortMoney(raw) {
    if (raw === null || raw === undefined || raw === '') return null;

    let s = String(raw).trim();
    if (!s) return null;

    // strip $ and commas
    s = s.replace(/[\$,]/g, '').toLowerCase();

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

  const numOrNull = (v) => {
    const n = parseShortMoney(v);
    return n == null ? null : n;
  };


  // Normalize status (frontend may send 'follow-up', etc.)
  let status = strOrNull(req.body.status);
  if (status) {
    status = status
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '_')
      .replace(/-/g, '_');
  }

  // Tags → text[]
  let tags = null;

  if (typeof req.body.tags === 'string') {
    const parts = req.body.tags
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);

    tags = parts.length ? parts : null;
  } else if (Array.isArray(req.body.tags)) {
    const parts = req.body.tags
      .map(s => String(s).trim())
      .filter(Boolean);

    tags = parts.length ? parts : null;
  }


  const payload = {
    name: strOrNull(req.body.name),
    email: strOrNull(req.body.email),
    company: strOrNull(req.body.company),
    website: strOrNull(req.body.website),
    city: strOrNull(req.body.city),
    state: strOrNull(req.body.state?.toUpperCase?.() || req.body.state),
    status,
    industry: strOrNull(req.body.industry),
    forecast_month: strOrNull(req.body.forecast_month),
    lead_type: strOrNull(req.body.lead_type),
    arr: numOrNull(req.body.arr),
    ap_spend: numOrNull(req.body.ap_spend),
    notes: strOrNull(req.body.notes),
    latitude: numOrNull(req.body.latitude),
    longitude: numOrNull(req.body.longitude),
    tags,
  };

  const sql = `
    UPDATE leads SET
      name            = COALESCE($2,  name),
      email           = COALESCE($3,  email),
      company         = COALESCE($4,  company),
      website         = COALESCE($5,  website),
      city            = COALESCE($6,  city),
      state           = COALESCE($7,  state),
      status          = COALESCE($8,  status),
      industry        = COALESCE($9,  industry),
      forecast_month  = COALESCE($10, forecast_month),
      lead_type       = COALESCE($11, lead_type),
      arr             = COALESCE($12, arr),
      ap_spend        = COALESCE($13, ap_spend),
      tags            = COALESCE($14, tags),
      notes           = COALESCE($15, notes),
      latitude        = COALESCE($16, latitude),
      longitude       = COALESCE($17, longitude),
      updated_at      = NOW()
    WHERE id = $1
    RETURNING *;
  `;

  const params = [
    id,
    payload.name,                          // $2
    payload.email,                         // $3
    payload.company,                       // $4
    payload.website,                       // $5
    payload.city,                          // $6
    payload.state,                         // $7
    payload.status,                        // $8
    payload.industry,                      // $9
    payload.forecast_month,                // $10
    payload.lead_type,                     // $11
    payload.arr,                           // $12
    payload.ap_spend,                      // $13
    payload.tags,                          // $14
    payload.notes,                         // $15
    payload.latitude,                      // $16
    payload.longitude,                     // $17
  ];

  try {
    // 1) Read previous status before update
    const { rows: beforeRows } = await pool.query(
      'SELECT status FROM leads WHERE id = $1',
      [id]
    );
    if (!beforeRows.length) {
      return res.status(404).json({ error: 'Lead not found', id });
    }
    const oldStatus = beforeRows[0].status || null;

    // 2) Run the update
    const { rows } = await pool.query(sql, params);
    if (!rows.length) {
      return res.status(404).json({ error: 'Lead not found', id });
    }

    const lead = rows[0];

    // 3) If status actually changed, log into lead_status_history
    if (payload.status != null) {
      const prevNorm = (oldStatus || '').toLowerCase();
      const newNorm = (lead.status || '').toLowerCase();
      if (prevNorm !== newNorm) {
        const historySql = `
          INSERT INTO lead_status_history
            (lead_id, old_status, new_status, changed_at, changed_by, note)
          VALUES ($1, $2, $3, NOW(), $4, $5);
        `;
        await pool.query(historySql, [
          id,
          oldStatus || null,
          lead.status || null,
          null,                 // changed_by (null for now)
          payload.notes || null,
        ]);
      }
    }

    // 4) Clean status for frontend (replace underscores with dashes)
    if (typeof lead.status === 'string') {
      lead.status = lead.status.replace(/_/g, '-');
    }

    return res.json(lead);
  } catch (err) {
    console.error('PUT /update-lead error:', err);
    return res
      .status(500)
      .json({ error: 'Failed to update lead', details: err.message });
  }
});



// --- DELETE A LEAD ---
// DELETE /leads/:id – permanently remove a single lead
// (activities etc. will be removed automatically if your FKs use ON DELETE CASCADE)
app.delete('/leads/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid id' });
  }

  try {
    const result = await pool.query(
      'DELETE FROM leads WHERE id = $1 RETURNING id, name, company',
      [id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Lead not found' });
    }

    return res.json({ ok: true, deleted: result.rows[0] });
  } catch (err) {
    console.error('DELETE /leads/:id error', err);
    return res
      .status(500)
      .json({ error: 'Failed to delete lead', detail: err.message });
  }
});

// --- UPDATE ONLY TAGS FOR A LEAD ---
// PUT /leads/:id/tags
app.put('/leads/:id/tags', async (req, res) => {
  const id = req.params.id;
  const { tags } = req.body;

  if (!id) {
    return res.status(400).json({ error: "Lead ID is required" });
  }

  try {
    const result = await pool.query(
      `
      UPDATE leads
      SET tags = $1,
          updated_at = NOW()
      WHERE id = $2
      RETURNING id, tags;
      `,
      [
        // tags should be stored as an array (text[])
        Array.isArray(tags)
          ? tags.map((t) => t.trim()).filter(Boolean)
          : String(tags || "")
              .split(",")
              .map((t) => t.trim())
              .filter(Boolean),
        id
      ]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Lead not found" });
    }

    return res.json({
      success: true,
      lead: result.rows[0]
    });
  } catch (err) {
    console.error("Error updating tags:", err);
    return res.status(500).json({ error: "Failed to update tags" });
  }
});


// --- BULK DELETE ALL LEADS ---
// POST /leads/bulk-delete – dangerous: wipes ALL leads
app.post('/leads/bulk-delete', async (req, res) => {
  const { confirm } = req.body || {};

  // Simple safety check so we don't delete by accident
  if (confirm !== 'DELETE') {
    return res.status(400).json({
      error: 'Missing or invalid confirm token. Pass { "confirm": "DELETE" } to bulk delete.'
    });
  }
  

  try {
    const result = await pool.query('DELETE FROM leads');
    // If your foreign keys use ON DELETE CASCADE, related activities etc. will go too
    return res.json({ ok: true, deleted: result.rowCount });
  } catch (err) {
    console.error('POST /leads/bulk-delete error', err);
    return res
      .status(500)
      .json({ error: 'Failed to bulk delete leads', detail: err.message });
  }
});

// --- BULK DELETE FILTERED LEADS (SAFE MODE) ---
// POST /leads/bulk-delete-by-ids – deletes only the IDs you send
app.post('/leads/bulk-delete-by-ids', async (req, res) => {
  try {
    let { ids } = req.body || {};

    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'No lead IDs provided.' });
    }

    // Coerce to integers and drop anything invalid
    ids = ids
      .map((id) => Number(id))
      .filter((n) => Number.isInteger(n));

    if (ids.length === 0) {
      return res.status(400).json({ error: 'No valid numeric IDs provided.' });
    }

    const result = await pool.query(
      'DELETE FROM leads WHERE id = ANY($1::int[])',
      [ids]
    );

    return res.json({ ok: true, deleted: result.rowCount });
  } catch (err) {
    console.error('POST /leads/bulk-delete-by-ids error', err);
    return res
      .status(500)
      .json({ error: 'Failed to bulk delete selected leads', detail: err.message });
  }
});




// === ONE-BY-ONE LEAD GEO-CODING ROUTE ===
app.post('/leads/:id/geocode', async (req, res) => {
  const id = req.params.id;

  try {
    // 1. Load the lead
    const result = await pool.query(
      `
      SELECT id, company, city, state, latitude, longitude
      FROM leads
      WHERE id = $1
      `,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Lead not found' });
    }

    const lead = result.rows[0];

    // 2. Normalize fields
    const norm = (v) => {
      if (!v) return null;
      const s = String(v).trim();
      return s === '' ? null : s;
    };

    const company = norm(lead.company);
    const city    = norm(lead.city);
    const state   = norm(lead.state);

    if (!company && !city && !state) {
      // Truly nothing to geocode with
      return res.status(400).json({
        success: false,
        error: 'Lead has no location data (company/city/state all empty)',
        code: 'NO_LOCATION_DATA'
      });
    }

    // 3. Call geocoder (will try multiple query shapes)
    const geo = await geocodeOne({ company, city, state });

    if (!geo) {
      // No result from Nominatim — log but don't crash the app
      console.warn('Geocode: no result for lead', id, {
        company,
        city,
        state,
      });

      // If you have these columns, keep them updated; if not, you can drop this block
      try {
        await pool.query(
          `
          UPDATE leads
          SET geocode_status = 'error',
              geocode_error  = 'No result from geocoder',
              updated_at     = NOW()
          WHERE id = $1
          `,
          [id]
        );
      } catch (e) {
        console.warn('Geocode: could not update geocode_status for lead', id, e.message);
      }

      // Use 422 to indicate "valid request, but we could not find a location"
      return res.status(422).json({
        success: false,
        error: 'No geocode result for this lead'
      });
    }

    // 4. Save new lat/lng
    const update = await pool.query(
      `
      UPDATE leads
      SET latitude       = $1,
          longitude      = $2,
          geocode_status = 'ok',
          geocode_error  = NULL,
          updated_at     = NOW()
      WHERE id = $3
      RETURNING id, company, city, state, latitude, longitude, geocode_status
      `,
      [geo.lat, geo.lon, id]
    );

    const updatedLead = update.rows[0];

    return res.json({
      success: true,
      lead: updatedLead
    });
  } catch (err) {
    console.error('Geocode single lead error:', err);

    try {
      await pool.query(
        `
        UPDATE leads
        SET geocode_status = 'error',
            geocode_error  = $1,
            updated_at     = NOW()
        WHERE id = $2
        `,
        [err.message || 'Unknown geocode error', id]
      );
    } catch (e) {
      console.warn('Geocode: secondary update failed for lead', id, e.message);
    }

    return res.status(500).json({
      success: false,
      error: 'Unexpected error during geocode',
      details: err.message
    });
  }
});



// === ON-DEMAND GEO-CODER ROUTE ===
// Hit this from the List View "Geocode All Missing" button
app.post('/geocode/missing', async (req, res) => {
  try {
    // Accept from body (preferred) OR fallback to querystring if needed
    const rawLimit  = (req.body && req.body.limit)   ?? req.query.limit;
    const rawDelay  = (req.body && req.body.delayMs) ?? req.query.delayMs;

    const limit   = rawLimit ? Number(rawLimit) : 25;
    const delayMs = rawDelay ? Number(rawDelay) : 1000;

    console.log('🌎 Bulk geocode requested', { limit, delayMs });

    const result = await geocodeMissingLeads({ limit, delayMs });

    return res.json({
      ok: true,
      result
    });
  } catch (e) {
    console.error('Geocode error:', e);
    return res.status(500).json({ ok: false, error: 'geocode_failed' });
  }
});

// --- SERVER STARTUP ---
const PORT = process.env.PORT || process.env.PORT0 || 8080;

app.listen(PORT, () => {
  console.log(`✅ Deli 2.0 backend listening on port ${PORT}`);
});



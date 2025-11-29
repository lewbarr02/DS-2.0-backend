// index.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const multer = require('multer');
const { parse } = require('csv-parse');
const path = require('path');
const app = express();
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
const CONTACT_EMAIL = process.env.NOMINATIM_EMAIL || 'lewis.barr@finexio.com';
const USER_AGENT = process.env.NOMINATIM_USER_AGENT || `DeliSandwich/1.0 (${CONTACT_EMAIL})`;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// --- Query-param Boolean helper ---
function qpBool(v, def = true) {
  if (v === undefined || v === null || v === '') return def;
  const s = String(v).toLowerCase();
  return s === '1' || s === 'true' || s === 'yes';
}
// leads | accounts
function qpCountMode(v) {
  const s = String(v || 'leads').toLowerCase();
  return s === 'accounts' ? 'accounts' : 'leads';
}


// === SINGLE ADDRESS GEOCODER ===
// Calls OpenStreetMap Nominatim and returns { lat, lon } or null
async function geocodeOne({ company, city, state }) {
  try {
    // Build the query string
    const qParts = [company, city, state].filter(Boolean);
    const query = encodeURIComponent(qParts.join(', '));

    const url = `${NOMINATIM_BASE}?format=json&q=${query}&limit=1&addressdetails=0&email=${encodeURIComponent(CONTACT_EMAIL)}`;
    const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const results = await response.json();
    if (!Array.isArray(results) || results.length === 0) return null;

    const { lat, lon } = results[0];
    if (!lat || !lon) return null;

    return { lat: parseFloat(lat), lon: parseFloat(lon) };
  } catch (err) {
    console.error('geocodeOne() failed:', err.message);
    return null;
  }
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

// === SUMMARY DASHBOARD (Finexio BDR Traction Engine) ===
// GET /summary?from=YYYY-MM-DD&to=YYYY-MM-DD&pinned_only=1&count_mode=leads|accounts
app.get('/summary', async (req, res) => {
  let client;
  try {
    client = await pool.connect();

    const { from, to } = req.query;
    const pinnedOnly = qpBool(req.query.pinned_only, true);
    const countMode  = qpCountMode(req.query.count_mode);

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
    const actSql = `
      SELECT id, lead_id, happened_at, type
      FROM activities
      WHERE happened_at >= $1::date
        AND happened_at <  $2::date
      ORDER BY happened_at ASC
    `;
    const { rows: activities } = await client.query(actSql, [fromStr, toStr]);

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
        OR id = ANY($3::int[])
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
    if (pinnedOnly) {
      leadsFiltered = leadsFiltered.filter(
        (l) => l.latitude != null && l.longitude != null
      );
    }

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
    const histSql = `
      SELECT h.lead_id, h.old_status, h.new_status, h.changed_at,
             l.state, l.ap_spend
      FROM lead_status_history h
      JOIN leads l ON l.id = h.lead_id
      WHERE h.changed_at >= $1::date
        AND h.changed_at <  $2::date
    `;
    const { rows: historyRows } = await client.query(histSql, [fromStr, toStr]);

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

    // ----- Assemble payload -----
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

    return res.json({
      ok: true,
      range: { from: fromStr, to: toStr },
      metrics,
      unplaced_count: unplacedCount,
      leads: leadsFiltered
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

// POST /api/daily-queue/generate
// Body: { batch_size?: number, industries?: string[] }
app.post('/api/daily-queue/generate', async (req, res) => {
  const rawSize = req.body?.batch_size;
  const size = normalizeBatchSize(rawSize);
  const industries = Array.isArray(req.body?.industries)
    ? req.body.industries.filter(Boolean)
    : [];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1) Pick candidate leads according to priority rules
    const params = [size];
    let industryFilterSql = '';
    if (industries.length) {
      params.push(industries);
      industryFilterSql = 'AND l.industry = ANY($2)';
    }

    const pickSql = `
      WITH candidate AS (
        SELECT
          l.*,
          CASE
            WHEN LOWER(COALESCE(l.status, '')) = 'hot'         THEN 1
            WHEN LOWER(COALESCE(l.status, '')) = 'warm'        THEN 2
            WHEN LOWER(COALESCE(l.status, '')) = 'unspecified' THEN 3
            WHEN LOWER(COALESCE(l.status, '')) = 'follow-up'   THEN 4
            WHEN LOWER(COALESCE(l.status, '')) = 'research'    THEN 5
            WHEN LOWER(COALESCE(l.status, '')) = 'cold'        THEN 6
            ELSE 7
          END AS status_rank,
          CASE
            WHEN l.next_touch_at IS NOT NULL AND l.next_touch_at <= NOW() THEN 0
            WHEN l.last_touch_at IS NULL                                  THEN 1
            WHEN l.last_touch_at <= NOW() - INTERVAL '4 days'            THEN 2
            ELSE 3
          END AS touch_rank
        FROM leads l
        WHERE COALESCE(l.is_retired, false) = false
          AND LOWER(COALESCE(l.status, '')) NOT IN ('converted','no fit','no_fit')
          ${industryFilterSql}

      )
      SELECT *
      FROM candidate
      ORDER BY
        status_rank ASC,
        touch_rank ASC,
        COALESCE(last_touch_at, '1970-01-01'::timestamptz) ASC
      LIMIT $1;
    `;

    const { rows: picked } = await client.query(pickSql, params);
    if (!picked.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        ok: false,
        error: 'no_candidates',
        message: 'No eligible leads found for a new daily queue.',
      });
    }

    const requestedSize = size;
    const actualSize = picked.length;

    // 2) Create batch row
    const batchSql = `
      INSERT INTO daily_batches (batch_date, batch_size)
      VALUES (CURRENT_DATE, $1)
      RETURNING id, created_at, batch_date, batch_size, is_completed;
    `;

    const { rows: batchRows } = await client.query(batchSql, [requestedSize]);
    const batch = batchRows[0];

    // 3) Insert items
    const itemSql = `
      INSERT INTO daily_batch_items (batch_id, lead_id, position)
      VALUES ($1, $2, $3)
      RETURNING id, batch_id, lead_id, position, is_completed, is_skipped;
    `;
    const items = [];
    for (let i = 0; i < picked.length; i++) {
      const lead = picked[i];
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
      // fallback for “Last touch” if needed
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
    return res.status(500).json({ ok: false, error: 'generate_failed' });
  } finally {
    client.release();
  }
});

// GET /api/daily-queue/current
app.get('/api/daily-queue/current', async (_req, res) => {
  const client = await pool.connect();
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
    action_type,       // "call" | "email" | "social"
    notes,
    next_touch_choice, // "tomorrow" | "3_days" | "next_week" | "later_this_month" | "custom"
    next_touch_at,     // only used when choice === "custom"
  } = req.body || {};

  const client = await pool.connect();

  // We'll compute an activity payload but insert it *after* the main transaction
  let activityPayload = null;

  try {
    await client.query('BEGIN');

    // 1) Load item + lead (lock row for this item)
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

    // 2) Compute next_touch_at (explicit date → choice → offset)
    let nextTouch = null;

    if (next_touch_at) {
      // Custom date string from the UI, e.g. "2025-11-30"
      const d = new Date(next_touch_at);
      if (!Number.isNaN(d.getTime())) {
        nextTouch = d;
      }
    } else if (next_touch_choice) {
      const base = new Date();
      base.setHours(12, 0, 0, 0);

      let offsetDays = 0;
      switch (next_touch_choice) {
        case 'tomorrow':
          offsetDays = 1;
          break;
        case '3_days':
          offsetDays = 3;
          break;
        case 'next_week':
          offsetDays = 7;
          break;
        case 'later_this_month':
          offsetDays = 14;
          break;
        case 'custom':
          // handled above via next_touch_at
          offsetDays = 0;
          break;
        default:
          offsetDays = 0;
      }

      if (offsetDays > 0) {
        base.setDate(base.getDate() + offsetDays);
        nextTouch = base;
      }
    }

    // 3) Update lead status / retirement / touch dates
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

    // 4) Prepare activity payload (we'll insert after COMMIT)
    if (action_type) {
      activityPayload = {
        lead_id: item.lead_id,
        activity_type: action_type,
        notes: notes || null,
        status_before: oldStatus || null,
        status_after: newStatus || null,
      };
    }

    // 5) Insert into lead_status_history if status changed
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

    // 6) Mark batch item as completed
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

    // 7) If all items are done/skipped, close the batch
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

    // 8) Best-effort: log activity AFTER COMMIT so it can't break Done flow
    if (activityPayload) {
      const pieces = [];

      // Activity type label (CALL / EMAIL / SOCIAL)
      if (activityPayload.activity_type) {
        const typeLabel = activityPayload.activity_type.toString().toUpperCase();
        pieces.push(typeLabel);
      }

      // Status change (warm → hot)
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

      // Short notes snippet
      if (activityPayload.notes) {
        const trimmed = activityPayload.notes.length > 80
          ? activityPayload.notes.slice(0, 77) + '...'
          : activityPayload.notes;
        pieces.push(`“${trimmed}”`);
      }

      const summary = pieces.join(' — ');

      // 🔹 Match your actual activities schema:
      // id | created_at | lead_id | happened_at | type | summary | meta
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
        // Do NOT throw – the Done operation already succeeded
      }
	 } // <-- close if (activityPayload)


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
const OPTIONAL_HEADERS = [
  'email',
  'industry','owner','city','state','status','tags','cadence name','source','source channel',
  'conversion stage','arr','ap spend','size','obstacle','net new','self sourced','engagement score',
  'last contacted at','next action at','last status change','notes','latitude','longitude',
  'forecast month','lead type','website'
];

const ALL_HEADERS = [...REQUIRED_HEADERS, ...OPTIONAL_HEADERS];

// Map CSV -> DB columns
const FIELD_MAP = {
  'name'          : 'name',
  'email'         : 'email',
  'company'       : 'company',
  'industry'      : 'industry',
  'owner'         : 'owner',
  'city'          : 'city',
  'state'         : 'state',
  'status'        : 'status',
  'tags'          : 'tags',
  'cadence name'  : 'cadence_name',
  'source'        : 'source',
  'source channel': 'source_channel',
  'conversion stage': 'conversion_stage',
  'arr'           : 'arr',
  'ap spend'      : 'ap_spend',
  'size'          : 'size',
  'obstacle'      : 'obstacle',
  'net new'       : 'net_new',
  'self sourced'  : 'self_sourced',
  'engagement score': 'engagement_score',
  'last contacted at': 'last_contacted_at',
  'next action at': 'next_action_at',
  'last status change': 'last_status_change',
  'notes'         : 'notes',
  'latitude'      : 'latitude',
  'longitude'     : 'longitude',
  'forecast month': 'forecast_month',
  'lead type'     : 'lead_type',
  'website'       : 'website'
};


// --- Status normalization ---
const ALLOWED_STATUS = new Set([
  'converted','hot','warm','cold','research','follow-up','unspecified'
]);

function normalizeStatus(v) {
  const s = (v ?? '').toString().trim().toLowerCase();
  const aliases = {
    'wam': 'warm',
    'wrm': 'warm',
    'w': 'warm',
    'h': 'hot',
    'c': 'cold',
    'r': 'research',
    'prospect': 'research',
    'followup': 'follow-up',
    'follow up': 'follow-up',
    '': 'unspecified'
  };
  const mapped = aliases[s] || s;
  return ALLOWED_STATUS.has(mapped) ? mapped : 'unspecified';
}

// Parse money-ish input like "25000000", "25M", "2.5m", "10k", "1B"
function parseShortMoney(v) {
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

// CSV helper now just delegates to the new parser
function toNumber(v) {
  return parseShortMoney(v);
}

function toBool(v) {
  if (v == null) return false;
  const s = String(v).trim().toLowerCase();
  return ['true','yes','y','1','t'].includes(s);
}
function toDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}



// storage in memory is fine for <10MB CSVs; switch to disk if needed
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

/** Normalize a single CSV row into DB-ready shape */
function normalizeRow(rowObj) {
  const obj = {};
  // copy mapped fields, trimming strings
  for (const [csvKey, dbKey] of Object.entries(FIELD_MAP)) {
    const v = rowObj[csvKey] ?? rowObj[String(csvKey).toLowerCase()];
    if (v === undefined) continue;

    if (dbKey === 'tags') {
      // split on comma or semicolon into text[]
      if (typeof v === 'string' && v.trim() !== '') {
        obj.tags = v.split(/[;,]/g).map(s => s.trim()).filter(Boolean);
      } else {
        obj.tags = []; // never null
      }
    } else if (['arr','ap_spend','engagement_score'].includes(dbKey)) {
      obj[dbKey] = toNumber(v);
    } else if (['latitude','longitude'].includes(dbKey)) {
      const num = String(v).trim();
      obj[dbKey] = num === '' || isNaN(Number(num)) ? null : Number(num);
    } else if (['net_new','self_sourced'].includes(dbKey)) {
      obj[dbKey] = toBool(v);
    } else if (['last_contacted_at','next_action_at','last_status_change'].includes(dbKey)) {
      obj[dbKey] = toDate(v);
    } else {
      const s = typeof v === 'string' ? v.trim() : v;
      obj[dbKey] = s === '' ? null : s;
    }
  }

  // enforce required
  if (!obj.name || !obj.company) {
    throw new Error('Missing required fields: name, company');
  }

  // status cleanup if present
  if (obj.status) obj.status = normalizeStatus(obj.status);

  return obj;
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


// Upload & import
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
        const values = [
          r.name ?? null,
          r.email ?? null,
          r.company ?? null,
          r.industry ?? null,
          r.owner ?? null,
          r.city ?? null,
          r.state ?? null,
          normalizeStatus(r.status),
          Array.isArray(r.tags) ? r.tags : [],
          r.cadence_name ?? null,
          r.source ?? 'csv-import',
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
      return res.status(500).json({
        error: err.message || 'Import failed during database transaction.',
        detail: err.detail, code: err.code, hint: err.hint, position: err.position
      });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('IMPORT ERR:', err);
    return res.status(400).json({ error: err.message, detail: err.detail, code: err.code });
  }
});


// --- UPDATE A LEAD (Safe UPSERT; now logs status history) ---
// PUT /update-lead/:id  — update a single lead, log status change, and return the updated row
app.put('/update-lead/:id', async (req, res) => {
  const id = req.params.id;

  // Helpers
  const strOrNull = (v) =>
    v === '' || v == null ? null : String(v);
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







// === ON-DEMAND GEO-CODER ROUTE ===
// lets you hit it manually from Postman or a button later
app.post('/geocode/missing', async (req, res) => {
  try {
    const { limit = 25, delayMs = 1000 } = req.body || {};
    const result = await geocodeMissingLeads({ limit, delayMs });
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('Geocode error:', e);
    res.status(500).json({ ok: false, error: 'geocode_failed' });
  }
});


// --- LOCAL DEV PORT / RAILWAY PORT ---
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`[DS] Listening on :${PORT}`);
});

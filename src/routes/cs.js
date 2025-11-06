// src/routes/cs.js
const express = require('express');
const { pool } = require('../../db'); // keep as-is if file lives in root

const cs = express.Router();

// GET /api/cs/accounts
cs.get('/accounts', async (_req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT id, name, city, state, csm_owner
      FROM accounts
      WHERE is_active = TRUE
      ORDER BY name
    `);
    res.json({ items: result.rows });
  } catch (e) {
    next(e);
  }
});

// POST /api/cs/touchpoints
cs.post('/touchpoints', async (req, res, next) => {
  try {
    const { account_id, date, channel, summary, next_step, next_step_due, created_by } = req.body;
    const result = await pool.query(
      `INSERT INTO touchpoints
        (account_id, date, channel, summary, next_step, next_step_due, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [account_id, date, channel, summary, next_step, next_step_due, created_by]
    );
    res.status(201).json(result.rows[0]);
  } catch (e) {
    next(e);
  }
});

// POST /api/cs/signals
cs.post('/signals', async (req, res, next) => {
  try {
    const { account_id, type, tag, context, source, severity, created_by } = req.body;
    const result = await pool.query(
      `INSERT INTO signals
        (account_id, type, tag, context, source, severity, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [account_id, type, tag, context, source, severity, created_by]
    );
    res.status(201).json(result.rows[0]);
  } catch (e) {
    next(e);
  }
});

// GET /api/cs/accounts/:id/timeline
cs.get('/accounts/:id/timeline', async (req, res, next) => {
  try {
    const { id } = req.params;
    const sql = `
      SELECT 'touch' AS kind, t.created_at AS ts, t.summary, t.channel::text AS meta, t.next_step, t.next_step_due
        FROM touchpoints t WHERE t.account_id = $1
      UNION ALL
      SELECT 'signal' AS kind, s.created_at AS ts, s.context AS summary, s.type::text AS meta, NULL::text AS next_step, NULL::date AS next_step_due
        FROM signals s WHERE s.account_id = $1
      ORDER BY ts DESC
      LIMIT 200
    `;
    const { rows } = await pool.query(sql, [id]);
    res.json({ items: rows });
  } catch (e) {
    next(e);
  }
});


module.exports = { cs };

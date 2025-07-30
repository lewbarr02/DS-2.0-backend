
require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Root route
app.get('/', (req, res) => {
  res.send('Deli Sandwich API is running!');
});

// Get all leads
app.get('/leads', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM leads ORDER BY id DESC');
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching leads:', err);
    res.status(500).json({ error: 'Failed to fetch leads' });
  }
});

// Post a new lead
app.post('/leads', async (req, res) => {
  const {
    name, city, state, company, tags, cadence, notes,
    website, status, net_new, size, arr, obstacle, self_sourced
  } = req.body;

  try {
    const result = await pool.query(
      `INSERT INTO leads (
        name, city, state, company, tags, cadence, notes,
        website, status, net_new, size, arr, obstacle, self_sourced
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      RETURNING *`,
      [name, city, state, company, tags, cadence, notes,
        website, status, net_new, size, arr, obstacle, self_sourced]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error inserting lead:', err);
    res.status(500).json({ error: 'Failed to insert lead' });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log('Deli Sandwich API is running!');
  console.log(`Server running on port ${PORT}`);
});

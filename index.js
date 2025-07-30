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

// Simple test route
app.get('/', (req, res) => {
  res.send('Deli Sandwich API is running!');
});

// Get all leads
app.get('/leads', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM leads ORDER BY id DESC');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

// Add a new lead
app.post('/leads', async (req, res) => {
  const { name, company, arr, lifecycle_stage } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO leads (name, company, arr, lifecycle_stage) VALUES ($1, $2, $3, $4) RETURNING *',
      [name, company, arr, lifecycle_stage]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
// trigger redeploy
\n// really force deploy now

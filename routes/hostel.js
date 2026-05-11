const express = require('express');
const router = express.Router();
const db = require('../db');
router.get('/', async (req, res) => {
  const [rooms] = await db.query('SELECT * FROM hostel_rooms WHERE is_active=1');
  res.render('hostel/index', { title: 'Hostel', activePage: 'hostel', rooms });
});
module.exports = router;

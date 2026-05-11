const express = require('express');
const router = express.Router();
const db = require('../db');
router.get('/', async (req, res) => {
  const [routes] = await db.query('SELECT * FROM transport_routes WHERE is_active=1');
  const [vehicles] = await db.query('SELECT * FROM transport_vehicles WHERE is_active=1');
  res.render('transport/index', { title: 'Transport', activePage: 'transport', routes, vehicles });
});
module.exports = router;

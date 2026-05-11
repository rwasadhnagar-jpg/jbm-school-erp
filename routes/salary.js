const express = require('express');
const router = express.Router();
const db = require('../db');
router.get('/', async (req, res) => {
  const [payments] = await db.query(
    `SELECT sp.*, s.first_name, s.last_name FROM salary_payments sp
     LEFT JOIN staff s ON sp.staff_id=s.id ORDER BY sp.year DESC, sp.month DESC LIMIT 50`
  );
  res.render('salary/index', { title: 'Salary Management', activePage: 'salary', payments });
});
module.exports = router;

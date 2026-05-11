const express = require('express');
const router = express.Router();
const db = require('../db');

router.get('/', async (req, res) => {
  try {
    const { search, staff_type } = req.query;
    let q = 'SELECT * FROM staff WHERE 1=1';
    const p = [];
    if (search) { q += ' AND (first_name LIKE ? OR last_name LIKE ? OR designation LIKE ?)'; p.push(`%${search}%`,`%${search}%`,`%${search}%`); }
    if (staff_type) { q += ' AND staff_type = ?'; p.push(staff_type); }
    q += ' AND is_active=1 ORDER BY first_name';
    const [staff] = await db.query(q, p);
    const [[{ total }]] = await db.query("SELECT COUNT(*) as total FROM staff WHERE is_active=1");
    res.render('staff/list', { title: 'Staff Management', activePage: 'staff', staff, total, search, staff_type });
  } catch (err) {
    console.error(err);
    res.render('staff/list', { title: 'Staff Management', activePage: 'staff', staff: [], total: 0, search: '', staff_type: '' });
  }
});

router.get('/add', (req, res) => {
  res.render('staff/add', { title: 'Add Staff', activePage: 'staff' });
});

router.post('/add', async (req, res) => {
  try {
    const b = req.body;
    await db.query(
      `INSERT INTO staff (first_name, last_name, gender, dob, email, phone, designation, department,
        staff_type, employment_type, role, joining_date, aadhar_no, pan_no, qualification, address)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [b.first_name, b.last_name, b.gender||null, b.dob||null, b.email||null, b.phone||null,
       b.designation||null, b.department||null, b.staff_type||'Teaching',
       b.employment_type||'Permanent', b.role||null, b.joining_date||null,
       b.aadhar_no||null, b.pan_no||null, b.qualification||null, b.address||null]
    );
    req.flash('success', `Staff ${b.first_name} ${b.last_name} added successfully`);
    res.redirect('/teachers');
  } catch (err) {
    req.flash('error', 'Failed to add staff: ' + err.message);
    res.redirect('/teachers/add');
  }
});

module.exports = router;

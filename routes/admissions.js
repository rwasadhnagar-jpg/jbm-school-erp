const express = require('express');
const router = express.Router();
const db = require('../db');

router.get('/', async (req, res) => {
  const [admissions] = await db.query('SELECT * FROM admissions ORDER BY created_at DESC LIMIT 50');
  res.render('admissions/index', { title: 'Admissions', activePage: 'admission', admissions });
});

router.get('/add', (req, res) => res.render('admissions/add', { title: 'New Enquiry', activePage: 'admission' }));

router.post('/add', async (req, res) => {
  const b = req.body;
  const enquiryNo = 'ENQ' + Date.now();
  await db.query(
    `INSERT INTO admissions (enquiry_no,student_name,class_applied,father_name,father_mobile,mother_name,email,address,enquiry_date,status,remarks)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [enquiryNo,b.student_name,b.class_applied||null,b.father_name||null,b.father_mobile||null,
     b.mother_name||null,b.email||null,b.address||null,b.enquiry_date||null,'Enquiry',b.remarks||null]
  );
  req.flash('success', 'Enquiry registered: ' + enquiryNo);
  res.redirect('/registration');
});

module.exports = router;

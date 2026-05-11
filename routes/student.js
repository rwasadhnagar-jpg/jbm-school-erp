const express = require('express');
const router = express.Router();
const db = require('../db');

const requireStudent = (req, res, next) => {
  if (!req.session.student) return res.redirect('/portal/login');
  next();
};

// LOGIN PAGE
router.get('/login', (req, res) => {
  if (req.session.student) return res.redirect('/portal/dashboard');
  res.render('student/login', { title: 'Student Portal — JBM School', error: req.flash('error'), success: req.flash('success') });
});

// LOGIN POST
router.post('/login', async (req, res) => {
  try {
    const { admission_no, dob } = req.body;
    if (!admission_no || !dob) {
      req.flash('error', 'Please enter Admission Number and Date of Birth');
      return res.redirect('/portal/login');
    }

    const [[student]] = await db.query(
      `SELECT s.*, c.class_name, c.section
       FROM students s
       LEFT JOIN classes c ON s.class_id = c.id
       WHERE s.admission_no = ? AND s.status = 'active'`,
      [admission_no.trim()]
    );

    if (!student) {
      req.flash('error', 'Admission number not found or student is inactive');
      return res.redirect('/portal/login');
    }

    // Check DOB matches
    const dbDob = student.dob ? new Date(student.dob).toISOString().split('T')[0] : null;
    const inputDob = new Date(dob).toISOString().split('T')[0];

    if (!dbDob || dbDob !== inputDob) {
      req.flash('error', 'Date of Birth does not match our records');
      return res.redirect('/portal/login');
    }

    req.session.student = {
      id: student.id,
      admission_no: student.admission_no,
      name: `${student.first_name} ${student.last_name}`,
      class_name: student.class_name,
      section: student.section,
      dob: student.dob
    };

    res.redirect('/portal/dashboard');
  } catch (err) {
    console.error(err);
    req.flash('error', 'Login failed. Please try again.');
    res.redirect('/portal/login');
  }
});

// LOGOUT
router.get('/logout', (req, res) => {
  req.session.student = null;
  req.flash('success', 'Logged out successfully');
  res.redirect('/portal/login');
});

// DASHBOARD
router.get('/dashboard', requireStudent, async (req, res) => {
  try {
    const studentId = req.session.student.id;

    // Full student info
    const [[student]] = await db.query(
      `SELECT s.*, c.class_name, c.section
       FROM students s LEFT JOIN classes c ON s.class_id=c.id
       WHERE s.id=?`, [studentId]
    );

    // Parent info
    const [parents] = await db.query(
      'SELECT * FROM parents WHERE student_id=?', [studentId]
    );
    const father = parents.find(p => p.type === 'father');
    const mother = parents.find(p => p.type === 'mother');

    // Fee payments
    const [payments] = await db.query(
      `SELECT fp.*, u.name as collected_by_name
       FROM fee_payments fp
       LEFT JOIN users u ON fp.collected_by = u.id
       WHERE fp.student_id = ?
       ORDER BY fp.payment_date DESC`,
      [studentId]
    );

    const totalPaid = payments.reduce((sum, p) => sum + parseFloat(p.amount_paid || 0), 0);

    // Certificates / TCs issued to this student
    const [certs] = await db.query(
      `SELECT id, type, serial_no, issue_date FROM certificates WHERE student_id=? ORDER BY issue_date DESC`,
      [studentId]
    );

    res.render('student/dashboard', {
      title: 'My Portal — JBM School',
      student, father, mother, payments, totalPaid, certs,
      error: req.flash('error'),
      success: req.flash('success')
    });
  } catch (err) {
    console.error(err);
    res.redirect('/portal/login');
  }
});

// VIEW RECEIPT
router.get('/receipt/:payment_id', requireStudent, async (req, res) => {
  try {
    const [[payment]] = await db.query(
      `SELECT fp.*, s.first_name, s.last_name, s.admission_no,
              c.class_name, c.section,
              p.first_name as father_name,
              u.name as collected_by_name
       FROM fee_payments fp
       LEFT JOIN students s ON fp.student_id = s.id
       LEFT JOIN classes c ON s.class_id = c.id
       LEFT JOIN parents p ON s.id = p.student_id AND p.type='father'
       LEFT JOIN users u ON fp.collected_by = u.id
       WHERE fp.id = ? AND fp.student_id = ?`,
      [req.params.payment_id, req.session.student.id]
    );
    if (!payment) return res.redirect('/portal/dashboard');
    res.render('fees/receipt', { payment });
  } catch (err) {
    res.redirect('/portal/dashboard');
  }
});

module.exports = router;

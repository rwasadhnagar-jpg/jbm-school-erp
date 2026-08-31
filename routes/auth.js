const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../db');

// Ensure users table supports parent/student roles
(async () => {
  try {
    await db.query(`ALTER TABLE users MODIFY COLUMN role ENUM('admin','teacher','accountant','librarian','transport','parent','student') DEFAULT 'teacher'`);
  } catch(e) {}
})();

// ─── Staff/Admin Login Page ──────────────────────────────────────────────────
router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.render('auth/login', { title: 'Login', tab: 'staff' });
});

// ─── Parent Login Page ───────────────────────────────────────────────────────
router.get('/parent-login', (req, res) => {
  if (req.session.user && req.session.user.role === 'parent') return res.redirect('/portal/dashboard');
  res.render('auth/login', { title: 'Parent Login', tab: 'parent' });
});

// ─── Staff/Admin Login POST ──────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const [rows] = await db.query('SELECT * FROM users WHERE email = ? AND is_active = 1', [email]);
    if (!rows.length) {
      req.flash('error', 'Invalid email or password');
      return res.redirect('/login');
    }
    const user = rows[0];
    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      req.flash('error', 'Invalid email or password');
      return res.redirect('/login');
    }
    req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role, staff_id: user.staff_id };
    res.redirect('/dashboard');
  } catch (err) {
    console.error('LOGIN ERROR:', err.code, err.message);
    req.flash('error', 'Error: ' + err.message);
    res.redirect('/login');
  }
});

// ─── Parent Login POST ──────────────────────────────────────────────────────
router.post('/parent-login', async (req, res) => {
  const { admission_no, mobile } = req.body;
  try {
    if (!admission_no || !mobile) {
      req.flash('error', 'Please enter Admission Number and registered mobile number');
      return res.redirect('/parent-login');
    }

    // Find the student by admission number
    const [[student]] = await db.query(
      `SELECT s.id, s.admission_no, s.first_name, s.last_name, s.class_id, c.class_name, c.section
       FROM students s LEFT JOIN classes c ON s.class_id = c.id
       WHERE s.admission_no = ? AND s.status = 'active'`, [admission_no]
    );
    if (!student) {
      req.flash('error', 'No active student found with this admission number');
      return res.redirect('/parent-login');
    }

    // Verify parent mobile
    const [parents] = await db.query(
      `SELECT * FROM parents WHERE student_id = ? AND (mobile = ? OR sms_whatsapp_no = ?)`,
      [student.id, mobile, mobile]
    );
    if (!parents.length) {
      req.flash('error', 'Mobile number does not match our records');
      return res.redirect('/parent-login');
    }

    const parent = parents[0];

    // Find all children of this parent (by matching mobile across parents table)
    const [allChildren] = await db.query(
      `SELECT DISTINCT s.id, s.admission_no, s.first_name, s.last_name, s.class_id, c.class_name, c.section
       FROM parents p JOIN students s ON p.student_id = s.id LEFT JOIN classes c ON s.class_id = c.id
       WHERE (p.mobile = ? OR p.sms_whatsapp_no = ?) AND s.status = 'active'`,
      [mobile, mobile]
    );

    req.session.user = {
      id: parent.id,
      name: parent.first_name ? `${parent.first_name} ${parent.last_name || ''}`.trim() : 'Parent',
      role: 'parent',
      mobile: mobile,
      children: allChildren
    };
    res.redirect('/portal/dashboard');
  } catch (err) {
    console.error('PARENT LOGIN ERROR:', err.message);
    req.flash('error', 'Error: ' + err.message);
    res.redirect('/parent-login');
  }
});

router.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;

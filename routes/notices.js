const express = require('express');
const router = express.Router();
const db = require('../db');
const { sendPushToRole } = require('./notifications');

const STAFF_ROLES = ['teacher', 'accountant', 'librarian', 'transport'];
const STUDENT_ROLES = ['parent', 'student'];

router.get('/', async (req, res) => {
  const [notices] = await db.query('SELECT * FROM notices ORDER BY created_at DESC LIMIT 50');
  res.render('notices/index', { title: 'Notices', activePage: 'notices', notices });
});
router.get('/add', (req, res) => res.render('notices/add', { title: 'Add Notice', activePage: 'notices' }));
router.post('/add', async (req, res) => {
  const b = req.body;
  await db.query(
    `INSERT INTO notices (title,content,for_type,publish_date,expiry_date,created_by) VALUES (?,?,?,?,?,?)`,
    [b.title, b.content||null, b.for_type||'all', b.publish_date||null, b.expiry_date||null, req.session.user.id]
  );

  try {
    const roles = b.for_type === 'staff' ? STAFF_ROLES : b.for_type === 'student' ? STUDENT_ROLES : [...STAFF_ROLES, ...STUDENT_ROLES];
    const payload = { title: 'New Notice: ' + b.title, body: (b.content || '').slice(0, 150) };
    for (const role of roles) await sendPushToRole(role, payload);
  } catch (e) { console.error('notice push failed:', e.message); }

  req.flash('success', 'Notice added successfully');
  res.redirect('/notices');
});
module.exports = router;

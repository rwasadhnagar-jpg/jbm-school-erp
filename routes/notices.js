const express = require('express');
const router = express.Router();
const db = require('../db');
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
  req.flash('success', 'Notice added successfully');
  res.redirect('/notices');
});
module.exports = router;

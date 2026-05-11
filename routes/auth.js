const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../db');

router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.render('auth/login', { title: 'Login' });
});

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
    req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role };
    res.redirect('/dashboard');
  } catch (err) {
    console.error('LOGIN ERROR:', err.code, err.message, err.stack);
    req.flash('error', 'Error: ' + err.message);
    res.redirect('/login');
  }
});

router.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;

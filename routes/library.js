const express = require('express');
const router = express.Router();
const db = require('../db');
router.get('/', async (req, res) => {
  const [books] = await db.query('SELECT * FROM library_books WHERE is_active=1 ORDER BY title LIMIT 50');
  res.render('library/index', { title: 'Library', activePage: 'library', books });
});
module.exports = router;

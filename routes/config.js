const express = require('express');
const router = express.Router();
const db = require('../db');
const fs = require('fs');
const path = require('path');
const { runBackup, BACKUP_DIR } = require('../backup');

router.get('/', async (req, res) => {
  const [config] = await db.query('SELECT * FROM configuration');
  res.render('config/index', { title: 'Configuration', activePage: 'config', config });
});

router.post('/save', async (req, res) => {
  const entries = Object.entries(req.body);
  for (const [key, value] of entries) {
    await db.query('UPDATE configuration SET value=? WHERE key_name=?', [value, key]);
  }
  req.flash('success', 'Configuration saved');
  res.redirect('/configuration');
});

// Backup page
router.get('/backup', (req, res) => {
  let backups = [];
  if (fs.existsSync(BACKUP_DIR)) {
    backups = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.endsWith('.sql'))
      .map(f => {
        const stat = fs.statSync(path.join(BACKUP_DIR, f));
        return { name: f, size: (stat.size / 1024).toFixed(1), date: stat.mtime };
      })
      .sort((a, b) => b.date - a.date);
  }
  res.render('config/backup', { title: 'Database Backup', activePage: 'config', backups });
});

// Manual backup trigger
router.post('/backup/run', async (req, res) => {
  try {
    const file = await runBackup();
    req.flash('success', `✅ Backup created: ${file}`);
  } catch (e) {
    req.flash('error', 'Backup failed: ' + e.message);
  }
  res.redirect('/configuration/backup');
});

// Download a backup file
router.get('/backup/download/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);
  const filepath = path.join(BACKUP_DIR, filename);
  if (!fs.existsSync(filepath)) return res.status(404).send('File not found');
  res.download(filepath, filename);
});

// Delete a backup file
router.post('/backup/delete/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);
  const filepath = path.join(BACKUP_DIR, filename);
  if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
  req.flash('success', 'Backup deleted');
  res.redirect('/configuration/backup');
});

module.exports = router;

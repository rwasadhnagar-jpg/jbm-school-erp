const express = require('express');
const router = express.Router();
const db = require('../db');
const fs = require('fs');
const path = require('path');
const { runBackup, BACKUP_DIR } = require('../backup');

const RESET_PASSWORD = 'Alley@1508';

router.get('/', async (req, res) => {
  const [configRows] = await db.query('SELECT * FROM configuration ORDER BY id');
  // Separate into groups
  const schoolKeys = ['school_name','school_code','school_address','school_phone','school_email','academic_year','currency','date_format'];
  const paymentKeys = ['upi_id','upi_name','bank_name','account_holder','account_no','ifsc_code','branch_name','payment_note'];
  const config = {};
  configRows.forEach(r => config[r.key_name] = r.value);
  const schoolConfig = configRows.filter(r => schoolKeys.includes(r.key_name));
  const paymentConfig = configRows.filter(r => paymentKeys.includes(r.key_name));
  const otherConfig = configRows.filter(r => !schoolKeys.includes(r.key_name) && !paymentKeys.includes(r.key_name));
  res.render('config/index', {
    title: 'Configuration', activePage: 'config',
    config, schoolConfig, paymentConfig, otherConfig,
    success: req.flash('success'), error: req.flash('error')
  });
});

router.post('/save', async (req, res) => {
  const entries = Object.entries(req.body);
  for (const [key, value] of entries) {
    await db.query(
      'INSERT INTO configuration (key_name, value) VALUES (?,?) ON DUPLICATE KEY UPDATE value=?',
      [key, value, value]
    );
  }
  req.flash('success', 'Configuration saved successfully');
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
  res.render('config/backup', { title: 'Database Backup', activePage: 'backup', backups, success: req.flash('success'), error: req.flash('error') });
});

router.post('/backup/run', async (req, res) => {
  try {
    const file = await runBackup();
    req.flash('success', `✅ Backup created: ${file}`);
  } catch (e) {
    req.flash('error', 'Backup failed: ' + e.message);
  }
  res.redirect('/configuration/backup');
});

router.get('/backup/download/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);
  const filepath = path.join(BACKUP_DIR, filename);
  if (!fs.existsSync(filepath)) return res.status(404).send('File not found');
  res.download(filepath, filename);
});

router.post('/backup/delete/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);
  const filepath = path.join(BACKUP_DIR, filename);
  if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
  req.flash('success', 'Backup deleted');
  res.redirect('/configuration/backup');
});

// ── RESET DEMO DATA ────────────────────────────────────────────────────────────
router.post('/reset-demo', async (req, res) => {
  try {
    const { reset_password } = req.body;
    if (reset_password !== RESET_PASSWORD) {
      req.flash('error', 'Incorrect password. Reset cancelled.');
      return res.redirect('/configuration');
    }

    // Clear all transaction/demo data, preserve master data
    await db.query('SET FOREIGN_KEY_CHECKS=0');
    await db.query('TRUNCATE TABLE fee_payments');
    await db.query('TRUNCATE TABLE online_payments').catch(()=>{});
    await db.query('TRUNCATE TABLE attendance_student');
    await db.query('TRUNCATE TABLE attendance_staff');
    await db.query('TRUNCATE TABLE certificates');
    await db.query('TRUNCATE TABLE notices');
    await db.query('TRUNCATE TABLE leave_requests');
    await db.query('TRUNCATE TABLE admissions');
    await db.query('TRUNCATE TABLE salary_payments');
    await db.query('TRUNCATE TABLE sms_log');
    await db.query('TRUNCATE TABLE library_issues');
    await db.query('TRUNCATE TABLE accounts_transactions');
    await db.query('SET FOREIGN_KEY_CHECKS=1');

    req.flash('success', '✅ Demo data reset successfully. All transaction records cleared. Master data (students, classes, staff, config) preserved.');
    res.redirect('/configuration');
  } catch (err) {
    console.error(err);
    req.flash('error', 'Reset failed: ' + err.message);
    res.redirect('/configuration');
  }
});

module.exports = router;

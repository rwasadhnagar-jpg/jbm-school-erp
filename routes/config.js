const express = require('express');
const router = express.Router();
const db = require('../db');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const xlsxLib = require('xlsx');
const { runBackup, BACKUP_DIR } = require('../backup');

const importUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

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

// ── DATA IMPORT ────────────────────────────────────────────────────────────────
router.get('/import', (req, res) => {
  const academicYears = ['2021-2022','2022-2023','2023-2024','2024-2025','2025-2026','2026-2027'];
  res.render('config/import', {
    title: 'Import Data', activePage: 'config',
    academicYears,
    success: req.flash('success'), error: req.flash('error')
  });
});

// Import Students
router.post('/import/students', importUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) { req.flash('error', 'No file uploaded'); return res.redirect('/configuration/import'); }
    const wb = xlsxLib.read(req.file.buffer, { type: 'buffer', cellDates: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = xlsxLib.utils.sheet_to_json(ws, { defval: '' });
    if (!rows.length) { req.flash('error', 'File is empty'); return res.redirect('/configuration/import'); }

    const [classes] = await db.query('SELECT id, class_name, section FROM classes');
    const classMap = {};
    classes.forEach(c => {
      classMap[`${c.class_name}`.trim().toLowerCase()] = c.id;
      classMap[`${c.class_name}-${c.section}`.trim().toLowerCase()] = c.id;
      classMap[`${c.class_name} ${c.section}`.trim().toLowerCase()] = c.id;
    });

    let inserted = 0, skipped = 0, errors = [];
    for (const row of rows) {
      try {
        const admission_no = String(row['Admission No'] || row['AdmissionNo'] || row['admission_no'] || '').trim();
        const first_name   = String(row['First Name'] || row['FirstName'] || row['first_name'] || row['Name'] || '').trim();
        const last_name    = String(row['Last Name'] || row['LastName'] || row['last_name'] || '').trim();
        const gender       = String(row['Gender'] || row['gender'] || '').trim();
        const dob_raw      = row['DOB'] || row['Date of Birth'] || row['dob'] || '';
        const phone        = String(row['Phone'] || row['Mobile'] || row['phone'] || '').trim();
        const classRaw     = String(row['Class'] || row['class'] || row['Class Name'] || '').trim().toLowerCase();
        const father_name  = String(row['Father Name'] || row['FatherName'] || row['father_name'] || '').trim();
        const mother_name  = String(row['Mother Name'] || row['MotherName'] || row['mother_name'] || '').trim();
        const address      = String(row['Address'] || row['address'] || '').trim();

        if (!admission_no || !first_name) { skipped++; continue; }

        // Parse DOB — supports Date object, YYYY-MM-DD, DD/MM/YYYY, DD-MM-YYYY
        let dob = null;
        if (dob_raw) {
          if (dob_raw instanceof Date) {
            const d = dob_raw;
            dob = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
          } else {
            const s = String(dob_raw).trim();
            if (/^\d{4}-\d{2}-\d{2}/.test(s)) dob = s.substring(0, 10);
            else if (/^\d{2}[\/\-]\d{2}[\/\-]\d{4}$/.test(s)) {
              const [d2,m2,y2] = s.split(/[\/\-]/);
              dob = `${y2}-${m2}-${d2}`;
            }
          }
        }

        const class_id = classMap[classRaw] || null;
        const status = String(row['Status'] || 'active').toLowerCase() === 'active' ? 'active' : 'inactive';

        // Upsert student (insert or update if admission_no exists)
        const [existing] = await db.query('SELECT id FROM students WHERE admission_no=?', [admission_no]);
        if (existing.length) {
          await db.query(`UPDATE students SET first_name=?,last_name=?,gender=?,dob=?,phone=?,class_id=?,status=? WHERE admission_no=?`,
            [first_name, last_name||'', gender, dob, phone, class_id, status, admission_no]);
        } else {
          await db.query(`INSERT INTO students (admission_no,first_name,last_name,gender,dob,phone,class_id,status) VALUES (?,?,?,?,?,?,?,?)`,
            [admission_no, first_name, last_name||'', gender, dob, phone, class_id, status]);
        }
        // Insert father/mother
        const [[{id: sid}]] = await db.query('SELECT id FROM students WHERE admission_no=?', [admission_no]);
        if (father_name) {
          await db.query(`INSERT INTO parents (student_id,type,name,phone) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE name=?,phone=?`,
            [sid,'father',father_name,phone,father_name,phone]);
        }
        if (mother_name) {
          await db.query(`INSERT INTO parents (student_id,type,name) VALUES (?,?,?) ON DUPLICATE KEY UPDATE name=?`,
            [sid,'mother',mother_name,mother_name]);
        }
        if (address) {
          await db.query(`INSERT INTO student_addresses (student_id,present_address) VALUES (?,?) ON DUPLICATE KEY UPDATE present_address=?`,
            [sid, address, address]);
        }
        inserted++;
      } catch(e) {
        errors.push(`Row error: ${e.message}`);
        skipped++;
      }
    }
    req.flash('success', `✅ Students import done: ${inserted} added/updated, ${skipped} skipped${errors.length ? ` (${errors.length} errors)` : ''}`);
  } catch(e) {
    req.flash('error', 'Import failed: ' + e.message);
  }
  res.redirect('/configuration/import');
});

// Import Fee Payments (historical)
router.post('/import/fees', importUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) { req.flash('error', 'No file uploaded'); return res.redirect('/configuration/import'); }
    const wb = xlsxLib.read(req.file.buffer, { type: 'buffer', cellDates: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = xlsxLib.utils.sheet_to_json(ws, { defval: '' });
    if (!rows.length) { req.flash('error', 'File is empty'); return res.redirect('/configuration/import'); }

    const [[adminUser]] = await db.query('SELECT id FROM users WHERE role="admin" LIMIT 1');
    const adminId = adminUser ? adminUser.id : 1;

    let inserted = 0, skipped = 0;
    for (const row of rows) {
      try {
        const admission_no  = String(row['Admission No'] || row['AdmissionNo'] || row['admission_no'] || '').trim();
        const receipt_no    = String(row['Receipt No'] || row['ReceiptNo'] || row['receipt_no'] || '').trim();
        const amount        = parseFloat(row['Amount'] || row['amount'] || 0);
        const payment_mode  = String(row['Mode'] || row['Payment Mode'] || row['payment_mode'] || 'Cash').trim();
        const remarks       = String(row['Remarks'] || row['remarks'] || '').trim();
        let payment_date    = null;
        const d_raw         = row['Date'] || row['Payment Date'] || row['date'] || '';
        if (d_raw instanceof Date) {
          payment_date = `${d_raw.getFullYear()}-${String(d_raw.getMonth()+1).padStart(2,'0')}-${String(d_raw.getDate()).padStart(2,'0')}`;
        } else if (d_raw) {
          const s = String(d_raw).trim();
          if (/^\d{4}-\d{2}-\d{2}/.test(s)) payment_date = s.substring(0,10);
          else if (/^\d{2}[\/\-]\d{2}[\/\-]\d{4}$/.test(s)) {
            const [d2,m2,y2] = s.split(/[\/\-]/);
            payment_date = `${y2}-${m2}-${d2}`;
          }
        }

        if (!admission_no || !amount) { skipped++; continue; }

        const [[student]] = await db.query('SELECT id FROM students WHERE admission_no=?', [admission_no]);
        if (!student) { skipped++; continue; }

        const rec_no = receipt_no || `IMP-${admission_no}-${Date.now()}`;
        const [exist] = await db.query('SELECT id FROM fee_payments WHERE receipt_no=?', [rec_no]);
        if (exist.length) { skipped++; continue; }

        await db.query(
          `INSERT INTO fee_payments (student_id,receipt_no,amount_paid,payment_date,payment_mode,remarks,collected_by) VALUES (?,?,?,?,?,?,?)`,
          [student.id, rec_no, amount, payment_date || new Date().toISOString().split('T')[0], payment_mode, remarks, adminId]
        );
        inserted++;
      } catch(e) { skipped++; }
    }
    req.flash('success', `✅ Fee payments import done: ${inserted} added, ${skipped} skipped/duplicate`);
  } catch(e) {
    req.flash('error', 'Import failed: ' + e.message);
  }
  res.redirect('/configuration/import');
});

// Import Attendance
router.post('/import/attendance', importUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) { req.flash('error', 'No file uploaded'); return res.redirect('/configuration/import'); }
    const academic_year = req.body.academic_year || '';
    const wb = xlsxLib.read(req.file.buffer, { type: 'buffer', cellDates: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = xlsxLib.utils.sheet_to_json(ws, { defval: '' });
    if (!rows.length) { req.flash('error', 'File is empty'); return res.redirect('/configuration/import'); }

    let inserted = 0, skipped = 0;
    for (const row of rows) {
      try {
        const admission_no = String(row['Admission No'] || row['AdmissionNo'] || row['admission_no'] || '').trim();
        const status_val   = String(row['Status'] || row['status'] || 'Present').trim();
        const remarks      = String(row['Remarks'] || row['remarks'] || '').trim();
        let att_date = null;
        const d_raw = row['Date'] || row['date'] || '';
        if (d_raw instanceof Date) {
          att_date = `${d_raw.getFullYear()}-${String(d_raw.getMonth()+1).padStart(2,'0')}-${String(d_raw.getDate()).padStart(2,'0')}`;
        } else if (d_raw) {
          const s = String(d_raw).trim();
          if (/^\d{4}-\d{2}-\d{2}/.test(s)) att_date = s.substring(0,10);
          else if (/^\d{2}[\/\-]\d{2}[\/\-]\d{4}$/.test(s)) {
            const [d2,m2,y2] = s.split(/[\/\-]/);
            att_date = `${y2}-${m2}-${d2}`;
          }
        }

        if (!admission_no || !att_date) { skipped++; continue; }
        const [[student]] = await db.query('SELECT id FROM students WHERE admission_no=?', [admission_no]);
        if (!student) { skipped++; continue; }

        await db.query(
          `INSERT INTO attendance_student (student_id, date, status, remarks) VALUES (?,?,?,?)
           ON DUPLICATE KEY UPDATE status=VALUES(status), remarks=VALUES(remarks)`,
          [student.id, att_date, status_val, remarks]
        );
        inserted++;
      } catch(e) { skipped++; }
    }
    req.flash('success', `✅ Attendance import done: ${inserted} records added/updated, ${skipped} skipped`);
  } catch(e) {
    req.flash('error', 'Import failed: ' + e.message);
  }
  res.redirect('/configuration/import');
});

module.exports = router;

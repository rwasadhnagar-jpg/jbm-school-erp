const express = require('express');
const router = express.Router();
const db = require('../db');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const multer = require('multer');
const xlsxLib = require('xlsx');
const uploadExcel = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

function genPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'; // no 0/O/1/l/I
  let pw = '';
  for (let i = 0; i < 8; i++) pw += chars[crypto.randomInt(chars.length)];
  return pw;
}

function suggestEmail(first, last, id) {
  const clean = s => (s || '').toLowerCase().replace(/[^a-z]/g, '');
  return `${clean(first)}.${clean(last)}${id}@jbmpschool.local`;
}

router.get('/', async (req, res) => {
  try {
    const { search, staff_type } = req.query;
    let q = 'SELECT * FROM staff WHERE 1=1';
    const p = [];
    if (search) { q += ' AND (first_name LIKE ? OR last_name LIKE ? OR designation LIKE ?)'; p.push(`%${search}%`,`%${search}%`,`%${search}%`); }
    if (staff_type) { q += ' AND staff_type = ?'; p.push(staff_type); }
    q += ' AND is_active=1 ORDER BY first_name';
    const [staff] = await db.query(q, p);
    const [[{ total }]] = await db.query("SELECT COUNT(*) as total FROM staff WHERE is_active=1");
    res.render('staff/list', { title: 'Staff Management', activePage: 'staff', staff, total, search, staff_type });
  } catch (err) {
    console.error(err);
    res.render('staff/list', { title: 'Staff Management', activePage: 'staff', staff: [], total: 0, search: '', staff_type: '' });
  }
});

router.get('/add', (req, res) => {
  res.render('staff/add', { title: 'Add Staff', activePage: 'staff' });
});

router.post('/add', async (req, res) => {
  try {
    const b = req.body;
    await db.query(
      `INSERT INTO staff (first_name, last_name, gender, dob, email, phone, designation, department,
        staff_type, employment_type, role, joining_date, aadhar_no, pan_no, qualification, address)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [b.first_name, b.last_name, b.gender||null, b.dob||null, b.email||null, b.phone||null,
       b.designation||null, b.department||null, b.staff_type||'Teaching',
       b.employment_type||'Permanent', b.role||null, b.joining_date||null,
       b.aadhar_no||null, b.pan_no||null, b.qualification||null, b.address||null]
    );
    req.flash('success', `Staff ${b.first_name} ${b.last_name} added successfully`);
    res.redirect('/teachers');
  } catch (err) {
    req.flash('error', 'Failed to add staff: ' + err.message);
    res.redirect('/teachers/add');
  }
});

// ─── Bulk Create Teacher Login Accounts ──────────────────────────────────────
router.get('/bulk-accounts', async (req, res) => {
  try {
    const [staffList] = await db.query(
      `SELECT s.* FROM staff s
       LEFT JOIN users u ON u.staff_id = s.id
       WHERE s.staff_type='Teaching' AND s.is_active=1 AND u.id IS NULL
       ORDER BY s.first_name`
    );
    const rows = staffList.map(s => ({
      ...s,
      suggestedEmail: (s.email && s.email.includes('@')) ? s.email : suggestEmail(s.first_name, s.last_name, s.id)
    }));
    res.render('staff/bulk-accounts', { title: 'Bulk Create Teacher Logins', activePage: 'staff', rows });
  } catch (err) {
    console.error(err);
    req.flash('error', 'Could not load staff list');
    res.redirect('/teachers');
  }
});

router.post('/bulk-accounts', async (req, res) => {
  try {
    const [staffList] = await db.query(
      `SELECT s.* FROM staff s
       LEFT JOIN users u ON u.staff_id = s.id
       WHERE s.staff_type='Teaching' AND s.is_active=1 AND u.id IS NULL`
    );
    const results = [];
    for (const s of staffList) {
      if (!req.body['include_' + s.id]) continue;
      let em = (req.body['email_' + s.id] || '').trim().toLowerCase();
      if (!em) em = suggestEmail(s.first_name, s.last_name, s.id);
      let finalEmail = em, n = 1;
      while (true) {
        const [[exists]] = await db.query('SELECT id FROM users WHERE email=?', [finalEmail]);
        if (!exists) break;
        finalEmail = em.replace('@', `${n}@`);
        n++;
      }
      const password = genPassword();
      const hash = await bcrypt.hash(password, 10);
      await db.query(
        `INSERT INTO users (name, email, password, role, staff_id) VALUES (?,?,?,'teacher',?)`,
        [`${s.first_name} ${s.last_name}`, finalEmail, hash, s.id]
      );
      results.push({ name: `${s.first_name} ${s.last_name}`, email: finalEmail, password });
    }
    if (!results.length) {
      req.flash('error', 'No teachers were selected');
      return res.redirect('/teachers/bulk-accounts');
    }
    res.render('staff/bulk-accounts-result', { title: 'Teacher Logins Created', activePage: 'staff', results });
  } catch (err) {
    console.error(err);
    req.flash('error', 'Failed to create accounts: ' + err.message);
    res.redirect('/teachers/bulk-accounts');
  }
});

// ─── Bulk Onboard Teachers via Excel (Name + Class + Section) ───────────────
router.get('/bulk-upload', (req, res) => {
  res.render('staff/bulk-upload', { title: 'Bulk Upload Teachers (Excel)', activePage: 'staff' });
});

router.post('/bulk-upload', uploadExcel.single('file'), async (req, res) => {
  try {
    if (!req.file) { req.flash('error', 'No file uploaded'); return res.redirect('/teachers/bulk-upload'); }
    const wb = xlsxLib.read(req.file.buffer, { type: 'buffer', cellDates: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = xlsxLib.utils.sheet_to_json(ws, { defval: '' });
    if (!rows.length) { req.flash('error', 'File is empty'); return res.redirect('/teachers/bulk-upload'); }

    const [classes] = await db.query('SELECT id, class_name, section FROM classes');
    const classMap = {};
    classes.forEach(c => {
      classMap[`${c.class_name}`.trim().toLowerCase()] = c.id;
      classMap[`${c.class_name}-${c.section}`.trim().toLowerCase()] = c.id;
      classMap[`${c.class_name} ${c.section}`.trim().toLowerCase()] = c.id;
    });
    const [subjects] = await db.query('SELECT id FROM subjects WHERE is_active=1');

    const results = [];
    for (const row of rows) {
      const rawName = String(row['Teacher Name'] || row['TeacherName'] || row['Name'] || '').trim();
      const rawClass = String(row['Class'] || row['class'] || '').trim();
      const rawSection = String(row['Section'] || row['section'] || '').trim();
      if (!rawName || !rawClass) { results.push({ name: rawName || '(blank)', class: `${rawClass} ${rawSection}`.trim(), status: 'skipped — missing name or class' }); continue; }

      try {
        const classKey = rawSection ? `${rawClass}-${rawSection}`.trim().toLowerCase() : rawClass.trim().toLowerCase();
        const class_id = classMap[classKey] || classMap[rawClass.trim().toLowerCase()] || null;
        if (!class_id) { results.push({ name: rawName, class: `${rawClass} ${rawSection}`.trim(), status: 'skipped — class not found' }); continue; }

        const parts = rawName.split(/\s+/);
        const first_name = parts[0];
        const last_name = parts.slice(1).join(' ') || '';

        let [existingStaff] = await db.query(
          `SELECT s.*, u.id AS user_id FROM staff s LEFT JOIN users u ON u.staff_id = s.id
           WHERE s.staff_type='Teaching' AND s.is_active=1 AND LOWER(s.first_name)=? AND LOWER(s.last_name)=?`,
          [first_name.toLowerCase(), last_name.toLowerCase()]
        );
        let staffRow = existingStaff[0];

        if (!staffRow) {
          const [ins] = await db.query(
            `INSERT INTO staff (first_name, last_name, staff_type, is_active) VALUES (?,?,'Teaching',1)`,
            [first_name, last_name]
          );
          staffRow = { id: ins.insertId, first_name, last_name, user_id: null };
        }

        await db.query('UPDATE classes SET class_teacher_id=? WHERE id=?', [staffRow.id, class_id]);
        for (const sub of subjects) {
          await db.query(
            `INSERT IGNORE INTO teacher_subjects (staff_id, subject_id, class_id, academic_year_id) VALUES (?,?,?,1)`,
            [staffRow.id, sub.id, class_id]
          );
        }

        if (staffRow.user_id) {
          results.push({ name: rawName, class: `${rawClass} ${rawSection}`.trim(), status: 'assigned — login already existed' });
          continue;
        }

        let em = suggestEmail(first_name, last_name, staffRow.id);
        let finalEmail = em, n = 1;
        while (true) {
          const [[exists]] = await db.query('SELECT id FROM users WHERE email=?', [finalEmail]);
          if (!exists) break;
          finalEmail = em.replace('@', `${n}@`);
          n++;
        }
        const password = genPassword();
        const hash = await bcrypt.hash(password, 10);
        await db.query(
          `INSERT INTO users (name, email, password, role, staff_id) VALUES (?,?,?,'teacher',?)`,
          [rawName, finalEmail, hash, staffRow.id]
        );
        results.push({ name: rawName, class: `${rawClass} ${rawSection}`.trim(), email: finalEmail, password, status: 'created' });
      } catch (e) {
        results.push({ name: rawName, class: `${rawClass} ${rawSection}`.trim(), status: 'error — ' + e.message });
      }
    }

    res.render('staff/bulk-upload-result', { title: 'Teachers Onboarded', activePage: 'staff', results });
  } catch (err) {
    console.error(err);
    req.flash('error', 'Import failed: ' + err.message);
    res.redirect('/teachers/bulk-upload');
  }
});

module.exports = router;

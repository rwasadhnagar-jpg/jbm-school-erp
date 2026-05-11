const express = require('express');
const router = express.Router();
const db = require('../db');
const XLSX = require('xlsx');
const multer = require('multer');
const path = require('path');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// Ensure certificates table exists
db.query(`CREATE TABLE IF NOT EXISTS certificates (
  id INT NOT NULL AUTO_INCREMENT,
  student_id INT NOT NULL,
  type ENUM('TC','Bonafide','Marksheet') NOT NULL,
  serial_no VARCHAR(30),
  issue_date DATE,
  data_json TEXT,
  issued_by INT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_student (student_id)
)`).catch(e => console.error('Cert table create:', e.message));

// INDEX — list all issued certificates
router.get('/', async (req, res) => {
  try {
    const { type, search } = req.query;
    let q = `SELECT cert.*, s.first_name, s.last_name, s.admission_no,
              c.class_name, c.section, u.name as issued_by_name
             FROM certificates cert
             LEFT JOIN students s ON cert.student_id = s.id
             LEFT JOIN classes c ON s.class_id = c.id
             LEFT JOIN users u ON cert.issued_by = u.id
             WHERE 1=1`;
    const params = [];
    if (type) { q += ' AND cert.type=?'; params.push(type); }
    if (search) { q += ' AND (s.first_name LIKE ? OR s.last_name LIKE ? OR s.admission_no LIKE ? OR cert.serial_no LIKE ?)'; const l = `%${search}%`; params.push(l,l,l,l); }
    q += ' ORDER BY cert.created_at DESC';
    const [certs] = await db.query(q, params);
    res.render('certificates/index', { title: 'Certificates & TC', activePage: 'certificates', certs, type, search });
  } catch(err) {
    console.error(err);
    res.render('certificates/index', { title: 'Certificates & TC', activePage: 'certificates', certs: [], type:'', search:'' });
  }
});

// TC FORM
router.get('/tc/new', async (req, res) => {
  const [students] = await db.query("SELECT s.*, c.class_name, c.section FROM students s LEFT JOIN classes c ON s.class_id=c.id WHERE s.status='active' ORDER BY s.first_name");
  res.render('certificates/tc-form', { title: 'Issue Transfer Certificate', activePage: 'certificates', students, prefill: {} });
});

// TC ISSUE
router.post('/tc/issue', async (req, res) => {
  try {
    const b = req.body;
    const [[{ cnt }]] = await db.query('SELECT COUNT(*)+1 as cnt FROM certificates WHERE type="TC"');
    const serial_no = 'TC' + new Date().getFullYear() + String(cnt).padStart(4,'0');
    const data = JSON.stringify({ reason: b.reason, conduct: b.conduct, result: b.result, dob_words: b.dob_words, admission_date: b.admission_date, leaving_date: b.leaving_date, last_class: b.last_class, remarks: b.remarks });
    const [ins] = await db.query(
      'INSERT INTO certificates (student_id, type, serial_no, issue_date, data_json, issued_by) VALUES (?,?,?,?,?,?)',
      [b.student_id, 'TC', serial_no, b.issue_date || new Date().toISOString().split('T')[0], data, req.session.user.id]
    );
    res.redirect(`/certificates/tc/print/${ins.insertId}`);
  } catch(err) {
    console.error(err);
    req.flash('error', 'Failed to issue TC: ' + err.message);
    res.redirect('/certificates/tc/new');
  }
});

// TC PRINT
router.get('/tc/print/:id', async (req, res) => {
  try {
    const [[cert]] = await db.query(
      `SELECT cert.*, s.first_name, s.last_name, s.admission_no, s.dob, s.gender, s.category, s.religion,
              s.nationality, s.roll_no, c.class_name, c.section, u.name as issued_by_name,
              p.first_name as father_name, p.last_name as father_last
       FROM certificates cert
       LEFT JOIN students s ON cert.student_id = s.id
       LEFT JOIN classes c ON s.class_id = c.id
       LEFT JOIN users u ON cert.issued_by = u.id
       LEFT JOIN parents p ON p.student_id = s.id AND p.type='father'
       WHERE cert.id=? AND cert.type='TC'`, [req.params.id]
    );
    if (!cert) return res.redirect('/certificates');
    cert.data = JSON.parse(cert.data_json || '{}');
    res.render('certificates/tc-print', { title: 'Transfer Certificate', cert });
  } catch(err) { console.error(err); res.redirect('/certificates'); }
});

// BONAFIDE FORM
router.get('/bonafide/new', async (req, res) => {
  const [students] = await db.query("SELECT s.*, c.class_name, c.section FROM students s LEFT JOIN classes c ON s.class_id=c.id WHERE s.status='active' ORDER BY s.first_name");
  res.render('certificates/bonafide-form', { title: 'Issue Bonafide Certificate', activePage: 'certificates', students });
});

// BONAFIDE ISSUE
router.post('/bonafide/issue', async (req, res) => {
  try {
    const b = req.body;
    const [[{ cnt }]] = await db.query('SELECT COUNT(*)+1 as cnt FROM certificates WHERE type="Bonafide"');
    const serial_no = 'BNF' + new Date().getFullYear() + String(cnt).padStart(4,'0');
    const data = JSON.stringify({ purpose: b.purpose, remarks: b.remarks });
    const [ins] = await db.query(
      'INSERT INTO certificates (student_id, type, serial_no, issue_date, data_json, issued_by) VALUES (?,?,?,?,?,?)',
      [b.student_id, 'Bonafide', serial_no, b.issue_date || new Date().toISOString().split('T')[0], data, req.session.user.id]
    );
    res.redirect(`/certificates/bonafide/print/${ins.insertId}`);
  } catch(err) {
    console.error(err);
    req.flash('error', 'Failed to issue certificate');
    res.redirect('/certificates/bonafide/new');
  }
});

// BONAFIDE PRINT
router.get('/bonafide/print/:id', async (req, res) => {
  try {
    const [[cert]] = await db.query(
      `SELECT cert.*, s.first_name, s.last_name, s.admission_no, s.dob, s.gender,
              c.class_name, c.section, u.name as issued_by_name,
              p.first_name as father_name
       FROM certificates cert
       LEFT JOIN students s ON cert.student_id = s.id
       LEFT JOIN classes c ON s.class_id = c.id
       LEFT JOIN users u ON cert.issued_by = u.id
       LEFT JOIN parents p ON p.student_id = s.id AND p.type='father'
       WHERE cert.id=? AND cert.type='Bonafide'`, [req.params.id]
    );
    if (!cert) return res.redirect('/certificates');
    cert.data = JSON.parse(cert.data_json || '{}');
    res.render('certificates/bonafide-print', { title: 'Bonafide Certificate', cert });
  } catch(err) { console.error(err); res.redirect('/certificates'); }
});

// MARKSHEET FORM
router.get('/marksheet/new', async (req, res) => {
  const [students] = await db.query("SELECT s.*, c.class_name, c.section FROM students s LEFT JOIN classes c ON s.class_id=c.id WHERE s.status='active' ORDER BY s.first_name");
  res.render('certificates/marksheet-form', { title: 'Issue Marksheet', activePage: 'certificates', students });
});

// MARKSHEET ISSUE
router.post('/marksheet/issue', async (req, res) => {
  try {
    const b = req.body;
    const [[{ cnt }]] = await db.query('SELECT COUNT(*)+1 as cnt FROM certificates WHERE type="Marksheet"');
    const serial_no = 'MKS' + new Date().getFullYear() + String(cnt).padStart(4,'0');
    const subjects = Array.isArray(b.subject) ? b.subject : [b.subject];
    const max_marks = Array.isArray(b.max_marks) ? b.max_marks : [b.max_marks];
    const obtained = Array.isArray(b.obtained) ? b.obtained : [b.obtained];
    const subjectsData = subjects.map((s,i) => ({ name: s, max: parseInt(max_marks[i]||100), obt: parseInt(obtained[i]||0) }));
    const totalMax = subjectsData.reduce((a,s) => a+s.max, 0);
    const totalObt = subjectsData.reduce((a,s) => a+s.obt, 0);
    const pct = totalMax > 0 ? ((totalObt/totalMax)*100).toFixed(1) : 0;
    let grade = 'F';
    if (pct >= 90) grade = 'A+'; else if (pct >= 75) grade = 'A'; else if (pct >= 60) grade = 'B'; else if (pct >= 45) grade = 'C'; else if (pct >= 33) grade = 'D';
    const data = JSON.stringify({ exam_name: b.exam_name, academic_year: b.academic_year, subjects: subjectsData, totalMax, totalObt, percentage: pct, grade, result: pct >= 33 ? 'PASS' : 'FAIL', remarks: b.remarks });
    const [ins] = await db.query(
      'INSERT INTO certificates (student_id, type, serial_no, issue_date, data_json, issued_by) VALUES (?,?,?,?,?,?)',
      [b.student_id, 'Marksheet', serial_no, b.issue_date || new Date().toISOString().split('T')[0], data, req.session.user.id]
    );
    res.redirect(`/certificates/marksheet/print/${ins.insertId}`);
  } catch(err) {
    console.error(err);
    req.flash('error', 'Failed to issue marksheet: ' + err.message);
    res.redirect('/certificates/marksheet/new');
  }
});

// MARKSHEET PRINT
router.get('/marksheet/print/:id', async (req, res) => {
  try {
    const [[cert]] = await db.query(
      `SELECT cert.*, s.first_name, s.last_name, s.admission_no, s.dob, s.roll_no, s.gender,
              c.class_name, c.section, u.name as issued_by_name,
              p.first_name as father_name
       FROM certificates cert
       LEFT JOIN students s ON cert.student_id = s.id
       LEFT JOIN classes c ON s.class_id = c.id
       LEFT JOIN users u ON cert.issued_by = u.id
       LEFT JOIN parents p ON p.student_id = s.id AND p.type='father'
       WHERE cert.id=? AND cert.type='Marksheet'`, [req.params.id]
    );
    if (!cert) return res.redirect('/certificates');
    cert.data = JSON.parse(cert.data_json || '{}');
    res.render('certificates/marksheet-print', { title: 'Marksheet', cert });
  } catch(err) { console.error(err); res.redirect('/certificates'); }
});

// BULK MARKSHEET — download template
router.get('/marksheet/bulk-template', async (req, res) => {
  try {
    const { class_id, exam_name, subjects } = req.query;
    if (!class_id || !exam_name || !subjects) {
      req.flash('error', 'Please select class, exam and subjects first');
      return res.redirect('/certificates/marksheet/bulk');
    }

    const subjectList = subjects.split(',').map(s => s.trim()).filter(Boolean);
    const [students] = await db.query(
      "SELECT s.id, s.admission_no, s.first_name, s.last_name, s.roll_no, c.class_name, c.section FROM students s LEFT JOIN classes c ON s.class_id=c.id WHERE s.status='active' AND s.class_id=? ORDER BY s.roll_no, s.first_name",
      [class_id]
    );

    // Build header row
    const headers = ['student_id', 'admission_no', 'student_name', 'roll_no', ...subjectList.map(s => s), 'remarks'];
    const rows = [headers];

    students.forEach(st => {
      const row = [st.id, st.admission_no, `${st.first_name} ${st.last_name}`, st.roll_no || ''];
      subjectList.forEach(() => row.push(''));
      row.push(''); // remarks
      rows.push(row);
    });

    const ws = XLSX.utils.aoa_to_sheet(rows);
    // Column widths
    ws['!cols'] = [{ wch: 10 }, { wch: 14 }, { wch: 24 }, { wch: 8 }, ...subjectList.map(() => ({ wch: 12 })), { wch: 20 }];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Marks');

    // Info sheet
    const infoData = [
      ['JBM Public School — Bulk Marks Upload Template'],
      ['Exam:', exam_name],
      ['Academic Year:', '2026-2027'],
      ['Instructions:'],
      ['1. Do NOT change student_id, admission_no or student_name columns'],
      ['2. Enter marks obtained in each subject column (numbers only)'],
      ['3. Leave blank if student was absent — they will be skipped'],
      ['4. Max marks are set to 100 per subject by default'],
      ['5. Save as .xlsx and upload'],
    ];
    const ws2 = XLSX.utils.aoa_to_sheet(infoData);
    ws2['!cols'] = [{ wch: 30 }, { wch: 30 }];
    XLSX.utils.book_append_sheet(wb, ws2, 'Instructions');

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const [[cls]] = await db.query('SELECT class_name, section FROM classes WHERE id=?', [class_id]);
    const filename = `marks_template_${cls.class_name}_${cls.section}_${exam_name.replace(/\s+/g,'_')}.xlsx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buf);
  } catch (err) {
    console.error(err);
    req.flash('error', 'Failed to generate template: ' + err.message);
    res.redirect('/certificates/marksheet/bulk');
  }
});

// BULK MARKSHEET — upload form
router.get('/marksheet/bulk', async (req, res) => {
  const [classes] = await db.query('SELECT * FROM classes WHERE academic_year_id=1 ORDER BY class_name, section');
  res.render('certificates/marksheet-bulk', { title: 'Bulk Marks Upload', activePage: 'certificates', classes });
});

// BULK MARKSHEET — process upload
router.post('/marksheet/bulk-upload', upload.single('marks_file'), async (req, res) => {
  try {
    const { exam_name, academic_year, max_marks_per_subject, class_id } = req.body;
    if (!req.file) { req.flash('error', 'No file uploaded'); return res.redirect('/certificates/marksheet/bulk'); }

    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

    if (!rows.length) { req.flash('error', 'Excel sheet is empty'); return res.redirect('/certificates/marksheet/bulk'); }

    // Detect subject columns (everything after roll_no, before remarks)
    const allKeys = Object.keys(rows[0]);
    const fixedCols = ['student_id', 'admission_no', 'student_name', 'roll_no'];
    const subjectCols = allKeys.filter(k => !fixedCols.includes(k) && k !== 'remarks');

    const maxPerSubject = parseInt(max_marks_per_subject) || 100;
    let created = 0, skipped = 0;

    for (const row of rows) {
      const studentId = parseInt(row.student_id);
      if (!studentId) { skipped++; continue; }

      // Build subjects array — skip if all marks blank
      const subjects = subjectCols.map(col => ({
        name: col,
        max: maxPerSubject,
        obt: row[col] === '' || row[col] === null ? null : parseInt(row[col])
      }));

      const hasMarks = subjects.some(s => s.obt !== null);
      if (!hasMarks) { skipped++; continue; }

      // Fill null marks as 0
      subjects.forEach(s => { if (s.obt === null) s.obt = 0; });

      const totalMax = subjects.reduce((a, s) => a + s.max, 0);
      const totalObt = subjects.reduce((a, s) => a + s.obt, 0);
      const pct = totalMax > 0 ? ((totalObt / totalMax) * 100).toFixed(1) : 0;
      let grade = 'F';
      if (pct >= 90) grade = 'A+'; else if (pct >= 75) grade = 'A'; else if (pct >= 60) grade = 'B'; else if (pct >= 45) grade = 'C'; else if (pct >= 33) grade = 'D';

      const [[{ cnt }]] = await db.query('SELECT COUNT(*)+1 as cnt FROM certificates WHERE type="Marksheet"');
      const serial_no = 'MKS' + new Date().getFullYear() + String(cnt).padStart(4, '0');
      const data = JSON.stringify({
        exam_name, academic_year: academic_year || '2026-2027',
        subjects, totalMax, totalObt, percentage: pct, grade,
        result: pct >= 33 ? 'PASS' : 'FAIL',
        remarks: row.remarks || ''
      });

      await db.query(
        'INSERT INTO certificates (student_id, type, serial_no, issue_date, data_json, issued_by) VALUES (?,?,?,?,?,?)',
        [studentId, 'Marksheet', serial_no, new Date().toISOString().split('T')[0], data, req.session.user.id]
      );
      created++;
    }

    req.flash('success', `Bulk upload done! ${created} marksheets created, ${skipped} rows skipped.`);
    res.redirect('/certificates');
  } catch (err) {
    console.error(err);
    req.flash('error', 'Upload failed: ' + err.message);
    res.redirect('/certificates/marksheet/bulk');
  }
});

// DELETE certificate
router.post('/delete/:id', async (req, res) => {
  await db.query('DELETE FROM certificates WHERE id=?', [req.params.id]);
  req.flash('success', 'Certificate deleted');
  res.redirect('/certificates');
});

module.exports = router;

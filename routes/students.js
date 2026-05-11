const express = require('express');
const router = express.Router();
const db = require('../db');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '../public/uploads/students');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 1024 * 1024 } });

// LIST
router.get('/', async (req, res) => {
  try {
    const { search, class_id, status } = req.query;
    let query = `SELECT s.*, c.class_name, c.section,
      p.first_name as father_first, p.last_name as father_last, p.mobile as father_mobile
      FROM students s
      LEFT JOIN classes c ON s.class_id = c.id
      LEFT JOIN parents p ON p.student_id = s.id AND p.type = 'father'
      WHERE 1=1`;
    const params = [];
    if (search) { query += ' AND (s.first_name LIKE ? OR s.last_name LIKE ? OR s.admission_no LIKE ?)'; params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
    if (class_id) { query += ' AND s.class_id = ?'; params.push(class_id); }
    if (status) { query += ' AND s.status = ?'; params.push(status); }
    else { query += ' AND s.status = "active"'; }
    query += ' ORDER BY s.created_at DESC LIMIT 100';

    const [students] = await db.query(query, params);
    const [classes] = await db.query('SELECT * FROM classes WHERE academic_year_id = 1 ORDER BY class_name, section');
    const [[{ total }]] = await db.query('SELECT COUNT(*) as total FROM students WHERE status="active"');

    res.render('students/list', { title: 'Student Administration', activePage: 'students', students, classes, total, search, class_id, status });
  } catch (err) {
    console.error(err);
    req.flash('error', 'Failed to load students');
    res.render('students/list', { title: 'Student Administration', activePage: 'students', students: [], classes: [], total: 0, search: '', class_id: '', status: '' });
  }
});

// ADD FORM
router.get('/add', async (req, res) => {
  try {
    const [classes] = await db.query('SELECT * FROM classes WHERE academic_year_id = 1 ORDER BY class_name, section');
    const [feeGroups] = await db.query('SELECT * FROM fee_groups WHERE is_active = 1');
    res.render('students/add', { title: 'Add Student', activePage: 'students', classes, feeGroups });
  } catch (err) {
    console.error(err);
    req.flash('error', 'Failed to load form');
    res.redirect('/studentadministration');
  }
});

// SAVE NEW STUDENT
router.post('/add', upload.fields([
  { name: 'student_photo', maxCount: 1 },
  { name: 'father_photo', maxCount: 1 },
  { name: 'mother_photo', maxCount: 1 }
]), async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const b = req.body;
    const studentPhoto = req.files['student_photo'] ? '/uploads/students/' + req.files['student_photo'][0].filename : null;

    const [result] = await conn.query(
      `INSERT INTO students (admission_no, roll_no, class_id, academic_year_id, admission_date, status, day_scholar,
        fee_group_id, house, first_name, middle_name, last_name, gender, dob, aadhar_no, blood_group, religion,
        category, email, nationality, srn_no, child_id, samagra_id, place_of_birth, caste, apaar_id,
        height_cm, weight_kg, mother_tongue, medical_condition, notes, is_special_child, is_ews,
        pen_no, is_physically_disabled, disability_details, photo)
       VALUES (?,?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [b.admission_no, b.roll_no || null, b.class_id || null, b.admission_date || null,
       b.status || 'active', b.day_scholar || 'Day Scholar', b.fee_group_id || null, b.house || null,
       b.first_name, b.middle_name || null, b.last_name, b.gender, b.dob || null,
       b.aadhar_no || null, b.blood_group || null, b.religion || null, b.category || 'General',
       b.email || null, b.nationality || 'Indian', b.srn_no || null, b.child_id || null,
       b.samagra_id || null, b.place_of_birth || null, b.caste || null, b.apaar_id || null,
       b.height_cm || null, b.weight_kg || null, b.mother_tongue || null,
       b.medical_condition || null, b.notes || null,
       b.is_special_child ? 1 : 0, b.is_ews ? 1 : 0, b.pen_no || null,
       b.is_physically_disabled ? 1 : 0, b.disability_details || null, studentPhoto]
    );
    const studentId = result.insertId;

    // Father
    if (b.father_first_name) {
      const fatherPhoto = req.files['father_photo'] ? '/uploads/students/' + req.files['father_photo'][0].filename : null;
      await conn.query(
        `INSERT INTO parents (student_id, type, salutation, first_name, middle_name, last_name, email, mobile,
          sms_whatsapp_no, qualification, occupation, income_per_year, department, designation,
          aadhar_no, pan_no, company_name, photo)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [studentId, 'father', b.father_salutation || null, b.father_first_name, b.father_middle_name || null,
         b.father_last_name || null, b.father_email || null, b.father_mobile || null,
         b.father_sms_no || null, b.father_qualification || null, b.father_occupation || null,
         b.father_income || null, b.father_department || null, b.father_designation || null,
         b.father_aadhar || null, b.father_pan || null, b.father_company || null, fatherPhoto]
      );
    }

    // Mother
    if (b.mother_first_name) {
      const motherPhoto = req.files['mother_photo'] ? '/uploads/students/' + req.files['mother_photo'][0].filename : null;
      await conn.query(
        `INSERT INTO parents (student_id, type, first_name, middle_name, last_name, email, mobile,
          sms_whatsapp_no, qualification, occupation, income_per_year, aadhar_no, pan_no, photo)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [studentId, 'mother', b.mother_first_name, b.mother_middle_name || null,
         b.mother_last_name || null, b.mother_email || null, b.mother_mobile || null,
         b.mother_sms_no || null, b.mother_qualification || null, b.mother_occupation || null,
         b.mother_income || null, b.mother_aadhar || null, b.mother_pan || null, motherPhoto]
      );
    }

    // Address
    if (b.present_address) {
      await conn.query(
        `INSERT INTO student_addresses (student_id, type, address, state, city, district, taluka, pin_code)
         VALUES (?,?,?,?,?,?,?,?)`,
        [studentId, 'present', b.present_address, b.present_state || null, b.present_city || null,
         b.present_district || null, b.present_taluka || null, b.present_pin || null]
      );
    }

    // Previous school
    if (b.prev_school_name) {
      await conn.query(
        `INSERT INTO previous_school (student_id, school_name, school_class, date_of_leaving, tc_number, udise_code)
         VALUES (?,?,?,?,?,?)`,
        [studentId, b.prev_school_name, b.prev_school_class || null, b.prev_leaving_date || null,
         b.prev_tc_no || null, b.prev_udise || null]
      );
    }

    await conn.commit();
    req.flash('success', `Student ${b.first_name} ${b.last_name} added successfully! Admission No: ${b.admission_no}`);
    res.redirect('/studentadministration');
  } catch (err) {
    await conn.rollback();
    console.error(err);
    req.flash('error', 'Failed to add student: ' + err.message);
    res.redirect('/studentadministration/add');
  } finally {
    conn.release();
  }
});

// VIEW STUDENT
router.get('/view/:id', async (req, res) => {
  try {
    const [[student]] = await db.query(
      `SELECT s.*, c.class_name, c.section FROM students s LEFT JOIN classes c ON s.class_id = c.id WHERE s.id = ?`,
      [req.params.id]
    );
    if (!student) { req.flash('error', 'Student not found'); return res.redirect('/studentadministration'); }
    const [parents] = await db.query('SELECT * FROM parents WHERE student_id = ?', [req.params.id]);
    const [addresses] = await db.query('SELECT * FROM student_addresses WHERE student_id = ?', [req.params.id]);
    const [[prevSchool]] = await db.query('SELECT * FROM previous_school WHERE student_id = ?', [req.params.id]);
    const [[bankDetails]] = await db.query('SELECT * FROM student_bank WHERE student_id = ?', [req.params.id]);
    const [feeHistory] = await db.query(
      'SELECT * FROM fee_payments WHERE student_id = ? ORDER BY payment_date DESC LIMIT 10', [req.params.id]
    );
    res.render('students/view', { title: student.first_name + ' ' + student.last_name, activePage: 'students', student, parents, addresses, prevSchool, bankDetails, feeHistory });
  } catch (err) {
    console.error(err);
    req.flash('error', 'Failed to load student');
    res.redirect('/studentadministration');
  }
});

// EDIT FORM
router.get('/edit/:id', async (req, res) => {
  try {
    const [[student]] = await db.query('SELECT * FROM students WHERE id = ?', [req.params.id]);
    if (!student) return res.redirect('/studentadministration');
    const [classes] = await db.query('SELECT * FROM classes WHERE academic_year_id = 1 ORDER BY class_name, section');
    const [feeGroups] = await db.query('SELECT * FROM fee_groups WHERE is_active = 1');
    const [parents] = await db.query('SELECT * FROM parents WHERE student_id = ?', [req.params.id]);
    const father = parents.find(p => p.type === 'father') || {};
    const mother = parents.find(p => p.type === 'mother') || {};
    const [addresses] = await db.query('SELECT * FROM student_addresses WHERE student_id = ?', [req.params.id]);
    const presentAddr = addresses.find(a => a.type === 'present') || {};
    res.render('students/edit', { title: 'Edit Student', activePage: 'students', student, classes, feeGroups, father, mother, presentAddr });
  } catch (err) {
    console.error(err);
    req.flash('error', 'Failed to load student');
    res.redirect('/studentadministration');
  }
});

// UPDATE STUDENT
router.post('/edit/:id', async (req, res) => {
  try {
    const b = req.body;
    await db.query(
      `UPDATE students SET admission_no=?, roll_no=?, class_id=?, admission_date=?, status=?,
        day_scholar=?, house=?, first_name=?, middle_name=?, last_name=?, gender=?, dob=?,
        aadhar_no=?, blood_group=?, religion=?, category=?, email=?, nationality=?,
        mother_tongue=?, medical_condition=?, notes=? WHERE id=?`,
      [b.admission_no, b.roll_no || null, b.class_id || null, b.admission_date || null,
       b.status || 'active', b.day_scholar || 'Day Scholar', b.house || null,
       b.first_name, b.middle_name || null, b.last_name, b.gender, b.dob || null,
       b.aadhar_no || null, b.blood_group || null, b.religion || null, b.category || 'General',
       b.email || null, b.nationality || 'Indian', b.mother_tongue || null,
       b.medical_condition || null, b.notes || null, req.params.id]
    );
    req.flash('success', 'Student updated successfully');
    res.redirect('/studentadministration/view/' + req.params.id);
  } catch (err) {
    console.error(err);
    req.flash('error', 'Failed to update: ' + err.message);
    res.redirect('/studentadministration/edit/' + req.params.id);
  }
});

// BULK UPLOAD PAGE
router.get('/bulk-upload', (req, res) => {
  res.render('students/bulk-upload', { title: 'Bulk Upload Students', activePage: 'students' });
});

// BULK UPLOAD PROCESS — accepts XLSX or CSV
const xlsxLib = require('xlsx');
const xlsxUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
router.post('/bulk-upload', xlsxUpload.single('csvfile'), async (req, res) => {
  try {
    if (!req.file) { req.flash('error', 'No file uploaded'); return res.redirect('/studentadministration/bulk-upload'); }

    // Parse XLSX or CSV
    const wb = xlsxLib.read(req.file.buffer, { type: 'buffer', cellDates: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = xlsxLib.utils.sheet_to_json(ws, { defval: '' });

    const [classes] = await db.query('SELECT * FROM classes WHERE academic_year_id=1');
    // Build map: "nursery kaveri" → id, also "nursery-kaveri" etc.
    const classMap = {};
    classes.forEach(c => {
      classMap[(c.class_name + ' ' + c.section).toLowerCase().trim()] = c.id;
      classMap[(c.class_name + '-' + c.section).toLowerCase().trim()] = c.id;
      classMap[c.class_name.toLowerCase().trim()] = c.id;
    });

    let added = 0, skipped = 0, errors = [];

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      // Normalize column names (trim whitespace)
      const row = {};
      Object.keys(r).forEach(k => { row[k.trim()] = (r[k] !== null && r[k] !== undefined) ? String(r[k]).trim() : ''; });

      // Map Excel columns → DB fields
      const admNo   = row['AdmissionNumber'] || row['admission_no'] || row['Admission No'] || '';
      const fullName = row['Name'] || '';
      const nameParts = fullName.trim().split(/\s+/);
      const firstName = nameParts[0] || '';
      const lastName  = nameParts.length > 1 ? nameParts.slice(1).join(' ') : '';

      if (!admNo || !firstName) { skipped++; continue; }

      const classRaw   = (row['Class'] || row['class'] || '').toLowerCase().trim();
      const classId    = classMap[classRaw] || null;

      const gender     = row['Gender'] || 'Male';
      let dob          = row['DOB'] || null;
      if (dob && dob instanceof Date) dob = dob.toISOString().split('T')[0];
      else if (dob && dob.includes('/')) { const [d,m,y] = dob.split('/'); dob = `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`; }
      else if (!dob) dob = null;

      const rollNo     = row['roleNumber'] || row['roll_no'] || null;
      const status     = (row['Status'] || 'active').toLowerCase() === 'active' ? 'active' : 'inactive';
      const mobile     = row['Mobile'] || row['mobile'] || null;
      const smsNo      = row['SmsNo'] || null;
      const category   = row['Employment Category'] || row['category'] || 'General';
      const dayScholar = (row['StudentType'] || '').toLowerCase().includes('day') ? 'Day Scholar' : 'Boarding';
      const fatherName = row['Father'] || row['father_name'] || null;
      const motherName = row['Mother'] || row['mother_name'] || null;
      const safeLastName = lastName || firstName; // last_name is NOT NULL

      try {
        await db.query(
          `INSERT INTO students (admission_no,first_name,last_name,gender,dob,roll_no,class_id,academic_year_id,status,day_scholar,category)
           VALUES (?,?,?,?,?,?,?,1,?,?,?)
           ON DUPLICATE KEY UPDATE first_name=VALUES(first_name),last_name=VALUES(last_name),class_id=VALUES(class_id),status=VALUES(status),day_scholar=VALUES(day_scholar)`,
          [admNo, firstName, safeLastName, gender, dob||null, rollNo||null, classId, status, dayScholar, category||'General']
        );
        const [[s]] = await db.query('SELECT id FROM students WHERE admission_no=?', [admNo]);
        if (s) {
          // Check before insert since parents has no unique key
          if (fatherName) {
            const [[existing]] = await db.query('SELECT id FROM parents WHERE student_id=? AND type="father"', [s.id]);
            if (existing) {
              await db.query('UPDATE parents SET first_name=?,mobile=?,sms_whatsapp_no=? WHERE id=?', [fatherName, mobile||null, smsNo||null, existing.id]);
            } else {
              await db.query('INSERT INTO parents (student_id,type,first_name,mobile,sms_whatsapp_no) VALUES (?,?,?,?,?)', [s.id,'father',fatherName,mobile||null,smsNo||null]);
            }
          }
          if (motherName) {
            const [[existing]] = await db.query('SELECT id FROM parents WHERE student_id=? AND type="mother"', [s.id]);
            if (existing) {
              await db.query('UPDATE parents SET first_name=? WHERE id=?', [motherName, existing.id]);
            } else {
              await db.query('INSERT INTO parents (student_id,type,first_name) VALUES (?,?,?)', [s.id,'mother',motherName]);
            }
          }
        }
        added++;
      } catch(e) { errors.push(`Row ${i+2}: ${e.message}`); }
    }

    const msg = `✅ ${added} students uploaded${skipped?' | Skipped: '+skipped:''}${errors.length?' | Errors: '+errors.length:''}`;
    req.flash('success', msg);
    if (errors.length) req.flash('error', errors.slice(0,5).join(' | '));
    res.redirect('/studentadministration');
  } catch(err) {
    req.flash('error', 'Upload failed: ' + err.message);
    res.redirect('/studentadministration/bulk-upload');
  }
});

// REPORTS - CLASS SUMMARY
router.get('/reports/class-summary', async (req, res) => {
  try {
    const [summary] = await db.query(
      `SELECT c.class_name, c.section,
        COUNT(s.id) as total,
        SUM(CASE WHEN s.gender='Male' THEN 1 ELSE 0 END) as boys,
        SUM(CASE WHEN s.gender='Female' THEN 1 ELSE 0 END) as girls,
        SUM(CASE WHEN s.category='General' THEN 1 ELSE 0 END) as general,
        SUM(CASE WHEN s.category='OBC' THEN 1 ELSE 0 END) as obc,
        SUM(CASE WHEN s.category='SC' THEN 1 ELSE 0 END) as sc,
        SUM(CASE WHEN s.category='ST' THEN 1 ELSE 0 END) as st,
        SUM(CASE WHEN s.category='EWS' THEN 1 ELSE 0 END) as ews
       FROM classes c LEFT JOIN students s ON s.class_id=c.id AND s.status='active'
       WHERE c.academic_year_id=1 GROUP BY c.id ORDER BY c.class_name, c.section`
    );
    const [[totals]] = await db.query(`SELECT COUNT(*) as total, SUM(CASE WHEN gender='Male' THEN 1 ELSE 0 END) as boys, SUM(CASE WHEN gender='Female' THEN 1 ELSE 0 END) as girls FROM students WHERE status='active'`);
    res.render('students/report-class-summary', { title: 'Class Summary Report', activePage: 'students', summary, totals });
  } catch(err) {
    console.error(err);
    req.flash('error','Report failed');
    res.redirect('/studentadministration');
  }
});

// REPORTS - DOWNLOAD CSV
router.get('/reports/download', async (req, res) => {
  try {
    const { class_id, category, gender } = req.query;
    let q = `SELECT s.admission_no, s.first_name, s.middle_name, s.last_name, s.gender, s.dob,
              s.category, s.roll_no, s.aadhar_no, s.email, s.status,
              c.class_name, c.section,
              p.first_name as father_name, p.mobile as father_mobile
             FROM students s
             LEFT JOIN classes c ON s.class_id=c.id
             LEFT JOIN parents p ON p.student_id=s.id AND p.type='father'
             WHERE s.status='active'`;
    const params = [];
    if (class_id) { q += ' AND s.class_id=?'; params.push(class_id); }
    if (category) { q += ' AND s.category=?'; params.push(category); }
    if (gender) { q += ' AND s.gender=?'; params.push(gender); }
    q += ' ORDER BY c.class_name, c.section, s.roll_no';
    const [rows] = await db.query(q, params);
    const headers = ['Admission No','First Name','Middle Name','Last Name','Gender','DOB','Category','Roll No','Class','Section','Father Name','Father Mobile','Aadhar','Email','Status'];
    const csvRows = [headers.join(',')];
    rows.forEach(r => csvRows.push([r.admission_no,r.first_name,r.middle_name||'',r.last_name,r.gender,r.dob?r.dob.toISOString().split('T')[0]:'',r.category,r.roll_no||'',r.class_name||'',r.section||'',r.father_name||'',r.father_mobile||'',r.aadhar_no||'',r.email||'',r.status].join(',')));
    res.setHeader('Content-Type','text/csv');
    res.setHeader('Content-Disposition','attachment; filename="students_'+Date.now()+'.csv"');
    res.send(csvRows.join('\n'));
  } catch(err) {
    req.flash('error','Download failed');
    res.redirect('/studentadministration');
  }
});

// DELETE
router.post('/delete/:id', async (req, res) => {
  try {
    await db.query('UPDATE students SET status = "inactive" WHERE id = ?', [req.params.id]);
    req.flash('success', 'Student deactivated successfully');
    res.redirect('/studentadministration');
  } catch (err) {
    req.flash('error', 'Failed to delete student');
    res.redirect('/studentadministration');
  }
});

module.exports = router;

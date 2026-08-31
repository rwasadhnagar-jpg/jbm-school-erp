const express = require('express');
const router = express.Router();
const db = require('../db');
const { pickTemplate } = require('../utils/remarkTemplates');

// === DB INIT (mirrors routes/student.js self-migrating pattern) ===
(async () => {
  try {
    await db.query(`CREATE TABLE IF NOT EXISTS subjects (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      code VARCHAR(20) DEFAULT NULL,
      is_active TINYINT(1) DEFAULT 1,
      UNIQUE KEY subj_name (name)
    )`);
    await db.query(`CREATE TABLE IF NOT EXISTS exam_terms (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      academic_year_id INT DEFAULT NULL,
      start_date DATE DEFAULT NULL,
      end_date DATE DEFAULT NULL,
      max_marks_default DECIMAL(6,2) DEFAULT 100,
      is_active TINYINT(1) DEFAULT 1,
      sort_order INT DEFAULT 0,
      UNIQUE KEY term_name_ay (name, academic_year_id)
    )`);
    await db.query(`CREATE TABLE IF NOT EXISTS teacher_subjects (
      id INT AUTO_INCREMENT PRIMARY KEY,
      staff_id INT NOT NULL,
      subject_id INT NOT NULL,
      class_id INT NOT NULL,
      academic_year_id INT DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY staff_subject_class (staff_id, subject_id, class_id, academic_year_id)
    )`);
    await db.query(`CREATE TABLE IF NOT EXISTS student_marks (
      id INT AUTO_INCREMENT PRIMARY KEY,
      student_id INT NOT NULL,
      subject_id INT NOT NULL,
      class_id INT NOT NULL,
      exam_term_id INT NOT NULL,
      marks_obtained DECIMAL(6,2) DEFAULT NULL,
      max_marks DECIMAL(6,2) DEFAULT 100,
      performance_vs_previous VARCHAR(20) DEFAULT NULL,
      classwork_homework_note TEXT,
      strengths TEXT,
      areas_needing_attention TEXT,
      study_habits_note TEXT,
      entered_by INT DEFAULT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY student_subject_term (student_id, subject_id, exam_term_id)
    )`);
    await db.query(`CREATE TABLE IF NOT EXISTS student_overall_remarks (
      id INT AUTO_INCREMENT PRIMARY KEY,
      student_id INT NOT NULL,
      class_id INT NOT NULL,
      exam_term_id INT NOT NULL,
      participation_engagement TEXT,
      attendance_punctuality_note TEXT,
      discipline_conduct TEXT,
      peer_interaction TEXT,
      co_scholastic_activities TEXT,
      notable_improvement TEXT,
      goals_for_term TEXT,
      entered_by INT DEFAULT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY student_term (student_id, exam_term_id)
    )`);
    await db.query(`INSERT IGNORE INTO exam_terms (name, academic_year_id, start_date, end_date, sort_order) VALUES
      ('Half Yearly', 1, '2026-09-15', '2026-10-15', 5),
      ('Annual Exam', 1, '2027-02-15', '2027-03-15', 6)`);
    await db.query(`INSERT IGNORE INTO subjects (name, code) VALUES
      ('English','ENG'), ('Hindi','HIN'), ('Mathematics','MAT'), ('Science','SCI'),
      ('Social Studies','SST'), ('Computer Science','CS'), ('Physical Education','PE'),
      ('Art & Craft','ART'), ('Environmental Studies','EVS')`);

    // Unit tests + term_type (added when 4 unit tests were introduced alongside Half Yearly/Annual)
    try { await db.query(`ALTER TABLE exam_terms ADD COLUMN term_type ENUM('unit_test','term') DEFAULT 'term'`); } catch(e) {}
    try { await db.query(`ALTER TABLE student_marks ADD COLUMN template_remark TEXT`); } catch(e) {}
    await db.query(`UPDATE exam_terms SET term_type='term', sort_order=5 WHERE name='Half Yearly'`);
    await db.query(`UPDATE exam_terms SET term_type='term', sort_order=6 WHERE name='Annual Exam'`);
    await db.query(`INSERT IGNORE INTO exam_terms (name, academic_year_id, term_type, sort_order) VALUES
      ('Unit Test 1', 1, 'unit_test', 1),
      ('Unit Test 2', 1, 'unit_test', 2),
      ('Unit Test 3', 1, 'unit_test', 3),
      ('Unit Test 4', 1, 'unit_test', 4)`);
  } catch (e) { console.error('remarks tables init:', e.message); }
})();

function isAdmin(req) { return req.session.user && req.session.user.role === 'admin'; }

const requireAdmin = (req, res, next) => {
  if (!isAdmin(req)) {
    req.flash('error', 'Only admin can access this page');
    return res.redirect('/remarks');
  }
  next();
};

// ─── Landing page ────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const staffId = req.session.user.staff_id;
    let mySubjects = [];
    let myClasses = [];

    if (isAdmin(req)) {
      [mySubjects] = await db.query(
        `SELECT ts.id, ts.class_id, ts.subject_id, c.class_name, c.section, sub.name AS subject_name,
                s.first_name, s.last_name
         FROM teacher_subjects ts
         JOIN classes c ON ts.class_id=c.id
         JOIN subjects sub ON ts.subject_id=sub.id
         JOIN staff s ON ts.staff_id=s.id
         ORDER BY c.class_name, c.section, sub.name`);
      [myClasses] = await db.query(
        `SELECT c.id, c.class_name, c.section, s.first_name, s.last_name
         FROM classes c LEFT JOIN staff s ON c.class_teacher_id=s.id
         WHERE c.class_teacher_id IS NOT NULL
         ORDER BY c.class_name, c.section`);
    } else if (staffId) {
      [mySubjects] = await db.query(
        `SELECT ts.id, ts.class_id, ts.subject_id, c.class_name, c.section, sub.name AS subject_name
         FROM teacher_subjects ts
         JOIN classes c ON ts.class_id=c.id
         JOIN subjects sub ON ts.subject_id=sub.id
         WHERE ts.staff_id=?
         ORDER BY c.class_name, c.section, sub.name`, [staffId]);
      [myClasses] = await db.query(
        `SELECT id, class_name, section FROM classes WHERE class_teacher_id=? ORDER BY class_name, section`, [staffId]);
    }

    const [terms] = await db.query('SELECT * FROM exam_terms WHERE is_active=1 ORDER BY sort_order, start_date');

    res.render('remarks/index', {
      title: 'Progress / Remarks', activePage: 'remarks',
      mySubjects, myClasses, terms,
      admin: isAdmin(req), linked: !!staffId || isAdmin(req)
    });
  } catch (err) {
    console.error(err);
    req.flash('error', 'Could not load remarks page');
    res.redirect('/dashboard');
  }
});

// ─── Subject marks & remarks entry ───────────────────────────────────────────
router.get('/marks', async (req, res) => {
  try {
    const { class_id, subject_id, exam_term_id } = req.query;
    const [classes] = await db.query('SELECT * FROM classes WHERE academic_year_id=1 ORDER BY class_name, section');
    const [subjects] = await db.query('SELECT * FROM subjects WHERE is_active=1 ORDER BY name');
    const [terms] = await db.query('SELECT * FROM exam_terms WHERE is_active=1 ORDER BY sort_order, start_date');
    let students = [], existing = [], allowed = isAdmin(req), term = null;

    if (class_id && subject_id && exam_term_id) {
      if (!allowed) {
        const staffId = req.session.user.staff_id;
        if (staffId) {
          const [[perm]] = await db.query(
            'SELECT 1 FROM teacher_subjects WHERE staff_id=? AND subject_id=? AND class_id=?',
            [staffId, subject_id, class_id]);
          allowed = !!perm;
        }
      }
      if (allowed) {
        [students] = await db.query("SELECT * FROM students WHERE class_id=? AND status='active' ORDER BY roll_no, first_name", [class_id]);
        [existing] = await db.query('SELECT * FROM student_marks WHERE class_id=? AND subject_id=? AND exam_term_id=?', [class_id, subject_id, exam_term_id]);
        term = terms.find(t => String(t.id) === String(exam_term_id));

        if (term && term.term_type === 'term' && (term.start_date || term.end_date)) {
          const startDate = term.start_date, endDate = term.end_date;
          for (const s of students) {
            const [[att]] = await db.query(
              `SELECT COUNT(*) total, SUM(status='Present') present, SUM(status='Late') late
               FROM attendance_student WHERE student_id=? AND date BETWEEN ? AND ?`,
              [s.id, startDate, endDate]
            );
            const total = Number(att.total) || 0;
            const present = Number(att.present) || 0;
            const late = Number(att.late) || 0;
            s.attendancePct = total > 0 ? Math.round(((present + late) / total) * 1000) / 10 : 0;
          }
        }
      } else {
        req.flash('error', 'You are not assigned to teach this subject for this class');
      }
    }

    const subjectName = (subjects.find(s => String(s.id) === String(subject_id)) || {}).name || '';

    res.render('remarks/marks', {
      title: 'Enter Marks & Remarks', activePage: 'remarks',
      classes, subjects, terms, students, existing, term, subjectName,
      class_id, subject_id, exam_term_id, allowed
    });
  } catch (err) {
    console.error(err);
    req.flash('error', 'Could not load marks entry page');
    res.redirect('/remarks');
  }
});

router.post('/marks', async (req, res) => {
  const { class_id, subject_id, exam_term_id, marks } = req.body;
  try {
    if (!isAdmin(req)) {
      const staffId = req.session.user.staff_id;
      const [[perm]] = staffId
        ? await db.query('SELECT 1 FROM teacher_subjects WHERE staff_id=? AND subject_id=? AND class_id=?', [staffId, subject_id, class_id])
        : [[null]];
      if (!perm) {
        req.flash('error', 'You are not assigned to teach this subject for this class');
        return res.redirect('/remarks');
      }
    }
    const [[term]] = await db.query('SELECT * FROM exam_terms WHERE id=?', [exam_term_id]);
    const [students] = await db.query("SELECT id FROM students WHERE class_id=? AND status='active'", [class_id]);
    for (const s of students) {
      const m = (marks && marks['s' + s.id]) || {};
      const template_remark = term && term.term_type === 'term' ? (m.template_remark || null) : null;
      await db.query(
        `INSERT INTO student_marks
           (student_id, subject_id, class_id, exam_term_id, marks_obtained, max_marks, template_remark, entered_by)
         VALUES (?,?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE
           marks_obtained=VALUES(marks_obtained), max_marks=VALUES(max_marks),
           template_remark=VALUES(template_remark), entered_by=VALUES(entered_by)`,
        [s.id, subject_id, class_id, exam_term_id,
         m.marks_obtained || null, m.max_marks || 100, template_remark,
         req.session.user.id]
      );
    }
    req.flash('success', 'Marks & remarks saved successfully');
  } catch (err) {
    console.error(err);
    req.flash('error', 'Failed to save marks & remarks');
  }
  res.redirect(`/remarks/marks?class_id=${class_id}&subject_id=${subject_id}&exam_term_id=${exam_term_id}`);
});

// ─── Class-teacher overall remarks entry ─────────────────────────────────────
router.get('/overall', async (req, res) => {
  try {
    const { class_id, exam_term_id } = req.query;
    const [classes] = await db.query('SELECT * FROM classes WHERE academic_year_id=1 ORDER BY class_name, section');
    const [terms] = await db.query('SELECT * FROM exam_terms WHERE is_active=1 ORDER BY sort_order, start_date');
    let students = [], existing = [], allowed = isAdmin(req);

    if (class_id && exam_term_id) {
      if (!allowed) {
        const staffId = req.session.user.staff_id;
        if (staffId) {
          const [[cls]] = await db.query('SELECT 1 FROM classes WHERE id=? AND class_teacher_id=?', [class_id, staffId]);
          allowed = !!cls;
        }
      }
      if (allowed) {
        [students] = await db.query("SELECT * FROM students WHERE class_id=? AND status='active' ORDER BY roll_no, first_name", [class_id]);
        [existing] = await db.query('SELECT * FROM student_overall_remarks WHERE class_id=? AND exam_term_id=?', [class_id, exam_term_id]);
      } else {
        req.flash('error', 'You can only enter overall remarks for a class you are the class teacher of');
      }
    }

    res.render('remarks/overall', {
      title: 'Overall Remarks', activePage: 'remarks',
      classes, terms, students, existing, class_id, exam_term_id, allowed
    });
  } catch (err) {
    console.error(err);
    req.flash('error', 'Could not load overall remarks page');
    res.redirect('/remarks');
  }
});

router.post('/overall', async (req, res) => {
  const { class_id, exam_term_id, remark } = req.body;
  try {
    if (!isAdmin(req)) {
      const staffId = req.session.user.staff_id;
      const [[cls]] = staffId
        ? await db.query('SELECT 1 FROM classes WHERE id=? AND class_teacher_id=?', [class_id, staffId])
        : [[null]];
      if (!cls) {
        req.flash('error', 'You can only enter overall remarks for a class you are the class teacher of');
        return res.redirect('/remarks');
      }
    }
    const [students] = await db.query("SELECT id FROM students WHERE class_id=? AND status='active'", [class_id]);
    for (const s of students) {
      const r = (remark && remark['s' + s.id]) || {};
      await db.query(
        `INSERT INTO student_overall_remarks
           (student_id, class_id, exam_term_id, participation_engagement, attendance_punctuality_note,
            discipline_conduct, peer_interaction, co_scholastic_activities, notable_improvement, goals_for_term, entered_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE
           participation_engagement=VALUES(participation_engagement), attendance_punctuality_note=VALUES(attendance_punctuality_note),
           discipline_conduct=VALUES(discipline_conduct), peer_interaction=VALUES(peer_interaction),
           co_scholastic_activities=VALUES(co_scholastic_activities), notable_improvement=VALUES(notable_improvement),
           goals_for_term=VALUES(goals_for_term), entered_by=VALUES(entered_by)`,
        [s.id, class_id, exam_term_id, r.participation_engagement || null, r.attendance_punctuality_note || null,
         r.discipline_conduct || null, r.peer_interaction || null, r.co_scholastic_activities || null,
         r.notable_improvement || null, r.goals_for_term || null, req.session.user.id]
      );
    }
    req.flash('success', 'Overall remarks saved successfully');
  } catch (err) {
    console.error(err);
    req.flash('error', 'Failed to save overall remarks');
  }
  res.redirect(`/remarks/overall?class_id=${class_id}&exam_term_id=${exam_term_id}`);
});

// ─── Admin: Assign teachers to class/subject ─────────────────────────────────
router.get('/assign', requireAdmin, async (req, res) => {
  const [assignments] = await db.query(
    `SELECT ts.*, s.first_name, s.last_name, c.class_name, c.section, sub.name AS subject_name
     FROM teacher_subjects ts
     JOIN staff s ON ts.staff_id=s.id
     JOIN classes c ON ts.class_id=c.id
     JOIN subjects sub ON ts.subject_id=sub.id
     ORDER BY c.class_name, c.section, sub.name`);
  res.render('remarks/assign', { title: 'Assign Teachers', activePage: 'remarks', assignments });
});

router.get('/assign/add', requireAdmin, async (req, res) => {
  const [staffList] = await db.query("SELECT * FROM staff WHERE staff_type='Teaching' AND is_active=1 ORDER BY first_name");
  const [classes] = await db.query('SELECT * FROM classes WHERE academic_year_id=1 ORDER BY class_name, section');
  const [subjects] = await db.query('SELECT * FROM subjects WHERE is_active=1 ORDER BY name');
  res.render('remarks/assign-add', { title: 'Assign Teacher', activePage: 'remarks', staffList, classes, subjects });
});

router.post('/assign/add', requireAdmin, async (req, res) => {
  try {
    const { staff_id, subject_id, class_id } = req.body;
    await db.query(
      `INSERT INTO teacher_subjects (staff_id, subject_id, class_id, academic_year_id) VALUES (?,?,?,1)
       ON DUPLICATE KEY UPDATE staff_id=staff_id`,
      [staff_id, subject_id, class_id]
    );
    req.flash('success', 'Teacher assigned successfully');
    res.redirect('/remarks/assign');
  } catch (err) {
    console.error(err);
    req.flash('error', 'Failed to assign teacher');
    res.redirect('/remarks/assign/add');
  }
});

router.post('/assign/:id/delete', requireAdmin, async (req, res) => {
  await db.query('DELETE FROM teacher_subjects WHERE id=?', [req.params.id]);
  req.flash('success', 'Assignment removed');
  res.redirect('/remarks/assign');
});

// ─── Admin: Link teacher logins to staff records ─────────────────────────────
router.get('/link-teachers', requireAdmin, async (req, res) => {
  const [users] = await db.query("SELECT * FROM users WHERE role='teacher' ORDER BY name");
  const [staffList] = await db.query("SELECT * FROM staff WHERE staff_type='Teaching' AND is_active=1 ORDER BY first_name");
  res.render('remarks/link-teachers', { title: 'Link Teacher Logins', activePage: 'remarks', users, staffList });
});

router.post('/link-teachers', requireAdmin, async (req, res) => {
  try {
    const { user_id, staff_id } = req.body;
    await db.query('UPDATE users SET staff_id=? WHERE id=?', [staff_id || null, user_id]);
    req.flash('success', 'Teacher login linked successfully');
  } catch (err) {
    console.error(err);
    req.flash('error', 'Failed to link teacher');
  }
  res.redirect('/remarks/link-teachers');
});

// ─── Admin: Exam terms CRUD ───────────────────────────────────────────────────
router.get('/terms', requireAdmin, async (req, res) => {
  const [terms] = await db.query('SELECT * FROM exam_terms ORDER BY sort_order, start_date');
  res.render('remarks/terms', { title: 'Exam Terms', activePage: 'remarks', terms });
});

router.get('/terms/add', requireAdmin, (req, res) => {
  res.render('remarks/terms-add', { title: 'Add Exam Term', activePage: 'remarks' });
});

router.post('/terms/add', requireAdmin, async (req, res) => {
  const b = req.body;
  await db.query(
    `INSERT INTO exam_terms (name, academic_year_id, start_date, end_date, max_marks_default, sort_order) VALUES (?,1,?,?,?,?)`,
    [b.name, b.start_date || null, b.end_date || null, b.max_marks_default || 100, b.sort_order || 0]
  );
  req.flash('success', 'Exam term added');
  res.redirect('/remarks/terms');
});

// ─── Admin: Subjects CRUD ─────────────────────────────────────────────────────
router.get('/subjects', requireAdmin, async (req, res) => {
  const [subjects] = await db.query('SELECT * FROM subjects ORDER BY name');
  res.render('remarks/subjects', { title: 'Subjects', activePage: 'remarks', subjects });
});

router.get('/subjects/add', requireAdmin, (req, res) => {
  res.render('remarks/subjects-add', { title: 'Add Subject', activePage: 'remarks' });
});

router.post('/subjects/add', requireAdmin, async (req, res) => {
  const b = req.body;
  await db.query('INSERT IGNORE INTO subjects (name, code) VALUES (?,?)', [b.name, b.code || null]);
  req.flash('success', 'Subject added');
  res.redirect('/remarks/subjects');
});

module.exports = router;

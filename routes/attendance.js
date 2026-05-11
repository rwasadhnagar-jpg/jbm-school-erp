const express = require('express');
const router = express.Router();
const db = require('../db');

router.get('/', async (req, res) => {
  const [classes] = await db.query('SELECT * FROM classes WHERE academic_year_id=1 ORDER BY class_name,section');
  res.render('attendance/index', { title: 'Student Attendance', activePage: 'attendance', classes });
});

router.get('/take', async (req, res) => {
  try {
    const { class_id, date } = req.query;
    const today = date || new Date().toISOString().split('T')[0];
    const [classes] = await db.query('SELECT * FROM classes WHERE academic_year_id=1 ORDER BY class_name,section');
    let students = [];
    let existing = [];
    if (class_id) {
      [students] = await db.query("SELECT * FROM students WHERE class_id=? AND status='active' ORDER BY roll_no,first_name", [class_id]);
      [existing] = await db.query('SELECT * FROM attendance_student WHERE class_id=? AND date=?', [class_id, today]);
    }
    res.render('attendance/take', { title: 'Take Attendance', activePage: 'attendance', classes, students, existing, class_id, today });
  } catch (err) {
    console.error(err);
    res.redirect('/attday');
  }
});

router.post('/take', async (req, res) => {
  try {
    const { class_id, date, attendance } = req.body;
    const [students] = await db.query("SELECT id FROM students WHERE class_id=? AND status='active'", [class_id]);
    for (const s of students) {
      const status = (attendance && attendance[s.id]) || 'Absent';
      await db.query(
        `INSERT INTO attendance_student (student_id, class_id, date, status, marked_by)
         VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE status=?, marked_by=?`,
        [s.id, class_id, date, status, req.session.user.id, status, req.session.user.id]
      );
    }
    req.flash('success', 'Attendance saved successfully');
    res.redirect('/attday');
  } catch (err) {
    console.error(err);
    req.flash('error', 'Failed to save attendance');
    res.redirect('/attday');
  }
});

module.exports = router;

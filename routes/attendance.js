const express = require('express');
const router = express.Router();
const db = require('../db');

// Formats using local date parts — toISOString() would shift to UTC and land on the wrong calendar day for IST
function isoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Computes the list of dates to show for week/month grid modes, capped at today
function computeRange(mode, dateStr) {
  const d = dateStr ? new Date(dateStr + 'T00:00:00') : new Date();
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const dates = [];
  if (mode === 'week') {
    const day = d.getDay(); // 0=Sun..6=Sat
    const diffToMon = (day === 0 ? -6 : 1 - day);
    const monday = new Date(d); monday.setDate(d.getDate() + diffToMon);
    for (let i = 0; i < 6; i++) { // Mon-Sat
      const dt = new Date(monday); dt.setDate(monday.getDate() + i);
      if (dt <= today) dates.push(isoDate(dt));
    }
  } else if (mode === 'month') {
    const first = new Date(d.getFullYear(), d.getMonth(), 1);
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    for (let dt = new Date(first); dt <= last; dt.setDate(dt.getDate() + 1)) {
      if (dt <= today) dates.push(isoDate(dt));
    }
  }
  return dates;
}

router.get('/', async (req, res) => {
  const [classes] = await db.query('SELECT * FROM classes WHERE academic_year_id=1 ORDER BY class_name,section');
  res.render('attendance/index', { title: 'Student Attendance', activePage: 'attendance', classes });
});

router.get('/take', async (req, res) => {
  try {
    const { class_id, date } = req.query;
    const today = date || new Date().toISOString().split('T')[0];
    const mode = ['week', 'month'].includes(req.query.mode) ? req.query.mode : 'day';
    const dates = mode === 'day' ? [today] : computeRange(mode, today);
    const [classes] = await db.query('SELECT * FROM classes WHERE academic_year_id=1 ORDER BY class_name,section');
    let students = [];
    let existing = [];
    if (class_id) {
      [students] = await db.query("SELECT * FROM students WHERE class_id=? AND status='active' ORDER BY roll_no,first_name", [class_id]);
      if (dates.length) {
        const placeholders = dates.map(() => '?').join(',');
        [existing] = await db.query(`SELECT * FROM attendance_student WHERE class_id=? AND date IN (${placeholders})`, [class_id, ...dates]);
      }
    }
    res.render('attendance/take', { title: 'Take Attendance', activePage: 'attendance', classes, students, existing, class_id, today, mode, dates });
  } catch (err) {
    console.error(err);
    res.redirect('/attday');
  }
});

router.post('/take', async (req, res) => {
  const { class_id, date, mode } = req.body;
  try {
    const [students] = await db.query("SELECT id FROM students WHERE class_id=? AND status='active'", [class_id]);

    if (mode === 'week' || mode === 'month') {
      const dates = Array.isArray(req.body.dates) ? req.body.dates : (req.body.dates ? [req.body.dates] : []);
      const attendance = req.body.attendance || {};
      for (const s of students) {
        for (const d of dates) {
          const status = (attendance['s' + s.id] && attendance['s' + s.id][d]) || 'Absent';
          await db.query(
            `INSERT INTO attendance_student (student_id, class_id, date, status, marked_by)
             VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE status=?, marked_by=?`,
            [s.id, class_id, d, status, req.session.user.id, status, req.session.user.id]
          );
        }
      }
    } else {
      const attendance = req.body.attendance || {};
      for (const s of students) {
        const status = attendance['s' + s.id] || 'Absent';
        await db.query(
          `INSERT INTO attendance_student (student_id, class_id, date, status, marked_by)
           VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE status=?, marked_by=?`,
          [s.id, class_id, date, status, req.session.user.id, status, req.session.user.id]
        );
      }
    }
    req.flash('success', 'Attendance saved successfully');
    res.redirect(`/attday/take?class_id=${class_id}&mode=${mode || 'day'}`);
  } catch (err) {
    console.error(err);
    req.flash('error', 'Failed to save attendance');
    res.redirect('/attday');
  }
});

module.exports = router;

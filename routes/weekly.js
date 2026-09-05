const express = require('express');
const router = express.Router();
const db = require('../db');

// === DB INIT (mirrors routes/remarks.js self-migrating pattern) ===
(async () => {
  try {
    await db.query(`CREATE TABLE IF NOT EXISTS weekly_updates (
      id INT AUTO_INCREMENT PRIMARY KEY,
      class_id INT NOT NULL,
      week_start_date DATE NOT NULL,
      note TEXT,
      updated_by INT DEFAULT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY class_week (class_id, week_start_date)
    )`);
  } catch (e) { console.error('weekly_updates migration failed:', e.message); }
})();

// Local-date formatting — toISOString() shifts to UTC and lands on the wrong calendar day for IST
function isoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function getWeekStart(dateStr) {
  const d = dateStr ? new Date(dateStr + 'T00:00:00') : new Date();
  const day = d.getDay(); // 0=Sun..6=Sat
  const diffToMon = (day === 0 ? -6 : 1 - day);
  const monday = new Date(d);
  monday.setDate(d.getDate() + diffToMon);
  monday.setHours(0, 0, 0, 0);
  return monday;
}

async function weeklyAttendance(classId, fromDate, toDate) {
  const [[row]] = await db.query(
    `SELECT
       SUM(status='Present') AS present,
       SUM(status='Absent') AS absent,
       COUNT(*) AS total
     FROM attendance_student WHERE class_id=? AND date BETWEEN ? AND ?`,
    [classId, fromDate, toDate]
  );
  const total = Number(row.total) || 0;
  const present = Number(row.present) || 0;
  return { present, total, pct: total ? Math.round((present / total) * 100) : null };
}

async function upcomingNotices() {
  const today = isoDate(new Date());
  const weekAhead = isoDate(new Date(Date.now() + 7 * 86400000));
  const weekAgo = new Date(Date.now() - 7 * 86400000);
  const [notices] = await db.query(
    `SELECT * FROM notices
     WHERE (publish_date BETWEEN ? AND ?)
        OR (publish_date IS NULL AND created_at >= ?)
     ORDER BY COALESCE(publish_date, DATE(created_at)) ASC
     LIMIT 10`,
    [today, weekAhead, weekAgo]
  );
  return notices;
}

router.get('/', async (req, res) => {
  try {
    const monday = getWeekStart(req.query.date);
    const mondayStr = isoDate(monday);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
    const rangeEnd = isoDate(today < sunday ? today : sunday);
    const notices = await upcomingNotices();

    if (req.session.user.role === 'admin') {
      const [classes] = await db.query(
        `SELECT c.*, st.first_name AS teacher_first, st.last_name AS teacher_last,
                wu.note, wu.updated_at
         FROM classes c
         LEFT JOIN staff st ON st.id = c.class_teacher_id
         LEFT JOIN weekly_updates wu ON wu.class_id = c.id AND wu.week_start_date = ?
         WHERE c.academic_year_id = 1
         ORDER BY c.class_name, c.section`,
        [mondayStr]
      );
      const submittedCount = classes.filter(c => c.note).length;
      // school-wide (no class filter) — separate query since weeklyAttendance() assumes a class_id
      const [[wide]] = await db.query(
        `SELECT SUM(status='Present') AS present, COUNT(*) AS total FROM attendance_student WHERE date BETWEEN ? AND ?`,
        [mondayStr, rangeEnd]
      );
      const wideTotal = Number(wide.total) || 0;
      const wideTotalPct = wideTotal ? Math.round((Number(wide.present) || 0) / wideTotal * 100) : null;

      return res.render('weekly/index', {
        title: 'This Week', activePage: 'weekly',
        weekStart: mondayStr, weekEnd: rangeEnd,
        isAdmin: true, classes, submittedCount, totalClasses: classes.length,
        schoolAttendancePct: wideTotalPct, notices
      });
    }

    // Teacher view
    const staffId = req.session.user.staff_id;
    const [myClasses] = await db.query(
      `SELECT c.*, wu.note, wu.updated_at
       FROM classes c
       LEFT JOIN weekly_updates wu ON wu.class_id = c.id AND wu.week_start_date = ?
       WHERE c.class_teacher_id = ? AND c.academic_year_id = 1
       ORDER BY c.class_name, c.section`,
      [mondayStr, staffId]
    );
    for (const c of myClasses) {
      c.attendance = await weeklyAttendance(c.id, mondayStr, rangeEnd);
    }

    const [marksThisWeek] = await db.query(
      `SELECT sub.name AS subject_name, c.class_name, c.section, COUNT(*) AS cnt
       FROM student_marks sm
       JOIN teacher_subjects ts ON ts.subject_id = sm.subject_id AND ts.class_id = sm.class_id
       JOIN subjects sub ON sub.id = sm.subject_id
       JOIN classes c ON c.id = sm.class_id
       WHERE ts.staff_id = ? AND sm.updated_at BETWEEN ? AND DATE_ADD(?, INTERVAL 1 DAY)
       GROUP BY sub.name, c.class_name, c.section`,
      [staffId, mondayStr, rangeEnd]
    );

    res.render('weekly/index', {
      title: 'This Week', activePage: 'weekly',
      weekStart: mondayStr, weekEnd: rangeEnd,
      isAdmin: false, myClasses, marksThisWeek, notices
    });
  } catch (err) {
    console.error(err);
    req.flash('error', 'Could not load this week\'s update');
    res.redirect('/dashboard');
  }
});

router.post('/note', async (req, res) => {
  try {
    const { class_id, week_start_date, note } = req.body;
    if (req.session.user.role === 'teacher') {
      const [[cls]] = await db.query('SELECT class_teacher_id FROM classes WHERE id=?', [class_id]);
      if (!cls || cls.class_teacher_id !== req.session.user.staff_id) {
        req.flash('error', 'You can only update your own class');
        return res.redirect('/weekly');
      }
    }
    await db.query(
      `INSERT INTO weekly_updates (class_id, week_start_date, note, updated_by)
       VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE note=?, updated_by=?, updated_at=CURRENT_TIMESTAMP`,
      [class_id, week_start_date, note, req.session.user.id, note, req.session.user.id]
    );
    req.flash('success', 'This week\'s update saved');
  } catch (err) {
    console.error(err);
    req.flash('error', 'Failed to save update');
  }
  res.redirect('/weekly');
});

module.exports = router;

const express = require('express');
const router = express.Router();
const db = require('../db');

router.get('/', async (req, res) => {
  if (req.session.user && req.session.user.role === 'parent') return res.redirect('/portal/dashboard');
  if (req.session.user && req.session.user.role === 'student') return res.redirect('/portal/dashboard');
  // Vice Principal has no role in Teacher Performance any more (Academic Monitoring only).
  if (req.session.user && req.session.user.role === 'vice_principal') return res.redirect('/supervision');
  if (req.session.user && ['principal', 'incharge'].includes(req.session.user.role)) return res.redirect('/performance');
  try {
    const [[{ totalStudents }]] = await db.query('SELECT COUNT(*) as totalStudents FROM students WHERE status = "active"');
    const [[{ totalStaff }]] = await db.query('SELECT COUNT(*) as totalStaff FROM staff WHERE is_active = 1');
    const [[{ totalClasses }]] = await db.query('SELECT COUNT(*) as totalClasses FROM classes WHERE academic_year_id = 1');

    const today = new Date().toISOString().split('T')[0];
    const [[{ presentToday }]] = await db.query(
      'SELECT COUNT(*) as presentToday FROM attendance_student WHERE date = ? AND status = "Present"', [today]
    );
    const [[{ absentToday }]] = await db.query(
      'SELECT COUNT(*) as absentToday FROM attendance_student WHERE date = ? AND status = "Absent"', [today]
    );
    const [[{ staffPresentToday }]] = await db.query(
      'SELECT COUNT(*) as staffPresentToday FROM attendance_staff WHERE date = ? AND status = "Present"', [today]
    );

    const [[{ todayCollection }]] = await db.query(
      'SELECT COALESCE(SUM(amount_paid),0) as todayCollection FROM fee_payments WHERE payment_date = ?', [today]
    );
    const [[{ monthCollection }]] = await db.query(
      'SELECT COALESCE(SUM(amount_paid),0) as monthCollection FROM fee_payments WHERE MONTH(payment_date) = MONTH(CURDATE()) AND YEAR(payment_date) = YEAR(CURDATE())'
    );

    const [recentStudents] = await db.query(
      'SELECT s.*, c.class_name, c.section FROM students s LEFT JOIN classes c ON s.class_id = c.id ORDER BY s.created_at DESC LIMIT 5'
    );
    const [pendingLeaves] = await db.query(
      'SELECT * FROM leave_requests WHERE status = "Pending" LIMIT 5'
    );
    const [recentNotices] = await db.query(
      'SELECT * FROM notices ORDER BY created_at DESC LIMIT 5'
    );

    // This-week snapshot (Monday through today)
    const now = new Date();
    const dow = now.getDay();
    const monday = new Date(now); monday.setDate(now.getDate() + (dow === 0 ? -6 : 1 - dow));
    const mondayStr = `${monday.getFullYear()}-${String(monday.getMonth()+1).padStart(2,'0')}-${String(monday.getDate()).padStart(2,'0')}`;
    const [[weekAttRow]] = await db.query(
      'SELECT SUM(status="Present") AS present, COUNT(*) AS total FROM attendance_student WHERE date BETWEEN ? AND ?',
      [mondayStr, today]
    );
    const weekTotal = Number(weekAttRow.total) || 0;
    const weekAttendancePct = weekTotal ? Math.round((Number(weekAttRow.present) || 0) / weekTotal * 100) : null;
    const [[weekUpdatesRow]] = await db.query(
      'SELECT COUNT(*) AS cnt FROM weekly_updates WHERE week_start_date=?', [mondayStr]
    ).catch(() => [[{ cnt: 0 }]]);

    res.render('dashboard', {
      title: 'Dashboard',
      activePage: 'dashboard',
      stats: { totalStudents, totalStaff, totalClasses, presentToday, absentToday, staffPresentToday, todayCollection, monthCollection },
      recentStudents,
      pendingLeaves,
      recentNotices,
      week: { attendancePct: weekAttendancePct, classesUpdated: weekUpdatesRow.cnt, totalClasses },
      layout: 'layout'
    });
  } catch (err) {
    console.error(err);
    res.render('dashboard', {
      title: 'Dashboard',
      activePage: 'dashboard',
      stats: { totalStudents: 0, totalStaff: 0, totalClasses: 0, presentToday: 0, absentToday: 0, staffPresentToday: 0, todayCollection: 0, monthCollection: 0 },
      recentStudents: [],
      pendingLeaves: [],
      recentNotices: [],
      week: { attendancePct: null, classesUpdated: 0, totalClasses: 0 },
      layout: 'layout'
    });
  }
});

module.exports = router;

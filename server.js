const path = require('path');
require('dotenv').config({ path: path.join(__dirname, process.env.ENV_FILE || '.env') });
const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const methodOverride = require('method-override');
const moment = require('moment');
const cron = require('node-cron');
const { runBackup } = require('./backup');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 5052;

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Middleware
app.use(express.urlencoded({ extended: true, limit: '10mb', parameterLimit: 100000 }));
app.use(express.json({ limit: '10mb' }));
app.use(methodOverride('_method'));
app.use(express.static(path.join(__dirname, 'public')));

// Session
app.use(session({
  secret: process.env.SESSION_SECRET || 'jbmerp2026',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 } // 8 hours
}));

app.use(flash());

// Global locals
app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.success = req.flash('success');
  res.locals.error = req.flash('error');
  res.locals.schoolName = process.env.SCHOOL_NAME || 'JBM Public School';
  res.locals.academicYear = process.env.ACADEMIC_YEAR || '2026-2027';
  res.locals.moment = moment;
  next();
});

// Auth middleware
const requireLogin = (req, res, next) => {
  if (!req.session.user) return res.redirect('/login');
  next();
};

const requireRole = (...roles) => (req, res, next) => {
  if (!req.session.user) return res.redirect('/login');
  if (!roles.includes(req.session.user.role)) {
    req.flash('error', 'You do not have permission to access this page');
    return res.redirect('/dashboard');
  }
  next();
};

// Routes
const authRoutes = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');
const studentRoutes = require('./routes/students');
const feeRoutes = require('./routes/fees');
const staffRoutes = require('./routes/staff');
const attendanceRoutes = require('./routes/attendance');
const admissionRoutes = require('./routes/admissions');
const libraryRoutes = require('./routes/library');
const transportRoutes = require('./routes/transport');
const hostelRoutes = require('./routes/hostel');
const salaryRoutes = require('./routes/salary');
const noticeRoutes = require('./routes/notices');
const configRoutes = require('./routes/config');
const certificateRoutes = require('./routes/certificates');
const smsRoutes = require('./routes/sms');
const portalRoutes = require('./routes/student');
const remarksRoutes = require('./routes/remarks');
const weeklyRoutes = require('./routes/weekly');
const performanceRoutes = require('./routes/performance');
const supervisionRoutes = require('./routes/supervision');
const notifications = require('./routes/notifications');

app.use('/', authRoutes);
app.use('/portal', portalRoutes);
app.use('/dashboard', requireLogin, dashboardRoutes);
app.use('/studentadministration', requireRole('admin'), studentRoutes);
app.use('/feemanagement', requireRole('admin', 'accountant'), feeRoutes);
app.use('/teachers', requireRole('admin'), staffRoutes);
app.use('/attday', requireRole('admin', 'teacher'), attendanceRoutes);
app.use('/registration', requireRole('admin'), admissionRoutes);
app.use('/lms', requireRole('admin', 'librarian'), libraryRoutes);
app.use('/transport', requireRole('admin', 'transport'), transportRoutes);
app.use('/hostel', requireRole('admin'), hostelRoutes);
app.use('/sal', requireRole('admin', 'accountant'), salaryRoutes);
app.use('/notices', requireRole('admin'), noticeRoutes);
app.use('/remarks', requireRole('admin', 'teacher'), remarksRoutes);
app.use('/weekly', requireRole('admin', 'teacher'), weeklyRoutes);
app.use('/performance', requireRole('admin', 'teacher', 'principal', 'vice_principal', 'incharge'), performanceRoutes);
app.use('/supervision', requireRole('admin', 'principal', 'vice_principal', 'incharge'), supervisionRoutes);
app.use('/configuration', requireRole('admin'), configRoutes);
app.use('/certificates', requireRole('admin'), certificateRoutes);
app.use('/sms', requireRole('admin'), smsRoutes);
app.use('/notifications', requireLogin, notifications.router);

// Root redirect
app.get('/', (req, res) => {
  if (req.session.user) {
    if (req.session.user.role === 'parent') return res.redirect('/portal/dashboard');
    return res.redirect('/dashboard');
  }
  res.redirect('/login');
});

// 404
app.use((req, res) => {
  res.status(404).render('404', { title: 'Page Not Found' });
});

app.listen(PORT, () => {
  console.log(`\n✅ JBM School ERP running at http://localhost:${PORT}`);
  console.log(`📚 Academic Year: ${process.env.ACADEMIC_YEAR}`);
  console.log(`🔑 Login: admin@jbmps.com / admin123\n`);
});

// Daily backup at 11:30 PM every night
cron.schedule('30 23 * * *', async () => {
  console.log('🔄 Running scheduled daily backup...');
  try {
    const file = await runBackup();
    console.log(`✅ Daily backup complete: ${file}`);
  } catch (e) {
    console.error('❌ Backup failed:', e.message);
  }
}, { timezone: 'Asia/Kolkata' });

// Daily 10 AM: remind class teachers who haven't marked today's attendance yet
async function runAttendanceReminder() {
  try {
    const today = new Date().toISOString().split('T')[0];
    const [classes] = await db.query(
      `SELECT c.id, c.class_name, c.section, u.id AS user_id
       FROM classes c JOIN users u ON u.staff_id = c.class_teacher_id
       WHERE c.class_teacher_id IS NOT NULL AND c.academic_year_id=1`
    );
    for (const c of classes) {
      const [[row]] = await db.query('SELECT COUNT(*) cnt FROM attendance_student WHERE class_id=? AND date=?', [c.id, today]);
      if (Number(row.cnt) === 0) {
        await notifications.sendPushToUser(c.user_id, {
          title: 'Attendance Reminder',
          body: `Don't forget to mark today's attendance for ${c.class_name}-${c.section}.`
        });
      }
    }
  } catch (e) { console.error('attendance reminder failed:', e.message); }
}
cron.schedule('0 10 * * *', runAttendanceReminder, { timezone: 'Asia/Kolkata' });

// Daily 9 AM (within 3 days of an active exam term's end date): remind teachers of pending marks
async function runMarksReminder() {
  try {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const [terms] = await db.query("SELECT * FROM exam_terms WHERE is_active=1 AND end_date IS NOT NULL");
    for (const term of terms) {
      const endDate = new Date(term.end_date);
      const daysLeft = Math.round((endDate - today) / 86400000);
      if (daysLeft < 0 || daysLeft > 3) continue;

      const [assignments] = await db.query(
        `SELECT ts.*, u.id AS user_id, c.class_name, c.section, sub.name AS subject_name
         FROM teacher_subjects ts
         JOIN users u ON u.staff_id = ts.staff_id
         JOIN classes c ON ts.class_id = c.id
         JOIN subjects sub ON ts.subject_id = sub.id`
      );
      for (const a of assignments) {
        const [[activeCount]] = await db.query("SELECT COUNT(*) cnt FROM students WHERE class_id=? AND status='active'", [a.class_id]);
        const [[markedCount]] = await db.query(
          'SELECT COUNT(*) cnt FROM student_marks WHERE class_id=? AND subject_id=? AND exam_term_id=? AND marks_obtained IS NOT NULL',
          [a.class_id, a.subject_id, term.id]
        );
        if (Number(markedCount.cnt) < Number(activeCount.cnt)) {
          await notifications.sendPushToUser(a.user_id, {
            title: 'Marks Due Soon',
            body: `${term.name} marks for ${a.subject_name} — ${a.class_name}-${a.section} are due by ${term.end_date}. Please complete entry.`
          });
        }
      }
    }
  } catch (e) { console.error('marks reminder failed:', e.message); }
}
cron.schedule('0 9 * * *', runMarksReminder, { timezone: 'Asia/Kolkata' });

// Monday 8 AM: remind class teachers who haven't posted this week's class update yet
async function runWeeklyUpdateReminder() {
  try {
    const now = new Date();
    const day = now.getDay(); // 0=Sun..6=Sat
    const diffToMon = (day === 0 ? -6 : 1 - day);
    const monday = new Date(now); monday.setDate(now.getDate() + diffToMon);
    const mondayStr = `${monday.getFullYear()}-${String(monday.getMonth()+1).padStart(2,'0')}-${String(monday.getDate()).padStart(2,'0')}`;

    const [classes] = await db.query(
      `SELECT c.id, c.class_name, c.section, u.id AS user_id
       FROM classes c JOIN users u ON u.staff_id = c.class_teacher_id
       WHERE c.class_teacher_id IS NOT NULL AND c.academic_year_id=1`
    );
    for (const c of classes) {
      const [[row]] = await db.query('SELECT COUNT(*) cnt FROM weekly_updates WHERE class_id=? AND week_start_date=?', [c.id, mondayStr]);
      if (Number(row.cnt) === 0) {
        await notifications.sendPushToUser(c.user_id, {
          title: 'Weekly Update Reminder',
          body: `Add this week's class update for ${c.class_name}-${c.section}.`
        });
      }
    }
  } catch (e) { console.error('weekly update reminder failed:', e.message); }
}
cron.schedule('0 8 * * 1', runWeeklyUpdateReminder, { timezone: 'Asia/Kolkata' });

// 3rd of each month, 9 AM: remind each wing Incharge of staff in their own wing still missing
// last month's performance review (only the Incharge enters these now — Principal/Admin just
// review/edit, so they aren't nagged for "missing" entries the same way).
async function runPerformanceReviewReminder() {
  try {
    const now = new Date();
    const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const prevMonthStr = `${prevMonth.getFullYear()}-${String(prevMonth.getMonth() + 1).padStart(2, '0')}-01`;
    const [incharges] = await db.query("SELECT id, wing FROM users WHERE role='incharge' AND is_active=1 AND wing IS NOT NULL");
    for (const inc of incharges) {
      const [[{ cnt: totalStaff }]] = await db.query(
        "SELECT COUNT(*) cnt FROM staff WHERE staff_type='Teaching' AND is_active=1 AND wing=?", [inc.wing]
      );
      if (Number(totalStaff) === 0) continue;
      const [[row]] = await db.query(
        `SELECT COUNT(DISTINCT r.staff_id) cnt FROM performance_monthly_reviews r
         JOIN staff s ON s.id = r.staff_id
         WHERE r.month_date=? AND s.wing=? AND (r.syllabus_pace IS NOT NULL OR r.classroom_mgmt IS NOT NULL
           OR r.homework_correction IS NOT NULL OR r.parent_comm IS NOT NULL OR r.admin_compliance IS NOT NULL
           OR r.cocurricular IS NOT NULL OR r.professional_dev IS NOT NULL OR r.behaviour_teamwork IS NOT NULL
           OR r.overall_holistic IS NOT NULL)`,
        [prevMonthStr, inc.wing]
      );
      const missing = Number(totalStaff) - Number(row.cnt);
      if (missing > 0) {
        await notifications.sendPushToUser(inc.id, {
          title: 'Monthly Teacher Reviews Due',
          body: `${missing} teacher(s) still need last month's review from you.`
        });
      }
    }
  } catch (e) { console.error('performance review reminder failed:', e.message); }
}
cron.schedule('0 9 3 * *', runPerformanceReviewReminder, { timezone: 'Asia/Kolkata' });

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const methodOverride = require('method-override');
const moment = require('moment');
const cron = require('node-cron');
const { runBackup } = require('./backup');

const app = express();
const PORT = process.env.PORT || 5052;

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
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

app.use('/', authRoutes);
app.use('/dashboard', requireLogin, dashboardRoutes);
app.use('/studentadministration', requireLogin, studentRoutes);
app.use('/feemanagement', requireLogin, feeRoutes);
app.use('/teachers', requireLogin, staffRoutes);
app.use('/attday', requireLogin, attendanceRoutes);
app.use('/registration', requireLogin, admissionRoutes);
app.use('/lms', requireLogin, libraryRoutes);
app.use('/transport', requireLogin, transportRoutes);
app.use('/hostel', requireLogin, hostelRoutes);
app.use('/sal', requireLogin, salaryRoutes);
app.use('/notices', requireLogin, noticeRoutes);
app.use('/configuration', requireLogin, configRoutes);
app.use('/certificates', requireLogin, certificateRoutes);
app.use('/sms', requireLogin, smsRoutes);

// Root redirect
app.get('/', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
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

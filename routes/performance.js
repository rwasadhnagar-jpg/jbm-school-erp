const express = require('express');
const router = express.Router();
const db = require('../db');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const xlsxLib = require('xlsx');
const uploadExcel = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
let PDFDocument;
try { PDFDocument = require('pdfkit'); } catch (e) { console.error('pdfkit not available:', e.message); }

const {
  WEIGHT_DEFAULTS, getWeights, monthScore, combineMonthScores, computeStudentOutcomesAuto,
  computeAnnualSummary, proposedIncrement, recommendedAction,
} = require('../utils/performanceCalc');

const RATER_ROLE_MAP = { principal: 'Principal', vice_principal: 'Vice Principal', incharge: 'Incharge' };
const ACADEMIC_YEAR_ID = 1;

// === DB INIT (self-migrating, mirrors routes/salary.js / routes/remarks.js pattern) ===
(async () => {
  try {
    await db.query('ALTER TABLE staff ADD COLUMN IF NOT EXISTS date_of_leaving DATE DEFAULT NULL');
    await db.query('ALTER TABLE staff ADD COLUMN IF NOT EXISTS years_of_service_override DECIMAL(4,1) DEFAULT NULL');

    await db.query(`CREATE TABLE IF NOT EXISTS performance_monthly_reviews (
      id INT AUTO_INCREMENT PRIMARY KEY,
      staff_id INT NOT NULL,
      month_date DATE NOT NULL,
      academic_year_id INT DEFAULT 1,
      rater ENUM('Principal','Vice Principal','Incharge') NOT NULL,
      attendance_pct DECIMAL(5,2) DEFAULT NULL,
      late_arrivals INT DEFAULT 0,
      syllabus_pace DECIMAL(3,1) DEFAULT NULL,
      classroom_mgmt DECIMAL(3,1) DEFAULT NULL,
      homework_correction DECIMAL(3,1) DEFAULT NULL,
      parent_complaints INT DEFAULT 0,
      discipline_issues INT DEFAULT 0,
      academic_flags INT DEFAULT 0,
      student_outcomes_override DECIMAL(3,1) DEFAULT NULL,
      parent_comm DECIMAL(3,1) DEFAULT NULL,
      admin_compliance DECIMAL(3,1) DEFAULT NULL,
      cocurricular DECIMAL(3,1) DEFAULT NULL,
      professional_dev DECIMAL(3,1) DEFAULT NULL,
      behaviour_teamwork DECIMAL(3,1) DEFAULT NULL,
      overall_holistic DECIMAL(3,1) DEFAULT NULL,
      notes TEXT,
      entered_by INT DEFAULT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY staff_month_rater (staff_id, month_date, rater)
    )`);

    await db.query(`CREATE TABLE IF NOT EXISTS performance_memos (
      id INT AUTO_INCREMENT PRIMARY KEY,
      staff_id INT NOT NULL,
      memo_date DATE NOT NULL,
      category ENUM('Discipline','Punctuality','Academic Non-Performance','Other') NOT NULL,
      description TEXT,
      issued_by INT DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    await db.query(`CREATE TABLE IF NOT EXISTS performance_annual_overrides (
      id INT AUTO_INCREMENT PRIMARY KEY,
      staff_id INT NOT NULL,
      academic_year_id INT NOT NULL,
      role_responsibility_score DECIMAL(3,1) DEFAULT NULL,
      UNIQUE KEY staff_ay (staff_id, academic_year_id)
    )`);

    for (const [k, v] of Object.entries(WEIGHT_DEFAULTS)) {
      await db.query('INSERT INTO configuration (key_name, value) VALUES (?,?) ON DUPLICATE KEY UPDATE key_name=key_name', [k, String(v)]);
    }
  } catch (e) { console.error('performance tables init:', e.message); }
})();

// === Access helpers ===
function isChairman(req) { return req.session.user && req.session.user.role === 'admin'; }
function myRaterLabel(req) { return RATER_ROLE_MAP[req.session.user.role]; }

const requireAdmin = (req, res, next) => {
  if (!isChairman(req)) { req.flash('error', 'Only admin can access this page'); return res.redirect('/performance'); }
  next();
};
const requireRaterOrAdmin = (req, res, next) => {
  if (isChairman(req) || myRaterLabel(req)) return next();
  req.flash('error', 'You do not have access to this page');
  res.redirect('/performance');
};
const requireAdminOrPrincipal = (req, res, next) => {
  if (isChairman(req) || (req.session.user && req.session.user.role === 'principal')) return next();
  req.flash('error', 'Only admin or principal can issue memos');
  res.redirect('/performance');
};

// === Date helpers ===
function isoDate(d) { return d.toISOString().slice(0, 10); }
function toISODate(v) {
  if (!v) return null;
  if (v instanceof Date) return isoDate(v);
  const s = String(v).trim();
  return s || null;
}
function monthsInRange(startDateStr, endDate) {
  const months = [];
  const d = new Date(startDateStr);
  d.setDate(1);
  const end = new Date(endDate.getFullYear(), endDate.getMonth(), 1);
  while (d <= end) { months.push(isoDate(d)); d.setMonth(d.getMonth() + 1); }
  return months;
}
const SCORED_FIELD_SQL = `(syllabus_pace IS NOT NULL OR classroom_mgmt IS NOT NULL OR homework_correction IS NOT NULL
  OR parent_comm IS NOT NULL OR admin_compliance IS NOT NULL OR cocurricular IS NOT NULL
  OR professional_dev IS NOT NULL OR behaviour_teamwork IS NOT NULL OR overall_holistic IS NOT NULL)`;

async function findOldestIncompleteMonth(months, raterLabel) {
  const [[{ cnt: totalStaff }]] = await db.query("SELECT COUNT(*) cnt FROM staff WHERE staff_type='Teaching' AND is_active=1");
  for (const m of months) {
    const [[row]] = await db.query(
      `SELECT COUNT(DISTINCT staff_id) cnt FROM performance_monthly_reviews WHERE month_date=? AND rater=? AND ${SCORED_FIELD_SQL}`,
      [m, raterLabel]
    );
    if (Number(row.cnt) < Number(totalStaff)) return m;
  }
  return months[months.length - 1];
}

// === Landing page ===
router.get('/', async (req, res) => {
  const role = req.session.user.role;
  if (role === 'admin') return res.redirect('/performance/annual');
  if (RATER_ROLE_MAP[role]) return res.redirect('/performance/monthly/entry');
  if (role === 'teacher') return res.redirect('/performance/my-report-card');
  req.flash('error', 'You do not have access to this module');
  res.redirect('/dashboard');
});

// === Weights & Settings ===
router.get('/settings', requireAdmin, async (req, res) => {
  const weights = await getWeights(db);
  res.render('performance/settings', { title: 'Performance Weights & Settings', activePage: 'performance', weights });
});

router.post('/settings', requireAdmin, async (req, res) => {
  try {
    for (const k of Object.keys(WEIGHT_DEFAULTS)) {
      if (req.body[k] !== undefined && req.body[k] !== '') {
        await db.query('INSERT INTO configuration (key_name, value) VALUES (?,?) ON DUPLICATE KEY UPDATE value=?', [k, req.body[k], req.body[k]]);
      }
    }
    req.flash('success', 'Weights & settings saved');
  } catch (err) {
    console.error(err);
    req.flash('error', 'Failed to save settings: ' + err.message);
  }
  res.redirect('/performance/settings');
});

// === Staff Roster ===
router.get('/roster', requireAdmin, async (req, res) => {
  const [staffList] = await db.query("SELECT * FROM staff WHERE staff_type='Teaching' ORDER BY is_active DESC, first_name");
  res.render('performance/roster', { title: 'Staff Roster', activePage: 'performance', staffList });
});

router.post('/roster/:id/edit', requireAdmin, async (req, res) => {
  try {
    const { date_of_leaving, years_of_service_override } = req.body;
    await db.query(
      'UPDATE staff SET date_of_leaving=?, years_of_service_override=?, is_active=? WHERE id=?',
      [date_of_leaving || null, years_of_service_override || null, date_of_leaving ? 0 : 1, req.params.id]
    );
    req.flash('success', 'Roster updated');
  } catch (err) {
    console.error(err);
    req.flash('error', 'Failed to update: ' + err.message);
  }
  res.redirect('/performance/roster');
});

// === Roster import (66 staff from the spreadsheet — staff table starts empty) ===
router.get('/roster/import', requireAdmin, (req, res) => {
  res.render('performance/roster-import', { title: 'Import Staff Roster', activePage: 'performance' });
});

router.post('/roster/import', requireAdmin, uploadExcel.single('file'), async (req, res) => {
  try {
    if (!req.file) { req.flash('error', 'No file uploaded'); return res.redirect('/performance/roster/import'); }
    const wb = xlsxLib.read(req.file.buffer, { type: 'buffer', cellDates: true });
    const ws = wb.Sheets['Staff Roster'] || wb.Sheets[wb.SheetNames[0]];
    const rows = xlsxLib.utils.sheet_to_json(ws, { defval: '', range: 2 });

    const results = [];
    for (const row of rows) {
      const rawName = String(row['Employee Name'] || '').trim();
      if (!rawName) continue;
      try {
        const staffType = String(row['Staff Type'] || 'Teaching').trim() === 'Non-Teaching' ? 'Non-Teaching' : 'Teaching';
        const parts = rawName.split(/\s+/);
        const first_name = parts[0];
        const last_name = parts.slice(1).join(' ') || '';
        const joining = toISODate(row['Date of Joining']);
        const dateOfLeaving = toISODate(row['Date of Leaving\n(blank = active)']);
        const yearsField = row['Years of Service\n(manual, if joining date unknown)'];
        const yearsOverride = yearsField !== '' && yearsField !== undefined ? Number(yearsField) : null;

        const [existing] = await db.query(
          'SELECT id FROM staff WHERE LOWER(first_name)=? AND LOWER(last_name)=?',
          [first_name.toLowerCase(), last_name.toLowerCase()]
        );
        if (existing.length) {
          await db.query(
            `UPDATE staff SET staff_type=?, joining_date=COALESCE(?,joining_date),
             date_of_leaving=?, years_of_service_override=?, is_active=? WHERE id=?`,
            [staffType, joining, dateOfLeaving, yearsOverride, dateOfLeaving ? 0 : 1, existing[0].id]
          );
          results.push({ name: rawName, status: 'updated (already existed)' });
        } else {
          await db.query(
            `INSERT INTO staff (first_name, last_name, staff_type, joining_date, date_of_leaving, years_of_service_override, is_active)
             VALUES (?,?,?,?,?,?,?)`,
            [first_name, last_name, staffType, joining, dateOfLeaving, yearsOverride, dateOfLeaving ? 0 : 1]
          );
          results.push({ name: rawName, status: 'created' });
        }
      } catch (e) {
        results.push({ name: rawName, status: 'error — ' + e.message });
      }
    }
    res.render('performance/roster-import-result', { title: 'Roster Import Result', activePage: 'performance', results });
  } catch (err) {
    console.error(err);
    req.flash('error', 'Import failed: ' + err.message);
    res.redirect('/performance/roster/import');
  }
});

// === Rater logins (Principal / Vice Principal / Incharge) ===
router.get('/raters', requireAdmin, async (req, res) => {
  const [raters] = await db.query("SELECT id, name, email, role, is_active FROM users WHERE role IN ('principal','vice_principal','incharge') ORDER BY role");
  res.render('performance/raters', { title: 'Rater Logins', activePage: 'performance', raters });
});

router.get('/raters/add', requireAdmin, (req, res) => {
  res.render('performance/raters-add', { title: 'Add Rater Login', activePage: 'performance' });
});

router.post('/raters/add', requireAdmin, async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    if (!RATER_ROLE_MAP[role]) throw new Error('Invalid role selected');
    const hash = await bcrypt.hash(password, 10);
    await db.query('INSERT INTO users (name, email, password, role) VALUES (?,?,?,?)', [name, email, hash, role]);
    req.flash('success', `${name} added as ${RATER_ROLE_MAP[role]}`);
    res.redirect('/performance/raters');
  } catch (err) {
    console.error(err);
    req.flash('error', 'Failed to add rater login: ' + err.message);
    res.redirect('/performance/raters/add');
  }
});

// === Monthly Review entry (blind — each rater only ever sees their own scores) ===
router.get('/monthly/entry', requireRaterOrAdmin, async (req, res) => {
  try {
    const raterLabel = isChairman(req) ? (req.query.rater || 'Principal') : myRaterLabel(req);
    const [[ay]] = await db.query('SELECT * FROM academic_years WHERE id=?', [ACADEMIC_YEAR_ID]);
    const months = monthsInRange(ay.start_date, new Date());
    let month = req.query.month;
    if (!month || !months.includes(month)) month = await findOldestIncompleteMonth(months, raterLabel);

    const [staffList] = await db.query("SELECT * FROM staff WHERE staff_type='Teaching' AND is_active=1 ORDER BY first_name");
    const [existingRows] = await db.query(
      'SELECT * FROM performance_monthly_reviews WHERE month_date=? AND rater=?', [month, raterLabel]
    );
    const existingByStaff = {};
    existingRows.forEach(r => { existingByStaff[r.staff_id] = r; });
    for (const s of staffList) {
      s.existing = existingByStaff[s.id] || {};
      s.outcomesAuto = await computeStudentOutcomesAuto(db, s.id, month);
    }

    res.render('performance/monthly-entry', {
      title: 'Monthly Review Entry', activePage: 'performance',
      staffList, month, months, raterLabel, isChairman: isChairman(req),
    });
  } catch (err) {
    console.error(err);
    req.flash('error', 'Could not load monthly entry page');
    res.redirect('/performance');
  }
});

router.post('/monthly/entry', requireRaterOrAdmin, async (req, res) => {
  const raterLabel = isChairman(req) ? req.body.rater : myRaterLabel(req);
  const month = req.body.month;
  try {
    if (!raterLabel || !month) throw new Error('Missing rater or month');
    const [staffList] = await db.query("SELECT id FROM staff WHERE staff_type='Teaching' AND is_active=1");
    for (const s of staffList) {
      const r = (req.body.review && req.body.review['s' + s.id]) || {};
      const anyValue = Object.values(r).some(v => v !== '' && v !== null && v !== undefined);
      if (!anyValue) continue;
      await db.query(
        `INSERT INTO performance_monthly_reviews
          (staff_id, month_date, academic_year_id, rater, attendance_pct, late_arrivals, syllabus_pace,
           classroom_mgmt, homework_correction, parent_complaints, discipline_issues, student_outcomes_override,
           parent_comm, admin_compliance, cocurricular, professional_dev, behaviour_teamwork, overall_holistic,
           notes, entered_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE
           attendance_pct=VALUES(attendance_pct), late_arrivals=VALUES(late_arrivals), syllabus_pace=VALUES(syllabus_pace),
           classroom_mgmt=VALUES(classroom_mgmt), homework_correction=VALUES(homework_correction),
           parent_complaints=VALUES(parent_complaints), discipline_issues=VALUES(discipline_issues),
           student_outcomes_override=VALUES(student_outcomes_override), parent_comm=VALUES(parent_comm),
           admin_compliance=VALUES(admin_compliance), cocurricular=VALUES(cocurricular),
           professional_dev=VALUES(professional_dev), behaviour_teamwork=VALUES(behaviour_teamwork),
           overall_holistic=VALUES(overall_holistic), notes=VALUES(notes), entered_by=VALUES(entered_by)`,
        [s.id, month, ACADEMIC_YEAR_ID, raterLabel,
         r.attendance_pct || null, r.late_arrivals || 0, r.syllabus_pace || null,
         r.classroom_mgmt || null, r.homework_correction || null, r.parent_complaints || 0, r.discipline_issues || 0,
         r.student_outcomes_override || null, r.parent_comm || null, r.admin_compliance || null,
         r.cocurricular || null, r.professional_dev || null, r.behaviour_teamwork || null, r.overall_holistic || null,
         r.notes || null, req.session.user.id]
      );
    }
    req.flash('success', 'Monthly reviews saved');
  } catch (err) {
    console.error(err);
    req.flash('error', 'Failed to save: ' + err.message);
  }
  const suffix = isChairman(req) ? `&rater=${encodeURIComponent(raterLabel || '')}` : '';
  res.redirect(`/performance/monthly/entry?month=${month}${suffix}`);
});

// === Admin: full monthly history across all raters ===
router.get('/monthly', requireAdmin, async (req, res) => {
  try {
    const { month, rater } = req.query;
    let q = `SELECT r.*, s.first_name, s.last_name FROM performance_monthly_reviews r JOIN staff s ON r.staff_id=s.id WHERE 1=1`;
    const p = [];
    if (month) { q += ' AND r.month_date=?'; p.push(month); }
    if (rater) { q += ' AND r.rater=?'; p.push(rater); }
    q += ' ORDER BY r.month_date DESC, s.first_name';
    const [rows] = await db.query(q, p);
    const weights = await getWeights(db);
    rows.forEach(r => { r.score = monthScore(r, weights); });

    let monthTop = [], monthBottom = [];
    if (month) {
      const [monthRows] = await db.query(
        `SELECT r.*, s.first_name, s.last_name FROM performance_monthly_reviews r
         JOIN staff s ON r.staff_id=s.id WHERE r.month_date=?`,
        [month]
      );
      const byStaff = {};
      monthRows.forEach(r => {
        if (!byStaff[r.staff_id]) byStaff[r.staff_id] = { staff: { id: r.staff_id, first_name: r.first_name, last_name: r.last_name }, rows: [] };
        byStaff[r.staff_id].rows.push(r);
      });
      const ranked = Object.values(byStaff)
        .map(entry => ({ staff: entry.staff, combined: combineMonthScores(entry.rows, weights) }))
        .filter(e => e.combined !== null)
        .sort((a, b) => b.combined - a.combined);
      monthTop = ranked.slice(0, 3);
      monthBottom = ranked.slice(-3).reverse().filter(e => !monthTop.includes(e));
    }

    res.render('performance/monthly-list', { title: 'Monthly Review History', activePage: 'performance', rows, month, rater, monthTop, monthBottom });
  } catch (err) {
    console.error(err);
    req.flash('error', 'Could not load history');
    res.redirect('/performance');
  }
});

// === Memos ===
router.get('/memos', requireAdminOrPrincipal, async (req, res) => {
  const [memos] = await db.query(
    `SELECT m.*, s.first_name, s.last_name FROM performance_memos m JOIN staff s ON m.staff_id=s.id ORDER BY m.memo_date DESC`
  );
  res.render('performance/memos', { title: 'Memo Log', activePage: 'performance', memos });
});

router.get('/memos/add', requireAdminOrPrincipal, async (req, res) => {
  const [staffList] = await db.query("SELECT * FROM staff WHERE staff_type='Teaching' AND is_active=1 ORDER BY first_name");
  res.render('performance/memos-add', { title: 'Issue Memo', activePage: 'performance', staffList });
});

router.post('/memos/add', requireAdminOrPrincipal, async (req, res) => {
  try {
    const { staff_id, memo_date, category, description } = req.body;
    await db.query(
      'INSERT INTO performance_memos (staff_id, memo_date, category, description, issued_by) VALUES (?,?,?,?,?)',
      [staff_id, memo_date, category, description || null, req.session.user.id]
    );

    const monthBucket = memo_date.slice(0, 7) + '-01';
    await db.query(
      `INSERT INTO performance_monthly_reviews (staff_id, month_date, academic_year_id, rater)
       VALUES (?,?,?,'Principal') ON DUPLICATE KEY UPDATE staff_id=staff_id`,
      [staff_id, monthBucket, ACADEMIC_YEAR_ID]
    );
    if (category === 'Discipline') {
      await db.query(
        `UPDATE performance_monthly_reviews SET discipline_issues=discipline_issues+1 WHERE staff_id=? AND month_date=? AND rater='Principal'`,
        [staff_id, monthBucket]
      );
    } else if (category === 'Punctuality') {
      await db.query(
        `UPDATE performance_monthly_reviews SET late_arrivals=late_arrivals+1 WHERE staff_id=? AND month_date=? AND rater='Principal'`,
        [staff_id, monthBucket]
      );
    } else if (category === 'Academic Non-Performance') {
      await db.query(
        `UPDATE performance_monthly_reviews SET academic_flags=academic_flags+1,
         notes = CONCAT(COALESCE(notes,''), '\n[Memo] Academic Non-Performance: ', ?, ' (', ?, ')')
         WHERE staff_id=? AND month_date=? AND rater='Principal'`,
        [description || '', memo_date, staff_id, monthBucket]
      );
    }
    req.flash('success', 'Memo issued');
    res.redirect('/performance/memos');
  } catch (err) {
    console.error(err);
    req.flash('error', 'Failed to issue memo: ' + err.message);
    res.redirect('/performance/memos/add');
  }
});

// === Annual Summary (admin — all teachers) ===
router.get('/annual', requireAdmin, async (req, res) => {
  try {
    const [staffList] = await db.query("SELECT * FROM staff WHERE staff_type='Teaching' ORDER BY first_name");
    const weights = await getWeights(db);
    const summaries = [];
    for (const s of staffList) summaries.push(await computeAnnualSummary(db, s, ACADEMIC_YEAR_ID, weights));
    summaries.forEach(sum => {
      sum.increment = proposedIncrement(sum, summaries, weights.perf_budget_total);
      sum.action = recommendedAction(sum);
    });

    const ranked = summaries.filter(s => s.weighted !== null).sort((a, b) => b.weighted - a.weighted);
    const topPerformers = ranked.slice(0, 3);
    const needsImprovement = ranked.slice(-3).reverse().filter(s => !topPerformers.includes(s));
    const rankMap = new Map();
    topPerformers.forEach((s, i) => rankMap.set(s.staff.id, i + 1));
    const bottomSet = new Set(needsImprovement.map(s => s.staff.id));

    res.render('performance/annual-list', {
      title: 'Annual Summary', activePage: 'performance', summaries, weights,
      topPerformers, needsImprovement, rankMap, bottomSet,
    });
  } catch (err) {
    console.error(err);
    req.flash('error', 'Could not load annual summary');
    res.redirect('/performance');
  }
});

router.post('/annual/:staffId/role-resp', requireAdmin, async (req, res) => {
  try {
    const { role_responsibility_score } = req.body;
    await db.query(
      `INSERT INTO performance_annual_overrides (staff_id, academic_year_id, role_responsibility_score)
       VALUES (?,?,?) ON DUPLICATE KEY UPDATE role_responsibility_score=VALUES(role_responsibility_score)`,
      [req.params.staffId, ACADEMIC_YEAR_ID, role_responsibility_score || null]
    );
    req.flash('success', 'Role & Responsibility score saved');
  } catch (err) {
    console.error(err);
    req.flash('error', 'Failed to save: ' + err.message);
  }
  res.redirect('/performance/annual');
});

// === Report cards ===
async function renderReportCard(req, res, staffId, restricted) {
  try {
    const [[staff]] = await db.query('SELECT * FROM staff WHERE id=?', [staffId]);
    if (!staff) { req.flash('error', 'Staff not found'); return res.redirect('/performance'); }
    const weights = await getWeights(db);
    const summary = await computeAnnualSummary(db, staff, ACADEMIC_YEAR_ID, weights);
    let increment = 0, action = '', rankLabel = null;
    if (!restricted) {
      const [allStaff] = await db.query("SELECT * FROM staff WHERE staff_type='Teaching'");
      const allSummaries = [];
      for (const s of allStaff) allSummaries.push(await computeAnnualSummary(db, s, ACADEMIC_YEAR_ID, weights));
      increment = proposedIncrement(summary, allSummaries, weights.perf_budget_total);
      action = recommendedAction(summary);

      const ranked = allSummaries.filter(s => s.weighted !== null).sort((a, b) => b.weighted - a.weighted);
      const myIndex = ranked.findIndex(s => s.staff.id === Number(staffId));
      if (myIndex === 0) rankLabel = '🏆 #1 Top Performer';
      else if (myIndex >= 0 && myIndex < 3) rankLabel = `🏆 Top Performer (#${myIndex + 1})`;
      else if (myIndex >= 0 && myIndex >= ranked.length - 3) rankLabel = '⚠️ Needs Improvement';
    }
    const [memos] = await db.query('SELECT * FROM performance_memos WHERE staff_id=? ORDER BY memo_date', [staffId]);
    res.render('performance/report-card', {
      title: 'Teacher Report Card', activePage: 'performance',
      staff, summary, increment, action, memos, restricted, rankLabel,
    });
  } catch (err) {
    console.error(err);
    req.flash('error', 'Could not load report card');
    res.redirect('/performance');
  }
}

router.get('/annual/:staffId', requireAdmin, (req, res) => renderReportCard(req, res, req.params.staffId, false));

router.get('/my-report-card', async (req, res) => {
  if (req.session.user.role !== 'teacher' || !req.session.user.staff_id) {
    req.flash('error', 'No linked staff record for this login');
    return res.redirect('/dashboard');
  }
  await renderReportCard(req, res, req.session.user.staff_id, true);
});

// === PDF report cards (reuses the pdfkit + purple letterhead pattern from routes/salary.js) ===
async function renderReportCardPdf(req, res, staffId, restricted) {
  try {
    const [[staff]] = await db.query('SELECT * FROM staff WHERE id=?', [staffId]);
    if (!staff) return res.status(404).send('Staff not found');
    const weights = await getWeights(db);
    const summary = await computeAnnualSummary(db, staff, ACADEMIC_YEAR_ID, weights);
    let increment = 0, action = '';
    if (!restricted) {
      const [allStaff] = await db.query("SELECT * FROM staff WHERE staff_type='Teaching'");
      const allSummaries = [];
      for (const s of allStaff) allSummaries.push(await computeAnnualSummary(db, s, ACADEMIC_YEAR_ID, weights));
      increment = proposedIncrement(summary, allSummaries, weights.perf_budget_total);
      action = recommendedAction(summary);
    }
    const [memos] = await db.query('SELECT * FROM performance_memos WHERE staff_id=? ORDER BY memo_date', [staffId]);

    const [rows] = await db.query(
      "SELECT key_name, value FROM configuration WHERE key_name IN ('school_name','school_address')"
    );
    const cfg = {}; rows.forEach(r => { cfg[r.key_name] = r.value; });
    const schoolName = cfg.school_name || process.env.SCHOOL_NAME || 'JBM Public School';
    const schoolAddress = cfg.school_address || 'RZ 666/1, Sadh Nagar, Palam, New Delhi - 110045';

    const MARGIN = 50, PAGE_W = 595.28, PAGE_H = 841.89, CONTENT_W = PAGE_W - MARGIN * 2, FOOTER_RESERVE = 60;
    const doc = new PDFDocument({ margin: MARGIN, size: 'A4', autoFirstPage: true });
    const name = `${staff.first_name} ${staff.last_name || ''}`.trim();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="ReportCard_${name.replace(/ /g, '_')}.pdf"`);
    doc.pipe(res);

    doc.rect(MARGIN, MARGIN, CONTENT_W, 2).fill('#4A0E8F');
    doc.moveDown(0.3);
    doc.fontSize(16).font('Helvetica-Bold').fillColor('#4A0E8F').text(schoolName.toUpperCase(), { align: 'center' });
    doc.fontSize(9).font('Helvetica').fillColor('#333333').text(schoolAddress, { align: 'center' });
    doc.moveDown(0.3);
    doc.rect(MARGIN, doc.y, CONTENT_W, 1).fill('#cccccc');
    doc.fillColor('#000000').moveDown(0.6);

    doc.fontSize(12).font('Helvetica-Bold').text('TEACHER PERFORMANCE REPORT CARD', { align: 'center' });
    doc.moveDown(0.6);

    doc.fontSize(9).font('Helvetica');
    doc.text(`Name: ${name}`);
    doc.text(`Designation: ${staff.designation || '—'}`);
    doc.text(`Status: ${staff.date_of_leaving ? 'Left' : 'Active'}`);
    doc.moveDown(0.6);

    const col = { month: { x: MARGIN, w: 100 }, score: { x: MARGIN + 100, w: 100 } };
    const ROW_H = 16;
    function drawHeader(yPos) {
      doc.rect(MARGIN, yPos, CONTENT_W, ROW_H).fill('#4A0E8F');
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#ffffff');
      doc.text('Month', col.month.x + 2, yPos + 4, { width: col.month.w - 4 });
      doc.text('Month Score (0-10)', col.score.x + 2, yPos + 4, { width: col.score.w - 4 });
      doc.fillColor('#000000');
      return yPos + ROW_H;
    }
    let y = drawHeader(doc.y);
    let rowNum = 0;
    for (const m of summary.monthCombined) {
      rowNum++;
      if (y + ROW_H + FOOTER_RESERVE > PAGE_H - MARGIN) { doc.addPage(); y = drawHeader(MARGIN + 10); }
      if (rowNum % 2 === 0) doc.rect(MARGIN, y, CONTENT_W, ROW_H).fill('#f3e8ff');
      doc.font('Helvetica').fontSize(8).fillColor('#000000');
      const label = new Date(m.month_date).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
      doc.text(label, col.month.x + 2, y + 4, { width: col.month.w - 4 });
      doc.text(String(m.combined), col.score.x + 2, y + 4, { width: col.score.w - 4 });
      doc.rect(MARGIN, y, CONTENT_W, ROW_H).stroke('#cccccc');
      y += ROW_H;
    }
    y += 16;

    if (y + 140 > PAGE_H - MARGIN) { doc.addPage(); y = MARGIN + 10; }
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#000000').text('Annual Summary', MARGIN, y);
    y = doc.y + 6;
    doc.font('Helvetica').fontSize(9);
    doc.text(`Months Logged: ${summary.monthsLogged}`, MARGIN, y); y = doc.y + 2;
    doc.text(`Annual Performance Score: ${summary.annualPerf ?? '—'}`, MARGIN, y); y = doc.y + 2;
    doc.text(`Years of Service: ${summary.years !== null ? Math.round(summary.years * 10) / 10 : '—'}`, MARGIN, y); y = doc.y + 2;
    doc.text(`Loyalty Score: ${summary.loyalty ?? '—'}`, MARGIN, y); y = doc.y + 2;
    doc.text(`Behaviour Score: ${summary.behaviour ?? '—'}`, MARGIN, y); y = doc.y + 2;
    doc.text(`Role & Responsibility: ${summary.roleResp ?? '—'}`, MARGIN, y); y = doc.y + 2;
    doc.font('Helvetica-Bold').text(`Weighted Score: ${summary.weighted ?? '—'}`, MARGIN, y); y = doc.y + 8;

    if (!restricted) {
      doc.font('Helvetica-Bold').fontSize(10).text(`Band: ${summary.band || '—'}`, MARGIN, y); y = doc.y + 2;
      doc.text(`Proposed Increment: Rs. ${increment.toLocaleString('en-IN')}`, MARGIN, y); y = doc.y + 2;
      doc.font('Helvetica').fontSize(9).text(`Recommended Action: ${action}`, MARGIN, y, { width: CONTENT_W }); y = doc.y + 10;
    }

    if (memos.length) {
      if (y + 60 > PAGE_H - MARGIN) { doc.addPage(); y = MARGIN + 10; }
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#000000').text('Memo History', MARGIN, y);
      y = doc.y + 6;
      doc.font('Helvetica').fontSize(8);
      for (const m of memos) {
        if (y + 14 > PAGE_H - MARGIN) { doc.addPage(); y = MARGIN + 10; }
        const dateStr = new Date(m.memo_date).toLocaleDateString('en-IN');
        doc.text(`${dateStr} — ${m.category}: ${m.description || ''}`, MARGIN, y, { width: CONTENT_W });
        y = doc.y + 2;
      }
    }

    doc.end();
  } catch (err) {
    console.error(err);
    res.status(500).send('PDF generation failed: ' + err.message);
  }
}

router.get('/annual/:staffId/pdf', requireAdmin, (req, res) => renderReportCardPdf(req, res, req.params.staffId, false));
router.get('/my-report-card/pdf', (req, res) => {
  if (req.session.user.role !== 'teacher' || !req.session.user.staff_id) return res.redirect('/dashboard');
  renderReportCardPdf(req, res, req.session.user.staff_id, true);
});

module.exports = router;

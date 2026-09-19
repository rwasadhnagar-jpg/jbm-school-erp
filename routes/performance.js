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
  WEIGHT_DEFAULTS, getWeights, monthScore, computeStudentOutcomesAuto,
  computeObservationAutoScores, computeAttendanceAuto, computeWeeklyChecklistAuto,
  computeAnnualSummary, proposedIncrement, recommendedAction,
} = require('../utils/performanceCalc');
const { WINGS, wingMembershipClause } = require('./supervision');
const { cascadeStaffDeactivation } = require('./staff');

// Redesigned 2026-09-15: was blind 3-rater (Principal/Vice Principal/Incharge, averaged) — now
// only the wing Incharge enters/owns the monthly row; Principal and Admin may review/edit it but
// don't hold their own separate scored row. Vice Principal is no longer a scorer at all.
const ACADEMIC_YEAR_ID = 1;

// === DB INIT (self-migrating, mirrors routes/salary.js / routes/remarks.js pattern) ===
(async () => {
  try {
    await db.query('ALTER TABLE staff ADD COLUMN IF NOT EXISTS date_of_leaving DATE DEFAULT NULL');
    await db.query('ALTER TABLE staff ADD COLUMN IF NOT EXISTS years_of_service_override DECIMAL(4,1) DEFAULT NULL');

    // Fresh-install shape: one row per staff/month (owned by whichever Incharge entered it).
    await db.query(`CREATE TABLE IF NOT EXISTS performance_monthly_reviews (
      id INT AUTO_INCREMENT PRIMARY KEY,
      staff_id INT NOT NULL,
      month_date DATE NOT NULL,
      academic_year_id INT DEFAULT 1,
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
      punctuality_rating DECIMAL(3,1) DEFAULT NULL,
      dress_code_rating DECIMAL(3,1) DEFAULT NULL,
      overall_conduct_rating DECIMAL(3,1) DEFAULT NULL,
      lesson_prep_rating DECIMAL(3,1) DEFAULT NULL,
      notes TEXT,
      entered_by INT DEFAULT NULL,
      submitted_at TIMESTAMP NULL DEFAULT NULL,
      reviewed_by INT DEFAULT NULL,
      reviewed_at TIMESTAMP NULL DEFAULT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY staff_month (staff_id, month_date)
    )`);
    // Migration for a pre-existing table from the old blind-3-rater shape — each statement is
    // independently safe to re-run (fails harmlessly once already applied, since the outer
    // try/catch below would otherwise abort every later init statement on the first failure).
    const migrateOldRaterShape = async () => {
      const [cols] = await db.query("SHOW COLUMNS FROM performance_monthly_reviews LIKE 'rater'");
      if (cols.length) {
        // Old shape had up to 3 rows per staff/month (one per rater) — not meaningful under the
        // new one-row-per-month model, and would collide on the new UNIQUE KEY anyway. This is
        // test/UAT data only (no real production Performance rows exist yet), so a clean wipe is
        // safe and simpler than trying to merge 3 blind scores into one.
        try { await db.query('DELETE FROM performance_monthly_reviews'); } catch (e) {}
      }
      try { await db.query('ALTER TABLE performance_monthly_reviews DROP INDEX staff_month_rater'); } catch (e) {}
      try { await db.query('ALTER TABLE performance_monthly_reviews ADD UNIQUE KEY staff_month (staff_id, month_date)'); } catch (e) {}
      try { await db.query('ALTER TABLE performance_monthly_reviews DROP COLUMN rater'); } catch (e) {}
      try { await db.query('ALTER TABLE performance_monthly_reviews ADD COLUMN submitted_at TIMESTAMP NULL DEFAULT NULL'); } catch (e) {}
      try { await db.query('ALTER TABLE performance_monthly_reviews ADD COLUMN reviewed_by INT DEFAULT NULL'); } catch (e) {}
      try { await db.query('ALTER TABLE performance_monthly_reviews ADD COLUMN reviewed_at TIMESTAMP NULL DEFAULT NULL'); } catch (e) {}
    };
    await migrateOldRaterShape();
    // 12-point checklist (2026-09-15) — 4 weekly-form fields added to the monthly row alongside
    // the existing observation-derived ones.
    await db.query('ALTER TABLE performance_monthly_reviews ADD COLUMN IF NOT EXISTS punctuality_rating DECIMAL(3,1) DEFAULT NULL');
    await db.query('ALTER TABLE performance_monthly_reviews ADD COLUMN IF NOT EXISTS dress_code_rating DECIMAL(3,1) DEFAULT NULL');
    await db.query('ALTER TABLE performance_monthly_reviews ADD COLUMN IF NOT EXISTS overall_conduct_rating DECIMAL(3,1) DEFAULT NULL');
    await db.query('ALTER TABLE performance_monthly_reviews ADD COLUMN IF NOT EXISTS lesson_prep_rating DECIMAL(3,1) DEFAULT NULL');

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
// Role matrix: Incharge enters the monthly row for their own wing's teachers only. Principal and
// Admin can read/edit ANY teacher's row (review/correction layer on top of the Incharge's entry —
// they don't hold separate scored rows of their own any more). Vice Principal has no role here.
function isChairman(req) { return req.session.user && req.session.user.role === 'admin'; }
function isIncharge(req) { return req.session.user && req.session.user.role === 'incharge'; }
function isPrincipal(req) { return req.session.user && req.session.user.role === 'principal'; }
// "Relevant Incharge only": an Incharge is locked to their own wing everywhere in this module —
// mirrors resolveWing()/myWing() in routes/supervision.js (this module doesn't share that file's
// helpers, so duplicated here with the same behaviour). Returns null for admin/principal, meaning
// "no wing restriction" — they can review/edit any teacher.
function myWingFilter(req) {
  if (req.session.user.role !== 'incharge') return null;
  return req.session.user.wing || null;
}

const requireAdmin = (req, res, next) => {
  if (!isChairman(req)) { req.flash('error', 'Only admin can access this page'); return res.redirect('/performance'); }
  next();
};
// Anyone who can view/enter/edit the monthly review screens: Incharge (own wing), Principal (all), Admin (all).
const requireScorerOrAdmin = (req, res, next) => {
  if (isChairman(req) || isPrincipal(req) || isIncharge(req)) return next();
  req.flash('error', 'You do not have access to this page');
  res.redirect('/performance');
};
const requireAdminOrPrincipal = (req, res, next) => {
  if (isChairman(req) || isPrincipal(req)) return next();
  req.flash('error', 'Only admin or principal can issue memos');
  res.redirect('/performance');
};

// === Date helpers ===
// Local-date formatting — toISOString() carries the UTC time-of-day of the original parsed
// string forward through setMonth()/setDate(), which under IST made `d <= end` in
// monthsInRange() fail for the CURRENT month (d ended up at "Sep 1, 05:30 IST" vs end's
// "Sep 1, 00:00 IST") — silently excluding the current month from the picker every time.
// Same class of bug as the qs_bracket_key_bug memory's attendance.js fix.
function isoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function toISODate(v) {
  if (!v) return null;
  if (v instanceof Date) return isoDate(v);
  const s = String(v).trim();
  return s || null;
}
function monthsInRange(startDateStr, endDate) {
  const months = [];
  // `d` and `end` must share the same time-of-day (exact local midnight) or the comparison
  // below can silently drop the current month — `new Date(startDateStr)` parses as UTC
  // midnight, which under IST displays as 05:30 local, while `end` was built at exact local
  // midnight, so `d` could end up "later" than `end` on their shared boundary month.
  const d = new Date(startDateStr);
  d.setHours(0, 0, 0, 0);
  d.setDate(1);
  const end = new Date(endDate.getFullYear(), endDate.getMonth(), 1);
  end.setHours(0, 0, 0, 0);
  while (d <= end) { months.push(isoDate(d)); d.setMonth(d.getMonth() + 1); }
  return months;
}
const SCORED_FIELD_SQL = `(syllabus_pace IS NOT NULL OR classroom_mgmt IS NOT NULL OR homework_correction IS NOT NULL
  OR parent_comm IS NOT NULL OR admin_compliance IS NOT NULL OR cocurricular IS NOT NULL
  OR professional_dev IS NOT NULL OR behaviour_teamwork IS NOT NULL OR overall_holistic IS NOT NULL
  OR punctuality_rating IS NOT NULL OR dress_code_rating IS NOT NULL
  OR overall_conduct_rating IS NOT NULL OR lesson_prep_rating IS NOT NULL)`;

async function findOldestIncompleteMonth(months, wingFilter) {
  const wingClauseBare = wingFilter ? ` AND ${wingMembershipClause('id', 'wing')}` : '';
  const wingClauseAliased = wingFilter ? ` AND ${wingMembershipClause('s.id', 's.wing')}` : '';
  const wingParams = wingFilter ? [wingFilter, wingFilter] : [];
  const [[{ cnt: totalStaff }]] = await db.query(
    `SELECT COUNT(*) cnt FROM staff WHERE staff_type='Teaching' AND is_active=1${wingClauseBare}`, wingParams
  );
  for (const m of months) {
    const [[row]] = await db.query(
      `SELECT COUNT(DISTINCT r.staff_id) cnt FROM performance_monthly_reviews r
       JOIN staff s ON s.id = r.staff_id
       WHERE r.month_date=? AND ${SCORED_FIELD_SQL}${wingClauseAliased}`,
      [m, ...wingParams]
    );
    if (Number(row.cnt) < Number(totalStaff)) return m;
  }
  return months[months.length - 1];
}

// === Landing page ===
router.get('/', async (req, res) => {
  const role = req.session.user.role;
  if (role === 'admin') return res.redirect('/performance/annual');
  if (role === 'incharge' || role === 'principal') return res.redirect('/performance/monthly/entry');
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
    if (date_of_leaving) await cascadeStaffDeactivation(req.params.id);
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

// === Principal / Vice Principal logins (Incharge logins now live entirely under Academic
// Supervision → Manage In-charges, since they always need a wing). Vice Principal has no role in
// Performance scoring any more, but still needs a login for Academic Monitoring's principal-level
// access (meeting minutes etc.), so account creation for it stays here. ===
router.get('/raters', requireAdmin, async (req, res) => {
  const [raters] = await db.query("SELECT id, name, email, role, is_active FROM users WHERE role IN ('principal','vice_principal') ORDER BY role");
  res.render('performance/raters', { title: 'Principal / Vice Principal Logins', activePage: 'performance', raters });
});

router.get('/raters/add', requireAdmin, (req, res) => {
  res.render('performance/raters-add', { title: 'Add Login', activePage: 'performance' });
});

router.post('/raters/add', requireAdmin, async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    if (!['principal', 'vice_principal'].includes(role)) throw new Error('Only Principal/Vice Principal logins are created here — Incharge logins are created under Academic Supervision → Manage In-charges');
    const hash = await bcrypt.hash(password, 10);
    await db.query('INSERT INTO users (name, email, password, role) VALUES (?,?,?,?)', [name, email, hash, role]);
    req.flash('success', `${name} added as ${role === 'principal' ? 'Principal' : 'Vice Principal'}`);
    res.redirect('/performance/raters');
  } catch (err) {
    console.error(err);
    req.flash('error', 'Failed to add login: ' + err.message);
    res.redirect('/performance/raters/add');
  }
});

// === Monthly Review entry (Incharge owns their wing's entries; Principal/Admin can review/edit
// any teacher's) === One-teacher-at-a-time flow: the list page shows overall progress and lets you
// jump to anyone (in scope), but "Continue Scoring" and the single-entry page's own Save button
// both drive straight through the not-yet-scored teachers so you can power through a roster
// without bouncing back to a list each time.
async function findNextUnscoredStaffId(month, currentStaffId, wingFilter) {
  const wingClause = wingFilter ? ` AND ${wingMembershipClause('id', 'wing')}` : '';
  const wingParams = wingFilter ? [wingFilter, wingFilter] : [];
  const [staffList] = await db.query(
    `SELECT id FROM staff WHERE staff_type='Teaching' AND is_active=1${wingClause} ORDER BY first_name`, wingParams
  );
  const [scoredRows] = await db.query(
    `SELECT staff_id FROM performance_monthly_reviews WHERE month_date=? AND ${SCORED_FIELD_SQL}`,
    [month]
  );
  const scoredSet = new Set(scoredRows.map(r => r.staff_id));
  const ids = staffList.map(s => s.id);
  const currentIdx = ids.indexOf(Number(currentStaffId));
  for (let offset = 1; offset <= ids.length; offset++) {
    const idx = (currentIdx + offset + ids.length) % ids.length;
    if (!scoredSet.has(ids[idx])) return ids[idx];
  }
  return null; // everyone scored
}

router.get('/monthly/entry', requireScorerOrAdmin, async (req, res) => {
  try {
    const wingFilter = myWingFilter(req);
    if (req.session.user.role === 'incharge' && !wingFilter) {
      req.flash('error', 'Your login has no wing assigned yet — ask admin to set it under Manage In-charges.');
      return res.redirect('/performance');
    }
    // Principal/Admin can optionally narrow to one wing via ?wing=; default is every wing.
    const pickedWing = !wingFilter && req.query.wing ? req.query.wing : null;
    const effectiveWingFilter = wingFilter || pickedWing;
    const [[ay]] = await db.query('SELECT * FROM academic_years WHERE id=?', [ACADEMIC_YEAR_ID]);
    const months = monthsInRange(ay.start_date, new Date());
    let month = req.query.month;
    if (!month || !months.includes(month)) month = await findOldestIncompleteMonth(months, effectiveWingFilter);

    const wingClause = effectiveWingFilter ? ` AND ${wingMembershipClause('id', 'wing')}` : '';
    const wingParams = effectiveWingFilter ? [effectiveWingFilter, effectiveWingFilter] : [];
    const [staffList] = await db.query(
      `SELECT * FROM staff WHERE staff_type='Teaching' AND is_active=1${wingClause} ORDER BY first_name`, wingParams
    );
    const [scoredRows] = await db.query(
      `SELECT staff_id FROM performance_monthly_reviews WHERE month_date=? AND ${SCORED_FIELD_SQL}`,
      [month]
    );
    const scoredSet = new Set(scoredRows.map(r => r.staff_id));
    staffList.forEach(s => { s.scored = scoredSet.has(s.id); });
    const doneCount = staffList.filter(s => s.scored).length;
    const firstUnscored = staffList.find(s => !s.scored);

    res.render('performance/monthly-entry', {
      title: 'Monthly Review Entry', activePage: 'performance',
      staffList, month, months, isChairman: isChairman(req), isIncharge: isIncharge(req),
      canPickWing: !wingFilter, pickedWing, WINGS,
      doneCount, totalCount: staffList.length, firstUnscoredId: firstUnscored ? firstUnscored.id : null,
      allDone: req.query.all_done === '1',
    });
  } catch (err) {
    console.error(err);
    req.flash('error', 'Could not load monthly entry page');
    res.redirect('/performance');
  }
});

router.get('/monthly/entry/:staffId', requireScorerOrAdmin, async (req, res) => {
  try {
    const wingFilter = myWingFilter(req);
    const [[ay]] = await db.query('SELECT * FROM academic_years WHERE id=?', [ACADEMIC_YEAR_ID]);
    const months = monthsInRange(ay.start_date, new Date());
    let month = req.query.month;
    if (!month || !months.includes(month)) month = await findOldestIncompleteMonth(months, wingFilter);

    const [[staff]] = await db.query("SELECT * FROM staff WHERE id=? AND staff_type='Teaching' AND is_active=1", [req.params.staffId]);
    if (!staff) { req.flash('error', 'Teacher not found'); return res.redirect('/performance/monthly/entry'); }
    // Relevant-Incharge-only: block direct-URL access to a teacher outside my wing (primary or
    // additional cross-wing membership).
    if (wingFilter) {
      const [[member]] = await db.query(
        `SELECT id FROM staff WHERE id=? AND ${wingMembershipClause('id', 'wing')}`, [staff.id, wingFilter, wingFilter]
      );
      if (!member) {
        req.flash('error', 'You do not have access to this teacher');
        return res.redirect('/performance/monthly/entry');
      }
    }

    const wingClause = wingFilter ? ` AND ${wingMembershipClause('id', 'wing')}` : '';
    const wingParams = wingFilter ? [wingFilter, wingFilter] : [];
    const [staffOrder] = await db.query(
      `SELECT id, first_name, last_name FROM staff WHERE staff_type='Teaching' AND is_active=1${wingClause} ORDER BY first_name`, wingParams
    );
    const position = staffOrder.findIndex(s => s.id === staff.id);
    const prevStaff = position > 0 ? staffOrder[position - 1] : null;
    const nextStaff = position < staffOrder.length - 1 ? staffOrder[position + 1] : null;

    const [[existing]] = await db.query(
      'SELECT * FROM performance_monthly_reviews WHERE staff_id=? AND month_date=?', [staff.id, month]
    );
    const outcomesAuto = await computeStudentOutcomesAuto(db, staff.id, month);
    const obsAuto = isChairman(req) ? null : await computeObservationAutoScores(db, staff.id, month, req.session.user.id);
    const attendanceAuto = await computeAttendanceAuto(db, staff.id, month);
    const weeklyAuto = await computeWeeklyChecklistAuto(db, staff.id, month);

    res.render('performance/monthly-entry-single', {
      title: 'Monthly Review Entry', activePage: 'performance',
      staff, months, month, isChairman: isChairman(req), isIncharge: isIncharge(req),
      existing: existing || {}, outcomesAuto, obsAuto, attendanceAuto, weeklyAuto,
      position: position + 1, totalCount: staffOrder.length, prevStaff, nextStaff,
      justSaved: req.query.saved === '1',
    });
  } catch (err) {
    console.error(err);
    req.flash('error', 'Could not load that teacher');
    res.redirect('/performance/monthly/entry');
  }
});

router.post('/monthly/entry/:staffId', requireScorerOrAdmin, async (req, res) => {
  const month = req.body.month;
  const staffId = req.params.staffId;
  const wingFilter = myWingFilter(req);
  try {
    if (!month) throw new Error('Missing month');
    if (wingFilter) {
      const [[staff]] = await db.query(
        `SELECT id FROM staff WHERE id=? AND ${wingMembershipClause('id', 'wing')}`, [staffId, wingFilter, wingFilter]
      );
      if (!staff) throw new Error('You do not have access to this teacher');
    }
    const r = req.body;
    // Incharge entering/updating their own row stamps submitted_at (their submission); Principal/
    // Admin editing it instead stamps reviewed_by/reviewed_at as a review marker — never shown in
    // the Incharge's own UI, just an internal record of who last checked it.
    const isReview = !isIncharge(req);
    await db.query(
      `INSERT INTO performance_monthly_reviews
        (staff_id, month_date, academic_year_id, attendance_pct, late_arrivals, syllabus_pace,
         classroom_mgmt, homework_correction, parent_complaints, discipline_issues, student_outcomes_override,
         parent_comm, admin_compliance, cocurricular, professional_dev, behaviour_teamwork, overall_holistic,
         punctuality_rating, dress_code_rating, overall_conduct_rating, lesson_prep_rating,
         notes, entered_by, submitted_at, reviewed_by, reviewed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
         attendance_pct=VALUES(attendance_pct), late_arrivals=VALUES(late_arrivals), syllabus_pace=VALUES(syllabus_pace),
         classroom_mgmt=VALUES(classroom_mgmt), homework_correction=VALUES(homework_correction),
         parent_complaints=VALUES(parent_complaints), discipline_issues=VALUES(discipline_issues),
         student_outcomes_override=VALUES(student_outcomes_override), parent_comm=VALUES(parent_comm),
         admin_compliance=VALUES(admin_compliance), cocurricular=VALUES(cocurricular),
         professional_dev=VALUES(professional_dev), behaviour_teamwork=VALUES(behaviour_teamwork),
         overall_holistic=VALUES(overall_holistic),
         punctuality_rating=VALUES(punctuality_rating), dress_code_rating=VALUES(dress_code_rating),
         overall_conduct_rating=VALUES(overall_conduct_rating), lesson_prep_rating=VALUES(lesson_prep_rating),
         notes=VALUES(notes),
         entered_by=IF(VALUES(entered_by) IS NULL, entered_by, VALUES(entered_by)),
         submitted_at=IF(VALUES(submitted_at) IS NULL, submitted_at, VALUES(submitted_at)),
         reviewed_by=IF(VALUES(reviewed_by) IS NULL, reviewed_by, VALUES(reviewed_by)),
         reviewed_at=IF(VALUES(reviewed_at) IS NULL, reviewed_at, VALUES(reviewed_at))`,
      [staffId, month, ACADEMIC_YEAR_ID,
       r.attendance_pct || null, r.late_arrivals || 0, r.syllabus_pace || null,
       r.classroom_mgmt || null, r.homework_correction || null, r.parent_complaints || 0, r.discipline_issues || 0,
       r.student_outcomes_override || null, r.parent_comm || null, r.admin_compliance || null,
       r.cocurricular || null, r.professional_dev || null, r.behaviour_teamwork || null, r.overall_holistic || null,
       r.punctuality_rating || null, r.dress_code_rating || null, r.overall_conduct_rating || null, r.lesson_prep_rating || null,
       r.notes || null,
       isReview ? null : req.session.user.id, isReview ? null : new Date(),
       isReview ? req.session.user.id : null, isReview ? new Date() : null]
    );

    const nextId = await findNextUnscoredStaffId(month, staffId, wingFilter);
    if (nextId) {
      return res.redirect(`/performance/monthly/entry/${nextId}?month=${month}&saved=1`);
    }
    return res.redirect(`/performance/monthly/entry?month=${month}&all_done=1`);
  } catch (err) {
    console.error(err);
    req.flash('error', 'Failed to save: ' + err.message);
    res.redirect(`/performance/monthly/entry/${staffId}?month=${month}`);
  }
});

// === Admin: full monthly history (one row per staff/month now) ===
router.get('/monthly', requireAdmin, async (req, res) => {
  try {
    const { month, wing } = req.query;
    let q = `SELECT r.*, s.first_name, s.last_name, s.wing, u1.name AS entered_by_name, u2.name AS reviewed_by_name
              FROM performance_monthly_reviews r
              JOIN staff s ON r.staff_id=s.id
              LEFT JOIN users u1 ON u1.id = r.entered_by
              LEFT JOIN users u2 ON u2.id = r.reviewed_by
              WHERE 1=1`;
    const p = [];
    if (month) { q += ' AND r.month_date=?'; p.push(month); }
    if (wing && WINGS[wing]) { q += ' AND s.wing=?'; p.push(wing); }
    q += ' ORDER BY r.month_date DESC, s.first_name';
    const [rows] = await db.query(q, p);
    const weights = await getWeights(db);
    rows.forEach(r => { r.score = monthScore(r, weights); });

    let monthTop = [], monthBottom = [];
    if (month) {
      const ranked = rows
        .filter(r => r.score !== null)
        .map(r => ({ staff: { id: r.staff_id, first_name: r.first_name, last_name: r.last_name }, combined: r.score }))
        .sort((a, b) => b.combined - a.combined);
      monthTop = ranked.slice(0, 3);
      monthBottom = ranked.slice(-3).reverse().filter(e => !monthTop.includes(e));
    }

    res.render('performance/monthly-list', { title: 'Monthly Review History', activePage: 'performance', rows, month, wing, WINGS, monthTop, monthBottom });
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
      `INSERT INTO performance_monthly_reviews (staff_id, month_date, academic_year_id)
       VALUES (?,?,?) ON DUPLICATE KEY UPDATE staff_id=staff_id`,
      [staff_id, monthBucket, ACADEMIC_YEAR_ID]
    );
    if (category === 'Discipline') {
      await db.query(
        `UPDATE performance_monthly_reviews SET discipline_issues=discipline_issues+1 WHERE staff_id=? AND month_date=?`,
        [staff_id, monthBucket]
      );
    } else if (category === 'Punctuality') {
      await db.query(
        `UPDATE performance_monthly_reviews SET late_arrivals=late_arrivals+1 WHERE staff_id=? AND month_date=?`,
        [staff_id, monthBucket]
      );
    } else if (category === 'Academic Non-Performance') {
      await db.query(
        `UPDATE performance_monthly_reviews SET academic_flags=academic_flags+1,
         notes = CONCAT(COALESCE(notes,''), '\n[Memo] Academic Non-Performance: ', ?, ' (', ?, ')')
         WHERE staff_id=? AND month_date=?`,
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

// === Teacher Pulse dashboard (added: wires the design-review mockup to live data) ===
// Two genuinely different scales exist in this data, and Pulse shows both honestly rather than
// forcing one: Today/Week come from supervision_observations' 1-5 in-class ratings (8-point
// checklist, mirrors OBSERVATION_POINTS in routes/supervision.js — not exported there, so
// duplicated here per this codebase's existing convention, see myWingFilter above); Month/Year
// come from performance_monthly_reviews' 0-10 monthScore()/computeAnnualSummary() — the SAME
// tested functions the Monthly History and Annual Summary pages already use, not re-derived here.
// There is no independent "class score" in this schema (only teachers are scored), so — unlike
// the pitch mockup — Pulse's lookup/drill-down covers teachers only.
const PULSE_OBSERVATION_POINTS = [
  'English Communication', 'Teaching Pedagogy', 'Student Engagement', 'Classroom Control & Discipline',
  'Student Response', 'Syllabus Pace', 'Notebook Checking', 'Homework / Assignment given',
];
const PULSE_STATUS_ORDER_5 = ['good', 'warning', 'serious', 'critical'];
const PULSE_STATUS_ORDER_10 = ['good', 'warning', 'critical'];
const PULSE_BAND_LABELS_5 = { good: 'Excellent', warning: 'Good', serious: 'Watch', critical: 'Critical' };
const PULSE_BAND_LABELS_10 = { good: 'Top Performer', warning: 'Average / Consider', critical: 'Below Expectations' };

function pulseIsoDate(d) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function pulseMondayOf(d) {
  const day = d.getDay();
  const diff = (day === 0 ? -6 : 1 - day);
  const m = new Date(d);
  m.setDate(d.getDate() + diff);
  m.setHours(0, 0, 0, 0);
  return m;
}
function pulseAddDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return pulseIsoDate(d);
}
function pulseAvg(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null; }
function pulseRound1(v) { return v === null || v === undefined ? null : Math.round(v * 10) / 10; }
function pulseStatusFor5(score) {
  if (score === null) return 'critical';
  if (score >= 4.0) return 'good';
  if (score >= 3.5) return 'warning';
  if (score >= 3.0) return 'serious';
  return 'critical';
}
function pulseStatusFor10(score, weights) {
  if (score === null) return 'critical';
  if (score >= weights.perf_threshold_top) return 'good';
  if (score >= weights.perf_threshold_avg) return 'warning';
  return 'critical';
}
function pulseWingSub(w) {
  const c = w.classes || [];
  return c.length > 1 ? `${c[0]}–${c[c.length - 1]}` : (c[0] || '');
}

async function buildPulseData(db, weights) {
  const now = new Date();
  const todayStr = pulseIsoDate(now);
  const mondayStr = pulseIsoDate(pulseMondayOf(now));
  const weekEndStr = pulseAddDays(mondayStr, 6);
  const monthStart = pulseIsoDate(new Date(now.getFullYear(), now.getMonth(), 1));

  const [[ay]] = await db.query('SELECT * FROM academic_years WHERE id=?', [ACADEMIC_YEAR_ID]);
  const [staffRows] = await db.query(
    "SELECT id, first_name, last_name, wing, designation FROM staff WHERE staff_type='Teaching' AND is_active=1 ORDER BY first_name"
  );
  const wingKeys = Object.keys(WINGS);
  const wingStaffCount = {}, staffByWing = {};
  wingKeys.forEach(w => { wingStaffCount[w] = 0; staffByWing[w] = []; });
  let unassignedCount = 0;
  staffRows.forEach(s => {
    if (s.wing && wingStaffCount[s.wing] !== undefined) { wingStaffCount[s.wing]++; staffByWing[s.wing].push(s); }
    else unassignedCount++;
  });

  // ---- Observation-based data (Today / Week), bounded to a rolling window for query size ----
  const [obsRaw] = await db.query(
    `SELECT o.id, o.teacher_id, o.wing, o.observation_date, o.revisit_required, o.teacher_name_free,
            o.subject_topic, p.point_label, p.rating
     FROM supervision_observations o
     LEFT JOIN supervision_observation_points p ON p.observation_id = o.id AND p.rating IS NOT NULL
     WHERE o.observation_date >= DATE_SUB(CURDATE(), INTERVAL 120 DAY)`
  );
  const obsById = new Map();
  for (const r of obsRaw) {
    let o = obsById.get(r.id);
    if (!o) {
      o = { id: r.id, teacherId: r.teacher_id, wing: r.wing, date: r.observation_date, revisit: !!r.revisit_required,
            teacherFree: r.teacher_name_free, topic: r.subject_topic, ratings: [], points: {} };
      obsById.set(r.id, o);
    }
    if (r.rating !== null) {
      const v = Number(r.rating);
      o.ratings.push(v);
      (o.points[r.point_label] = o.points[r.point_label] || []).push(v);
    }
  }
  const observations = [...obsById.values()];
  observations.forEach(o => { o.avg = pulseAvg(o.ratings); });

  function wingObsRollup(obsList) {
    const byWing = {};
    wingKeys.forEach(w => byWing[w] = []);
    obsList.forEach(o => { if (o.avg !== null && byWing[o.wing]) byWing[o.wing].push(o.avg); });
    const out = {};
    wingKeys.forEach(w => { out[w] = pulseRound1(pulseAvg(byWing[w])); });
    return out;
  }
  function obsAttention(obsList, teacherNameOf) {
    const flagged = obsList.filter(o => o.revisit).sort((a, b) => (a.date < b.date ? 1 : -1));
    const items = flagged.slice(0, 3).map(o => ({
      title: (teacherNameOf(o.teacherId) || o.teacherFree || 'Unnamed teacher') + ' · ' + (WINGS[o.wing] ? WINGS[o.wing].label.split(' (')[0] : o.wing),
      sub: (o.topic ? o.topic + ' — ' : '') + 'Flagged for revisit on ' + o.date,
      score: o.avg,
    }));
    if (items.length < 3) {
      const byTeacher = new Map();
      obsList.forEach(o => {
        if (o.avg === null || !o.teacherId) return;
        (byTeacher.get(o.teacherId) || byTeacher.set(o.teacherId, []).get(o.teacherId)).push(o.avg);
      });
      const worst = [...byTeacher.entries()]
        .map(([id, arr]) => ({ id, avg: pulseAvg(arr) }))
        .sort((a, b) => a.avg - b.avg)
        .filter(t => !items.some(it => it.title.startsWith(teacherNameOf(t.id) || '')));
      for (const t of worst) {
        if (items.length >= 3) break;
        items.push({ title: teacherNameOf(t.id) || `Staff #${t.id}`, sub: 'Lowest avg observation rating in range', score: pulseRound1(t.avg) });
      }
    }
    return items;
  }

  const staffNameById = new Map(staffRows.map(s => [s.id, `${s.first_name} ${s.last_name || ''}`.trim()]));
  const nameOf = (id) => staffNameById.get(id);

  const todayObs = observations.filter(o => o.date === todayStr);
  const weekObs = observations.filter(o => o.date >= mondayStr && o.date <= weekEndStr);

  // ---- Monthly review data (Month), for the current calendar month ----
  const [monthRows] = await db.query(
    `SELECT r.*, s.wing FROM performance_monthly_reviews r JOIN staff s ON s.id = r.staff_id WHERE r.month_date=?`,
    [monthStart]
  );
  const monthScoreById = new Map();
  monthRows.forEach(r => monthScoreById.set(r.staff_id, monthScore(r, weights)));
  const monthRowById = new Map(monthRows.map(r => [r.staff_id, r]));

  // ---- Whole-AY monthly rows (for the overall trend line + per-teacher month history) ----
  const [ayRows] = await db.query('SELECT r.* FROM performance_monthly_reviews r WHERE r.academic_year_id=?', [ACADEMIC_YEAR_ID]);
  const byMonth = new Map();
  ayRows.forEach(r => {
    const s = monthScore(r, weights);
    if (s === null) return;
    (byMonth.get(r.month_date) || byMonth.set(r.month_date, []).get(r.month_date)).push(s);
  });
  const monthKeysSorted = [...byMonth.keys()].sort();
  const overallMonthTrend = monthKeysSorted.map(m => pulseRound1(pulseAvg(byMonth.get(m))));

  // ---- Annual summaries (Year) — reuses the exact function /performance/annual uses ----
  const annualByStaff = new Map();
  for (const s of staffRows) annualByStaff.set(s.id, await computeAnnualSummary(db, s, ACADEMIC_YEAR_ID, weights));
  const annualList = [...annualByStaff.values()];

  function bandKeyFor10(band) {
    if (band === 'Top Performer') return 'good';
    if (band === 'Average / Consider') return 'warning';
    if (band === 'Below Expectations') return 'critical';
    return 'critical';
  }

  // ===== Assemble the 4 periods =====
  const periods = {};

  // --- Today ---
  {
    const wingScores = wingObsRollup(todayObs);
    const compliance = {};
    wingKeys.forEach(w => {
      const observedTeachers = new Set(todayObs.filter(o => o.wing === w && o.teacherId).map(o => o.teacherId)).size;
      compliance[w] = wingStaffCount[w] ? Math.min(1, observedTeachers / wingStaffCount[w]) : null;
    });
    const wingsWithObs = new Set(todayObs.map(o => o.wing)).size;
    const avgToday = pulseRound1(pulseAvg(todayObs.map(o => o.avg).filter(v => v !== null)));
    const flaggedToday = todayObs.filter(o => o.revisit).length;
    const last7 = [];
    for (let i = 6; i >= 0; i--) {
      const d = pulseIsoDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i));
      last7.push(observations.filter(o => o.date === d).length);
    }
    periods.today = {
      kpis: [
        { label: 'Classes observed today', value: todayObs.length, unit: 'classes', delta: '', dir: 'flat', trend: last7 },
        { label: 'Wings observed today', value: wingsWithObs, unit: `/${wingKeys.length}`, delta: '', dir: 'flat', trend: last7.map(() => wingsWithObs) },
        { label: 'Avg rating today', value: avgToday === null ? 0 : avgToday, unit: '/5', delta: '', dir: 'flat', trend: last7 },
        { label: 'Flagged for revisit today', value: flaggedToday, unit: 'flags', delta: '', dir: 'flat', trend: last7 },
      ],
      gauge: avgToday === null ? 0 : avgToday, gaugeLabel: 'Overall avg rating today', maxScore: 5,
      wingScores, bandLabel: "Today's class-observation ratings", bandUnit: 'teachers observed',
      bandLabels: PULSE_BAND_LABELS_5, statusOrder: PULSE_STATUS_ORDER_5,
      bandDist: (() => {
        const dist = { good: 0, warning: 0, serious: 0, critical: 0 };
        const seen = new Set();
        todayObs.forEach(o => { if (o.teacherId && o.avg !== null && !seen.has(o.teacherId)) { seen.add(o.teacherId); dist[pulseStatusFor5(o.avg)]++; } });
        return dist;
      })(),
      heatCols: last7.map((_, i) => pulseIsoDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (6 - i)))),
      heatMatrix: (() => {
        const m = {};
        wingKeys.forEach(w => { m[w] = []; });
        for (let i = 6; i >= 0; i--) {
          const d = pulseIsoDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i));
          const dayObs = observations.filter(o => o.date === d);
          wingKeys.forEach(w => m[w].push(pulseRound1(pulseAvg(dayObs.filter(o => o.wing === w).map(o => o.avg).filter(v => v !== null))) || 0));
        }
        return m;
      })(),
      attnLabel: 'Flagged today', attention: obsAttention(todayObs, nameOf),
      compliance,
      headline: flaggedToday ? `${flaggedToday} observation${flaggedToday > 1 ? 's' : ''} flagged for revisit today` : `${todayObs.length} classes observed today, none flagged`,
      wcardMetric: 'Avg rating today',
    };
  }

  // --- Week ---
  {
    const wingScores = wingObsRollup(weekObs);
    const compliance = {};
    wingKeys.forEach(w => {
      const observedTeachers = new Set(weekObs.filter(o => o.wing === w && o.teacherId).map(o => o.teacherId)).size;
      compliance[w] = wingStaffCount[w] ? Math.min(1, observedTeachers / wingStaffCount[w]) : null;
    });
    const [weeklyReports] = await db.query('SELECT wing FROM supervision_weekly_reports WHERE week_start_date=?', [mondayStr]);
    const submittedWings = new Set(weeklyReports.map(r => r.wing));
    const [attRows] = await db.query(
      `SELECT staff_id, working_days, leaves_taken, late_arrivals, punctuality_rating, dress_code_rating, overall_conduct_rating, lesson_prep_rating
       FROM staff_weekly_attendance WHERE week_start_date=?`, [mondayStr]
    );
    let attPctVals = [];
    attRows.forEach(r => { if (r.working_days) attPctVals.push(Math.max(0, Math.min(100, ((r.working_days - (r.leaves_taken || 0)) / r.working_days) * 100))); });
    const avgAttendance = pulseRound1(pulseAvg(attPctVals));
    const [[memoWeek]] = await db.query(
      'SELECT COUNT(*) cnt FROM performance_memos WHERE memo_date BETWEEN ? AND ?', [mondayStr, weekEndStr]
    );
    const avgWeek = pulseRound1(pulseAvg(weekObs.map(o => o.avg).filter(v => v !== null)));
    const last8 = [];
    const weekCols = [];
    for (let i = 7; i >= 0; i--) {
      const wkStart = pulseIsoDate(pulseMondayOf(new Date(now.getTime() - i * 7 * 86400000)));
      const wkEnd = pulseAddDays(wkStart, 6);
      const wkObs = observations.filter(o => o.date >= wkStart && o.date <= wkEnd);
      last8.push(pulseRound1(pulseAvg(wkObs.map(o => o.avg).filter(v => v !== null))) || 0);
      weekCols.push(wkStart.slice(5));
    }
    periods.week = {
      kpis: [
        { label: 'Weekly reports submitted', value: submittedWings.size, unit: `/${wingKeys.length} wings`, delta: '', dir: 'flat', trend: last8 },
        { label: 'Avg weekly observation rating', value: avgWeek === null ? 0 : avgWeek, unit: '/5', delta: '', dir: 'flat', trend: last8 },
        { label: 'Avg attendance this week', value: avgAttendance === null ? 0 : avgAttendance, unit: '%', delta: '', dir: 'flat', trend: last8 },
        { label: 'Memos logged this week', value: Number(memoWeek.cnt), unit: 'memos', delta: '', dir: 'flat', trend: last8 },
      ],
      gauge: avgWeek === null ? 0 : avgWeek, gaugeLabel: 'Overall avg weekly rating', maxScore: 5,
      wingScores, bandLabel: "This week's observation ratings", bandUnit: 'teachers observed',
      bandLabels: PULSE_BAND_LABELS_5, statusOrder: PULSE_STATUS_ORDER_5,
      bandDist: (() => {
        const dist = { good: 0, warning: 0, serious: 0, critical: 0 };
        const seen = new Set();
        weekObs.forEach(o => { if (o.teacherId && o.avg !== null && !seen.has(o.teacherId)) { seen.add(o.teacherId); dist[pulseStatusFor5(o.avg)]++; } });
        return dist;
      })(),
      heatCols: weekCols,
      heatMatrix: (() => {
        const m = {};
        wingKeys.forEach(w => { m[w] = []; });
        for (let i = 7; i >= 0; i--) {
          const wkStart = pulseIsoDate(pulseMondayOf(new Date(now.getTime() - i * 7 * 86400000)));
          const wkEnd = pulseAddDays(wkStart, 6);
          const wkObs = observations.filter(o => o.date >= wkStart && o.date <= wkEnd);
          wingKeys.forEach(w => m[w].push(pulseRound1(pulseAvg(wkObs.filter(o => o.wing === w).map(o => o.avg).filter(v => v !== null))) || 0));
        }
        return m;
      })(),
      attnLabel: 'Staff to check in on this week', attention: obsAttention(weekObs, nameOf),
      compliance,
      headline: `${wingKeys.length - submittedWings.size} of ${wingKeys.length} wings haven't submitted this week's report yet`,
      wcardMetric: 'Avg rating this week',
    };
  }

  // --- Month ---
  {
    const wingScores = {};
    wingKeys.forEach(w => {
      const scores = staffByWing[w].map(s => monthScoreById.get(s.id)).filter(v => v !== null && v !== undefined);
      wingScores[w] = pulseRound1(pulseAvg(scores));
    });
    const compliance = {};
    wingKeys.forEach(w => {
      const scored = staffByWing[w].filter(s => monthScoreById.get(s.id) != null).length;
      compliance[w] = wingStaffCount[w] ? scored / wingStaffCount[w] : null;
    });
    const allMonthScores = monthRows.map(r => monthScoreById.get(r.staff_id)).filter(v => v !== null && v !== undefined);
    const avgMonth = pulseRound1(pulseAvg(allMonthScores));
    const belowThreshold = allMonthScores.filter(v => v < weights.perf_threshold_avg).length;
    const attPctAll = monthRows.map(r => r.attendance_pct).filter(v => v !== null && v !== undefined).map(Number);
    const avgAttMonth = pulseRound1(pulseAvg(attPctAll));
    const trend6 = overallMonthTrend.slice(-7).map(v => v || 0);
    const attention = [...monthRows]
      .map(r => ({ staffId: r.staff_id, score: monthScoreById.get(r.staff_id) }))
      .filter(x => x.score !== null && x.score !== undefined)
      .sort((a, b) => a.score - b.score)
      .slice(0, 3)
      .map(x => ({ title: nameOf(x.staffId) || `Staff #${x.staffId}`, sub: `Month Score ${x.score}/10 this month`, score: x.score }));
    periods.month = {
      kpis: [
        { label: 'Reviews completed', value: monthRows.filter(r => monthScoreById.get(r.staff_id) != null).length, unit: `/${staffRows.length} staff`, delta: '', dir: 'flat', trend: trend6 },
        { label: 'Avg combined score', value: avgMonth === null ? 0 : avgMonth, unit: '/10', delta: '', dir: 'flat', trend: trend6 },
        { label: `Below threshold (<${weights.perf_threshold_avg})`, value: belowThreshold, unit: 'staff', delta: '', dir: 'flat', trend: trend6 },
        { label: 'Avg attendance', value: avgAttMonth === null ? 0 : avgAttMonth, unit: '%', delta: '', dir: 'flat', trend: trend6 },
      ],
      gauge: avgMonth === null ? 0 : avgMonth, gaugeLabel: 'Avg combined month score', maxScore: 10,
      wingScores, bandLabel: `${new Date(monthStart).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })} review bands`, bandUnit: 'staff reviewed',
      bandLabels: PULSE_BAND_LABELS_10, statusOrder: PULSE_STATUS_ORDER_10,
      bandDist: (() => {
        const dist = { good: 0, warning: 0, critical: 0 };
        allMonthScores.forEach(v => dist[pulseStatusFor10(v, weights)]++);
        return dist;
      })(),
      heatCols: monthKeysSorted.slice(-6).map(m => new Date(m).toLocaleDateString('en-IN', { month: 'short' })),
      heatMatrix: (() => {
        const cols = monthKeysSorted.slice(-6);
        const m = {};
        wingKeys.forEach(w => {
          m[w] = cols.map(mo => {
            const rowsThisMonth = ayRows.filter(r => r.month_date === mo && staffByWing[w].some(s => s.id === r.staff_id));
            const vals = rowsThisMonth.map(r => monthScore(r, weights)).filter(v => v !== null);
            return pulseRound1(pulseAvg(vals)) || 0;
          });
        });
        return m;
      })(),
      attnLabel: 'Below threshold this month', attention,
      compliance,
      headline: `${belowThreshold} teacher${belowThreshold === 1 ? '' : 's'} below the ${weights.perf_threshold_avg}/10 review threshold this month`,
      wcardMetric: 'Avg score this month',
    };
  }

  // --- Year ---
  {
    const wingScores = {};
    wingKeys.forEach(w => {
      const vals = staffByWing[w].map(s => annualByStaff.get(s.id).weighted).filter(v => v !== null && v !== undefined);
      wingScores[w] = pulseRound1(pulseAvg(vals));
    });
    const compliance = {};
    wingKeys.forEach(w => {
      const withData = staffByWing[w].filter(s => annualByStaff.get(s.id).weighted != null).length;
      compliance[w] = wingStaffCount[w] ? withData / wingStaffCount[w] : null;
    });
    const withWeighted = annualList.filter(s => s.weighted !== null);
    const avgYear = pulseRound1(pulseAvg(withWeighted.map(s => s.weighted)));
    const topPerformers = annualList.filter(s => s.band === 'Top Performer');
    let avgIncrement = null;
    if (weights.perf_budget_total > 0 && topPerformers.length) {
      const incs = topPerformers.map(s => proposedIncrement(s, annualList, weights.perf_budget_total));
      avgIncrement = Math.round(pulseAvg(incs));
    }
    const reviewedYTD = annualList.filter(s => s.monthsLogged > 0).length;
    const attention = annualList
      .filter(s => s.weighted !== null)
      .sort((a, b) => a.weighted - b.weighted)
      .slice(0, 3)
      .map(s => ({ title: `${s.staff.first_name} ${s.staff.last_name || ''}`.trim(), sub: `${s.band} — Weighted Score ${s.weighted}/10`, score: s.weighted }));
    periods.year = {
      kpis: [
        { label: 'Staff reviewed YTD', value: reviewedYTD, unit: `/${staffRows.length}`, delta: '', dir: 'flat', trend: overallMonthTrend.map(v => v || 0) },
        { label: 'Avg annual score', value: avgYear === null ? 0 : avgYear, unit: '/10', delta: '', dir: 'flat', trend: overallMonthTrend.map(v => v || 0) },
        { label: 'Top performers', value: topPerformers.length, unit: 'staff', delta: '', dir: 'flat', trend: overallMonthTrend.map(v => v || 0) },
        { label: 'Avg proposed increment', value: avgIncrement === null ? 0 : avgIncrement, unit: avgIncrement === null ? '— no budget set' : 'Rs', delta: '', dir: 'flat', trend: overallMonthTrend.map(v => v || 0) },
      ],
      gauge: avgYear === null ? 0 : avgYear, gaugeLabel: `Avg annual score (AY ${ay.start_date ? new Date(ay.start_date).getFullYear() : ''}–${ay.end_date ? new Date(ay.end_date).getFullYear() : ''})`, maxScore: 10,
      wingScores, bandLabel: 'Annual bands so far', bandUnit: 'staff',
      bandLabels: PULSE_BAND_LABELS_10, statusOrder: PULSE_STATUS_ORDER_10,
      bandDist: (() => {
        const dist = { good: 0, warning: 0, critical: 0 };
        annualList.forEach(s => { if (s.band) dist[bandKeyFor10(s.band)]++; });
        return dist;
      })(),
      heatCols: monthKeysSorted.map(m => new Date(m).toLocaleDateString('en-IN', { month: 'short', year: '2-digit' })),
      heatMatrix: (() => {
        const cols = monthKeysSorted;
        const m = {};
        wingKeys.forEach(w => {
          m[w] = cols.map(mo => {
            const rowsThisMonth = ayRows.filter(r => r.month_date === mo && staffByWing[w].some(s => s.id === r.staff_id));
            const vals = rowsThisMonth.map(r => monthScore(r, weights)).filter(v => v !== null);
            return pulseRound1(pulseAvg(vals)) || 0;
          });
        });
        return m;
      })(),
      attnLabel: 'Lowest annual scores so far', attention,
      compliance,
      headline: `${annualList.filter(s => s.band === 'Below Expectations').length} staff currently in Below Expectations`,
      wcardMetric: 'Avg score this year',
    };
  }

  // ===== Teachers (lookup / wing-list / drill-down) — real staff only, no fabricated class scores =====
  const teachers = staffRows.map(s => {
    const name = `${s.first_name} ${s.last_name || ''}`.trim();
    const todayMine = todayObs.filter(o => o.teacherId === s.id);
    const weekMine = weekObs.filter(o => o.teacherId === s.id);
    const monthRow = monthRowById.get(s.id);
    const annual = annualByStaff.get(s.id);
    const todayScore = pulseRound1(pulseAvg(todayMine.map(o => o.avg).filter(v => v !== null)));
    const weekScore = pulseRound1(pulseAvg(weekMine.map(o => o.avg).filter(v => v !== null)));
    const monthS = monthScoreById.get(s.id);
    const yearS = annual ? annual.weighted : null;

    function catsFromObs(obsList) {
      const byLabel = {};
      obsList.forEach(o => Object.entries(o.points).forEach(([label, arr]) => { (byLabel[label] = byLabel[label] || []).push(...arr); }));
      return PULSE_OBSERVATION_POINTS.filter(l => byLabel[l] && byLabel[l].length)
        .map(l => ({ label: l, value: pulseRound1(pulseAvg(byLabel[l])) }));
    }
    const MONTH_FIELD_LABELS = [
      ['syllabus_pace', 'Syllabus Pace'], ['classroom_mgmt', 'Classroom Management'], ['homework_correction', 'Homework Correction'],
      ['student_outcomes_override', 'Student Outcomes'], ['parent_comm', 'Parent Communication'], ['admin_compliance', 'Admin Compliance'],
      ['cocurricular', 'Co-Curricular'], ['professional_dev', 'Professional Development'], ['behaviour_teamwork', 'Behaviour & Teamwork'],
      ['overall_holistic', 'Overall Holistic'], ['punctuality_rating', 'Punctuality'], ['dress_code_rating', 'Dress Code'],
      ['overall_conduct_rating', 'Overall Conduct'], ['lesson_prep_rating', 'Lesson Preparation'],
    ];
    const monthCats = monthRow
      ? MONTH_FIELD_LABELS.filter(([k]) => monthRow[k] !== null && monthRow[k] !== undefined).map(([k, label]) => ({ label, value: Number(monthRow[k]) }))
      : [];
    const yearCats = annual
      ? [
          annual.annualPerf !== null ? { label: 'Annual Performance (avg of months)', value: annual.annualPerf } : null,
          annual.loyalty !== null ? { label: 'Loyalty (years of service)', value: annual.loyalty } : null,
          annual.roleResp !== null ? { label: 'Role & Responsibility', value: annual.roleResp } : null,
          annual.behaviour !== null ? { label: 'Behaviour & Teamwork', value: annual.behaviour } : null,
        ].filter(Boolean)
      : [];

    const trendMonths = annual && annual.monthCombined.length ? annual.monthCombined.slice(-7).map(m => m.combined) : [0];
    const trendObs5 = (() => {
      const last7 = [];
      for (let i = 6; i >= 0; i--) {
        const d = pulseIsoDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i));
        const dayMine = observations.filter(o => o.teacherId === s.id && o.date === d);
        last7.push(pulseRound1(pulseAvg(dayMine.map(o => o.avg).filter(v => v !== null))) || 0);
      }
      return last7;
    })();

    const flags = [];
    if (monthRow && (monthRow.academic_flags > 0 || monthRow.discipline_issues > 0)) {
      flags.push({ title: 'Flagged this month', sub: `${monthRow.discipline_issues || 0} discipline issue(s), ${monthRow.academic_flags || 0} academic flag(s)`, score: monthS });
    }
    todayMine.concat(weekMine).forEach(o => {
      if (o.revisit && !flags.some(f => f.sub.includes(o.date))) {
        flags.push({ title: 'Class flagged for revisit', sub: (o.topic ? o.topic + ' — ' : '') + o.date, score: o.avg });
      }
    });

    return {
      id: s.id, type: 'teacher', name, wing: s.wing || null, meta: s.designation || 'Teacher',
      // Keep true null through to the client — it must distinguish "no data yet" from an
      // actually-low score, rather than a 0 collapsing into a misleading "Critical" status pill.
      overallByPeriod: [todayScore, weekScore, monthS === undefined ? null : monthS, yearS],
      countLabel: {
        today: todayMine.length ? `${todayMine.length} class${todayMine.length > 1 ? 'es' : ''} observed today` : 'No observations today',
        week: weekMine.length ? `${weekMine.length} class${weekMine.length > 1 ? 'es' : ''} observed this week` : 'No observations this week',
        month: monthS != null ? 'Reviewed this month' : 'Not yet reviewed this month',
        year: annual ? `${annual.monthsLogged} month${annual.monthsLogged === 1 ? '' : 's'} reviewed this AY` : 'No data this AY',
      },
      categoriesByPeriod: { today: catsFromObs(todayMine), week: catsFromObs(weekMine), month: monthCats, year: yearCats },
      trendByPeriod: { today: trendObs5, week: trendObs5, month: trendMonths, year: trendMonths },
      flags,
    };
  });

  return {
    wings: wingKeys.map(w => ({ key: w, name: WINGS[w].label.replace(/\s*\(.*\)$/, ''), sub: pulseWingSub(WINGS[w]), staff: wingStaffCount[w] })),
    unassignedCount,
    thresholds10: { top: weights.perf_threshold_top, avg: weights.perf_threshold_avg },
    periods,
    teachers,
    generatedAt: new Date().toISOString(),
  };
}

router.get('/pulse', requireAdmin, async (req, res) => {
  try {
    const weights = await getWeights(db);
    const pulseData = await buildPulseData(db, weights);
    res.render('performance/pulse', { title: 'Teacher Pulse', activePage: 'performance', pulseJSON: JSON.stringify(pulseData) });
  } catch (err) {
    console.error(err);
    req.flash('error', 'Could not load Teacher Pulse: ' + err.message);
    res.redirect('/performance');
  }
});

module.exports = router;

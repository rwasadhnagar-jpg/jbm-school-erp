const express = require('express');
const router = express.Router();
const db = require('../db');
const bcrypt = require('bcryptjs');
const { computeAttendanceAuto, syncMonthlyFromWeekly } = require('../utils/performanceCalc');

const ACADEMIC_YEAR_ID = 1;

// Redefined 2026-09-15 (was: primary=Nursery-V combined, middle=VI-VIII, secondary=IX-X,
// sr_secondary=XI-XII) — Pre-Primary split off from Primary (each now has its own In-charge,
// mother-teacher model, one teacher per section), Middle+Secondary merged under one In-charge.
// Applies everywhere a wing is used (weekly reports, attendance, observations, Performance) —
// no real production In-charge logins existed under the old split yet, only local/UAT ones.
const WINGS = {
  pre_primary:      { label: 'Pre-Primary Wing (Nursery–Prep)', classes: ['Nursery', 'Prep'] },
  primary:          { label: 'Primary Wing (I–V)',              classes: ['I', 'II', 'III', 'IV', 'V'] },
  middle_secondary: { label: 'Middle & Secondary Wing (VI–X)',  classes: ['VI', 'VII', 'VIII', 'IX', 'X'] },
  sr_secondary:     { label: 'Sr. Secondary Wing (XI–XII)',     classes: ['XI', 'XII'] },
};
// Wings where classroom observation uses the automatic weekly rotation instead of free choice.
// Two flavours, since the unit being rotated differs:
// - SECTION mode (mother-teacher wings — one teacher per section): the rotation picks a SECTION;
//   visiting it fully covers that one teacher.
// - TEACHER mode (subject-specialist wings — many teachers per class, one teacher across many
//   classes): the rotation picks a TEACHER directly; the Incharge picks which of that teacher's
//   actual class periods they sat in on, since the section itself isn't the point.
const SECTION_ROTATION_WINGS = ['pre_primary', 'primary'];
const TEACHER_ROTATION_WINGS = ['middle_secondary', 'sr_secondary'];
const ALL_ROTATION_WINGS = [...SECTION_ROTATION_WINGS, ...TEACHER_ROTATION_WINGS];
const WING_KEYS = Object.keys(WINGS);

// Rebuilt 2026-09-15 into the agreed 12-point checklist, split across two forms: 4 items live on
// the Weekly Attendance screen (Punctuality, Dress Code, Overall Conduct, Lesson Preparation —
// see staff_weekly_attendance's *_rating columns), and these 8 remain here as the in-class
// checklist, filled during the actual visit. Replaces the earlier 10-point list (2026-09-11) —
// "Teacher Diary prepared" and "Emphasis on weak/slow learners" (with its child-flag) dropped,
// "Blackboard/Smart Class" folded into Teaching Pedagogy, "On schedule..." shortened to Syllabus
// Pace, "Class Control and Discipline" renamed Classroom Control & Discipline, "Oral Work/Class
// Discussion" renamed Student Engagement, "Students able to answer..." renamed Student Response,
// and English Communication added new. `needsChildFlag` support is left in place (unused by any
// current point) rather than removed, in case a future point needs it again.
const RATING_OPTIONS = [
  { value: '5', label: '5 — Excellent' },
  { value: '4', label: '4 — Good' },
  { value: '3', label: '3 — Satisfactory' },
  { value: '2', label: '2 — Needs Improvement' },
  { value: '1', label: '1 — Poor' },
];
const OBSERVATION_POINTS = [
  { label: 'English Communication' },
  { label: 'Teaching Pedagogy' },
  { label: 'Student Engagement' },
  { label: 'Classroom Control & Discipline' },
  { label: 'Student Response' },
  { label: 'Syllabus Pace' },
  { label: 'Notebook Checking' },
  { label: 'Homework / Assignment given' },
];
function observationPointsFor() { return OBSERVATION_POINTS; }
function wingLabel(wing) { return (WINGS[wing] && WINGS[wing].label) || wing; }
// SQL fragment for "this staff row belongs to wing W" — true for their primary wing (staff.wing)
// OR any additional cross-wing membership (staff_wings). `col` is the staff id column to use in
// the subquery (e.g. 's.id' or 'id'); `wingCol` is the staff wing column (e.g. 's.wing' or 'wing').
// Returns { clause, params } — params must be supplied as [wing, wing] wherever clause is used.
function wingMembershipClause(col, wingCol) {
  return `(${wingCol}=? OR ${col} IN (SELECT staff_id FROM staff_wings WHERE wing=?))`;
}

// === DB INIT (self-migrating, mirrors routes/performance.js) ===
(async () => {
  try {
    await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS wing VARCHAR(20) DEFAULT NULL');
    await db.query('ALTER TABLE staff ADD COLUMN IF NOT EXISTS wing VARCHAR(20) DEFAULT NULL');

    // One-time wing-key migration (2026-09-15): old 'middle'/'secondary' merge into
    // 'middle_secondary' — unambiguous, safe to do automatically. Old 'primary' (used to mean
    // Nursery-V) is now ambiguous between 'pre_primary' and the narrower new 'primary' — left
    // alone here; needs a manual re-tag from real class-assignment data (see project plan).
    // Safe to re-run: a no-op once no rows still carry the old keys.
    await db.query("UPDATE users SET wing='middle_secondary' WHERE wing IN ('middle','secondary')");
    await db.query("UPDATE staff SET wing='middle_secondary' WHERE wing IN ('middle','secondary')");

    await db.query(`CREATE TABLE IF NOT EXISTS staff_weekly_attendance (
      id INT AUTO_INCREMENT PRIMARY KEY,
      staff_id INT NOT NULL,
      week_start_date DATE NOT NULL,
      working_days INT DEFAULT NULL,
      leaves_taken INT DEFAULT 0,
      late_arrivals INT DEFAULT 0,
      leaves_clubbed_with_holiday INT DEFAULT 0,
      entered_by INT DEFAULT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY staff_week (staff_id, week_start_date)
    )`);
    await db.query('ALTER TABLE staff_weekly_attendance ADD COLUMN IF NOT EXISTS late_arrivals INT DEFAULT 0');
    // Weekly-form checklist items (2026-09-15), rated 1-5 like the in-class observation points —
    // filled alongside attendance, not tied to a single class visit. Nullable: leaving one blank
    // just means it wasn't rated that week, same blank-guard convention as everything else here.
    await db.query('ALTER TABLE staff_weekly_attendance ADD COLUMN IF NOT EXISTS punctuality_rating DECIMAL(3,1) DEFAULT NULL');
    await db.query('ALTER TABLE staff_weekly_attendance ADD COLUMN IF NOT EXISTS dress_code_rating DECIMAL(3,1) DEFAULT NULL');
    await db.query('ALTER TABLE staff_weekly_attendance ADD COLUMN IF NOT EXISTS overall_conduct_rating DECIMAL(3,1) DEFAULT NULL');
    await db.query('ALTER TABLE staff_weekly_attendance ADD COLUMN IF NOT EXISTS lesson_prep_rating DECIMAL(3,1) DEFAULT NULL');
    // Discipline incidents that week (2026-09-21) — moved off the monthly form so every Saturday
    // item (attendance, late, discipline, punctuality, dress code, conduct, lesson prep) is entered
    // in this one place and the monthly review just reads it.
    await db.query('ALTER TABLE staff_weekly_attendance ADD COLUMN IF NOT EXISTS discipline_issues INT DEFAULT 0');

    await db.query(`CREATE TABLE IF NOT EXISTS supervision_weekly_reports (
      id INT AUTO_INCREMENT PRIMARY KEY,
      wing VARCHAR(20) NOT NULL,
      week_start_date DATE NOT NULL,
      matters_for_management TEXT,
      submitted_by INT DEFAULT NULL,
      submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY wing_week (wing, week_start_date)
    )`);

    await db.query(`CREATE TABLE IF NOT EXISTS supervision_weekly_report_rows (
      id INT AUTO_INCREMENT PRIMARY KEY,
      report_id INT NOT NULL,
      visit_date DATE DEFAULT NULL,
      class_id INT DEFAULT NULL,
      teacher_id INT DEFAULT NULL,
      teacher_name_free VARCHAR(150) DEFAULT NULL,
      observation TEXT,
      action_taken TEXT,
      sort_order INT DEFAULT 0,
      FOREIGN KEY (report_id) REFERENCES supervision_weekly_reports(id) ON DELETE CASCADE
    )`);

    await db.query(`CREATE TABLE IF NOT EXISTS supervision_observations (
      id INT AUTO_INCREMENT PRIMARY KEY,
      wing VARCHAR(20) NOT NULL,
      class_id INT DEFAULT NULL,
      teacher_id INT DEFAULT NULL,
      teacher_name_free VARCHAR(150) DEFAULT NULL,
      subject_topic VARCHAR(200),
      observation_date DATE NOT NULL,
      period VARCHAR(50),
      observed_by INT DEFAULT NULL,
      syllabus_position ENUM('ahead','on_time','behind') DEFAULT NULL,
      guidance_given TEXT,
      revisit_required TINYINT(1) DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    await db.query(`CREATE TABLE IF NOT EXISTS supervision_observation_points (
      id INT AUTO_INCREMENT PRIMARY KEY,
      observation_id INT NOT NULL,
      point_no INT NOT NULL,
      point_label VARCHAR(255),
      rating CHAR(1) DEFAULT NULL,
      remarks VARCHAR(255),
      FOREIGN KEY (observation_id) REFERENCES supervision_observations(id) ON DELETE CASCADE
    )`);
    await db.query('ALTER TABLE supervision_observation_points ADD COLUMN IF NOT EXISTS child_name VARCHAR(150) DEFAULT NULL');
    await db.query('ALTER TABLE supervision_observation_points ADD COLUMN IF NOT EXISTS child_reason VARCHAR(255) DEFAULT NULL');

    // Submission lock (2026-09-15): once an Incharge files an observation there's no edit route
    // for it anyway, but `locked` marks that explicitly; `reviewed_by`/`reviewed_at` are an
    // Admin/Principal-only review marker, deliberately never surfaced in the Incharge's own UI —
    // "the incharge cannot see if the data is submitted [accepted]."
    await db.query('ALTER TABLE supervision_observations ADD COLUMN IF NOT EXISTS locked TINYINT(1) DEFAULT 0');
    await db.query('ALTER TABLE supervision_observations ADD COLUMN IF NOT EXISTS reviewed_by INT DEFAULT NULL');
    await db.query('ALTER TABLE supervision_observations ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMP NULL DEFAULT NULL');

    // Weekly rotation (Pre-Primary & Primary only — mother-teacher model, one teacher per
    // section). Each week, every real section in the group gets exactly one scheduled visit,
    // randomly assigned across that week's school days (capped per day), so the Incharge doesn't
    // choose which class to see and the whole group gets covered every week, not spread over
    // several. `assigned_to` is normally the wing's Incharge; Admin/Principal can override it for
    // one week as a spot-check (`is_override`) without touching the Incharge's regular wing.
    // class_id (section-mode: Pre-Primary/Primary) and teacher_id (teacher-mode: Middle &
    // Secondary/Sr Secondary) are mutually exclusive per row — exactly one is set depending on
    // which rotation flavour the wing uses. MySQL/MariaDB unique keys don't count NULLs as
    // colliding, so both UNIQUE KEYs below coexist fine even though most rows leave one column NULL.
    await db.query(`CREATE TABLE IF NOT EXISTS supervision_weekly_assignments (
      id INT AUTO_INCREMENT PRIMARY KEY,
      wing VARCHAR(20) NOT NULL,
      class_id INT DEFAULT NULL,
      teacher_id INT DEFAULT NULL,
      week_start_date DATE NOT NULL,
      planned_date DATE DEFAULT NULL,
      assigned_to INT NOT NULL,
      is_override TINYINT(1) DEFAULT 0,
      status ENUM('pending','done','skipped') DEFAULT 'pending',
      observation_id INT DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY class_week (class_id, week_start_date),
      UNIQUE KEY teacher_week (wing, teacher_id, week_start_date)
    )`);
    await db.query('ALTER TABLE supervision_weekly_assignments ADD COLUMN IF NOT EXISTS teacher_id INT DEFAULT NULL');
    try { await db.query('ALTER TABLE supervision_weekly_assignments MODIFY COLUMN class_id INT DEFAULT NULL'); } catch (e) {}
    // A cross-wing teacher (staff_wings) must get one slot per wing they belong to, not one slot
    // total — the key must include `wing`, or a second wing's insert silently no-ops against the
    // first wing's row for the same teacher/week (found via Akshita/Pinki both going missing from
    // one of their two wings' rotations).
    try { await db.query('ALTER TABLE supervision_weekly_assignments DROP INDEX teacher_week'); } catch (e) {}
    try { await db.query('ALTER TABLE supervision_weekly_assignments ADD UNIQUE KEY teacher_week (wing, teacher_id, week_start_date)'); } catch (e) {}

    // A teacher's `staff.wing` is their PRIMARY wing (their class-teacher assignment, managed via
    // the Attendance screen's admin dropdown / incharge tick-box). Some subject specialists also
    // teach a few periods into a second wing (e.g. a Sr Secondary class-teacher who also takes
    // Science periods in Middle & Secondary) — this table holds those ADDITIONAL memberships, so
    // that wing's Incharge can see/observe/score them too without changing their primary wing.
    await db.query(`CREATE TABLE IF NOT EXISTS staff_wings (
      id INT AUTO_INCREMENT PRIMARY KEY,
      staff_id INT NOT NULL,
      wing VARCHAR(20) NOT NULL,
      added_by INT DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY staff_wing (staff_id, wing)
    )`);

    // Same idea as staff_wings, but for an INCHARGE LOGIN covering more than one wing (e.g. one
    // person is In-charge of both Pre-Primary and Sr Secondary) — their `users.wing` column stays
    // their primary/default wing; this table holds any additional wings. See myAllowedWings() /
    // resolveWing() for how a login with more than one wing switches between them via ?wing=.
    await db.query(`CREATE TABLE IF NOT EXISTS user_wings (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      wing VARCHAR(20) NOT NULL,
      added_by INT DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY user_wing (user_id, wing)
    )`);

    await db.query(`CREATE TABLE IF NOT EXISTS supervision_meetings (
      id INT AUTO_INCREMENT PRIMARY KEY,
      week_start_date DATE NOT NULL UNIQUE,
      agenda TEXT,
      decisions TEXT,
      attendee_wings VARCHAR(100),
      held_by INT DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`);
  } catch (e) { console.error('supervision tables init:', e.message); }
})();

// === Date helpers (local-date, not toISOString — see qs_bracket_key_bug / IST lesson in routes/weekly.js) ===
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
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return isoDate(d);
}

// === Access helpers ===
// The "active" wing for this incharge session — normally their one assigned wing, but for an
// incharge covering more than one wing (see myAllowedWings) this is whichever of those wings they
// most recently switched to via resolveWing(), persisted on the session so it stays put across
// navigation without needing ?wing= on every link.
function myWing(req) { return req.session.user.wing; }
// Every wing this incharge login may act on — their primary wing plus any additional ones granted
// via the "Additional Wings" section on Manage In-charges (user_wings table). Falls back to just
// the primary wing for the normal one-wing-per-incharge case, and for any non-incharge role.
function myAllowedWings(req) {
  const u = req.session.user;
  if (u.wings && u.wings.length) return u.wings;
  return u.wing ? [u.wing] : [];
}
function isAdmin(req) { return req.session.user.role === 'admin'; }
function isPrincipalLevel(req) { return ['admin', 'principal', 'vice_principal'].includes(req.session.user.role); }

const requireAdmin = (req, res, next) => {
  if (!isAdmin(req)) { req.flash('error', 'Only admin can access this page'); return res.redirect('/supervision'); }
  next();
};
const requirePrincipalLevel = (req, res, next) => {
  if (!isPrincipalLevel(req)) { req.flash('error', 'Only Principal, Vice Principal or admin can access this page'); return res.redirect('/supervision'); }
  next();
};
// Attendance/staff-assignment access: admin, wing In-charges, and (added 2026-09-11 per user
// request) Principal — who also gets staff add/edit rights here, but NOT the full admin-only
// Staff/HR module (/teachers) — this stays a lightweight roster + wing-assignment screen only.
const requireAdminOrIncharge = (req, res, next) => {
  if (['admin', 'incharge', 'principal'].includes(req.session.user.role)) return next();
  req.flash('error', 'Only admin, Principal, or wing in-charges can access this page');
  res.redirect('/supervision');
};

// Resolves which wing a request should operate on. Incharge sessions are locked to whichever of
// their assigned wing(s) is currently active — most incharges have exactly one, so queryWing never
// matters for them; an incharge covering multiple wings (myAllowedWings) can switch which one is
// active by passing ?wing= a wing they're actually allowed, which persists on the session (see
// myWing) so it sticks across navigation. admin/principal/vice_principal may pick any wing via ?wing=.
function resolveWing(req, queryWing) {
  if (req.session.user.role === 'incharge') {
    const allowed = myAllowedWings(req);
    if (queryWing && allowed.includes(queryWing)) req.session.user.wing = queryWing;
    const w = myWing(req);
    if (!w || !WINGS[w]) return { wing: null, error: 'Your login has no wing assigned yet — ask admin to set it under Manage In-charges.' };
    return { wing: w, wings: allowed };
  }
  const w = queryWing && WINGS[queryWing] ? queryWing : WING_KEYS[0];
  return { wing: w };
}

// === Weekly rotation ===
const ROTATION_MAX_PER_DAY = 4;
const ROTATION_SCHOOL_DAYS = 5; // Mon-Fri — no holiday calendar exists in this app to consult

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Tops up whichever of `eligibleIds` don't already have a row this wing/week yet — covers both
// the brand-new-week case (nothing scheduled at all) and the case where someone got wing-tagged
// (or cross-wing-tagged) onto this wing AFTER the week's rotation was already generated, which
// previously left them permanently unscheduled for that week (ensureWeeklyAssignments used to be
// a strict one-shot: "do nothing if any row already exists"). Backfilled ids are placed on the
// earliest day that still has room under ROTATION_MAX_PER_DAY, counting whatever's already
// planned that day, so a late addition doesn't overload a day past the cap.
async function topUpRotationRows(column, eligibleIds, wing, weekStartStr, inchargeId) {
  const [existingRows] = await db.query(
    `SELECT ${column} AS eid, planned_date FROM supervision_weekly_assignments
     WHERE wing=? AND week_start_date=? AND ${column} IS NOT NULL`,
    [wing, weekStartStr]
  );
  const alreadyScheduled = new Set(existingRows.map(r => r.eid));
  const missingIds = eligibleIds.filter(id => !alreadyScheduled.has(id));
  if (!missingIds.length) return;

  const dayCounts = {};
  existingRows.forEach(r => {
    if (r.planned_date) {
      const d = isoDate(new Date(r.planned_date));
      dayCounts[d] = (dayCounts[d] || 0) + 1;
    }
  });

  // Round-robin across the week rather than filling one day to the cap before touching the next —
  // the old greedy fill-then-advance approach packed a small wing (e.g. Pre-Primary's 6 sections)
  // entirely onto Monday/Tuesday, leaving Wed-Fri with nothing scheduled at all ("not showing
  // today's visit" for the rest of the week). Spreading round-robin instead means every day gets
  // something whenever there's enough volume to cover the week, same total, same cap per day.
  let dayPointer = 0;
  for (const id of shuffle(missingIds)) {
    let attempts = 0;
    while (attempts < ROTATION_SCHOOL_DAYS && (dayCounts[addDays(weekStartStr, dayPointer)] || 0) >= ROTATION_MAX_PER_DAY) {
      dayPointer = (dayPointer + 1) % ROTATION_SCHOOL_DAYS;
      attempts++;
    }
    const plannedDate = addDays(weekStartStr, dayPointer);
    dayCounts[plannedDate] = (dayCounts[plannedDate] || 0) + 1;
    await db.query(
      `INSERT INTO supervision_weekly_assignments (wing, ${column}, week_start_date, planned_date, assigned_to)
       VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE ${column}=${column}`,
      [wing, id, weekStartStr, plannedDate, inchargeId]
    );
    dayPointer = (dayPointer + 1) % ROTATION_SCHOOL_DAYS;
  }
}

// Idempotent per id, not per wing/week: safe to call on every page load — it only inserts rows
// for ids that don't have one yet, so it both creates a fresh week's rotation and backfills
// anyone added to the wing after that week was first generated.
async function ensureWeeklyAssignments(wing, weekStartStr) {
  if (!ALL_ROTATION_WINGS.includes(wing)) return;

  const [[incharge]] = await db.query("SELECT id FROM users WHERE role='incharge' AND wing=? AND is_active=1 LIMIT 1", [wing]);
  if (!incharge) return; // no incharge assigned to this wing yet — nothing to schedule against

  if (SECTION_ROTATION_WINGS.includes(wing)) {
    // Mother-teacher wings: rotate SECTIONS — visiting one fully covers its one teacher.
    const [classesRaw] = await db.query(
      'SELECT id FROM classes WHERE academic_year_id=? AND class_name IN (?)', [ACADEMIC_YEAR_ID, WINGS[wing].classes]
    );
    if (!classesRaw.length) return;
    await topUpRotationRows('class_id', classesRaw.map(c => c.id), wing, weekStartStr, incharge.id);
  } else {
    // Subject-specialist wings: rotate TEACHERS directly — a section isn't the unit that maps to
    // one teacher here, so schedule the person, not the room. Includes cross-wing teachers
    // (staff_wings) so a specialist who also teaches into this wing gets covered too.
    const [teachersRaw] = await db.query(
      `SELECT id FROM staff WHERE staff_type='Teaching' AND is_active=1 AND ${wingMembershipClause('id', 'wing')}`,
      [wing, wing]
    );
    if (!teachersRaw.length) return;
    await topUpRotationRows('teacher_id', teachersRaw.map(t => t.id), wing, weekStartStr, incharge.id);
  }
}

// === Dashboard ===
router.get('/', async (req, res) => {
  try {
    const role = req.session.user.role;
    const monday = getWeekStart(req.query.date);
    const mondayStr = isoDate(monday);
    const weekEnd = addDays(mondayStr, 6);

    if (role === 'incharge') {
      const { wing, error: wingError } = resolveWing(req, req.query.wing);
      if (wingError) {
        return res.render('supervision/index', {
          title: 'Academic Supervision', activePage: 'supervision', role, wingError,
          weekStart: mondayStr,
        });
      }
      const [[report]] = await db.query('SELECT * FROM supervision_weekly_reports WHERE wing=? AND week_start_date=?', [wing, mondayStr]);
      let rowCount = 0;
      if (report) {
        const [[r]] = await db.query('SELECT COUNT(*) cnt FROM supervision_weekly_report_rows WHERE report_id=?', [report.id]);
        rowCount = Number(r.cnt);
      }
      const [[obsRow]] = await db.query(
        'SELECT COUNT(*) cnt FROM supervision_observations WHERE wing=? AND observation_date BETWEEN ? AND ?',
        [wing, mondayStr, weekEnd]
      );
      return res.render('supervision/index', {
        title: 'Academic Supervision', activePage: 'supervision', role,
        weekStart: mondayStr, weekEnd, wing, wingLabel: wingLabel(wing),
        reportSubmitted: !!report, rowCount, obsCount: Number(obsRow.cnt),
      });
    }

    // admin / principal / vice_principal — overview across all wings
    const overview = [];
    for (const w of WING_KEYS) {
      const [[report]] = await db.query('SELECT * FROM supervision_weekly_reports WHERE wing=? AND week_start_date=?', [w, mondayStr]);
      const [[obsRow]] = await db.query(
        'SELECT COUNT(*) cnt FROM supervision_observations WHERE wing=? AND observation_date BETWEEN ? AND ?',
        [w, mondayStr, weekEnd]
      );
      overview.push({ wing: w, label: wingLabel(w), submitted: !!report, obsCount: Number(obsRow.cnt) });
    }
    const [[meeting]] = await db.query('SELECT * FROM supervision_meetings WHERE week_start_date=?', [mondayStr]);
    const [[myObsRow]] = await db.query(
      'SELECT COUNT(*) cnt FROM supervision_observations WHERE observed_by=? AND observation_date BETWEEN ? AND ?',
      [req.session.user.id, mondayStr, weekEnd]
    );

    res.render('supervision/index', {
      title: 'Academic Supervision', activePage: 'supervision', role,
      weekStart: mondayStr, weekEnd, overview, meeting, myObsCount: Number(myObsRow.cnt),
    });
  } catch (err) {
    console.error(err);
    req.flash('error', 'Could not load Academic Supervision');
    res.redirect('/dashboard');
  }
});

// === Weekly Scrutiny Report (Annexure I) ===
router.get('/report', async (req, res) => {
  try {
    const monday = getWeekStart(req.query.week);
    const mondayStr = isoDate(monday);
    const { wing, error } = resolveWing(req, req.query.wing);
    if (error) { req.flash('error', error); return res.redirect('/supervision'); }

    const [[report]] = await db.query('SELECT * FROM supervision_weekly_reports WHERE wing=? AND week_start_date=?', [wing, mondayStr]);
    let rows = [];
    if (report) {
      [rows] = await db.query('SELECT * FROM supervision_weekly_report_rows WHERE report_id=? ORDER BY sort_order, id', [report.id]);
    }
    const [classesRaw] = await db.query(
      'SELECT * FROM classes WHERE academic_year_id=? AND class_name IN (?)',
      [ACADEMIC_YEAR_ID, WINGS[wing].classes]
    );
    const order = WINGS[wing].classes;
    classesRaw.sort((a, b) => order.indexOf(a.class_name) - order.indexOf(b.class_name) || String(a.section).localeCompare(String(b.section)));
    const [teachers] = await db.query("SELECT id, first_name, last_name FROM staff WHERE staff_type='Teaching' AND is_active=1 ORDER BY first_name");

    res.render('supervision/report', {
      title: 'Weekly Scrutiny Report', activePage: 'supervision',
      wing, wingLabel: wingLabel(wing), weekStart: mondayStr,
      prevWeek: addDays(mondayStr, -7), nextWeek: addDays(mondayStr, 7),
      report: report || {}, rows, classes: classesRaw, teachers, WINGS,
      canPickWing: req.session.user.role !== 'incharge', today: isoDate(new Date()),
    });
  } catch (err) {
    console.error(err);
    req.flash('error', 'Could not load weekly report');
    res.redirect('/supervision');
  }
});

router.post('/report', async (req, res) => {
  const monday = getWeekStart(req.body.week_start_date);
  const mondayStr = isoDate(monday);
  const { wing, error } = resolveWing(req, req.body.wing);
  if (error) { req.flash('error', error); return res.redirect('/supervision'); }
  try {
    const [existing] = await db.query('SELECT id FROM supervision_weekly_reports WHERE wing=? AND week_start_date=?', [wing, mondayStr]);
    let reportId;
    if (existing.length) {
      reportId = existing[0].id;
      await db.query(
        'UPDATE supervision_weekly_reports SET matters_for_management=?, submitted_by=?, updated_at=CURRENT_TIMESTAMP WHERE id=?',
        [req.body.matters_for_management || null, req.session.user.id, reportId]
      );
    } else {
      const [result] = await db.query(
        'INSERT INTO supervision_weekly_reports (wing, week_start_date, matters_for_management, submitted_by) VALUES (?,?,?,?)',
        [wing, mondayStr, req.body.matters_for_management || null, req.session.user.id]
      );
      reportId = result.insertId;
    }

    // Repeated same-name fields (visit_date, class_id, ...) — qs gives an array when there are
    // multiple rows and a bare string when there's exactly one; [].concat() normalizes both.
    // Deliberately NOT using rows[<id>]-style bracket keys here — see qs_bracket_key_bug memory.
    await db.query('DELETE FROM supervision_weekly_report_rows WHERE report_id=?', [reportId]);
    const visitDates = [].concat(req.body.visit_date || []);
    const classIds = [].concat(req.body.class_id || []);
    const teacherIds = [].concat(req.body.teacher_id || []);
    const teacherFrees = [].concat(req.body.teacher_name_free || []);
    const observations = [].concat(req.body.observation || []);
    const actions = [].concat(req.body.action_taken || []);

    for (let i = 0; i < visitDates.length; i++) {
      const hasAny = visitDates[i] || classIds[i] || teacherFrees[i] || observations[i] || actions[i];
      if (!hasAny) continue;
      await db.query(
        `INSERT INTO supervision_weekly_report_rows (report_id, visit_date, class_id, teacher_id, teacher_name_free, observation, action_taken, sort_order)
         VALUES (?,?,?,?,?,?,?,?)`,
        [reportId, visitDates[i] || null, classIds[i] || null, teacherIds[i] || null, teacherFrees[i] || null,
         observations[i] || null, actions[i] || null, i]
      );
    }
    req.flash('success', "This week's Scrutiny Report saved");
  } catch (err) {
    console.error(err);
    req.flash('error', 'Failed to save report: ' + err.message);
  }
  const wingParam = req.session.user.role !== 'incharge' ? `&wing=${wing}` : '';
  res.redirect(`/supervision/report?week=${mondayStr}${wingParam}`);
});

// === Class Observation Form (Annexure II) ===
router.get('/observations', async (req, res) => {
  try {
    const role = req.session.user.role;
    // Multi-wing incharges can switch which of their wings this list (and their active wing
    // generally) is scoped to via ?wing= — resolveWing validates it against their allowed set and
    // persists the switch. Admin/principal keep their existing "no filter by default" behaviour.
    let wing = role === 'incharge' ? resolveWing(req, req.query.wing).wing : (req.query.wing || '');
    let q = `SELECT o.*, c.class_name, c.section, st.first_name, st.last_name, u.name AS observer_name
             FROM supervision_observations o
             LEFT JOIN classes c ON c.id = o.class_id
             LEFT JOIN staff st ON st.id = o.teacher_id
             LEFT JOIN users u ON u.id = o.observed_by
             WHERE 1=1`;
    const params = [];
    if (wing && WINGS[wing]) { q += ' AND o.wing=?'; params.push(wing); }
    q += ' ORDER BY o.observation_date DESC, o.id DESC LIMIT 100';
    const [observations] = await db.query(q, params);
    res.render('supervision/observations', {
      title: 'Class Observations', activePage: 'supervision',
      observations, wing, WINGS, role,
    });
  } catch (err) {
    console.error(err);
    req.flash('error', 'Could not load observations');
    res.redirect('/supervision');
  }
});

router.get('/observations/new', async (req, res) => {
  try {
    const { wing, error } = resolveWing(req, req.query.wing);
    if (error) { req.flash('error', error); return res.redirect('/supervision'); }

    // Rotation wings: no free choice — you visit/observe whatever the weekly rotation assigned
    // you. Land on the rotation list instead, unless arriving here FROM that list with a specific
    // assignment already picked (assignment_id) to fill in.
    if (ALL_ROTATION_WINGS.includes(wing) && !req.query.assignment_id) {
      return res.redirect(`/supervision/rotation?wing=${wing}`);
    }

    let assignment = null;
    if (req.query.assignment_id) {
      const [[a]] = await db.query(
        `SELECT wa.*, c.class_name, c.section, c.class_teacher_id, st.first_name AS teacher_first_name, st.last_name AS teacher_last_name
         FROM supervision_weekly_assignments wa
         LEFT JOIN classes c ON c.id = wa.class_id
         LEFT JOIN staff st ON st.id = wa.teacher_id
         WHERE wa.id=?`, [req.query.assignment_id]
      );
      if (!a || a.assigned_to !== req.session.user.id || a.status !== 'pending') {
        req.flash('error', 'That visit is not assigned to you or has already been filed.');
        return res.redirect(`/supervision/rotation?wing=${wing}`);
      }
      assignment = a; // .class_id set => section-mode (class locked); .teacher_id set => teacher-mode (teacher locked)
    }

    const [classesRaw] = await db.query(
      'SELECT * FROM classes WHERE academic_year_id=? AND class_name IN (?)',
      [ACADEMIC_YEAR_ID, WINGS[wing].classes]
    );
    const order = WINGS[wing].classes;
    classesRaw.sort((a, b) => order.indexOf(a.class_name) - order.indexOf(b.class_name) || String(a.section).localeCompare(String(b.section)));
    // Wing-scoped: an observer should only be able to log a class visit against a teacher who
    // actually belongs to the wing being observed (previously this listed every active teacher
    // school-wide, so a cross-wing entry was possible — closed as part of "relevant Incharge only").
    // Includes teachers whose PRIMARY wing is elsewhere but who also teach into this wing (staff_wings).
    const [teachers] = await db.query(
      `SELECT id, first_name, last_name FROM staff WHERE staff_type='Teaching' AND is_active=1 AND ${wingMembershipClause('id', 'wing')} ORDER BY first_name`,
      [wing, wing]
    );

    // Session's picked date carries forward from one save to the next, and a running count
    // gives visible progress toward the "10-15 classes in one sitting" goal.
    const entryDate = req.query.date || isoDate(new Date());
    const [[countRow]] = await db.query(
      'SELECT COUNT(*) cnt FROM supervision_observations WHERE observed_by=? AND observation_date=?',
      [req.session.user.id, entryDate]
    );

    res.render('supervision/observation-form', {
      title: 'Class Observation Form', activePage: 'supervision',
      wing, wingLabel: wingLabel(wing), classes: classesRaw, teachers, WINGS, assignment,
      points: observationPointsFor(), ratingOptions: RATING_OPTIONS,
      today: entryDate, doneToday: Number(countRow.cnt), justSaved: req.query.saved === '1',
      canPickWing: req.session.user.role !== 'incharge',
    });
  } catch (err) {
    console.error(err);
    req.flash('error', 'Could not load observation form');
    res.redirect('/supervision');
  }
});

router.post('/observations', async (req, res) => {
  const { wing, error } = resolveWing(req, req.body.wing);
  if (error) { req.flash('error', error); return res.redirect('/supervision'); }
  try {
    // If this observation is filing a scheduled weekly-rotation visit, re-verify it's still this
    // user's pending assignment (not already done, not reassigned elsewhere since the form loaded).
    let assignment = null;
    if (req.body.assignment_id) {
      const [[a]] = await db.query('SELECT * FROM supervision_weekly_assignments WHERE id=?', [req.body.assignment_id]);
      if (!a || a.assigned_to !== req.session.user.id || a.status !== 'pending') {
        req.flash('error', 'That visit is no longer assigned to you or has already been filed.');
        return res.redirect(`/supervision/rotation?wing=${wing}`);
      }
      assignment = a;
      // Teacher-mode: the teacher is the locked part of the assignment, not the class — force it
      // server-side rather than trusting whatever the (disabled) form field sent.
      if (assignment.teacher_id) req.body.teacher_id = String(assignment.teacher_id);
    }
    // Server-side re-check that the picked teacher actually belongs to this wing — the dropdown
    // is already wing-filtered, but this closes the gap a free-text override or a tampered
    // request could otherwise slip through (see wing-scoping note on the GET route above).
    if (req.body.teacher_id) {
      const [[t]] = await db.query(
        `SELECT id FROM staff WHERE id=? AND ${wingMembershipClause('id', 'wing')}`,
        [req.body.teacher_id, wing, wing]
      );
      if (!t) {
        req.flash('error', 'That teacher is not in this wing — pick a teacher from the list.');
        return res.redirect(`/supervision/observations/new?wing=${wing}&date=${req.body.observation_date || ''}`);
      }
    }
    // Server-side backstop for the same rule the form's own `required` attributes enforce (added
    // 2026-09-17, incharges real-time testing when this landed) — never trust the client alone.
    // All 8 checklist points must carry a rating; remarks are only mandatory when a re-visit was
    // flagged (the revisit field itself only exists for Middle&Secondary / Sr Secondary wings, so
    // this naturally never fires for Pre-Primary/Primary, same as the client-side toggle).
    const ratingsCheck = [].concat(req.body.rating || []);
    if (ratingsCheck.length < 8 || ratingsCheck.some((r) => !r || !String(r).trim())) {
      req.flash('error', 'All 8 points must be rated before saving.');
      return res.redirect(`/supervision/observations/new?wing=${wing}&date=${req.body.observation_date || ''}`);
    }
    if (req.body.revisit_required === 'yes' && !String(req.body.guidance_given || '').trim()) {
      req.flash('error', 'Guidance/remarks are required when a re-visit is flagged.');
      return res.redirect(`/supervision/observations/new?wing=${wing}&date=${req.body.observation_date || ''}`);
    }
    const [result] = await db.query(
      `INSERT INTO supervision_observations
        (wing, class_id, teacher_id, teacher_name_free, subject_topic, observation_date, period, observed_by, syllabus_position, guidance_given, revisit_required, locked)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,1)`,
      [wing, req.body.class_id || null, req.body.teacher_id || null, req.body.teacher_name_free || null,
       req.body.subject_topic || null, req.body.observation_date, req.body.period || null, req.session.user.id,
       req.body.syllabus_position || null, req.body.guidance_given || null,
       req.body.revisit_required === 'yes' ? 1 : (req.body.revisit_required === 'no' ? 0 : null)]
    );
    const observationId = result.insertId;

    const labels = [].concat(req.body.point_label || []);
    const ratings = [].concat(req.body.rating || []);
    const pointRemarks = [].concat(req.body.point_remarks || []);
    const childNames = [].concat(req.body.child_name || []);
    const childReasons = [].concat(req.body.child_reason || []);
    for (let i = 0; i < labels.length; i++) {
      await db.query(
        `INSERT INTO supervision_observation_points
          (observation_id, point_no, point_label, rating, remarks, child_name, child_reason)
         VALUES (?,?,?,?,?,?,?)`,
        [observationId, i + 1, labels[i], ratings[i] || null, pointRemarks[i] || null,
         childNames[i] || null, childReasons[i] || null]
      );
    }

    if (assignment) {
      await db.query(
        "UPDATE supervision_weekly_assignments SET status='done', observation_id=? WHERE id=?",
        [observationId, assignment.id]
      );
      req.flash('success', 'Visit logged.');
      return res.redirect(`/supervision/rotation?wing=${wing}`);
    }
    // Free-choice wings: go straight back to a fresh form for the next class (not the list) — an
    // in-charge working through 10-15 classes from paper notes shouldn't have to navigate back
    // and forth each time.
    const nextParams = new URLSearchParams({ wing, date: req.body.observation_date, saved: '1' });
    return res.redirect(`/supervision/observations/new?${nextParams.toString()}`);
  } catch (err) {
    console.error(err);
    req.flash('error', 'Failed to save observation: ' + err.message);
    res.redirect('/supervision/observations/new');
  }
});

router.get('/observations/:id', async (req, res) => {
  try {
    const [[obs]] = await db.query(
      `SELECT o.*, c.class_name, c.section, st.first_name, st.last_name, u.name AS observer_name
       FROM supervision_observations o
       LEFT JOIN classes c ON c.id = o.class_id
       LEFT JOIN staff st ON st.id = o.teacher_id
       LEFT JOIN users u ON u.id = o.observed_by
       WHERE o.id=?`,
      [req.params.id]
    );
    if (!obs) { req.flash('error', 'Observation not found'); return res.redirect('/supervision/observations'); }
    if (req.session.user.role === 'incharge' && !myAllowedWings(req).includes(obs.wing)) {
      req.flash('error', 'You do not have access to this observation');
      return res.redirect('/supervision/observations');
    }
    const [points] = await db.query('SELECT * FROM supervision_observation_points WHERE observation_id=? ORDER BY point_no', [obs.id]);
    res.render('supervision/observation-view', {
      title: 'Class Observation', activePage: 'supervision',
      obs, points, wingLabelText: wingLabel(obs.wing),
    });
  } catch (err) {
    console.error(err);
    req.flash('error', 'Could not load observation');
    res.redirect('/supervision/observations');
  }
});

// === Weekly Rotation (all 4 wings — section-mode or teacher-mode, see SECTION/TEACHER_ROTATION_WINGS) ===
router.get('/rotation', async (req, res) => {
  try {
    const role = req.session.user.role;
    // Multi-wing incharges can switch their active wing here via ?wing= — resolveWing validates it
    // against their allowed set and persists the switch onto the session.
    let wing = role === 'incharge' ? resolveWing(req, req.query.wing).wing : (req.query.wing || '');
    if (!wing || !ALL_ROTATION_WINGS.includes(wing)) wing = ALL_ROTATION_WINGS[0];
    if (role === 'incharge' && !ALL_ROTATION_WINGS.includes(myWing(req))) {
      req.flash('error', 'The weekly rotation only applies to Pre-Primary, Primary, Middle & Secondary, and Sr Secondary.');
      return res.redirect('/supervision/observations');
    }
    const mode = SECTION_ROTATION_WINGS.includes(wing) ? 'section' : 'teacher';

    const monday = getWeekStart(req.query.week);
    const mondayStr = isoDate(monday);
    await ensureWeeklyAssignments(wing, mondayStr);

    const [rows] = await db.query(
      `SELECT wa.*, c.class_name, c.section, st.first_name AS teacher_first_name, st.last_name AS teacher_last_name,
              u.name AS assigned_to_name
       FROM supervision_weekly_assignments wa
       LEFT JOIN classes c ON c.id = wa.class_id
       LEFT JOIN staff st ON st.id = wa.teacher_id
       LEFT JOIN users u ON u.id = wa.assigned_to
       WHERE wa.wing=? AND wa.week_start_date=?
       ORDER BY wa.planned_date, c.class_name, c.section, st.first_name`,
      [wing, mondayStr]
    );
    const today = isoDate(new Date());
    const graceEnd = addDays(mondayStr, 6 + 3); // 3-day grace window past the week's end
    rows.forEach(r => {
      r.isMine = r.assigned_to === req.session.user.id;
      r.isOverdue = r.status === 'pending' && r.planned_date && isoDate(new Date(r.planned_date)) < today;
      r.pastGrace = r.status === 'pending' && today > graceEnd;
    });

    const [incharges] = await db.query("SELECT id, name FROM users WHERE role='incharge' AND is_active=1 ORDER BY name");

    // An Incharge doing their daily rounds only needs today's picks plus anything overdue from
    // earlier in the week — the full week's schedule (including days not yet reached) is more
    // than they asked to see day-to-day. Admin/Principal keep the full week for oversight.
    const visibleRows = role === 'incharge'
      ? rows.filter(r => {
          const d = r.planned_date ? isoDate(new Date(r.planned_date)) : null;
          return d === today || (d && d < today && r.status === 'pending');
        })
      : rows;

    res.render('supervision/rotation', {
      title: 'Weekly Rotation', activePage: 'supervision',
      wing, wingLabel: wingLabel(wing), weekStart: mondayStr, today, mode,
      prevWeek: addDays(mondayStr, -7), nextWeek: addDays(mondayStr, 7),
      rows: visibleRows, incharges, WINGS, ALL_ROTATION_WINGS, role,
      canPickWing: role !== 'incharge', canReassign: ['admin', 'principal'].includes(role),
    });
  } catch (err) {
    console.error(err);
    req.flash('error', 'Could not load weekly rotation');
    res.redirect('/supervision');
  }
});

router.post('/rotation/:id/skip', async (req, res) => {
  try {
    const [[a]] = await db.query('SELECT * FROM supervision_weekly_assignments WHERE id=?', [req.params.id]);
    if (!a) throw new Error('Not found');
    // Incharge may only skip their own pending assignment; Admin/Principal may skip any.
    const canSkip = ['admin', 'principal'].includes(req.session.user.role) || a.assigned_to === req.session.user.id;
    if (!canSkip) throw new Error('Not your assignment');
    await db.query("UPDATE supervision_weekly_assignments SET status='skipped' WHERE id=? AND status='pending'", [a.id]);
    req.flash('success', 'Marked as skipped (e.g. section does not actually exist, or teacher unavailable).');
  } catch (err) {
    console.error(err);
    req.flash('error', 'Failed to skip: ' + err.message);
  }
  res.redirect(`/supervision/rotation?wing=${req.body.wing || ''}`);
});

// Admin/Principal spot-check: hand this week's visit for one class to a different Incharge,
// without touching anyone's actual wing assignment — "gives me a chance to change the incharge
// for one week to check assessment is getting done properly."
router.post('/rotation/:id/reassign', async (req, res) => {
  if (!['admin', 'principal'].includes(req.session.user.role)) {
    req.flash('error', 'Only admin or Principal can reassign a weekly visit');
    return res.redirect(`/supervision/rotation?wing=${req.body.wing || ''}`);
  }
  try {
    const { assigned_to } = req.body;
    const [[u]] = await db.query("SELECT id FROM users WHERE id=? AND role='incharge'", [assigned_to]);
    if (!u) throw new Error('Pick a valid Incharge');
    await db.query(
      "UPDATE supervision_weekly_assignments SET assigned_to=?, is_override=1 WHERE id=? AND status='pending'",
      [assigned_to, req.params.id]
    );
    req.flash('success', "This week's visit reassigned");
  } catch (err) {
    console.error(err);
    req.flash('error', 'Failed to reassign: ' + err.message);
  }
  res.redirect(`/supervision/rotation?wing=${req.body.wing || ''}`);
});

// === Weekly Academic Meeting minutes (Principal / Vice Principal) ===
router.get('/meeting', requirePrincipalLevel, async (req, res) => {
  try {
    const monday = getWeekStart(req.query.week);
    const mondayStr = isoDate(monday);
    const [[meeting]] = await db.query('SELECT * FROM supervision_meetings WHERE week_start_date=?', [mondayStr]);
    res.render('supervision/meeting', {
      title: 'Weekly Academic Meeting', activePage: 'supervision',
      weekStart: mondayStr, prevWeek: addDays(mondayStr, -7), nextWeek: addDays(mondayStr, 7),
      meeting: meeting || {}, WINGS,
      attendeeWings: meeting && meeting.attendee_wings ? meeting.attendee_wings.split(',') : [],
    });
  } catch (err) {
    console.error(err);
    req.flash('error', 'Could not load meeting minutes');
    res.redirect('/supervision');
  }
});

router.post('/meeting', requirePrincipalLevel, async (req, res) => {
  const monday = getWeekStart(req.body.week_start_date);
  const mondayStr = isoDate(monday);
  try {
    const attendeeWings = [].concat(req.body.attendee_wings || []).filter(w => WINGS[w]).join(',');
    await db.query(
      `INSERT INTO supervision_meetings (week_start_date, agenda, decisions, attendee_wings, held_by)
       VALUES (?,?,?,?,?)
       ON DUPLICATE KEY UPDATE agenda=VALUES(agenda), decisions=VALUES(decisions), attendee_wings=VALUES(attendee_wings), held_by=VALUES(held_by)`,
      [mondayStr, req.body.agenda || null, req.body.decisions || null, attendeeWings || null, req.session.user.id]
    );
    req.flash('success', "This week's meeting minutes saved");
  } catch (err) {
    console.error(err);
    req.flash('error', 'Failed to save minutes: ' + err.message);
  }
  res.redirect(`/supervision/meeting?week=${mondayStr}`);
});

// === Weekly Staff Attendance (admin + wing In-charges, for their own wing's staff) ===
// Entered manually once a week per staff: working days, leaves taken, and how many of those
// leaves were clubbed with a holiday. No daily attendance marking or holiday calendar exists in
// this app — this is a deliberately lightweight weekly summary, not a day-by-day system.
router.get('/attendance', requireAdminOrIncharge, async (req, res) => {
  try {
    const monday = getWeekStart(req.query.week);
    const mondayStr = isoDate(monday);
    const role = req.session.user.role;
    let myOwnWing = null;
    let canAssignWing = false;
    let wingFilter = null; // admin/principal's optional "view just this wing" filter

    if (role === 'incharge') {
      // Multi-wing incharges can switch which wing they're currently ticking staff into via
      // ?wing= — resolveWing validates it against their allowed set and persists the switch.
      const resolved = resolveWing(req, req.query.wing);
      if (resolved.error) {
        req.flash('error', resolved.error);
        return res.redirect('/supervision');
      }
      myOwnWing = resolved.wing;
      // Incharge sees EVERY teaching staff member (not just their own wing) so they can tick/untick
      // who's under their supervision — see the checkbox column in the view.
    } else {
      canAssignWing = true;
      wingFilter = req.query.wing && WINGS[req.query.wing] ? req.query.wing : null; // null = all staff
    }

    let staffQuery = "SELECT * FROM staff WHERE staff_type='Teaching' AND is_active=1";
    const params = [];
    if (wingFilter) { staffQuery += ' AND wing=?'; params.push(wingFilter); }
    staffQuery += ' ORDER BY first_name';
    const [staffList] = await db.query(staffQuery, params);

    const [existingRows] = await db.query('SELECT * FROM staff_weekly_attendance WHERE week_start_date=?', [mondayStr]);
    const existingByStaff = {};
    existingRows.forEach(r => { existingByStaff[r.staff_id] = r; });
    staffList.forEach(s => { s.existing = existingByStaff[s.id] || {}; });

    res.render('supervision/attendance', {
      title: 'Weekly Staff Attendance', activePage: 'supervision',
      staffList, weekStart: mondayStr, prevWeek: addDays(mondayStr, -7), nextWeek: addDays(mondayStr, 7),
      WINGS, wingFilter, canAssignWing, role, myOwnWing,
    });
  } catch (err) {
    console.error(err);
    req.flash('error', 'Could not load weekly attendance');
    res.redirect('/supervision');
  }
});

router.post('/attendance', requireAdminOrIncharge, async (req, res) => {
  const monday = getWeekStart(req.body.week_start_date);
  const mondayStr = isoDate(monday);
  const role = req.session.user.role;
  const wingParam = req.body.wing && WINGS[req.body.wing] ? req.body.wing : '';
  try {
    let allowedIds = null; // which staff ids this submission is permitted to touch; null = no restriction (admin/principal)

    if (role === 'incharge') {
      const w = myWing(req);
      if (!w || !WINGS[w]) throw new Error('No wing assigned to your login');
      // Checkbox list ("tick who's under my supervision") replaces the whole wing roster for me:
      // checked ids get assigned to my wing, previously-mine ids that are now unchecked get cleared.
      const checkedIds = new Set([].concat(req.body.include_staff || []).map(Number));
      const [currentlyMineRows] = await db.query("SELECT id FROM staff WHERE staff_type='Teaching' AND is_active=1 AND wing=?", [w]);
      const currentlyMineIds = new Set(currentlyMineRows.map(r => r.id));
      for (const id of checkedIds) {
        if (!currentlyMineIds.has(id)) await db.query('UPDATE staff SET wing=? WHERE id=?', [w, id]);
      }
      for (const id of currentlyMineIds) {
        if (!checkedIds.has(id)) await db.query('UPDATE staff SET wing=NULL WHERE id=?', [id]);
      }
      allowedIds = checkedIds;
    }

    const [staffList] = await db.query("SELECT id FROM staff WHERE staff_type='Teaching' AND is_active=1");
    for (const s of staffList) {
      if (allowedIds && !allowedIds.has(s.id)) continue; // incharge can never write outside who they just ticked as theirs

      if ((role === 'admin' || role === 'principal') && req.body.staff_wing && req.body.staff_wing['s' + s.id] !== undefined) {
        const newWing = req.body.staff_wing['s' + s.id];
        if (newWing === '' || WINGS[newWing]) {
          await db.query('UPDATE staff SET wing=? WHERE id=?', [newWing || null, s.id]);
        }
      }

      const wd = req.body.working_days && req.body.working_days['s' + s.id];
      const lt = req.body.leaves_taken && req.body.leaves_taken['s' + s.id];
      const la = req.body.late_arrivals && req.body.late_arrivals['s' + s.id];
      const lc = req.body.leaves_clubbed && req.body.leaves_clubbed['s' + s.id];
      const pr = req.body.punctuality_rating && req.body.punctuality_rating['s' + s.id];
      const dr = req.body.dress_code_rating && req.body.dress_code_rating['s' + s.id];
      const cr = req.body.overall_conduct_rating && req.body.overall_conduct_rating['s' + s.id];
      const lr = req.body.lesson_prep_rating && req.body.lesson_prep_rating['s' + s.id];
      const di = req.body.discipline_issues && req.body.discipline_issues['s' + s.id];
      const hasAny = (wd !== undefined && wd !== '') || (lt !== undefined && lt !== '') || (la !== undefined && la !== '')
        || (lc !== undefined && lc !== '') || (pr !== undefined && pr !== '') || (dr !== undefined && dr !== '')
        || (cr !== undefined && cr !== '') || (lr !== undefined && lr !== '') || (di !== undefined && di !== '');
      if (!hasAny) continue;

      await db.query(
        `INSERT INTO staff_weekly_attendance
          (staff_id, week_start_date, working_days, leaves_taken, late_arrivals, discipline_issues, leaves_clubbed_with_holiday,
           punctuality_rating, dress_code_rating, overall_conduct_rating, lesson_prep_rating, entered_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE working_days=VALUES(working_days), leaves_taken=VALUES(leaves_taken),
           late_arrivals=VALUES(late_arrivals), discipline_issues=VALUES(discipline_issues),
           leaves_clubbed_with_holiday=VALUES(leaves_clubbed_with_holiday),
           punctuality_rating=VALUES(punctuality_rating), dress_code_rating=VALUES(dress_code_rating),
           overall_conduct_rating=VALUES(overall_conduct_rating), lesson_prep_rating=VALUES(lesson_prep_rating),
           entered_by=VALUES(entered_by)`,
        [s.id, mondayStr, wd !== '' && wd !== undefined ? wd : null, lt || 0, la || 0, di || 0, lc || 0,
         pr || null, dr || null, cr || null, lr || null, req.session.user.id]
      );
      // Keep this month's stored review row in step with the sheet (a week counts toward the
      // month of its Saturday — see WEEK_MONTH_SQL in utils/performanceCalc.js).
      await syncMonthlyFromWeekly(db, s.id, addDays(mondayStr, 5).slice(0, 7) + '-01');
    }
    req.flash('success', "This week's staff attendance saved");
  } catch (err) {
    console.error(err);
    req.flash('error', 'Failed to save attendance: ' + err.message);
  }
  const wingSuffix = wingParam ? `&wing=${wingParam}` : '';
  res.redirect(`/supervision/attendance?week=${mondayStr}${wingSuffix}`);
});

// Lightweight "add a new staff member" for admin + Principal, scoped to just this screen — NOT
// the full Staff/HR module (/teachers, still admin-only: salary, personal docs, etc. stay out of
// Principal's reach). Just enough to get someone into the roster so they can be assigned a wing.
router.post('/staff/quick-add', async (req, res) => {
  const week = req.body.week || '';
  if (!['admin', 'principal'].includes(req.session.user.role)) {
    req.flash('error', 'Only admin or Principal can add staff here');
    return res.redirect(`/supervision/attendance${week ? '?week=' + week : ''}`);
  }
  try {
    const { first_name, last_name, staff_type, wing } = req.body;
    if (!first_name || !first_name.trim()) throw new Error('Name is required');
    await db.query(
      'INSERT INTO staff (first_name, last_name, staff_type, wing, is_active) VALUES (?,?,?,?,1)',
      [first_name.trim(), (last_name || '').trim(), staff_type === 'Non-Teaching' ? 'Non-Teaching' : 'Teaching', wing && WINGS[wing] ? wing : null]
    );
    req.flash('success', `${first_name} added to staff`);
  } catch (err) {
    console.error(err);
    req.flash('error', 'Failed to add staff: ' + err.message);
  }
  res.redirect(`/supervision/attendance${week ? '?week=' + week : ''}`);
});

// === Teacher Overview (admin) ===
// One combined row per teacher: average Class Observation score (across ALL 10 points, ALL
// raters combined — unlike the blind per-rater Performance module, admin sees the real combined
// picture here) for the selected month AND academic-year-to-date side by side, plus that same
// month's weekly-attendance rollup (working days, leaves, late comings, clubbed leaves,
// attendance %). Built 2026-09-11 per admin's request to see this "in one go" rather than piecing
// it together from the Observations list and the Attendance screen separately.
async function computeObservationScoreSummary(staffId, monthStr, ayStartDateStr) {
  // Only count ratings that are actually the current 1-5 numeric scale — old test/legacy data
  // (this app briefly used A-D letter grades before 2026-09-10) would otherwise poison the
  // average with NaN if it ever shows up mixed in with real numeric ratings.
  const [monthRows] = await db.query(
    `SELECT p.rating, o.id AS observation_id
     FROM supervision_observations o
     JOIN supervision_observation_points p ON p.observation_id = o.id
     WHERE o.teacher_id = ? AND DATE_FORMAT(o.observation_date, '%Y-%m') = DATE_FORMAT(?, '%Y-%m')
       AND p.rating REGEXP '^[1-5]$'`,
    [staffId, monthStr]
  );
  const [ytdRows] = await db.query(
    `SELECT p.rating
     FROM supervision_observations o
     JOIN supervision_observation_points p ON p.observation_id = o.id
     WHERE o.teacher_id = ? AND o.observation_date >= ? AND p.rating REGEXP '^[1-5]$'`,
    [staffId, ayStartDateStr]
  );
  const avg = (rows) => (rows.length ? Math.round((rows.reduce((a, r) => a + Number(r.rating), 0) / rows.length) * 10) / 10 : null);
  return {
    monthAvg: avg(monthRows),
    ytdAvg: avg(ytdRows),
    monthObservationCount: new Set(monthRows.map((r) => r.observation_id)).size,
  };
}

router.get('/teacher-overview', requireAdmin, async (req, res) => {
  try {
    const [[ay]] = await db.query('SELECT * FROM academic_years WHERE id=?', [ACADEMIC_YEAR_ID]);
    const monthStr = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month + '-01' : isoDate(new Date()).slice(0, 8) + '01';

    const [staffList] = await db.query("SELECT id, first_name, last_name, wing FROM staff WHERE staff_type='Teaching' AND is_active=1 ORDER BY first_name");
    for (const s of staffList) {
      const [obsSummary, attendance] = await Promise.all([
        computeObservationScoreSummary(s.id, monthStr, ay.start_date),
        computeAttendanceAuto(db, s.id, monthStr),
      ]);
      s.obs = obsSummary;
      s.attendance = attendance;
    }

    res.render('supervision/teacher-overview', {
      title: 'Teacher Overview', activePage: 'supervision',
      staffList, month: monthStr.slice(0, 7), WINGS,
    });
  } catch (err) {
    console.error(err);
    req.flash('error', 'Could not load Teacher Overview');
    res.redirect('/supervision');
  }
});

// === Manage In-charges (admin) ===
router.get('/incharges', requireAdmin, async (req, res) => {
  const [incharges] = await db.query("SELECT id, name, email, wing, is_active FROM users WHERE role='incharge' ORDER BY wing IS NULL, wing, name");
  const [extraWings] = await db.query('SELECT id, user_id, wing FROM user_wings ORDER BY id');
  const extraByUser = {};
  extraWings.forEach(r => { (extraByUser[r.user_id] = extraByUser[r.user_id] || []).push(r); });
  incharges.forEach(inc => { inc.extraWings = extraByUser[inc.id] || []; });
  res.render('supervision/incharges', { title: 'Manage In-charges', activePage: 'supervision', incharges, WINGS });
});

// One person covering more than one wing (e.g. Pre-Primary + Sr Secondary) — grants an ADDITIONAL
// wing on top of their primary `users.wing`. They see a wing switcher in the sidebar once they
// have more than one, and must log out/in for a newly-granted wing to appear (loaded at login).
router.post('/incharges/:id/extra-wing/add', requireAdmin, async (req, res) => {
  try {
    const { wing } = req.body;
    if (!WINGS[wing]) throw new Error('Please select a wing');
    const [[inc]] = await db.query("SELECT wing FROM users WHERE id=? AND role='incharge'", [req.params.id]);
    if (!inc) throw new Error('In-charge not found');
    if (inc.wing === wing) throw new Error('That is already their primary wing');
    await db.query(
      'INSERT INTO user_wings (user_id, wing, added_by) VALUES (?,?,?) ON DUPLICATE KEY UPDATE user_id=user_id',
      [req.params.id, wing, req.session.user.id]
    );
    req.flash('success', 'Additional wing added — they need to log out and back in for it to show up.');
  } catch (err) {
    console.error(err);
    req.flash('error', 'Failed to add: ' + err.message);
  }
  res.redirect('/supervision/incharges');
});

router.post('/incharges/extra-wing/:id/remove', requireAdmin, async (req, res) => {
  try {
    await db.query('DELETE FROM user_wings WHERE id=?', [req.params.id]);
    req.flash('success', 'Additional wing removed — takes effect next time they log in.');
  } catch (err) {
    console.error(err);
    req.flash('error', 'Failed to remove: ' + err.message);
  }
  res.redirect('/supervision/incharges');
});

router.get('/incharges/add', requireAdmin, (req, res) => {
  res.render('supervision/incharges-add', { title: 'Add In-charge Login', activePage: 'supervision', WINGS });
});

router.post('/incharges/add', requireAdmin, async (req, res) => {
  try {
    const { name, email, password, wing } = req.body;
    if (!WINGS[wing]) throw new Error('Please select a wing');
    const hash = await bcrypt.hash(password, 10);
    await db.query("INSERT INTO users (name, email, password, role, wing) VALUES (?,?,?,'incharge',?)", [name, email, hash, wing]);
    req.flash('success', `${name} added as ${wingLabel(wing)} In-charge`);
    res.redirect('/supervision/incharges');
  } catch (err) {
    console.error(err);
    req.flash('error', 'Failed to add in-charge login: ' + err.message);
    res.redirect('/supervision/incharges/add');
  }
});

router.post('/incharges/:id/wing', requireAdmin, async (req, res) => {
  try {
    const { wing } = req.body;
    if (!WINGS[wing]) throw new Error('Please select a wing');
    await db.query("UPDATE users SET wing=? WHERE id=? AND role='incharge'", [wing, req.params.id]);
    req.flash('success', 'Wing assignment updated');
  } catch (err) {
    console.error(err);
    req.flash('error', 'Failed to update: ' + err.message);
  }
  res.redirect('/supervision/incharges');
});

// === Cross-wing teachers (admin/principal) ===
// Most teachers belong to exactly one wing (staff.wing, the "primary" assignment managed via the
// Attendance screen). Some subject specialists also teach a handful of periods into a second wing
// (e.g. a Sr Secondary class-teacher who also takes a few Science periods in Middle & Secondary)
// — this screen adds/removes those ADDITIONAL memberships (staff_wings) so the second wing's
// Incharge can see/observe/score them too, without touching their primary wing assignment.
const requireAdminOrPrincipalHere = (req, res, next) => {
  if (['admin', 'principal'].includes(req.session.user.role)) return next();
  req.flash('error', 'Only admin or Principal can manage cross-wing teachers');
  res.redirect('/supervision');
};

router.get('/cross-wing', requireAdminOrPrincipalHere, async (req, res) => {
  try {
    const [staffList] = await db.query(
      "SELECT id, first_name, last_name, wing FROM staff WHERE staff_type='Teaching' AND is_active=1 ORDER BY first_name"
    );
    const [memberships] = await db.query(
      `SELECT sw.id, sw.staff_id, sw.wing, s.first_name, s.last_name
       FROM staff_wings sw JOIN staff s ON s.id = sw.staff_id
       ORDER BY s.first_name`
    );
    res.render('supervision/cross-wing', {
      title: 'Cross-Wing Teachers', activePage: 'supervision', staffList, memberships, WINGS,
    });
  } catch (err) {
    console.error(err);
    req.flash('error', 'Could not load cross-wing teachers');
    res.redirect('/supervision');
  }
});

router.post('/cross-wing/add', requireAdminOrPrincipalHere, async (req, res) => {
  try {
    const { staff_id, wing } = req.body;
    if (!WINGS[wing]) throw new Error('Please select a wing');
    const [[staff]] = await db.query('SELECT wing FROM staff WHERE id=?', [staff_id]);
    if (!staff) throw new Error('Teacher not found');
    if (staff.wing === wing) throw new Error('That is already their primary wing');
    await db.query(
      'INSERT INTO staff_wings (staff_id, wing, added_by) VALUES (?,?,?) ON DUPLICATE KEY UPDATE staff_id=staff_id',
      [staff_id, wing, req.session.user.id]
    );
    req.flash('success', 'Cross-wing membership added');
  } catch (err) {
    console.error(err);
    req.flash('error', 'Failed to add: ' + err.message);
  }
  res.redirect('/supervision/cross-wing');
});

router.post('/cross-wing/:id/remove', requireAdminOrPrincipalHere, async (req, res) => {
  try {
    await db.query('DELETE FROM staff_wings WHERE id=?', [req.params.id]);
    req.flash('success', 'Cross-wing membership removed');
  } catch (err) {
    console.error(err);
    req.flash('error', 'Failed to remove: ' + err.message);
  }
  res.redirect('/supervision/cross-wing');
});

// === Class-Teacher Reassignment (admin/principal) ===
// The only place this used to happen was the Excel bulk-upload — routine reassignment (a section
// changing hands mid-session, a new teacher joining) had no interactive screen, so it was done by
// hand in the database. This gives admin/principal a normal screen for it: pick/replace the class
// teacher for any section, which also keeps that teacher's primary wing in sync automatically
// (same pairing done manually while setting up the real roster).
function classWingFor(className) {
  for (const [w, cfg] of Object.entries(WINGS)) {
    if (cfg.classes.includes(className)) return w;
  }
  return null;
}

router.get('/class-teachers', requireAdminOrPrincipalHere, async (req, res) => {
  try {
    const [classesRaw] = await db.query(
      `SELECT c.*, CONCAT(s.first_name,' ',COALESCE(s.last_name,'')) AS teacher_name, s.wing AS teacher_wing
       FROM classes c LEFT JOIN staff s ON s.id = c.class_teacher_id
       WHERE c.academic_year_id=?`, [ACADEMIC_YEAR_ID]
    );
    const order = WING_KEYS.flatMap(w => WINGS[w].classes);
    classesRaw.forEach(c => { c.wing = classWingFor(c.class_name); });
    classesRaw.sort((a, b) => order.indexOf(a.class_name) - order.indexOf(b.class_name) || String(a.section).localeCompare(String(b.section)));

    const [teachers] = await db.query(
      "SELECT id, first_name, last_name, wing FROM staff WHERE staff_type='Teaching' AND is_active=1 ORDER BY first_name"
    );

    res.render('supervision/class-teachers', {
      title: 'Class-Teacher Assignment', activePage: 'supervision', classes: classesRaw, teachers, WINGS,
    });
  } catch (err) {
    console.error(err);
    req.flash('error', 'Could not load class-teacher assignments');
    res.redirect('/supervision');
  }
});

router.post('/class-teachers/:classId/assign', requireAdminOrPrincipalHere, async (req, res) => {
  try {
    const { staff_id } = req.body;
    const [[cls]] = await db.query('SELECT class_name FROM classes WHERE id=?', [req.params.classId]);
    if (!cls) throw new Error('Class not found');
    const wing = classWingFor(cls.class_name);
    await db.query('UPDATE classes SET class_teacher_id=? WHERE id=?', [staff_id || null, req.params.classId]);
    if (staff_id && wing) {
      await db.query('UPDATE staff SET wing=? WHERE id=?', [wing, staff_id]);
    }
    req.flash('success', 'Class teacher updated');
  } catch (err) {
    console.error(err);
    req.flash('error', 'Failed to update: ' + err.message);
  }
  res.redirect('/supervision/class-teachers');
});

router.post('/class-teachers/:classId/remove', requireAdminOrPrincipalHere, async (req, res) => {
  try {
    await db.query('UPDATE classes SET class_teacher_id=NULL WHERE id=?', [req.params.classId]);
    req.flash('success', 'Class teacher removed (their wing assignment was left as-is)');
  } catch (err) {
    console.error(err);
    req.flash('error', 'Failed to remove: ' + err.message);
  }
  res.redirect('/supervision/class-teachers');
});

router.WINGS = WINGS;
router.SECTION_ROTATION_WINGS = SECTION_ROTATION_WINGS;
router.TEACHER_ROTATION_WINGS = TEACHER_ROTATION_WINGS;
router.ALL_ROTATION_WINGS = ALL_ROTATION_WINGS;
router.wingMembershipClause = wingMembershipClause;
module.exports = router;

// Teacher Performance Evaluation — scoring logic ported from JBM_Monthly_Teacher_Assessment_System.xlsx
// Scores are always computed live from current weights (never persisted), so changing a weight
// in Settings retroactively re-shapes every displayed past score — matching the spreadsheet's
// own live-recalculation behaviour.

// Month Score Composition weights, rebalanced 2026-09-15 to make room for the 4 new weekly-form
// checklist items (punctuality/dress code/conduct/lesson prep) — the original 11 fields' relative
// proportions are preserved, just scaled down by 0.8 so the group still sums to 1.0 with the 4
// new fields added at 0.05 each. Admin can rebalance further in Settings any time.
const WEIGHT_DEFAULTS = {
  perf_w_performance_annual: 0.5,
  perf_w_loyalty: 0.2,
  perf_w_role_resp: 0.2,
  perf_w_behaviour_annual: 0.1,
  perf_w_attendance: 0.08,
  perf_w_syllabus: 0.08,
  perf_w_classroom: 0.08,
  perf_w_homework: 0.04,
  perf_w_outcomes: 0.12,
  perf_w_parentcomm: 0.08,
  perf_w_admincompliance: 0.08,
  perf_w_cocurricular: 0.04,
  perf_w_profdev: 0.08,
  perf_w_behaviour_month: 0.08,
  perf_w_holistic: 0.04,
  perf_w_punctuality: 0.05,
  perf_w_dresscode: 0.05,
  perf_w_conduct: 0.05,
  perf_w_lessonprep: 0.05,
  perf_budget_total: 0,
  perf_threshold_top: 8,
  perf_threshold_avg: 6,
};

const MONTH_WEIGHT_TOTAL_KEYS = [
  'perf_w_attendance', 'perf_w_syllabus', 'perf_w_classroom', 'perf_w_homework', 'perf_w_outcomes',
  'perf_w_parentcomm', 'perf_w_admincompliance', 'perf_w_cocurricular', 'perf_w_profdev',
  'perf_w_behaviour_month', 'perf_w_holistic',
  'perf_w_punctuality', 'perf_w_dresscode', 'perf_w_conduct', 'perf_w_lessonprep',
];

const ANNUAL_WEIGHT_TOTAL_KEYS = [
  'perf_w_performance_annual', 'perf_w_loyalty', 'perf_w_role_resp', 'perf_w_behaviour_annual',
];

async function getWeights(db) {
  const [rows] = await db.query("SELECT key_name, value FROM configuration WHERE key_name LIKE 'perf_%'");
  const cfg = {};
  rows.forEach(r => { cfg[r.key_name] = r.value; });
  const w = {};
  for (const k of Object.keys(WEIGHT_DEFAULTS)) {
    w[k] = cfg[k] !== undefined && cfg[k] !== null && cfg[k] !== '' ? parseFloat(cfg[k]) : WEIGHT_DEFAULTS[k];
  }
  return w;
}

function n(v) { return v === null || v === undefined || v === '' ? 0 : Number(v); }

function effectiveOutcomes(row) {
  if (row.student_outcomes_override !== null && row.student_outcomes_override !== undefined && row.student_outcomes_override !== '') {
    return Number(row.student_outcomes_override);
  }
  if (row.student_outcomes_auto !== null && row.student_outcomes_auto !== undefined) {
    return Number(row.student_outcomes_auto);
  }
  return null;
}

// One rater's Month Score for one staff/month row. Returns null if nothing was scored yet
// (matches the spreadsheet's IF(COUNT(...)=0,"",...) blank guard).
function monthScore(row, weights) {
  const outcomes = effectiveOutcomes(row);
  const scoredFields = [
    row.syllabus_pace, row.classroom_mgmt, row.homework_correction, outcomes,
    row.parent_comm, row.admin_compliance, row.cocurricular, row.professional_dev,
    row.behaviour_teamwork, row.overall_holistic,
    row.punctuality_rating, row.dress_code_rating, row.overall_conduct_rating, row.lesson_prep_rating,
  ];
  const anyScored = (row.attendance_pct !== null && row.attendance_pct !== undefined && row.attendance_pct !== '')
    || scoredFields.some(f => f !== null && f !== undefined && f !== '');
  if (!anyScored) return null;

  let score =
      (n(row.attendance_pct) / 10) * weights.perf_w_attendance
    + n(row.syllabus_pace) * weights.perf_w_syllabus
    + n(row.classroom_mgmt) * weights.perf_w_classroom
    + n(row.homework_correction) * weights.perf_w_homework
    + n(outcomes) * weights.perf_w_outcomes
    + n(row.parent_comm) * weights.perf_w_parentcomm
    + n(row.admin_compliance) * weights.perf_w_admincompliance
    + n(row.cocurricular) * weights.perf_w_cocurricular
    + n(row.professional_dev) * weights.perf_w_profdev
    + n(row.behaviour_teamwork) * weights.perf_w_behaviour_month
    + n(row.overall_holistic) * weights.perf_w_holistic
    + n(row.punctuality_rating) * weights.perf_w_punctuality
    + n(row.dress_code_rating) * weights.perf_w_dresscode
    + n(row.overall_conduct_rating) * weights.perf_w_conduct
    + n(row.lesson_prep_rating) * weights.perf_w_lessonprep;

  const penalty = Math.min(2, n(row.late_arrivals) * 0.3 + n(row.parent_complaints) * 0.5 + n(row.discipline_issues) * 0.5);
  score -= penalty;
  return Math.max(0, Math.min(10, Math.round(score * 10) / 10));
}

// Auto-computes a Student Outcomes (0-10) figure from real marks data for a teacher's classes,
// as of the most recent completed exam term on/before monthDate. Carries forward until a newer
// term completes; returns null before the first term of the year completes (same blank-guard
// philosophy as the spreadsheet).
async function computeStudentOutcomesAuto(db, staffId, monthDateStr) {
  try {
    const [[term]] = await db.query(
      `SELECT * FROM exam_terms WHERE term_type='term' AND end_date IS NOT NULL AND end_date <= ?
       ORDER BY end_date DESC LIMIT 1`,
      [monthDateStr]
    );
    if (!term) return null;
    const [rows] = await db.query(
      `SELECT sm.marks_obtained, sm.max_marks, sm.performance_vs_previous
       FROM teacher_subjects ts
       JOIN student_marks sm ON sm.subject_id = ts.subject_id AND sm.class_id = ts.class_id AND sm.exam_term_id = ?
       WHERE ts.staff_id = ? AND sm.marks_obtained IS NOT NULL`,
      [term.id, staffId]
    );
    if (!rows.length) return null;
    let pctSum = 0, pctCount = 0, improved = 0, declined = 0;
    for (const r of rows) {
      const max = Number(r.max_marks) || 100;
      pctSum += (Number(r.marks_obtained) / max) * 100;
      pctCount++;
      if (r.performance_vs_previous === 'Improved') improved++;
      if (r.performance_vs_previous === 'Declined') declined++;
    }
    let score = (pctSum / pctCount) / 10;
    if (improved > declined) score += 0.5;
    else if (declined > improved) score -= 0.5;
    return Math.max(0, Math.min(10, Math.round(score * 10) / 10));
  } catch (e) {
    return null;
  }
}

// Auto-suggests Attendance % from the weekly staff-attendance summaries entered in Academic
// Monitoring (routes/supervision.js, staff_weekly_attendance — a manual weekly total, not a daily
// attendance system: working days, leaves taken, leaves clubbed with a holiday, all typed in by
// admin/wing-incharge once a week). Unlike computeObservationAutoScores, this is NOT scoped to one
// rater — attendance is a fact, not an opinion, so every rater (Principal/VP/Incharge) reviewing
// the same teacher/month sees the same auto-filled number. A week is attributed to the month
// containing its Monday (week_start_date), matching how the weekly screens already group weeks.
async function computeAttendanceAuto(db, staffId, monthDateStr) {
  try {
    const [rows] = await db.query(
      `SELECT working_days, leaves_taken, late_arrivals, leaves_clubbed_with_holiday
       FROM staff_weekly_attendance
       WHERE staff_id = ? AND DATE_FORMAT(week_start_date, '%Y-%m') = DATE_FORMAT(?, '%Y-%m')`,
      [staffId, monthDateStr]
    );
    if (!rows.length) return null;
    let totalWorking = 0, totalLeaves = 0, totalLate = 0, totalClubbed = 0, anyWorkingDays = false;
    for (const r of rows) {
      if (r.working_days !== null) { totalWorking += Number(r.working_days); anyWorkingDays = true; }
      totalLeaves += Number(r.leaves_taken) || 0;
      totalLate += Number(r.late_arrivals) || 0;
      totalClubbed += Number(r.leaves_clubbed_with_holiday) || 0;
    }
    const attendancePct = anyWorkingDays && totalWorking > 0
      ? Math.max(0, Math.min(100, Math.round(((totalWorking - totalLeaves) / totalWorking) * 1000) / 10))
      : null;
    return { attendancePct, totalWorking, totalLeaves, totalLate, totalClubbed, weeksLogged: rows.length };
  } catch (e) {
    return null;
  }
}

// Auto-suggests 4 monthly-review fields from that SAME rater's own Academic Monitoring class
// observations of this teacher this month (routes/supervision.js). Scoped to observed_by so each
// rater's blind row only ever reflects their own observations, never another rater's.
// Point labels updated 2026-09-15 for the rebuilt 8-point in-class checklist (see
// OBSERVATION_POINTS in routes/supervision.js) — mapping onto 4 of the review fields (1-5 scale ->
// 0-10 scale, so x2):
//   Syllabus Pace                                           -> syllabus_pace
//   Classroom Control & Discipline                          -> classroom_mgmt
//   avg(Notebook Checking, Homework / Assignment given)     -> homework_correction
//   avg(Teaching Pedagogy, Student Engagement, Student
//       Response, English Communication)                    -> overall_holistic
// Returns null if that rater logged no observations of this teacher this month.
async function computeObservationAutoScores(db, staffId, monthDateStr, observerId) {
  try {
    if (!observerId) return null;
    const [rows] = await db.query(
      `SELECT o.id AS observation_id, p.point_label, p.rating
       FROM supervision_observations o
       JOIN supervision_observation_points p ON p.observation_id = o.id
       WHERE o.teacher_id = ? AND o.observed_by = ?
         AND DATE_FORMAT(o.observation_date, '%Y-%m') = DATE_FORMAT(?, '%Y-%m')
         AND p.rating IS NOT NULL`,
      [staffId, observerId, monthDateStr]
    );
    if (!rows.length) return null;

    const byLabel = {};
    const observationIds = new Set();
    for (const r of rows) {
      observationIds.add(r.observation_id);
      (byLabel[r.point_label] = byLabel[r.point_label] || []).push(Number(r.rating));
    }
    const avg = (arr) => (arr && arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
    const toTen = (v) => (v === null ? null : Math.round(v * 2 * 10) / 10);

    const prep = avg(byLabel['Syllabus Pace']);
    const classroom = avg(byLabel['Classroom Control & Discipline']);
    const followupParts = [avg(byLabel['Notebook Checking']), avg(byLabel['Homework / Assignment given'])].filter((v) => v !== null);
    const followup = followupParts.length ? followupParts.reduce((a, b) => a + b, 0) / followupParts.length : null;
    const holisticParts = [
      avg(byLabel['Teaching Pedagogy']),
      avg(byLabel['Student Engagement']),
      avg(byLabel['Student Response']),
      avg(byLabel['English Communication']),
    ].filter((v) => v !== null);
    const holistic = holisticParts.length ? holisticParts.reduce((a, b) => a + b, 0) / holisticParts.length : null;

    return {
      syllabus_pace: toTen(prep),
      classroom_mgmt: toTen(classroom),
      homework_correction: toTen(followup),
      overall_holistic: toTen(holistic),
      observationCount: observationIds.size,
    };
  } catch (e) {
    return null;
  }
}

// Auto-suggests the 4 weekly-form checklist fields (Punctuality, Dress Code, Overall Conduct,
// Lesson Preparation) by averaging that month's weekly entries from staff_weekly_attendance.
// NOT rater-scoped — like attendance, these are entered once a week (not per-rater), so every
// rater/reviewer sees the same auto-filled numbers. 1-5 scale -> 0-10, same x2 convention as the
// in-class observation auto-fill.
async function computeWeeklyChecklistAuto(db, staffId, monthDateStr) {
  try {
    const [rows] = await db.query(
      `SELECT punctuality_rating, dress_code_rating, overall_conduct_rating, lesson_prep_rating
       FROM staff_weekly_attendance
       WHERE staff_id = ? AND DATE_FORMAT(week_start_date, '%Y-%m') = DATE_FORMAT(?, '%Y-%m')`,
      [staffId, monthDateStr]
    );
    if (!rows.length) return null;
    const avg = (key) => {
      const vals = rows.map(r => r[key]).filter(v => v !== null && v !== undefined).map(Number);
      return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    };
    const toTen = (v) => (v === null ? null : Math.round(v * 2 * 10) / 10);
    return {
      punctuality_rating: toTen(avg('punctuality_rating')),
      dress_code_rating: toTen(avg('dress_code_rating')),
      overall_conduct_rating: toTen(avg('overall_conduct_rating')),
      lesson_prep_rating: toTen(avg('lesson_prep_rating')),
    };
  } catch (e) {
    return null;
  }
}

// One row per staff/month now (Incharge enters, Principal/Admin may edit — no more blind
// multi-rater averaging), so a month's score is just monthScore() of that single row.
async function computeAnnualSummary(db, staff, academicYearId, weights) {
  const [reviewRows] = await db.query(
    'SELECT * FROM performance_monthly_reviews WHERE staff_id=? AND academic_year_id=? ORDER BY month_date',
    [staff.id, academicYearId]
  );

  const monthCombined = [];
  for (const row of reviewRows) {
    const combined = monthScore(row, weights);
    if (combined !== null) {
      monthCombined.push({ month_date: row.month_date, combined, enteredBy: row.entered_by });
    }
  }

  const monthsLogged = monthCombined.length;
  const annualPerf = monthsLogged
    ? Math.round((monthCombined.reduce((a, b) => a + b.combined, 0) / monthsLogged) * 10) / 10
    : null;

  let years = null;
  if (staff.years_of_service_override !== null && staff.years_of_service_override !== undefined) {
    years = Number(staff.years_of_service_override);
  } else if (staff.joining_date) {
    const end = staff.date_of_leaving ? new Date(staff.date_of_leaving) : new Date();
    const start = new Date(staff.joining_date);
    years = (end - start) / (365.25 * 24 * 3600 * 1000);
  }
  const loyalty = years !== null ? Math.min(10, Math.round(years * 0.7 * 10) / 10) : null;

  const behVals = reviewRows.map(r => r.behaviour_teamwork).filter(v => v !== null && v !== undefined).map(Number);
  const behaviour = behVals.length ? Math.round((behVals.reduce((a, b) => a + b, 0) / behVals.length) * 10) / 10 : null;

  const [[override]] = await db.query(
    'SELECT role_responsibility_score FROM performance_annual_overrides WHERE staff_id=? AND academic_year_id=?',
    [staff.id, academicYearId]
  );
  const roleResp = override && override.role_responsibility_score !== null ? Number(override.role_responsibility_score) : null;

  let weighted = null;
  if (annualPerf !== null && roleResp !== null) {
    weighted = annualPerf * weights.perf_w_performance_annual
      + (loyalty || 0) * weights.perf_w_loyalty
      + roleResp * weights.perf_w_role_resp
      + (behaviour || 0) * weights.perf_w_behaviour_annual;
    weighted = Math.round(weighted * 10) / 10;
  }

  let band = null;
  if (weighted !== null) {
    if (weighted >= weights.perf_threshold_top) band = 'Top Performer';
    else if (weighted >= weights.perf_threshold_avg) band = 'Average / Consider';
    else band = 'Below Expectations';
  }

  return { staff, monthsLogged, monthCombined, annualPerf, years, loyalty, behaviour, roleResp, weighted, band };
}

function proposedIncrement(summary, allSummaries, budget) {
  if (summary.band !== 'Top Performer' || !budget) return 0;
  const topSum = allSummaries.filter(s => s.band === 'Top Performer').reduce((a, b) => a + (b.weighted || 0), 0);
  if (!topSum) return 0;
  return Math.round((budget * summary.weighted) / topSum);
}

function recommendedAction(summary) {
  if (summary.band === null) return '';
  if (summary.staff.date_of_leaving) return 'Left mid-cycle — review pro-rated increment separately';
  if (summary.band === 'Top Performer') return 'Priority for increment from available pool';
  if (summary.band === 'Average / Consider') return 'Eligible only if pool allows after top performers';
  return 'No increment this year; revisit next cycle';
}

module.exports = {
  WEIGHT_DEFAULTS,
  MONTH_WEIGHT_TOTAL_KEYS,
  ANNUAL_WEIGHT_TOTAL_KEYS,
  getWeights,
  monthScore,
  computeStudentOutcomesAuto,
  computeObservationAutoScores,
  computeAttendanceAuto,
  computeWeeklyChecklistAuto,
  computeAnnualSummary,
  proposedIncrement,
  recommendedAction,
};

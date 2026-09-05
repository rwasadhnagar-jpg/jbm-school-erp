// Teacher Performance Evaluation — scoring logic ported from JBM_Monthly_Teacher_Assessment_System.xlsx
// Scores are always computed live from current weights (never persisted), so changing a weight
// in Settings retroactively re-shapes every displayed past score — matching the spreadsheet's
// own live-recalculation behaviour.

const RATERS = ['Principal', 'Vice Principal', 'Incharge'];

const WEIGHT_DEFAULTS = {
  perf_w_performance_annual: 0.5,
  perf_w_loyalty: 0.2,
  perf_w_role_resp: 0.2,
  perf_w_behaviour_annual: 0.1,
  perf_w_attendance: 0.1,
  perf_w_syllabus: 0.1,
  perf_w_classroom: 0.1,
  perf_w_homework: 0.05,
  perf_w_outcomes: 0.15,
  perf_w_parentcomm: 0.1,
  perf_w_admincompliance: 0.1,
  perf_w_cocurricular: 0.05,
  perf_w_profdev: 0.1,
  perf_w_behaviour_month: 0.1,
  perf_w_holistic: 0.05,
  perf_budget_total: 0,
  perf_threshold_top: 8,
  perf_threshold_avg: 6,
};

const MONTH_WEIGHT_TOTAL_KEYS = [
  'perf_w_attendance', 'perf_w_syllabus', 'perf_w_classroom', 'perf_w_homework', 'perf_w_outcomes',
  'perf_w_parentcomm', 'perf_w_admincompliance', 'perf_w_cocurricular', 'perf_w_profdev',
  'perf_w_behaviour_month', 'perf_w_holistic',
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
    + n(row.overall_holistic) * weights.perf_w_holistic;

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

// Combined Month Score for one staff/month = average of whichever raters scored that month.
// Replaces the spreadsheet's "only Principal counts" rule, since there's no single official
// rater any more in the blind multi-rater model.
function combineMonthScores(raterRows, weights) {
  const scores = raterRows.map(r => monthScore(r, weights)).filter(s => s !== null);
  if (!scores.length) return null;
  return Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10;
}

async function computeAnnualSummary(db, staff, academicYearId, weights) {
  const [reviewRows] = await db.query(
    'SELECT * FROM performance_monthly_reviews WHERE staff_id=? AND academic_year_id=?',
    [staff.id, academicYearId]
  );
  const byMonth = {};
  for (const r of reviewRows) {
    if (!byMonth[r.month_date]) byMonth[r.month_date] = [];
    byMonth[r.month_date].push(r);
  }

  const monthCombined = [];
  for (const [month, raterRows] of Object.entries(byMonth)) {
    const combined = combineMonthScores(raterRows, weights);
    if (combined !== null) {
      monthCombined.push({
        month_date: month,
        combined,
        raterScores: raterRows.map(r => ({ rater: r.rater, score: monthScore(r, weights) })),
      });
    }
  }
  monthCombined.sort((a, b) => a.month_date.localeCompare(b.month_date));

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

  let behSum = 0, behCount = 0;
  for (const raterRows of Object.values(byMonth)) {
    const vals = raterRows.map(r => r.behaviour_teamwork).filter(v => v !== null && v !== undefined).map(Number);
    if (vals.length) { behSum += vals.reduce((a, b) => a + b, 0) / vals.length; behCount++; }
  }
  const behaviour = behCount ? Math.round((behSum / behCount) * 10) / 10 : null;

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
  RATERS,
  WEIGHT_DEFAULTS,
  MONTH_WEIGHT_TOTAL_KEYS,
  ANNUAL_WEIGHT_TOTAL_KEYS,
  getWeights,
  monthScore,
  combineMonthScores,
  computeStudentOutcomesAuto,
  computeAnnualSummary,
  proposedIncrement,
  recommendedAction,
};

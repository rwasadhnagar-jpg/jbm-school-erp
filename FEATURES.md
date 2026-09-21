# JBM School ERP — Feature Record

Maintained record of every module, feature, and its deployment status. Update this file whenever a
feature is added, redesigned, or deployed — don't let it drift from `git log` / `git status`.

- **Local dev:** http://localhost:5052 (connects directly to production DB — not a sandbox)
- **Local test sandbox:** http://localhost:5053 (isolated `jbm_test` DB, portable MariaDB — safe to break)
- **Live production:** https://erp.jbmpschool.in
- **Repo:** https://github.com/rwasadhnagar-jpg/jbm-school-erp (public, `master` branch)
- **Stack:** Node.js + Express + EJS + MySQL2, bcryptjs/express-session/connect-flash, multer, node-cron, xlsx/exceljs, pdfkit, Razorpay, web-push

Last reviewed: 2026-09-18.

---

## 1. Status snapshot

| Area | State |
|---|---|
| Core ERP (auth, students, fees, staff, attendance, library, transport, hostel, salary, notices, certificates, SMS, remarks, parent/student portal) | **Live in production** |
| Teacher Self-Service Expansion (Excel onboarding, Unit Tests, templated remarks, push notifications) | **Live in production** (since 2026-09-01) |
| Teacher Performance Evaluation — **old** blind 3-rater model | Committed (`dc18e52`) but **superseded**, not live |
| Teacher Performance Evaluation — **current** single-entry model + Teacher Pulse dashboard + weekly rotation engine | **Built & verified locally only** (`jbm_test`), fully uncommitted |
| Academic Monitoring / Supervision module | **Built & verified locally only**, fully uncommitted |
| Auto-start stack on machine boot | Set up 2026-09-18 via Startup-folder shortcut |

Uncommitted files as of last check (`git status`):
```
M  public/css/style.css, public/js/main.js, routes/{auth,dashboard,performance,staff}.js,
   server.js, utils/performanceCalc.js, views/partials/header.ejs,
   views/performance/{monthly-entry,monthly-list,raters-add,raters,settings}.ejs
?? routes/supervision.js, views/supervision/, views/performance/{monthly-entry-single,pulse}.ejs,
   scripts/, start-erp-stack.ps1, test-stack-logs/, .claude/
```

---

## 2. Route map (current `server.js` mounts)

| Mount | Roles | Module |
|---|---|---|
| `/` | public | Auth (login/logout) |
| `/portal` | public | Parent + Student portal |
| `/dashboard` | any logged-in | Stats dashboard |
| `/studentadministration` | admin | Student records |
| `/feemanagement` | admin, accountant | Fees |
| `/teachers` | admin | Staff/HR |
| `/attday` | admin, teacher | Attendance |
| `/registration` | admin | Admissions |
| `/lms` | admin, librarian | Library |
| `/transport` | admin, transport | Transport |
| `/hostel` | admin | Hostel |
| `/sal` | admin, accountant | Salary/Payroll (PBR-absorbed) |
| `/notices` | admin | Notices |
| `/remarks` | admin, teacher | Progress/Remarks |
| `/weekly` | admin, teacher | Weekly updates |
| `/performance` | admin, teacher, principal, vice_principal, incharge | Teacher Performance + **Teacher Pulse** |
| `/supervision` | admin, principal, vice_principal, incharge | Academic Monitoring |
| `/configuration` | admin | Settings/backup |
| `/certificates` | admin | Certificates |
| `/sms` | admin | SMS |
| `/notifications` | any logged-in | Push subscribe endpoint |

---

## 3. Feature history (chronological)

### Foundation
- **Initial commit** (`25083ec`): core ERP with backup system, school branding.
- **Student Portal** (`9d31281`, `53f9f28`): admission_no + DOB login, fee history, receipt printing. URL moved `/student` → `/portal` to avoid a route conflict.
- **GitHub Actions auto-deploy** (`d2060d2` → `ecf3c12`, several fix commits): deploy pipeline iterated through FTP → SFTP → rsync+sshpass → SSH+git-pull before landing on the current process (see §5). Also fixed DOB format to DD/MM/YYYY on the student portal.
- **Fee payment**: online UPI QR payments, class-wise fee structure, online-payments admin view, "Reset Demo Data" utility (`a1eefdf`).
- **PBR Salary module absorbed** into ERP at `/sal` (`e021ccb`, `5956379`) — 7th CPC pay scales, loans, TDS, LWP-linked, payslip PDF. PBR app itself retired; salary logic now lives here.

### Phase 1 — Auth + RBAC (done 2026-06-13)
- `requireRole(...)` middleware on every route mount.
- Users table enum expanded to parent/student roles; parent login via admission_no + mobile, finds all children.
- 3-tab login screen (Staff / Parent Portal / Student Portal).
- Role-based sidebar (admin sees all, teacher sees academic, accountant sees financial, etc.).
- Parent portal dashboard listing all enrolled children + notices.

### Student Progress / Remarks module (added 2026-08-31, ahead of the original phase plan)
- Subject teachers enter marks + structured remarks per student/subject/term; class teachers add one overall remark per student/term; parents/students view combined progress via the portal.
- New tables: `subjects`, `exam_terms`, `teacher_subjects`, `student_marks`, `student_overall_remarks`.
- Found and fixed the **qs bracket-key bug**: Express+`qs` silently scrambles bulk-form array data when a field name uses a raw numeric DB id (under 100) as a bracket key — e.g. `rows[7]`. Fix: always prefix keys (`rows[s7]`). Also hit and fixed in `routes/attendance.js` (was silently marking every student "Absent" for ids < 100). Convention now enforced for any new bulk-entry form.

### Teacher Self-Service Expansion (added 2026-08-31, **live** 2026-09-01)
- **Excel teacher onboarding** (`/teachers/bulk-upload`): upload Teacher Name + Class + Section, auto-creates staff + login + class-teacher assignment + all-subject assignment for that class.
- **Unit Tests**: 4 new marks-only exam terms alongside Half Yearly/Annual.
- **Templated remarks**: auto-picked from 5 performance bands (marks% + attendance%), editable before save.
- **Attendance modes**: day/week/month grid entry; fixed an IST timezone bug in date formatting.
- **Teacher panel restricted** to Dashboard + Attendance + Progress/Remarks; incidentally fixed librarian/transport roles never seeing their own sidebar links.
- **Push notifications**: web-push + VAPID, service worker, "Enable Notifications" button, hooked into notice creation + two daily cron reminders (10am unmarked attendance, 9am pending marks).

### Teacher Performance Evaluation — v1, blind 3-rater (built 2026-09-05, committed `dc18e52`, **superseded, not live**)
- Ported the admin's `JBM_Monthly_Teacher_Assessment_System.xlsx` into the ERP.
- 3 independent rater roles (principal/vice_principal/incharge) scored every teacher monthly, blind to each other; admin saw everything including Band/Proposed Increment.
- Verified working locally, never deployed. **Entirely replaced by the redesign below** after the admin reviewed the working module and asked for a different model.

### Academic Monitoring / Supervision module (built 2026-09-06, **not deployed**)
- `routes/supervision.js`, mounted `/supervision`. Built from two source docs (duty-sheet + management-system Word docs).
- Weekly Scrutiny Report, Class Observation Form (originally 10-point, later folded into the 12-point redesign), Principal/VP weekly minutes, manual weekly staff attendance summary.
- Wing-scoped: an incharge login is locked to their own wing everywhere, confirmed unbypassable via URL/param tampering.
- Auto-feeds 4 fields into the Performance module's monthly review from that rater's own observation data that month.
- Fixed a pre-existing, app-wide mobile nav bug (sidebar unreachable on phones) — added hamburger + slide-in drawer.

### Teacher Performance Evaluation — v2 redesign + Teacher Pulse (2026-09-15, **built & verified locally only, still not deployed**)
Full architecture change requested by the admin after reviewing v1 live:
- **Roles**: Vice Principal removed as a Performance scorer (keeps Academic Monitoring access). Incharge is now sole monthly data-enterer for their own wing; Principal/Admin review/edit but don't hold separate scored rows.
- **Wings redefined globally**: Pre-Primary (Nursery, Prep) / Primary (I–V) / Middle & Secondary (VI–X, merged) / Sr Secondary (XI–XII) — 4 incharges total. New `staff_wings` table lets a teacher belong to a second wing (subject specialists teaching across wings).
- **Scoring model**: `performance_monthly_reviews` restructured to one row per staff/month (was one row per rater). Incharge's save stamps `entered_by`/`submitted_at`; Principal/Admin's save stamps `reviewed_by`/`reviewed_at` — deliberately hidden from the incharge (quiet quality-check mechanism).
- **12-point checklist**, split in two: a 4-item **weekly form** (Punctuality, Dress Code, Overall Conduct, Lesson Prep) on the Weekly Attendance screen, and an 8-item **in-class form** (English Communication, Teaching Pedagogy, Student Engagement, Classroom Control, Student Response, Syllabus Pace, Notebook Checking, Homework/Assignment) filled during the actual visit.
- **Weekly rotation engine** (`supervision_weekly_assignments`, `/supervision/rotation`): automatic weekly generation, capped 4/day, no repeats within a week (DB-enforced), overdue flagging with 3-day grace, Skip button, Admin/Principal spot-check reassignment. Two modes: section-rotation for Pre-Primary/Primary (mother-teacher model), teacher-rotation for Middle & Secondary/Sr Secondary (subject specialists).
- **Teacher Pulse dashboard** (`GET /performance/pulse`, admin-only, `views/performance/pulse.ejs`): Today / This Week / This Month / This Year views. Today+Week use a 1–5 rating scale (Excellent/Good/Watch/Critical bands); Month+Year use the weighted Performance score (Top Performer/Average/Below Expectations bands) — deliberately kept as two distinct scales rather than forced onto one. Shows classes/wings observed, avg rating, flagged-for-revisit count, wing ranking with drill-down to individual teachers, a teacher search/lookup box, weekly report submission tracking, attendance %, memo counts, and trend sparklines/heatmaps throughout.
- **New admin screens**: `/supervision/cross-wing` (manage a teacher's second wing), `/supervision/class-teachers` (assign/replace any section's class teacher, syncs primary wing).
- **Deactivation cascade**: setting a teacher's `date_of_leaving` now clears their `wing`, `staff_wings`, and any `class_teacher_id`/`teacher_subjects` pointers, without touching historical performance/observation/memo records (previously nothing cascaded).
- **One Saturday entry (2026-09-21)**: the school runs Mon–Sat and the Saturday Staff Attendance sheet (`/supervision/attendance`) is now the single place for working days (default 6), leaves, clubbed-with-holiday, late comings, **discipline issues** (new `staff_weekly_attendance.discipline_issues`), and the four ratings. On the monthly review those seven fields are read-only and calculated live — nothing is retyped and nothing goes stale: `syncMonthlyFromWeekly()` (`utils/performanceCalc.js`) refreshes the stored row whenever a Saturday sheet is saved or a Discipline/Punctuality memo is issued; monthly discipline/late = Saturday totals + that month's memos. A week counts toward the month of its **Saturday** (previously its Monday). Monthly form now only takes parent complaints, parent communication, admin compliance, co-curricular, professional development, behaviour/teamwork, and the observation-derived academic scores. The monthly-review reminder now fires on the **last working day of the month** (last non-Sunday) instead of the 3rd of the next month.
- Real data loaded into `jbm_test`: all 44 sections' class teachers populated from the admin's WhatsApp roster; 3 new staff records created (Neha Pandey, Nancy Kaushik, Permila Rani). Two stale duplicate `classes` rows (Nursery-Indus, XI/XII "SCI A") identified but deliberately left alone pending a cleanup decision.

---

## 4. Known issues / flagged, not yet fixed

- `schema.sql` in the repo root is **stale** vs. live production (e.g. missing `fee_heads.fee_type`, `fee_heads.apply_late_fee`) — don't use it to rebuild a DB from scratch; dump structure fresh from production instead.
- Two duplicate `classes` rows in `jbm_test` (Nursery-Indus, XI/XII "SCI A") — confirmed by the admin as not real, left alone pending an actual deletion decision (dependent enrollment/subject data exists).
- Push notification delivery to a real subscribed device has not been end-to-end verified post-deploy — confirm this next time it comes up.
- FTP credentials on file are stale/unverified (`530 Login incorrect` as of 2026-09-01) — don't trust without re-checking.
- Salary/Payroll (`/sal`) has not been audited against the full original spec (7th CPC table, loan/EMI tracking, per-staff TDS) — assume "largely built," not "feature-complete," until checked.

## 5. Deployment architecture — read before touching deploy

- Live app runs from `~/domains/erp.jbmpschool.in/nodejs/` on Hostinger, **not** the parent domain folder — a separate copy with its own `node_modules`/`.env`/logs.
- `npm` is not reachable via SSH at all. The only way to install/update dependencies is Hostinger's hPanel zip-upload **Deployments** build system.
- Deploy process: build a zip with `package.json` at the zip root (not nested), include a production `.env`, exclude `node_modules`/`.git`/logs/`public/uploads`, upload via hPanel → Website → Deployments.
- hPanel's "Redeploy" button rebuilds from the last uploaded zip, not current state — avoid clicking casually. Its "Running ▾" restart control has been unreliable; a fresh successful build is what actually restarts the app.
- `.github/workflows/deploy.yml` (the old auto-deploy-on-push pipeline) was **deleted 2026-09-01** — it was fundamentally broken and gave false confidence. `.github/workflows/check.yml` remains as a manual SSH diagnostic.
- Hostinger PORT: 8080 | Local dev PORT: 5052 (talks directly to production MySQL) | Local test sandbox PORT: 5053 (`jbm_test`, isolated).

## 6. Unified System Plan (original 9-phase roadmap, approved 2026-06-13)

| Phase | Module | Status |
|---|---|---|
| 1 | Auth + RBAC | Done |
| 2 | Leave Management (CL/EL/ML/LWP, balances, approval, carry-forward, encashment) | Not started |
| 3 | Salary/Payroll Rework | Largely built, not fully audited |
| 4 | Fee Enhancements (auto late-fee, sibling discount, defaulter reports) | Not started |
| 5 | Exam & Report Cards (CBSE CCE, bulk entry, PDF report cards) | Not started |
| 6 | Parent Portal (attendance, marks, notices, Razorpay fees) | Partially built (fee payment live; attendance/marks/notices via portal not confirmed complete) |
| 7 | WhatsApp/SMS Auto-Alerts | Not started |
| 8 | Certificate Templates | Route exists (`/certificates`), scope vs. plan not verified |
| 9 | PWA + Production Polish | Push notifications live; full PWA/session-store polish not confirmed |

Note: Student Progress/Remarks, Teacher Self-Service, Teacher Performance, and Academic Monitoring were all built **outside** this original phase order, at the admin's request, and are ahead of where the phase table implies.

const express = require('express');
const router = express.Router();
const db = require('../db');

// Ensure sms_log has student_id + template columns
db.query(`ALTER TABLE sms_log ADD COLUMN IF NOT EXISTS student_id INT DEFAULT NULL`).catch(() => {});
db.query(`ALTER TABLE sms_log ADD COLUMN IF NOT EXISTS class_id INT DEFAULT NULL`).catch(() => {});
db.query(`ALTER TABLE sms_log ADD COLUMN IF NOT EXISTS template_name VARCHAR(100) DEFAULT NULL`).catch(() => {});
db.query(`ALTER TABLE sms_log ADD COLUMN IF NOT EXISTS sent_by INT DEFAULT NULL`).catch(() => {});

const TEMPLATES = [
  { name: 'fee_reminder', label: 'Fee Reminder', message: 'Dear Parent, this is a reminder that the school fee for {student_name} (Class {class}) is due. Please pay at the earliest to avoid late fees. — JBM Public School' },
  { name: 'holiday_notice', label: 'Holiday Notice', message: 'Dear Parent, school will remain closed on {date} due to {reason}. Classes will resume on the next working day. — JBM Public School' },
  { name: 'event_alert', label: 'Event Alert', message: 'Dear Parent, {event_name} is scheduled on {date}. Your ward {student_name} is requested to attend. — JBM Public School' },
  { name: 'attendance_alert', label: 'Attendance Alert', message: 'Dear Parent, {student_name} was marked ABSENT on {date}. Please ensure regular attendance. — JBM Public School' },
  { name: 'result_notice', label: 'Result Notice', message: 'Dear Parent, the result of {exam_name} for {student_name} (Class {class}) has been declared. Please collect the report card from school. — JBM Public School' },
  { name: 'meeting_notice', label: 'Parent Meeting', message: 'Dear Parent, a Parent-Teacher Meeting is scheduled on {date} at {time}. Your presence is earnestly requested. — JBM Public School' },
];

// INDEX
router.get('/', async (req, res) => {
  try {
    const [logs] = await db.query(
      `SELECT sl.*, s.first_name, s.last_name, s.admission_no, c.class_name, c.section, u.name as sent_by_name
       FROM sms_log sl
       LEFT JOIN students s ON sl.student_id = s.id
       LEFT JOIN classes c ON sl.class_id = c.id
       LEFT JOIN users u ON sl.sent_by = u.id
       ORDER BY sl.sent_at DESC LIMIT 100`
    );
    const [[{ total }]] = await db.query('SELECT COUNT(*) as total FROM sms_log');
    const [[{ today }]] = await db.query("SELECT COUNT(*) as today FROM sms_log WHERE DATE(sent_at)=CURDATE()");
    res.render('sms/index', { title: 'SMS & Communication', activePage: 'sms', logs, total, today, templates: TEMPLATES });
  } catch(err) {
    console.error(err);
    res.render('sms/index', { title: 'SMS & Communication', activePage: 'sms', logs: [], total: 0, today: 0, templates: TEMPLATES });
  }
});

// COMPOSE PAGE
router.get('/compose', async (req, res) => {
  try {
    const [students] = await db.query("SELECT s.*, c.class_name, c.section FROM students s LEFT JOIN classes c ON s.class_id=c.id LEFT JOIN parents p ON p.student_id=s.id AND p.type='father' WHERE s.status='active' ORDER BY c.class_name, s.first_name");
    const [classes] = await db.query('SELECT * FROM classes WHERE academic_year_id=1 ORDER BY class_name, section');
    const { template } = req.query;
    const selectedTemplate = TEMPLATES.find(t => t.name === template) || null;
    res.render('sms/compose', { title: 'Compose Message', activePage: 'sms', students, classes, templates: TEMPLATES, selectedTemplate });
  } catch(err) {
    console.error(err);
    res.redirect('/sms');
  }
});

// SEND / LOG MESSAGE
router.post('/send', async (req, res) => {
  try {
    const b = req.body;
    const message = b.message;
    let recipients = [];

    if (b.target === 'individual' && b.student_id) {
      const [[st]] = await db.query(
        "SELECT s.*, p.mobile FROM students s LEFT JOIN parents p ON p.student_id=s.id AND p.type='father' WHERE s.id=?", [b.student_id]
      );
      if (st) recipients.push({ student_id: st.id, class_id: st.class_id, mobile: st.mobile || b.custom_mobile || '', name: st.first_name + ' ' + st.last_name });
    } else if (b.target === 'class' && b.class_id) {
      const [rows] = await db.query(
        "SELECT s.id, s.class_id, s.first_name, s.last_name, p.mobile FROM students s LEFT JOIN parents p ON p.student_id=s.id AND p.type='father' WHERE s.status='active' AND s.class_id=?", [b.class_id]
      );
      recipients = rows.map(r => ({ student_id: r.id, class_id: r.class_id, mobile: r.mobile || '', name: r.first_name + ' ' + r.last_name }));
    } else if (b.target === 'all') {
      const [rows] = await db.query(
        "SELECT s.id, s.class_id, s.first_name, s.last_name, p.mobile FROM students s LEFT JOIN parents p ON p.student_id=s.id AND p.type='father' WHERE s.status='active'"
      );
      recipients = rows.map(r => ({ student_id: r.id, class_id: r.class_id, mobile: r.mobile || '', name: r.first_name + ' ' + r.last_name }));
    } else if (b.target === 'custom') {
      recipients = [{ student_id: null, class_id: null, mobile: b.custom_mobile || '', name: 'Custom' }];
    }

    if (!recipients.length) { req.flash('error', 'No recipients found'); return res.redirect('/sms/compose'); }

    for (const r of recipients) {
      const mobile = r.mobile || '0000000000';
      await db.query(
        'INSERT INTO sms_log (to_number, message, type, status, student_id, class_id, template_name, sent_by) VALUES (?,?,?,?,?,?,?,?)',
        [mobile, message, b.type || 'WhatsApp', 'Sent', r.student_id, r.class_id, b.template_name || null, req.session.user.id]
      );
    }

    req.flash('success', `Message logged for ${recipients.length} recipient(s). Use WhatsApp links below to send.`);
    res.redirect('/sms?sent=1');
  } catch(err) {
    console.error(err);
    req.flash('error', 'Failed to log message: ' + err.message);
    res.redirect('/sms/compose');
  }
});

// WHATSAPP SENDER PAGE (for a class)
router.get('/whatsapp/:class_id', async (req, res) => {
  try {
    const [[cls]] = await db.query('SELECT * FROM classes WHERE id=?', [req.params.class_id]);
    const [students] = await db.query(
      "SELECT s.*, p.mobile, p.first_name as father_name FROM students s LEFT JOIN parents p ON p.student_id=s.id AND p.type='father' WHERE s.status='active' AND s.class_id=? ORDER BY s.first_name", [req.params.class_id]
    );
    const { msg } = req.query;
    res.render('sms/whatsapp', { title: 'WhatsApp Sender', activePage: 'sms', cls, students, msg: msg || '' });
  } catch(err) {
    console.error(err);
    res.redirect('/sms');
  }
});

// DELETE log entry
router.post('/delete/:id', async (req, res) => {
  await db.query('DELETE FROM sms_log WHERE id=?', [req.params.id]);
  res.redirect('/sms');
});

module.exports = router;

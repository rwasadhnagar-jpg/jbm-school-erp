const express = require('express');
const router = express.Router();
const db = require('../db');
const crypto = require('crypto');
const Razorpay = require('razorpay');

let razorpay;
try {
  razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID || 'rzp_test_placeholder',
    key_secret: process.env.RAZORPAY_KEY_SECRET || 'rzp_secret_placeholder'
  });
} catch(e) { console.error('Razorpay init error:', e.message); }

// === DB INIT ===
db.query(`CREATE TABLE IF NOT EXISTS fee_structure (
  id INT AUTO_INCREMENT PRIMARY KEY,
  class_id INT NOT NULL,
  fee_head_id INT NOT NULL,
  academic_year_id INT DEFAULT 1,
  amount DECIMAL(10,2) DEFAULT 0,
  UNIQUE KEY uq_class_head (class_id, fee_head_id, academic_year_id)
)`).catch(e => console.error('fee_structure table:', e.message));

db.query(`CREATE TABLE IF NOT EXISTS online_payments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  student_id INT NOT NULL,
  receipt_no VARCHAR(60) UNIQUE,
  fee_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
  late_fee DECIMAL(10,2) DEFAULT 0,
  total_amount DECIMAL(10,2) NOT NULL,
  fee_details TEXT,
  utr_no VARCHAR(120),
  payment_date DATE,
  status ENUM('Pending','Verified','Rejected') DEFAULT 'Pending',
  verified_by INT DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`).catch(e => console.error('online_payments table:', e.message));

// Add columns to fee_heads (fail silently if already exist)
db.query("ALTER TABLE fee_heads ADD COLUMN fee_type ENUM('Monthly','Annual') DEFAULT 'Monthly'").catch(()=>{});
db.query("ALTER TABLE fee_heads ADD COLUMN apply_late_fee TINYINT(1) DEFAULT 0").catch(()=>{});

// Seed default fee head types
db.query("UPDATE fee_heads SET fee_type='Monthly', apply_late_fee=1 WHERE name='Tuition Fee'").catch(()=>{});
db.query("UPDATE fee_heads SET fee_type='Annual', apply_late_fee=0 WHERE name='Annual Charges'").catch(()=>{});

// Seed payment config keys
db.query(`INSERT IGNORE INTO configuration (key_name, value, description) VALUES
  ('upi_id','jbmpschool@sbi','School UPI ID'),
  ('upi_name','JBM Public School','UPI Payee Name'),
  ('bank_name','State Bank of India','Bank Name'),
  ('account_holder','JBM Public School','Account Holder Name'),
  ('account_no','','Bank Account Number'),
  ('ifsc_code','','IFSC Code'),
  ('branch_name','','Branch Name'),
  ('payment_note','Please pay fees by 10th of each month to avoid late charges.','Payment Instruction Note')
`).catch(()=>{});

const requirePortalUser = (req, res, next) => {
  if (req.session.student) return next();
  if (req.session.user && req.session.user.role === 'parent') return next();
  return res.redirect('/portal/login');
};
const requireStudent = requirePortalUser;

// LOGIN PAGE — student self-login is disabled for now (parent-only access)
router.get('/login', (req, res) => {
  req.flash('error', 'Student login is not available yet. Please use the Parent Portal.');
  res.redirect('/parent-login');
});

// LOGIN POST — disabled for now (parent-only access)
router.post('/login', (req, res) => {
  req.flash('error', 'Student login is not available yet. Please use the Parent Portal.');
  res.redirect('/parent-login');
});

// LOGOUT
router.get('/logout', (req, res) => {
  req.session.student = null;
  req.flash('success', 'Logged out successfully');
  res.redirect('/portal/login');
});

// DASHBOARD
router.get('/dashboard', requirePortalUser, async (req, res) => {
  // Parent dashboard — show all children
  if (req.session.user && req.session.user.role === 'parent') {
    try {
      const children = req.session.user.children || [];
      const childData = [];
      for (const child of children) {
        const [[student]] = await db.query(
          `SELECT s.*, c.class_name, c.section FROM students s LEFT JOIN classes c ON s.class_id=c.id WHERE s.id=?`, [child.id]
        );
        const [officePay] = await db.query(
          `SELECT COALESCE(SUM(amount_paid),0) as total FROM fee_payments WHERE student_id=?`, [child.id]
        );
        const [onlinePay] = await db.query(
          `SELECT COALESCE(SUM(total_amount),0) as total FROM online_payments WHERE student_id=? AND status!='Rejected'`, [child.id]
        );
        childData.push({
          student,
          totalPaid: parseFloat(officePay[0].total) + parseFloat(onlinePay[0].total)
        });
      }
      const [recentNotices] = await db.query('SELECT * FROM notices ORDER BY created_at DESC LIMIT 5');
      return res.render('student/parent-dashboard', {
        title: 'Parent Portal — JBM School',
        parentName: req.session.user.name,
        childData, recentNotices,
        error: req.flash('error'), success: req.flash('success')
      });
    } catch(err) {
      console.error(err);
      return res.redirect('/parent-login');
    }
  }

  try {
    const studentId = req.session.student.id;
    const [[student]] = await db.query(
      `SELECT s.*, c.class_name, c.section FROM students s LEFT JOIN classes c ON s.class_id=c.id WHERE s.id=?`, [studentId]
    );
    const [parents] = await db.query('SELECT * FROM parents WHERE student_id=?', [studentId]);
    const father = parents.find(p => p.type === 'father');
    const mother = parents.find(p => p.type === 'mother');

    // Office payments (collected by admin)
    const [officePay] = await db.query(
      `SELECT fp.*, u.name as collected_by_name FROM fee_payments fp
       LEFT JOIN users u ON fp.collected_by = u.id
       WHERE fp.student_id = ? ORDER BY fp.payment_date DESC`, [studentId]
    );
    // Online payments (from portal)
    const [onlinePay] = await db.query(
      `SELECT * FROM online_payments WHERE student_id=? ORDER BY created_at DESC`, [studentId]
    );

    const totalOfficePaid = officePay.reduce((s, p) => s + parseFloat(p.amount_paid||0), 0);
    const totalOnlinePaid = onlinePay.filter(p=>p.status!=='Rejected').reduce((s,p)=>s+parseFloat(p.total_amount||0),0);
    const totalPaid = totalOfficePaid + totalOnlinePaid;

    const [certs] = await db.query(
      `SELECT id, type, serial_no, issue_date FROM certificates WHERE student_id=? ORDER BY issue_date DESC`, [studentId]
    );

    const [configRows] = await db.query('SELECT key_name, value FROM configuration');
    const config = {};
    configRows.forEach(r => config[r.key_name] = r.value);

    res.render('student/dashboard', {
      title: 'My Portal — JBM School',
      student, father, mother, officePay, onlinePay, totalPaid, certs, config,
      error: req.flash('error'), success: req.flash('success')
    });
  } catch (err) {
    console.error(err);
    res.redirect('/portal/login');
  }
});

// STUDENT PROGRESS (marks, remarks, attendance summary) — parent or self-login student
router.get('/progress/:studentId', requirePortalUser, async (req, res) => {
  try {
    const studentId = parseInt(req.params.studentId, 10);

    // Ownership check — a parent may only view their own children, a student only themself
    if (req.session.user && req.session.user.role === 'parent') {
      const owns = (req.session.user.children || []).some(c => c.id === studentId);
      if (!owns) {
        req.flash('error', 'You can only view progress for your own children');
        return res.redirect('/portal/dashboard');
      }
    } else if (req.session.student && req.session.student.id !== studentId) {
      req.flash('error', 'You can only view your own progress');
      return res.redirect('/portal/dashboard');
    }

    const [[student]] = await db.query(
      `SELECT s.*, c.class_name, c.section, c.id AS class_id
       FROM students s LEFT JOIN classes c ON s.class_id=c.id WHERE s.id=?`, [studentId]
    );
    if (!student) return res.redirect('/portal/dashboard');

    const [terms] = await db.query('SELECT * FROM exam_terms WHERE is_active=1 ORDER BY sort_order, start_date');
    let examTermId = req.query.exam_term_id ? parseInt(req.query.exam_term_id, 10) : null;
    if (!examTermId && terms.length) examTermId = terms[terms.length - 1].id;
    const term = terms.find(t => t.id === examTermId) || null;

    let subjectMarks = [];
    let overall = null;
    let attendance = { total: 0, present: 0, late: 0, percent: null };

    if (term) {
      [subjectMarks] = await db.query(
        `SELECT sm.*, sub.name AS subject_name
         FROM student_marks sm JOIN subjects sub ON sm.subject_id=sub.id
         WHERE sm.student_id=? AND sm.exam_term_id=? ORDER BY sub.name`,
        [studentId, examTermId]
      );
      const [[overallRow]] = await db.query(
        'SELECT * FROM student_overall_remarks WHERE student_id=? AND exam_term_id=?',
        [studentId, examTermId]
      );
      overall = overallRow || null;

      let startDate = term.start_date, endDate = term.end_date;
      if (!startDate || !endDate) {
        const [[ay]] = await db.query('SELECT * FROM academic_years WHERE id=?', [student.academic_year_id]);
        startDate = ay ? ay.start_date : null;
        endDate = ay ? ay.end_date : null;
      }
      if (startDate && endDate) {
        const [[att]] = await db.query(
          `SELECT COUNT(*) total, SUM(status='Present') present, SUM(status='Late') late
           FROM attendance_student WHERE student_id=? AND date BETWEEN ? AND ?`,
          [studentId, startDate, endDate]
        );
        const total = Number(att.total) || 0;
        const present = Number(att.present) || 0;
        const late = Number(att.late) || 0;
        attendance = {
          total, present, late,
          percent: total > 0 ? Math.round(((present + late) / total) * 1000) / 10 : null
        };
      }
    }

    res.render('student/progress', {
      title: 'Student Progress — JBM School',
      student, terms, term, subjectMarks, overall, attendance
    });
  } catch (err) {
    console.error(err);
    req.flash('error', 'Could not load progress page');
    res.redirect('/portal/dashboard');
  }
});

// PAY FEES PAGE
router.get('/pay', requireStudent, async (req, res) => {
  try {
    const studentId = req.session.student.id;
    const [[student]] = await db.query(
      `SELECT s.*, c.class_name, c.section, c.id as class_id
       FROM students s LEFT JOIN classes c ON s.class_id=c.id WHERE s.id=?`, [studentId]
    );

    // Get fee structure for this class
    const [feeStructure] = await db.query(
      `SELECT fs.*, fh.name as head_name, fh.fee_type, fh.apply_late_fee, fh.description
       FROM fee_structure fs
       LEFT JOIN fee_heads fh ON fs.fee_head_id = fh.id
       WHERE fs.class_id=? AND fs.academic_year_id=1 AND fh.is_active=1 AND fs.amount > 0
       ORDER BY fh.fee_type DESC, fh.name`, [student.class_id]
    );

    const [configRows] = await db.query('SELECT key_name, value FROM configuration');
    const config = {};
    configRows.forEach(r => config[r.key_name] = r.value);

    // Already paid months (from online_payments for this student)
    const [paidPayments] = await db.query(
      `SELECT * FROM online_payments WHERE student_id=? AND status!='Rejected' ORDER BY created_at DESC LIMIT 20`, [studentId]
    );

    res.render('student/fee-pay', {
      title: 'Pay Fees — JBM School',
      student, feeStructure, config, paidPayments,
      error: req.flash('error'), success: req.flash('success')
    });
  } catch (err) {
    console.error(err);
    req.flash('error', 'Could not load fee page');
    res.redirect('/portal/dashboard');
  }
});

// CREATE RAZORPAY ORDER
router.post('/pay/create-order', requireStudent, async (req, res) => {
  try {
    const { total_amount, fee_amount, late_fee, fee_details } = req.body;
    const amount = Math.round(parseFloat(total_amount) * 100); // paise
    if (!amount || amount <= 0) return res.json({ error: 'Invalid amount' });

    const order = await razorpay.orders.create({
      amount,
      currency: 'INR',
      receipt: 'RZP' + Date.now(),
      notes: {
        student_id: String(req.session.student.id),
        admission_no: req.session.student.admission_no,
        fee_amount, late_fee, fee_details
      }
    });

    res.json({
      order_id: order.id,
      amount: order.amount,
      currency: order.currency,
      key: process.env.RAZORPAY_KEY_ID
    });
  } catch (err) {
    console.error('Razorpay order error:', err);
    res.json({ error: err.message || 'Could not create payment order' });
  }
});

// RAZORPAY PAYMENT SUCCESS — verify signature + create receipt
router.post('/pay/razorpay-success', requireStudent, async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, fee_amount, late_fee, total_amount, fee_details } = req.body;

    // Verify HMAC signature
    const body = razorpay_order_id + '|' + razorpay_payment_id;
    const expected = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(body).digest('hex');
    if (expected !== razorpay_signature) {
      return res.json({ success: false, error: 'Payment verification failed. Please contact school office.' });
    }

    const studentId = req.session.student.id;
    const receiptNo = 'RZP' + Date.now();
    const today = new Date().toISOString().split('T')[0];

    // Insert into online_payments as Verified (no pending — auto verified)
    const [ins] = await db.query(
      `INSERT INTO online_payments (student_id, receipt_no, fee_amount, late_fee, total_amount, fee_details, utr_no, payment_date, status)
       VALUES (?,?,?,?,?,?,?,?,'Verified')`,
      [studentId, receiptNo,
       parseFloat(fee_amount || 0), parseFloat(late_fee || 0), parseFloat(total_amount),
       fee_details || '', razorpay_payment_id, today]
    );

    // Also create a fee_payment record immediately
    await db.query(
      `INSERT INTO fee_payments (student_id, receipt_no, amount_paid, payment_date, payment_mode, transaction_id, remarks, collected_by)
       VALUES (?,?,?,?,'UPI',?,?,1)`,
      [studentId, receiptNo, parseFloat(total_amount), today, razorpay_payment_id,
       `Razorpay UPI | Order: ${razorpay_order_id}`]
    );

    res.json({ success: true, receipt_id: ins.insertId });
  } catch (err) {
    console.error('Razorpay verify error:', err);
    res.json({ success: false, error: err.message });
  }
});

// SUBMIT ONLINE PAYMENT (kept as fallback — not shown in UI)
router.post('/pay/submit', requireStudent, async (req, res) => {
  try {
    const studentId = req.session.student.id;
    const { utr_no, fee_amount, late_fee, total_amount, fee_details } = req.body;

    if (!utr_no || !utr_no.trim()) {
      req.flash('error', 'Please enter the UTR / Transaction Reference Number');
      return res.redirect('/portal/pay');
    }
    if (!total_amount || parseFloat(total_amount) <= 0) {
      req.flash('error', 'Please select at least one fee to pay');
      return res.redirect('/portal/pay');
    }

    const receiptNo = 'ONL' + Date.now();
    const today = new Date().toISOString().split('T')[0];

    const [ins] = await db.query(
      `INSERT INTO online_payments (student_id, receipt_no, fee_amount, late_fee, total_amount, fee_details, utr_no, payment_date, status)
       VALUES (?,?,?,?,?,?,?,?,'Pending')`,
      [studentId, receiptNo,
       parseFloat(fee_amount||0), parseFloat(late_fee||0), parseFloat(total_amount),
       fee_details || '', utr_no.trim(), today]
    );

    res.redirect(`/portal/pay/receipt/${ins.insertId}`);
  } catch (err) {
    console.error(err);
    req.flash('error', 'Payment submission failed. Please try again.');
    res.redirect('/portal/pay');
  }
});

// ONLINE PAYMENT RECEIPT
router.get('/pay/receipt/:id', requireStudent, async (req, res) => {
  try {
    const [[payment]] = await db.query(
      `SELECT op.*, s.first_name, s.last_name, s.admission_no, s.roll_no,
              c.class_name, c.section, p.first_name as father_name, p.last_name as father_last
       FROM online_payments op
       LEFT JOIN students s ON op.student_id = s.id
       LEFT JOIN classes c ON s.class_id = c.id
       LEFT JOIN parents p ON p.student_id = s.id AND p.type='father'
       WHERE op.id=? AND op.student_id=?`,
      [req.params.id, req.session.student.id]
    );
    if (!payment) return res.redirect('/portal/dashboard');

    const [configRows] = await db.query('SELECT key_name, value FROM configuration');
    const config = {};
    configRows.forEach(r => config[r.key_name] = r.value);

    let feeDetails = [];
    try { feeDetails = JSON.parse(payment.fee_details || '[]'); } catch(e) {}

    res.render('student/payment-receipt', {
      title: 'Payment Receipt — JBM School',
      payment, config, feeDetails
    });
  } catch (err) {
    console.error(err);
    res.redirect('/portal/dashboard');
  }
});

// VIEW OFFICE RECEIPT (old route kept)
router.get('/receipt/:payment_id', requireStudent, async (req, res) => {
  try {
    const [[payment]] = await db.query(
      `SELECT fp.*, s.first_name, s.last_name, s.admission_no,
              c.class_name, c.section,
              p.first_name as father_name, u.name as collected_by_name
       FROM fee_payments fp
       LEFT JOIN students s ON fp.student_id = s.id
       LEFT JOIN classes c ON s.class_id = c.id
       LEFT JOIN parents p ON s.id = p.student_id AND p.type='father'
       LEFT JOIN users u ON fp.collected_by = u.id
       WHERE fp.id = ? AND fp.student_id = ?`,
      [req.params.payment_id, req.session.student.id]
    );
    if (!payment) return res.redirect('/portal/dashboard');
    res.render('fees/receipt', { payment });
  } catch (err) {
    res.redirect('/portal/dashboard');
  }
});

module.exports = router;

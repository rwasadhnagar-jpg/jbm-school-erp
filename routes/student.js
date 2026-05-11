const express = require('express');
const router = express.Router();
const db = require('../db');

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

const requireStudent = (req, res, next) => {
  if (!req.session.student) return res.redirect('/portal/login');
  next();
};

// LOGIN PAGE
router.get('/login', (req, res) => {
  if (req.session.student) return res.redirect('/portal/dashboard');
  res.render('student/login', { title: 'Student Portal — JBM School', error: req.flash('error'), success: req.flash('success') });
});

// LOGIN POST
router.post('/login', async (req, res) => {
  try {
    const { admission_no, dob } = req.body;
    if (!admission_no || !dob) {
      req.flash('error', 'Please enter Admission Number and Date of Birth');
      return res.redirect('/portal/login');
    }
    const [[student]] = await db.query(
      `SELECT s.*, c.class_name, c.section FROM students s
       LEFT JOIN classes c ON s.class_id = c.id
       WHERE s.admission_no = ? AND s.status = 'active'`,
      [admission_no.trim()]
    );
    if (!student) {
      req.flash('error', 'Admission number not found or student is inactive');
      return res.redirect('/portal/login');
    }
    const dbDob = student.dob ? new Date(student.dob).toISOString().split('T')[0] : null;
    const parts = dob.trim().split('/');
    const inputDob = parts.length === 3 ? `${parts[2]}-${parts[1].padStart(2,'0')}-${parts[0].padStart(2,'0')}` : null;
    if (!dbDob || !inputDob || dbDob !== inputDob) {
      req.flash('error', 'Date of Birth does not match our records');
      return res.redirect('/portal/login');
    }
    req.session.student = {
      id: student.id, admission_no: student.admission_no,
      name: `${student.first_name} ${student.last_name}`,
      class_name: student.class_name, section: student.section, dob: student.dob
    };
    res.redirect('/portal/dashboard');
  } catch (err) {
    console.error(err);
    req.flash('error', 'Login failed. Please try again.');
    res.redirect('/portal/login');
  }
});

// LOGOUT
router.get('/logout', (req, res) => {
  req.session.student = null;
  req.flash('success', 'Logged out successfully');
  res.redirect('/portal/login');
});

// DASHBOARD
router.get('/dashboard', requireStudent, async (req, res) => {
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

// SUBMIT ONLINE PAYMENT
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

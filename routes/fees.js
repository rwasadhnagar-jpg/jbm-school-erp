const express = require('express');
const router = express.Router();
const db = require('../db');

router.get('/', async (req, res) => {
  try {
    const [payments] = await db.query(
      `SELECT fp.*, s.first_name, s.last_name, s.admission_no, c.class_name, c.section
       FROM fee_payments fp
       LEFT JOIN students s ON fp.student_id = s.id
       LEFT JOIN classes c ON s.class_id = c.id
       ORDER BY fp.created_at DESC LIMIT 50`
    );
    const [[{ todayTotal }]] = await db.query(
      "SELECT COALESCE(SUM(amount_paid),0) as todayTotal FROM fee_payments WHERE payment_date = CURDATE()"
    );
    const [[{ monthTotal }]] = await db.query(
      "SELECT COALESCE(SUM(amount_paid),0) as monthTotal FROM fee_payments WHERE MONTH(payment_date)=MONTH(CURDATE()) AND YEAR(payment_date)=YEAR(CURDATE())"
    );
    const [feeHeads] = await db.query('SELECT * FROM fee_heads WHERE is_active=1');
    const [feeGroups] = await db.query('SELECT * FROM fee_groups WHERE is_active=1');
    res.render('fees/index', { title: 'Fee Management', activePage: 'fees', payments, todayTotal, monthTotal, feeHeads, feeGroups });
  } catch (err) {
    console.error(err);
    res.render('fees/index', { title: 'Fee Management', activePage: 'fees', payments: [], todayTotal: 0, monthTotal: 0, feeHeads: [], feeGroups: [] });
  }
});

router.get('/collect', async (req, res) => {
  try {
    const [students] = await db.query("SELECT s.*, c.class_name, c.section FROM students s LEFT JOIN classes c ON s.class_id=c.id WHERE s.status='active' ORDER BY s.first_name");
    const [feeHeads] = await db.query('SELECT * FROM fee_heads WHERE is_active=1');
    res.render('fees/collect', { title: 'Collect Fee', activePage: 'fees', students, feeHeads });
  } catch (err) {
    console.error(err);
    res.redirect('/feemanagement');
  }
});

router.post('/collect', async (req, res) => {
  try {
    const b = req.body;
    const receiptNo = 'RCP' + Date.now();
    await db.query(
      `INSERT INTO fee_payments (student_id, amount_paid, payment_date, payment_mode, receipt_no, transaction_id, remarks, collected_by)
       VALUES (?,?,?,?,?,?,?,?)`,
      [b.student_id, b.amount_paid, b.payment_date || new Date().toISOString().split('T')[0],
       b.payment_mode || 'Cash', receiptNo, b.transaction_id || null, b.remarks || null, req.session.user.id]
    );
    req.flash('success', `Fee collected! Receipt No: ${receiptNo}`);
    res.redirect('/feemanagement');
  } catch (err) {
    console.error(err);
    req.flash('error', 'Failed to collect fee: ' + err.message);
    res.redirect('/feemanagement/collect');
  }
});

// FEE RECEIPT
router.get('/receipt/:id', async (req, res) => {
  try {
    const [[payment]] = await db.query(
      `SELECT fp.*, s.first_name, s.last_name, s.admission_no, s.roll_no,
              c.class_name, c.section, u.name as collected_by_name,
              p.first_name as father_name, p.mobile as parent_mobile
       FROM fee_payments fp
       LEFT JOIN students s ON fp.student_id = s.id
       LEFT JOIN classes c ON s.class_id = c.id
       LEFT JOIN users u ON fp.collected_by = u.id
       LEFT JOIN parents p ON p.student_id = s.id AND p.type = 'father'
       WHERE fp.id = ?`, [req.params.id]
    );
    if (!payment) { req.flash('error', 'Receipt not found'); return res.redirect('/feemanagement'); }
    res.render('fees/receipt', { title: 'Fee Receipt', activePage: 'fees', payment });
  } catch (err) {
    console.error(err);
    req.flash('error', 'Could not load receipt');
    res.redirect('/feemanagement');
  }
});

// FEE COLLECTION REPORT
router.get('/reports/collection', async (req, res) => {
  try {
    const { from_date, to_date, class_id, payment_mode } = req.query;
    const from = from_date || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0];
    const to = to_date || new Date().toISOString().split('T')[0];
    let q = `SELECT fp.*, s.first_name, s.last_name, s.admission_no, c.class_name, c.section
             FROM fee_payments fp
             LEFT JOIN students s ON fp.student_id=s.id
             LEFT JOIN classes c ON s.class_id=c.id
             WHERE fp.payment_date BETWEEN ? AND ?`;
    const params = [from, to];
    if (class_id) { q += ' AND s.class_id=?'; params.push(class_id); }
    if (payment_mode) { q += ' AND fp.payment_mode=?'; params.push(payment_mode); }
    q += ' ORDER BY fp.payment_date DESC';
    const [payments] = await db.query(q, params);
    const [[{ total }]] = await db.query(`SELECT COALESCE(SUM(amount_paid),0) as total FROM fee_payments WHERE payment_date BETWEEN ? AND ?`, [from, to]);
    const [classes] = await db.query('SELECT * FROM classes WHERE academic_year_id=1 ORDER BY class_name,section');
    res.render('fees/report-collection', { title: 'Fee Collection Report', activePage: 'fees', payments, total, from_date: from, to_date: to, classes, class_id, payment_mode });
  } catch(err) {
    console.error(err);
    req.flash('error','Report failed');
    res.redirect('/feemanagement');
  }
});

// DEFAULTER LIST
router.get('/reports/defaulters', async (req, res) => {
  try {
    const { class_id } = req.query;
    let q = `SELECT s.*, c.class_name, c.section,
              COALESCE(SUM(fp.amount_paid),0) as total_paid,
              p.first_name as father_name, p.mobile as father_mobile
             FROM students s
             LEFT JOIN classes c ON s.class_id=c.id
             LEFT JOIN fee_payments fp ON fp.student_id=s.id
             LEFT JOIN parents p ON p.student_id=s.id AND p.type='father'
             WHERE s.status='active'`;
    const params = [];
    if (class_id) { q += ' AND s.class_id=?'; params.push(class_id); }
    q += ' GROUP BY s.id HAVING total_paid = 0 ORDER BY c.class_name, s.first_name';
    const [defaulters] = await db.query(q, params);
    const [classes] = await db.query('SELECT * FROM classes WHERE academic_year_id=1 ORDER BY class_name,section');
    res.render('fees/report-defaulters', { title: 'Fee Defaulter List', activePage: 'fees', defaulters, classes, class_id });
  } catch(err) {
    req.flash('error','Report failed');
    res.redirect('/feemanagement');
  }
});

// FEE HEADS MASTER
router.get('/masters/heads', async (req, res) => {
  const [heads] = await db.query('SELECT * FROM fee_heads ORDER BY id');
  res.render('fees/masters-heads', { title: 'Fee Heads', activePage: 'fees', heads });
});
router.post('/masters/heads/add', async (req, res) => {
  await db.query('INSERT INTO fee_heads (name,description) VALUES (?,?)', [req.body.name, req.body.description||null]);
  req.flash('success','Fee head added');
  res.redirect('/feemanagement/masters/heads');
});
router.post('/masters/heads/delete/:id', async (req, res) => {
  await db.query('UPDATE fee_heads SET is_active=0 WHERE id=?', [req.params.id]);
  req.flash('success','Fee head removed');
  res.redirect('/feemanagement/masters/heads');
});

// FEE GROUPS MASTER
router.get('/masters/groups', async (req, res) => {
  const [groups] = await db.query('SELECT fg.*, c.class_name, c.section FROM fee_groups fg LEFT JOIN classes c ON fg.class_id=c.id WHERE fg.is_active=1 ORDER BY fg.id');
  const [classes] = await db.query('SELECT * FROM classes WHERE academic_year_id=1 ORDER BY class_name,section');
  res.render('fees/masters-groups', { title: 'Fee Groups', activePage: 'fees', groups, classes });
});
router.post('/masters/groups/add', async (req, res) => {
  await db.query('INSERT INTO fee_groups (name,class_id,description) VALUES (?,?,?)', [req.body.name, req.body.class_id||null, req.body.description||null]);
  req.flash('success','Fee group added');
  res.redirect('/feemanagement/masters/groups');
});

// DOWNLOAD FEE REPORT CSV
router.get('/reports/download', async (req, res) => {
  const { from_date, to_date } = req.query;
  const from = from_date || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0];
  const to = to_date || new Date().toISOString().split('T')[0];
  const [rows] = await db.query(
    `SELECT fp.receipt_no, s.admission_no, s.first_name, s.last_name, c.class_name, c.section,
      fp.amount_paid, fp.payment_date, fp.payment_mode, fp.remarks
     FROM fee_payments fp
     LEFT JOIN students s ON fp.student_id=s.id
     LEFT JOIN classes c ON s.class_id=c.id
     WHERE fp.payment_date BETWEEN ? AND ? ORDER BY fp.payment_date DESC`, [from, to]
  );
  const headers = ['Receipt No','Adm No','Student Name','Class','Section','Amount','Date','Mode','Remarks'];
  const csv = [headers.join(','), ...rows.map(r => [r.receipt_no,r.admission_no,r.first_name+' '+r.last_name,r.class_name||'',r.section||'',r.amount_paid,r.payment_date?r.payment_date.toISOString().split('T')[0]:'',r.payment_mode,r.remarks||''].join(','))].join('\n');
  res.setHeader('Content-Type','text/csv');
  res.setHeader('Content-Disposition',`attachment; filename="fee_report_${from}_${to}.csv"`);
  res.send(csv);
});

module.exports = router;

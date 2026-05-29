const express = require('express');
const router = express.Router();
const db = require('../db');
const multer = require('multer');
const xlsxLib = require('xlsx');
const structureUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// ── FEE DASHBOARD ─────────────────────────────────────────────────────────────
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
    const [feeHeads] = await db.query('SELECT * FROM fee_heads WHERE is_active=1 ORDER BY name');
    const [feeGroups] = await db.query('SELECT * FROM fee_groups WHERE is_active=1');
    // Pending online payments count
    const [[{ pendingOnline }]] = await db.query(
      "SELECT COUNT(*) as pendingOnline FROM online_payments WHERE status='Pending'"
    ).catch(()=>[[{pendingOnline:0}]]);
    res.render('fees/index', { title: 'Fee Management', activePage: 'fees', payments, todayTotal, monthTotal, feeHeads, feeGroups, pendingOnline });
  } catch (err) {
    console.error(err);
    res.render('fees/index', { title: 'Fee Management', activePage: 'fees', payments: [], todayTotal: 0, monthTotal: 0, feeHeads: [], feeGroups: [], pendingOnline: 0 });
  }
});

// ── COLLECT FEE ───────────────────────────────────────────────────────────────
router.get('/collect', async (req, res) => {
  try {
    const [students] = await db.query("SELECT s.*, c.class_name, c.section FROM students s LEFT JOIN classes c ON s.class_id=c.id WHERE s.status='active' ORDER BY s.first_name");
    const [feeHeads] = await db.query('SELECT * FROM fee_heads WHERE is_active=1 ORDER BY name');
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
    req.flash('error', 'Failed to collect fee: ' + err.message);
    res.redirect('/feemanagement/collect');
  }
});

// ── FEE RECEIPT ───────────────────────────────────────────────────────────────
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
    req.flash('error', 'Could not load receipt');
    res.redirect('/feemanagement');
  }
});

// ── FEE STRUCTURE (Class-wise) ─────────────────────────────────────────────────
router.get('/structure', async (req, res) => {
  try {
    const [classes] = await db.query('SELECT * FROM classes WHERE academic_year_id=1 ORDER BY class_name, section');
    const [feeHeads] = await db.query('SELECT * FROM fee_heads WHERE is_active=1 ORDER BY fee_type DESC, name');
    const selectedClass = req.query.class_id ? parseInt(req.query.class_id) : null;
    let structure = [];
    let selectedClassName = '';
    if (selectedClass) {
      [structure] = await db.query(
        `SELECT fs.*, fh.name as head_name, fh.fee_type, fh.apply_late_fee
         FROM fee_heads fh
         LEFT JOIN fee_structure fs ON fs.fee_head_id=fh.id AND fs.class_id=? AND fs.academic_year_id=1
         WHERE fh.is_active=1
         ORDER BY fh.fee_type DESC, fh.name`, [selectedClass]
      );
      const cls = classes.find(c => c.id === selectedClass);
      if (cls) selectedClassName = `Class ${cls.class_name} - ${cls.section}`;
    }
    res.render('fees/fee-structure', {
      title: 'Fee Structure', activePage: 'fees',
      classes, feeHeads, structure, selectedClass, selectedClassName,
      success: req.flash('success'), error: req.flash('error')
    });
  } catch (err) {
    console.error(err);
    req.flash('error', 'Failed to load fee structure');
    res.redirect('/feemanagement');
  }
});

router.post('/structure/save', async (req, res) => {
  try {
    const { class_id, amounts, fee_types, apply_late_fees } = req.body;
    if (!class_id || !amounts) {
      req.flash('error', 'Invalid data');
      return res.redirect('/feemanagement/structure');
    }
    const headIds = Object.keys(amounts);
    for (const headId of headIds) {
      const amt = parseFloat(amounts[headId] || 0);
      const ftype = fee_types ? (fee_types[headId] || 'Monthly') : 'Monthly';
      const alf = apply_late_fees ? (apply_late_fees[headId] === '1' ? 1 : 0) : 0;

      // Update fee_head type + apply_late_fee
      await db.query(`UPDATE fee_heads SET fee_type=?, apply_late_fee=? WHERE id=?`, [ftype, alf, headId]);

      if (amt > 0) {
        await db.query(
          `INSERT INTO fee_structure (class_id, fee_head_id, academic_year_id, amount)
           VALUES (?,?,1,?)
           ON DUPLICATE KEY UPDATE amount=?`,
          [class_id, headId, amt, amt]
        );
      } else {
        await db.query(
          `DELETE FROM fee_structure WHERE class_id=? AND fee_head_id=? AND academic_year_id=1`,
          [class_id, headId]
        );
      }
    }
    req.flash('success', 'Fee structure saved successfully');
    res.redirect(`/feemanagement/structure?class_id=${class_id}`);
  } catch (err) {
    console.error(err);
    req.flash('error', 'Failed to save: ' + err.message);
    res.redirect('/feemanagement/structure');
  }
});

// Copy fee structure from one class to multiple
router.post('/structure/copy', async (req, res) => {
  try {
    const { from_class_id, to_class_ids } = req.body;
    const toIds = Array.isArray(to_class_ids) ? to_class_ids : [to_class_ids];
    const [srcRows] = await db.query(
      'SELECT * FROM fee_structure WHERE class_id=? AND academic_year_id=1', [from_class_id]
    );
    for (const toId of toIds) {
      for (const row of srcRows) {
        await db.query(
          `INSERT INTO fee_structure (class_id, fee_head_id, academic_year_id, amount)
           VALUES (?,?,1,?) ON DUPLICATE KEY UPDATE amount=?`,
          [toId, row.fee_head_id, row.amount, row.amount]
        );
      }
    }
    req.flash('success', `Fee structure copied to ${toIds.length} class(es)`);
    res.redirect(`/feemanagement/structure?class_id=${from_class_id}`);
  } catch (err) {
    req.flash('error', 'Copy failed: ' + err.message);
    res.redirect('/feemanagement/structure');
  }
});

// ── FEE STRUCTURE TEMPLATE DOWNLOAD ──────────────────────────────────────────
router.get('/structure/template', async (req, res) => {
  try {
    const [classes] = await db.query('SELECT * FROM classes WHERE academic_year_id=1 ORDER BY class_name+0, class_name, section');
    const [heads] = await db.query('SELECT * FROM fee_heads WHERE is_active=1 ORDER BY fee_type DESC, name');
    if (!heads.length) {
      req.flash('error', 'No fee heads found. Please create fee heads first.');
      return res.redirect('/feemanagement/masters/heads');
    }

    // Load existing structure amounts for prefilling
    const [existing] = await db.query(
      `SELECT fs.class_id, fs.fee_head_id, fs.amount FROM fee_structure fs WHERE fs.academic_year_id=1`
    );
    const existMap = {};
    existing.forEach(r => { existMap[`${r.class_id}_${r.fee_head_id}`] = r.amount; });

    const wb = xlsxLib.utils.book_new();

    // Build header row
    const headerRow = ['Class'];
    heads.forEach(h => headerRow.push(`${h.name} (${h.fee_type})`));

    // Build data rows
    const dataRows = classes.map(cls => {
      const row = [`Class ${cls.class_name} - ${cls.section}`];
      heads.forEach(h => {
        const amt = existMap[`${cls.id}_${h.id}`];
        row.push(amt !== undefined ? Number(amt) : '');
      });
      return row;
    });

    const wsData = [headerRow, ...dataRows];
    const ws = xlsxLib.utils.aoa_to_sheet(wsData);

    // Column widths
    ws['!cols'] = [{ wch: 22 }, ...heads.map(() => ({ wch: 20 }))];

    // Style header row cells (bold purple background via xlsx doesn't support full styling without xlsx-style,
    // so we add an instruction row instead)
    xlsxLib.utils.sheet_add_aoa(ws, [
      ['INSTRUCTIONS: Fill in the fee AMOUNT (₹) for each class and fee head. Monthly = per month amount. Annual = full year amount. Do NOT change column headers.']
    ], { origin: { r: classes.length + 2, c: 0 } });

    // Merge instruction cell
    ws['!merges'] = [{ s: { r: classes.length + 2, c: 0 }, e: { r: classes.length + 2, c: heads.length } }];

    xlsxLib.utils.book_append_sheet(wb, ws, 'Fee Structure');

    // Info sheet
    const infoData = [
      ['Fee Head', 'Type', 'Late Fee'],
      ...heads.map(h => [h.name, h.fee_type, h.apply_late_fee ? 'Yes (₹10/day)' : 'No'])
    ];
    const wsInfo = xlsxLib.utils.aoa_to_sheet(infoData);
    wsInfo['!cols'] = [{ wch: 25 }, { wch: 12 }, { wch: 16 }];
    xlsxLib.utils.book_append_sheet(wb, wsInfo, 'Fee Heads Reference');

    const buf = xlsxLib.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="fee_structure_template.xlsx"');
    res.send(buf);
  } catch (err) {
    console.error(err);
    req.flash('error', 'Template generation failed: ' + err.message);
    res.redirect('/feemanagement/structure');
  }
});

// ── FEE STRUCTURE BULK UPLOAD ─────────────────────────────────────────────────
router.post('/structure/bulk-upload', structureUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) { req.flash('error', 'No file uploaded'); return res.redirect('/feemanagement/structure'); }

    const wb = xlsxLib.read(req.file.buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = xlsxLib.utils.sheet_to_json(ws, { header: 1, defval: '' });
    if (rows.length < 2) { req.flash('error', 'File is empty or missing data rows'); return res.redirect('/feemanagement/structure'); }

    const headerRow = rows[0].map(h => String(h).trim());
    const [classes] = await db.query('SELECT * FROM classes WHERE academic_year_id=1');
    const [heads] = await db.query('SELECT * FROM fee_heads WHERE is_active=1');

    // Map header columns to fee head IDs
    // Header format: "Head Name (Monthly)" or "Head Name (Annual)"
    const colHeadMap = {}; // colIndex -> { headId, feeType }
    headerRow.forEach((col, idx) => {
      if (idx === 0) return; // skip Class column
      const match = col.match(/^(.+?)\s*\((Monthly|Annual)\)$/i);
      const headName = match ? match[1].trim() : col.replace(/\s*\((Monthly|Annual)\)\s*$/i, '').trim();
      const feeType = match ? match[2] : null;
      const head = heads.find(h => h.name.toLowerCase() === headName.toLowerCase());
      if (head) colHeadMap[idx] = { headId: head.id, feeType: feeType || head.fee_type };
    });

    if (!Object.keys(colHeadMap).length) {
      req.flash('error', 'No matching fee heads found in the file. Make sure column names match your fee heads.');
      return res.redirect('/feemanagement/structure');
    }

    // Build class map: "Class X - Y" → class id
    const classMap = {};
    classes.forEach(c => {
      classMap[`class ${c.class_name} - ${c.section}`.toLowerCase()] = c.id;
      classMap[`${c.class_name} - ${c.section}`.toLowerCase()] = c.id;
      classMap[`${c.class_name}`.toLowerCase()] = c.id;
    });

    let saved = 0, skipped = 0;
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const classLabel = String(row[0] || '').trim().toLowerCase();
      if (!classLabel || classLabel.startsWith('instruction')) continue;
      const classId = classMap[classLabel];
      if (!classId) { skipped++; continue; }

      for (const [colIdx, { headId, feeType }] of Object.entries(colHeadMap)) {
        const raw = row[colIdx];
        const amt = parseFloat(raw);
        if (isNaN(amt) || String(raw).trim() === '') {
          // Remove existing entry if blank
          await db.query('DELETE FROM fee_structure WHERE class_id=? AND fee_head_id=? AND academic_year_id=1', [classId, headId]);
          continue;
        }
        await db.query(
          `INSERT INTO fee_structure (class_id, fee_head_id, academic_year_id, amount) VALUES (?,?,1,?)
           ON DUPLICATE KEY UPDATE amount=?`,
          [classId, headId, amt, amt]
        );
        // Keep fee_head type in sync
        await db.query('UPDATE fee_heads SET fee_type=? WHERE id=?', [feeType, headId]);
        saved++;
      }
    }

    req.flash('success', `✅ Fee structure uploaded: ${saved} amounts saved, ${skipped} rows skipped`);
    res.redirect('/feemanagement/structure');
  } catch (err) {
    console.error(err);
    req.flash('error', 'Upload failed: ' + err.message);
    res.redirect('/feemanagement/structure');
  }
});

// ── ONLINE PAYMENTS (from Student Portal) ─────────────────────────────────────
router.get('/online', async (req, res) => {
  try {
    const { status } = req.query;
    let q = `SELECT op.*, s.first_name, s.last_name, s.admission_no, c.class_name, c.section
             FROM online_payments op
             LEFT JOIN students s ON op.student_id=s.id
             LEFT JOIN classes c ON s.class_id=c.id WHERE 1=1`;
    const params = [];
    if (status) { q += ' AND op.status=?'; params.push(status); }
    q += ' ORDER BY op.created_at DESC';
    const [onlinePayments] = await db.query(q, params);
    const [[{ pendingCount }]] = await db.query("SELECT COUNT(*) as pendingCount FROM online_payments WHERE status='Pending'");
    res.render('fees/online-payments', {
      title: 'Online Payments', activePage: 'fees',
      onlinePayments, pendingCount, filterStatus: status || '',
      success: req.flash('success'), error: req.flash('error')
    });
  } catch (err) {
    console.error(err);
    req.flash('error', 'Failed to load online payments');
    res.redirect('/feemanagement');
  }
});

router.post('/online/verify/:id', async (req, res) => {
  try {
    const [[op]] = await db.query(
      `SELECT op.*, s.class_id FROM online_payments op LEFT JOIN students s ON op.student_id=s.id WHERE op.id=?`,
      [req.params.id]
    );
    if (!op) { req.flash('error', 'Payment not found'); return res.redirect('/feemanagement/online'); }

    // Create verified fee_payment record
    const receiptNo = op.receipt_no.replace('ONL','VRF');
    await db.query(
      `INSERT INTO fee_payments (student_id, amount_paid, payment_date, payment_mode, receipt_no, transaction_id, remarks, collected_by)
       VALUES (?,?,?,?,?,?,?,?)`,
      [op.student_id, op.total_amount, op.payment_date || new Date().toISOString().split('T')[0],
       'UPI', receiptNo, op.utr_no, `Online Portal Payment | UTR: ${op.utr_no}`, req.session.user.id]
    );
    await db.query(
      `UPDATE online_payments SET status='Verified', verified_by=? WHERE id=?`,
      [req.session.user.id, req.params.id]
    );
    req.flash('success', `Payment verified. Receipt ${receiptNo} created.`);
    res.redirect('/feemanagement/online');
  } catch (err) {
    req.flash('error', 'Verification failed: ' + err.message);
    res.redirect('/feemanagement/online');
  }
});

router.post('/online/reject/:id', async (req, res) => {
  try {
    await db.query(`UPDATE online_payments SET status='Rejected' WHERE id=?`, [req.params.id]);
    req.flash('success', 'Payment marked as rejected');
    res.redirect('/feemanagement/online');
  } catch (err) {
    req.flash('error', 'Failed to reject');
    res.redirect('/feemanagement/online');
  }
});

// ── FEE COLLECTION REPORT ─────────────────────────────────────────────────────
router.get('/reports/collection', async (req, res) => {
  try {
    const { from_date, to_date, class_id, payment_mode } = req.query;
    const from = from_date || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0];
    const to = to_date || new Date().toISOString().split('T')[0];
    let q = `SELECT fp.*, s.first_name, s.last_name, s.admission_no, c.class_name, c.section
             FROM fee_payments fp LEFT JOIN students s ON fp.student_id=s.id LEFT JOIN classes c ON s.class_id=c.id
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
    req.flash('error','Report failed');
    res.redirect('/feemanagement');
  }
});

router.get('/reports/defaulters', async (req, res) => {
  try {
    const { class_id } = req.query;
    let q = `SELECT s.*, c.class_name, c.section,
              COALESCE(SUM(fp.amount_paid),0) as total_paid,
              p.first_name as father_name, p.mobile as father_mobile
             FROM students s LEFT JOIN classes c ON s.class_id=c.id
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

// ── FEE HEADS MASTER ──────────────────────────────────────────────────────────
router.get('/masters/heads', async (req, res) => {
  const [heads] = await db.query('SELECT * FROM fee_heads ORDER BY id');
  res.render('fees/masters-heads', { title: 'Fee Heads', activePage: 'fees', heads, success: req.flash('success'), error: req.flash('error') });
});

router.post('/masters/heads/add', async (req, res) => {
  const { name, description, fee_type, apply_late_fee } = req.body;
  await db.query(
    `INSERT INTO fee_heads (name, description, fee_type, apply_late_fee) VALUES (?,?,?,?)`,
    [name, description||null, fee_type||'Monthly', apply_late_fee==='1'?1:0]
  );
  req.flash('success','Fee head added');
  res.redirect('/feemanagement/masters/heads');
});

router.post('/masters/heads/update/:id', async (req, res) => {
  const { name, description, fee_type, apply_late_fee } = req.body;
  await db.query(
    `UPDATE fee_heads SET name=?, description=?, fee_type=?, apply_late_fee=? WHERE id=?`,
    [name, description||null, fee_type||'Monthly', apply_late_fee==='1'?1:0, req.params.id]
  );
  req.flash('success','Fee head updated');
  res.redirect('/feemanagement/masters/heads');
});

router.post('/masters/heads/delete/:id', async (req, res) => {
  await db.query('UPDATE fee_heads SET is_active=0 WHERE id=?', [req.params.id]);
  req.flash('success','Fee head removed');
  res.redirect('/feemanagement/masters/heads');
});

// ── FEE GROUPS MASTER ─────────────────────────────────────────────────────────
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

// ── DOWNLOAD FEE REPORT CSV ───────────────────────────────────────────────────
router.get('/reports/download', async (req, res) => {
  const { from_date, to_date } = req.query;
  const from = from_date || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0];
  const to = to_date || new Date().toISOString().split('T')[0];
  const [rows] = await db.query(
    `SELECT fp.receipt_no, s.admission_no, s.first_name, s.last_name, c.class_name, c.section,
      fp.amount_paid, fp.payment_date, fp.payment_mode, fp.remarks
     FROM fee_payments fp LEFT JOIN students s ON fp.student_id=s.id LEFT JOIN classes c ON s.class_id=c.id
     WHERE fp.payment_date BETWEEN ? AND ? ORDER BY fp.payment_date DESC`, [from, to]
  );
  const headers = ['Receipt No','Adm No','Student Name','Class','Section','Amount','Date','Mode','Remarks'];
  const csv = [headers.join(','), ...rows.map(r => [r.receipt_no,r.admission_no,r.first_name+' '+r.last_name,r.class_name||'',r.section||'',r.amount_paid,r.payment_date?r.payment_date.toISOString().split('T')[0]:'',r.payment_mode,r.remarks||''].join(','))].join('\n');
  res.setHeader('Content-Type','text/csv');
  res.setHeader('Content-Disposition',`attachment; filename="fee_report_${from}_${to}.csv"`);
  res.send(csv);
});

module.exports = router;

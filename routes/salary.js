const express = require('express');
const router = express.Router();
const db = require('../db');
let ExcelJS;
try { ExcelJS = require('exceljs'); } catch(e) { console.error('exceljs not available:', e.message); }
// pdfkit loaded lazily inside the route to avoid startup crash
let PDFDocument;
try { PDFDocument = require('pdfkit'); } catch(e) { console.error('pdfkit not available:', e.message); }

// ── Auto-create tables & columns on startup ───────────────────────────────────
(async () => {
  try {
    // Add salary columns to staff table if missing
    const alterStaff = [
      "ALTER TABLE staff ADD COLUMN IF NOT EXISTS basic_pay INT DEFAULT 0",
      "ALTER TABLE staff ADD COLUMN IF NOT EXISTS pay_scale VARCHAR(50) DEFAULT ''",
      "ALTER TABLE staff ADD COLUMN IF NOT EXISTS account_no VARCHAR(50) DEFAULT ''",
      "ALTER TABLE staff ADD COLUMN IF NOT EXISTS pf_applicable TINYINT(1) DEFAULT 0",
      "ALTER TABLE staff ADD COLUMN IF NOT EXISTS esi_applicable TINYINT(1) DEFAULT 0",
    ];
    for (const sql of alterStaff) await db.query(sql);

    // Salary PBR months table (stores per-month overrides as JSON)
    await db.query(`
      CREATE TABLE IF NOT EXISTS salary_pbr_months (
        id INT AUTO_INCREMENT PRIMARY KEY,
        year_no INT NOT NULL,
        month_no INT NOT NULL,
        da_percent DECIMAL(5,2) DEFAULT 30,
        hra_percent DECIMAL(5,2) DEFAULT 18,
        pf_percent DECIMAL(5,2) DEFAULT 12,
        esi_percent DECIMAL(5,2) DEFAULT 0.75,
        working_days INT DEFAULT 26,
        overrides JSON,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_month (year_no, month_no)
      )
    `);

    // Default salary settings in configuration table
    const defaults = [
      ['sal_da_percent', '30'],
      ['sal_hra_percent', '18'],
      ['sal_pf_percent', '12'],
      ['sal_esi_percent', '0.75'],
      ['sal_working_days', '26'],
      ['sal_adjust_n', '12'],
      ['sal_bank_name', 'Janta Co-operative Bank'],
      ['sal_bank_branch', 'Palam Branch, New Delhi 110045'],
      ['sal_principal_name', 'Ms Rajeshwari'],
    ];
    for (const [k, v] of defaults) {
      await db.query(
        'INSERT INTO configuration (key_name, value) VALUES (?,?) ON DUPLICATE KEY UPDATE key_name=key_name',
        [k, v]
      );
    }
  } catch (e) {
    console.error('Salary init error:', e.message);
  }
})();

// ── Helper: read salary settings from configuration table ─────────────────────
async function getSalarySettings() {
  const [rows] = await db.query(
    "SELECT key_name, value FROM configuration WHERE key_name LIKE 'sal_%'"
  );
  const cfg = {};
  rows.forEach(r => cfg[r.key_name] = r.value);
  return {
    daPercent:     parseFloat(cfg.sal_da_percent    || 30),
    hraPercent:    parseFloat(cfg.sal_hra_percent   || 18),
    pfPercent:     parseFloat(cfg.sal_pf_percent    || 12),
    esiPercent:    parseFloat(cfg.sal_esi_percent   || 0.75),
    workingDays:   parseInt  (cfg.sal_working_days  || 26),
    adjustN:       parseInt  (cfg.sal_adjust_n      || 12),
    bankName:      cfg.sal_bank_name      || 'Janta Co-operative Bank',
    bankBranch:    cfg.sal_bank_branch    || 'Palam Branch, New Delhi',
    principalName: cfg.sal_principal_name || 'Principal',
  };
}

// ── Helper: read school info ──────────────────────────────────────────────────
async function getSchoolInfo() {
  const [rows] = await db.query(
    "SELECT key_name, value FROM configuration WHERE key_name IN ('school_name','school_address','school_phone','school_email')"
  );
  const cfg = {};
  rows.forEach(r => cfg[r.key_name] = r.value);
  return {
    schoolName:    cfg.school_name    || process.env.SCHOOL_NAME || 'JBM Public School',
    schoolAddress: cfg.school_address || 'RZ 666/1, Sadh Nagar, Palam, New Delhi - 110045',
    schoolPhone:   cfg.school_phone   || '',
    schoolEmail:   cfg.school_email   || '',
  };
}

// ── PBR Main Page ─────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const settings = await getSalarySettings();
    res.render('salary/index', {
      title: 'Pay Bill Register',
      activePage: 'salary',
      settings
    });
  } catch (e) {
    console.error(e);
    res.render('salary/index', {
      title: 'Pay Bill Register',
      activePage: 'salary',
      settings: { daPercent: 30, hraPercent: 18, pfPercent: 12, esiPercent: 0.75, workingDays: 26, adjustN: 12 }
    });
  }
});

// ── Settings Page ─────────────────────────────────────────────────────────────
router.get('/settings', async (req, res) => {
  const settings = await getSalarySettings();
  res.render('salary/settings', {
    title: 'Salary Settings',
    activePage: 'salary',
    settings
  });
});

router.post('/settings', async (req, res) => {
  const b = req.body;
  const map = {
    sal_da_percent:     b.da_percent,
    sal_hra_percent:    b.hra_percent,
    sal_pf_percent:     b.pf_percent,
    sal_esi_percent:    b.esi_percent,
    sal_working_days:   b.working_days,
    sal_adjust_n:       b.adjust_n,
    sal_bank_name:      b.bank_name,
    sal_bank_branch:    b.bank_branch,
    sal_principal_name: b.principal_name,
  };
  for (const [k, v] of Object.entries(map)) {
    if (v !== undefined) {
      await db.query(
        'INSERT INTO configuration (key_name, value) VALUES (?,?) ON DUPLICATE KEY UPDATE value=?',
        [k, v, v]
      );
    }
  }
  req.flash('success', 'Salary settings saved!');
  res.redirect('/sal/settings');
});

// ── API: Staff list for PBR ───────────────────────────────────────────────────
router.get('/api/staff', async (req, res) => {
  try {
    const [staff] = await db.query(
      `SELECT id, CONCAT(first_name,' ',COALESCE(last_name,'')) AS name,
              designation, pay_scale, basic_pay, account_no,
              pf_applicable, esi_applicable
       FROM staff WHERE is_active=1
       ORDER BY FIELD(designation,'Vice Principal','PGT','TGT','PRT'), first_name`
    );
    const list = staff.map(s => ({
      id: s.id,
      name: s.name.trim(),
      designation: s.designation || '',
      payScale: s.pay_scale || '',
      basicPay: parseInt(s.basic_pay) || 0,
      accountNo: s.account_no || '',
      pfApplicable: !!s.pf_applicable,
      esiApplicable: !!s.esi_applicable,
    }));
    res.json(list);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── API: Load saved month ─────────────────────────────────────────────────────
router.get('/api/month/:year/:month', async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT * FROM salary_pbr_months WHERE year_no=? AND month_no=?',
      [req.params.year, req.params.month]
    );
    if (!rows.length) return res.json(null);
    const r = rows[0];
    res.json({
      daPercent:   parseFloat(r.da_percent),
      hraPercent:  parseFloat(r.hra_percent),
      pfPercent:   parseFloat(r.pf_percent),
      esiPercent:  parseFloat(r.esi_percent),
      workingDays: parseInt(r.working_days),
      overrides:   r.overrides || {},
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── API: Save month ───────────────────────────────────────────────────────────
router.post('/api/month/:year/:month', async (req, res) => {
  try {
    const { daPercent, hraPercent, pfPercent, esiPercent, workingDays, overrides } = req.body;
    await db.query(
      `INSERT INTO salary_pbr_months (year_no, month_no, da_percent, hra_percent, pf_percent, esi_percent, working_days, overrides)
       VALUES (?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
         da_percent=VALUES(da_percent), hra_percent=VALUES(hra_percent),
         pf_percent=VALUES(pf_percent), esi_percent=VALUES(esi_percent),
         working_days=VALUES(working_days), overrides=VALUES(overrides)`,
      [req.params.year, req.params.month, daPercent, hraPercent, pfPercent, esiPercent, workingDays, JSON.stringify(overrides || {})]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── API: Salary settings (for JS fetch) ──────────────────────────────────────
router.get('/api/settings', async (req, res) => {
  res.json(await getSalarySettings());
});

// ── Export: Excel ─────────────────────────────────────────────────────────────
router.post('/export/excel', async (req, res) => {
  try {
    const { rows, daPercent, hraPercent, pfPercent, esiPercent, monthLabel } = req.body;
    const school = await getSchoolInfo();

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('PBR');

    ws.mergeCells('A1:S1');
    ws.getCell('A1').value = school.schoolName;
    ws.getCell('A1').font = { bold: true, size: 14 };
    ws.getCell('A1').alignment = { horizontal: 'center' };

    ws.mergeCells('A2:S2');
    ws.getCell('A2').value = `PAY BILL REGISTER — ${monthLabel}`;
    ws.getCell('A2').font = { bold: true, size: 12 };
    ws.getCell('A2').alignment = { horizontal: 'center' };

    const headers = [
      'S.No','Name','Designation','Pay Scale','Basic Pay',
      `DA (${daPercent}%)`, `HRA (${hraPercent}%)`,
      'Gross','Working Days','Leave Days','Days Worked','Payable Gross',
      `PF (${pfPercent}%)`,`ESI (${esiPercent}%)`,'TDS','Loan/Adv','Total Deductions','Net Pay','Account No.'
    ];
    const hRow = ws.addRow(headers);
    hRow.font = { bold: true };
    hRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF6B21A8' } };
    hRow.alignment = { horizontal: 'center', wrapText: true };
    hRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };

    let totalNet = 0;
    rows.forEach(r => {
      totalNet += r.netPay;
      ws.addRow([
        r.sno, r.name, r.designation, r.payScale, r.basicPay,
        r.daAmt, r.hraAmt, r.gross, r.workDays, r.leaveDays, r.daysWorked, r.payableGross,
        r.pf, r.esi, r.tds, r.loan, r.totalDed, r.netPay, r.accountNo
      ]);
    });

    const totRow = ws.addRow(['', 'TOTAL', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', totalNet, '']);
    totRow.font = { bold: true };
    totRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } };

    ws.columns.forEach((col, i) => {
      col.width = i === 1 ? 22 : i === 2 ? 16 : 12;
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="PBR_${monthLabel.replace(' ', '_')}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (e) {
    console.error(e);
    res.status(500).send('Export failed: ' + e.message);
  }
});

// ── Export: Bank Letter PDF ───────────────────────────────────────────────────
router.post('/export/bank-letter', async (req, res) => {
  try {
    const { rows, monthLabel } = req.body;
    const settings = await getSalarySettings();
    const school = await getSchoolInfo();

    const MARGIN = 50;
    const PAGE_W = 595.28;
    const PAGE_H = 841.89;
    const CONTENT_W = PAGE_W - MARGIN * 2;
    const FOOTER_RESERVE = 80;

    const doc = new PDFDocument({ margin: MARGIN, size: 'A4', autoFirstPage: true });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="BankLetter_${monthLabel.replace(' ', '_')}.pdf"`);
    doc.pipe(res);

    // Letterhead
    doc.rect(MARGIN, MARGIN, CONTENT_W, 2).fill('#4A0E8F');
    doc.moveDown(0.3);
    doc.fontSize(16).font('Helvetica-Bold').fillColor('#4A0E8F')
       .text(school.schoolName.toUpperCase(), { align: 'center' });
    doc.fontSize(9).font('Helvetica').fillColor('#333333')
       .text(school.schoolAddress, { align: 'center' });
    if (school.schoolPhone) {
      doc.text(`Phone: ${school.schoolPhone}  |  Email: ${school.schoolEmail || ''}`, { align: 'center' });
    }
    doc.moveDown(0.3);
    doc.rect(MARGIN, doc.y, CONTENT_W, 1).fill('#cccccc');
    doc.fillColor('#000000');
    doc.moveDown(0.8);

    // Date
    const dateStr = new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' });
    doc.fontSize(10).font('Helvetica').text(`Date: ${dateStr}`, { align: 'right' });
    doc.moveDown(0.8);

    // Addressee
    doc.text('To,');
    doc.text('The Branch Manager,');
    doc.font('Helvetica-Bold').text(settings.bankName + ',');
    doc.font('Helvetica').text(settings.bankBranch);
    doc.moveDown(0.8);

    // Subject
    doc.font('Helvetica-Bold').fontSize(10)
       .text(`Sub: Credit of Salary for the month of ${monthLabel} — reg.`);
    doc.moveDown(0.6);

    // Body
    doc.font('Helvetica').fontSize(10).text('Respected Sir/Madam,');
    doc.moveDown(0.4);
    doc.text(
      `Please find below the details of salary to be credited to the respective savings accounts of the staff members of ${school.schoolName} for the month of ${monthLabel}. Kindly arrange to credit the amounts at the earliest.`,
      { align: 'justify', lineGap: 2 }
    );
    doc.moveDown(0.8);

    // Table columns
    const col = {
      sno:  { x: MARGIN,       w: 30  },
      name: { x: MARGIN + 30,  w: 155 },
      desg: { x: MARGIN + 185, w: 100 },
      acc:  { x: MARGIN + 285, w: 120 },
      net:  { x: MARGIN + 405, w: 90  },
    };
    const ROW_H = 16;

    function drawTableHeader(yPos) {
      doc.rect(MARGIN, yPos, CONTENT_W, ROW_H).fill('#4A0E8F');
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#ffffff');
      doc.text('S.No',        col.sno.x  + 2, yPos + 4, { width: col.sno.w  - 4, align: 'center' });
      doc.text('Name',        col.name.x + 2, yPos + 4, { width: col.name.w - 4 });
      doc.text('Designation', col.desg.x + 2, yPos + 4, { width: col.desg.w - 4 });
      doc.text('Account No.', col.acc.x  + 2, yPos + 4, { width: col.acc.w  - 4 });
      doc.text('Net Salary',  col.net.x  + 2, yPos + 4, { width: col.net.w  - 4, align: 'right' });
      doc.fillColor('#000000');
      return yPos + ROW_H;
    }

    let y = drawTableHeader(doc.y);
    let totalNet = 0;
    let rowNum = 0;

    rows.forEach(r => {
      totalNet += r.netPay;
      rowNum++;

      if (y + ROW_H + FOOTER_RESERVE > PAGE_H - MARGIN) {
        doc.addPage();
        y = MARGIN + 10;
        y = drawTableHeader(y);
      }

      if (rowNum % 2 === 0) {
        doc.rect(MARGIN, y, CONTENT_W, ROW_H).fill('#f3e8ff');
      }

      doc.font('Helvetica').fontSize(8).fillColor('#000000');
      doc.text(String(r.sno),                    col.sno.x  + 2, y + 4, { width: col.sno.w  - 4, align: 'center' });
      doc.text(r.name,                           col.name.x + 2, y + 4, { width: col.name.w - 4 });
      doc.text(r.designation || '',              col.desg.x + 2, y + 4, { width: col.desg.w - 4 });
      doc.text(r.accountNo   || '-',             col.acc.x  + 2, y + 4, { width: col.acc.w  - 4 });
      doc.text('Rs.' + r.netPay.toLocaleString('en-IN'), col.net.x + 2, y + 4, { width: col.net.w - 4, align: 'right' });
      doc.rect(MARGIN, y, CONTENT_W, ROW_H).stroke('#cccccc');
      y += ROW_H;
    });

    // Total row
    doc.rect(MARGIN, y, CONTENT_W, ROW_H).fill('#4A0E8F');
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#ffffff');
    doc.text('TOTAL', col.sno.x + 2, y + 4, { width: col.desg.x + col.desg.w - MARGIN - 4 });
    doc.text('Rs.' + totalNet.toLocaleString('en-IN'), col.net.x + 2, y + 4, { width: col.net.w - 4, align: 'right' });
    doc.fillColor('#000000');
    y += ROW_H + 20;

    // Footer / signature
    if (y + 100 > PAGE_H - MARGIN) {
      doc.addPage();
      y = MARGIN + 20;
    }

    doc.font('Helvetica').fontSize(10).fillColor('#000000');
    doc.text('Kindly arrange to credit the above amounts to the respective accounts at the earliest.', MARGIN, y, { width: CONTENT_W });
    y = doc.y + 10;
    doc.text('Thanking you,', MARGIN, y);
    y = doc.y + 40;
    doc.font('Helvetica-Bold').text(settings.principalName || 'Principal', MARGIN, y);
    doc.font('Helvetica').text('(Principal)', MARGIN);
    doc.text(school.schoolName, MARGIN);

    doc.moveDown(1);
    doc.fontSize(8).fillColor('#555555')
       .text(`Total Salary Amount: Rs.${totalNet.toLocaleString('en-IN')} for ${rows.length} staff members.`, { align: 'center' });

    doc.end();
  } catch (e) {
    console.error(e);
    res.status(500).send('PDF failed: ' + e.message);
  }
});

module.exports = router;

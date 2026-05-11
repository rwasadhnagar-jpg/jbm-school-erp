const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const fs = require('fs');
const db = require('./db');

const BACKUP_DIR = path.join(__dirname, 'backups');
const KEEP_DAYS = 7;

async function runBackup() {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const date = new Date().toISOString().slice(0, 10);
  const time = new Date().toTimeString().slice(0, 8).replace(/:/g, '-');
  const filename = `backup_${date}_${time}.sql`;
  const filepath = path.join(BACKUP_DIR, filename);

  const tables = [
    'academic_years', 'classes', 'students', 'parents', 'student_addresses',
    'fee_heads', 'fee_groups', 'fee_group_details', 'fee_payments', 'fee_concessions',
    'attendance_student', 'attendance_staff', 'staff', 'admissions',
    'library_books', 'library_issues', 'transport_routes', 'transport_vehicles',
    'transport_allocation', 'hostel_rooms', 'hostel_allocation',
    'salary_structure', 'salary_payments', 'notices', 'events',
    'accounts_transactions', 'inventory', 'users', 'configuration'
  ];

  let sql = `-- JBM School ERP Database Backup\n`;
  sql += `-- Date: ${new Date().toLocaleString('en-IN')}\n`;
  sql += `-- Database: ${process.env.DB_NAME}\n\n`;
  sql += `SET FOREIGN_KEY_CHECKS=0;\n\n`;

  for (const table of tables) {
    try {
      const [rows] = await db.query(`SELECT * FROM \`${table}\``);
      sql += `-- TABLE: ${table}\n`;
      sql += `TRUNCATE TABLE \`${table}\`;\n`;
      if (rows.length > 0) {
        const cols = Object.keys(rows[0]).map(c => `\`${c}\``).join(', ');
        for (const row of rows) {
          const vals = Object.values(row).map(v => {
            if (v === null) return 'NULL';
            if (v instanceof Date) return `'${v.toISOString().slice(0, 19).replace('T', ' ')}'`;
            return `'${String(v).replace(/'/g, "''")}'`;
          }).join(', ');
          sql += `INSERT INTO \`${table}\` (${cols}) VALUES (${vals});\n`;
        }
      }
      sql += '\n';
    } catch (e) {
      sql += `-- SKIP ${table}: ${e.message}\n\n`;
    }
  }

  sql += `SET FOREIGN_KEY_CHECKS=1;\n`;
  fs.writeFileSync(filepath, sql);

  // Delete backups older than KEEP_DAYS
  const files = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith('backup_') && f.endsWith('.sql'))
    .map(f => ({ name: f, time: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
    .sort((a, b) => b.time - a.time);

  files.slice(KEEP_DAYS).forEach(f => {
    fs.unlinkSync(path.join(BACKUP_DIR, f.name));
  });

  console.log(`✅ Backup saved: ${filename} (${(fs.statSync(filepath).size / 1024).toFixed(1)} KB)`);
  return filename;
}

module.exports = { runBackup, BACKUP_DIR };

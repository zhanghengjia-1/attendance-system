const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, 'server-state.json');
let pool = null;
let fileState = null;
let useDB = false;

// Connect to PostgreSQL (via DATABASE_URL or individual env vars), fall back to JSON file
async function initDB() {
  // Zeabur / Railway / Render all provide DATABASE_URL
  const databaseUrl = process.env.DATABASE_URL;

  if (databaseUrl) {
    try {
      pool = new Pool({
        connectionString: databaseUrl,
        connectionTimeoutMillis: 8000,
        max: 5,
        idleTimeoutMillis: 10000,
        allowExitOnIdle: true,
      });
      const client = await pool.connect();
      try {
        await client.query('SELECT 1');
        useDB = true;
        console.log('PostgreSQL 连接成功');

        // Create tables
        await client.query(`
          CREATE TABLE IF NOT EXISTS attendance_edits (
            month TEXT NOT NULL, emp_id TEXT NOT NULL,
            data JSONB NOT NULL DEFAULT '{}',
            updated_at TIMESTAMPTZ DEFAULT NOW(),
            PRIMARY KEY (month, emp_id)
          );
          CREATE TABLE IF NOT EXISTS daily_edits (
            month TEXT NOT NULL, emp_id TEXT NOT NULL,
            day_data JSONB NOT NULL DEFAULT '{}',
            updated_at TIMESTAMPTZ DEFAULT NOW(),
            PRIMARY KEY (month, emp_id)
          );
          CREATE TABLE IF NOT EXISTS overtime_applications (
            id BIGINT PRIMARY KEY, emp_id TEXT, emp_name TEXT DEFAULT '',
            date TEXT, type TEXT, hours REAL DEFAULT 0,
            reason TEXT DEFAULT '', status TEXT DEFAULT 'pending',
            created_at TIMESTAMPTZ DEFAULT NOW()
          );
          CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT ''
          );
          CREATE TABLE IF NOT EXISTS custom_employees (
            emp_id TEXT PRIMARY KEY, name TEXT NOT NULL, position TEXT DEFAULT '设备技术员'
          );
          CREATE TABLE IF NOT EXISTS hidden_employees (
            emp_id TEXT PRIMARY KEY, hidden_at TIMESTAMPTZ DEFAULT NOW()
          );
          CREATE TABLE IF NOT EXISTS rest_schedule (
            month TEXT NOT NULL, emp_id TEXT NOT NULL,
            rest_day INTEGER NOT NULL, rest_type TEXT DEFAULT 'week',
            week_num INTEGER, locked BOOLEAN DEFAULT true,
            PRIMARY KEY (month, emp_id)
          );
        `);
        await client.query("INSERT INTO settings (key, value) VALUES ('otLimit','36') ON CONFLICT DO NOTHING");
        await client.query("INSERT INTO settings (key, value) VALUES ('otWarn','30') ON CONFLICT DO NOTHING");
        console.log('数据库表初始化完成');
        return;
      } finally {
        client.release();
      }
    } catch(e) {
      console.warn('PostgreSQL 连接失败，回退到文件存储:', e.message);
      useDB = false;
      pool = null;
    }
  }

  // Fallback: JSON file
  try {
    if (fs.existsSync(STATE_FILE)) fileState = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch(e) {}
  if (!fileState) {
    fileState = { editedData: {}, dailyEdits: {}, otApplications: [], settings: { otLimit: 36, otWarn: 30 }, customEmployees: {} };
  }
  console.log('使用文件存储');
}

function saveFileState() {
  if (!useDB && fileState) fs.writeFileSync(STATE_FILE, JSON.stringify(fileState, null, 2), 'utf8');
}

// ===================== Attendance Edits =====================
async function getEditedData() {
  if (useDB) {
    const { rows } = await pool.query('SELECT month, emp_id, data FROM attendance_edits');
    const result = {};
    for (const r of rows) { if (!result[r.month]) result[r.month] = {}; result[r.month][r.emp_id] = r.data; }
    return result;
  }
  return fileState.editedData || {};
}
async function saveAttendanceEdit(month, empId, data) {
  if (useDB) {
    await pool.query('INSERT INTO attendance_edits (month,emp_id,data,updated_at) VALUES ($1,$2,$3,NOW()) ON CONFLICT (month,emp_id) DO UPDATE SET data=$3,updated_at=NOW()', [month, empId, JSON.stringify(data)]);
  } else {
    if (!fileState.editedData[month]) fileState.editedData[month] = {};
    fileState.editedData[month][empId] = data;
    saveFileState();
  }
}

// ===================== Daily Edits =====================
async function getDailyEdits() {
  if (useDB) {
    const { rows } = await pool.query('SELECT month, emp_id, day_data FROM daily_edits');
    const result = {};
    for (const r of rows) { if (!result[r.month]) result[r.month] = {}; result[r.month][r.emp_id] = r.day_data; }
    return result;
  }
  return fileState.dailyEdits || {};
}
async function saveDailyEdit(month, empId, day, normal, lianban, ot) {
  if (useDB) {
    const { rows } = await pool.query('SELECT day_data FROM daily_edits WHERE month=$1 AND emp_id=$2', [month, empId]);
    let dayData = rows.length > 0 ? rows[0].day_data : {};
    dayData[String(day)] = { n: normal, l: lianban || 0, o: ot };
    await pool.query('INSERT INTO daily_edits (month,emp_id,day_data,updated_at) VALUES ($1,$2,$3,NOW()) ON CONFLICT (month,emp_id) DO UPDATE SET day_data=$3,updated_at=NOW()', [month, empId, JSON.stringify(dayData)]);
  } else {
    if (!fileState.dailyEdits[month]) fileState.dailyEdits[month] = {};
    if (!fileState.dailyEdits[month][empId]) fileState.dailyEdits[month][empId] = {};
    fileState.dailyEdits[month][empId][String(day)] = { n: normal, l: lianban || 0, o: ot };
    saveFileState();
  }
}

// ===================== Overtime Applications =====================
async function getOTApplications() {
  if (useDB) { const { rows } = await pool.query('SELECT * FROM overtime_applications ORDER BY created_at DESC'); return rows; }
  return fileState.otApplications || [];
}
async function addOTApplication(app) {
  if (useDB) {
    await pool.query('INSERT INTO overtime_applications (id,emp_id,emp_name,date,type,hours,reason,status,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [app.id, app.empId, app.empName, app.date, app.type, app.hours, app.reason, 'pending', new Date().toISOString()]);
  } else { fileState.otApplications.unshift(app); saveFileState(); }
}
async function updateOTStatus(id, status) {
  if (useDB) { await pool.query('UPDATE overtime_applications SET status=$1 WHERE id=$2', [status, id]); }
  else { const a = fileState.otApplications.find(x => x.id === id); if (a) { a.status = status; saveFileState(); } }
}
async function deleteOTApplication(id) {
  if (useDB) { await pool.query('DELETE FROM overtime_applications WHERE id=$1', [id]); }
  else { fileState.otApplications = fileState.otApplications.filter(a => a.id !== id); saveFileState(); }
}

// ===================== Settings =====================
async function getSettings() {
  if (useDB) {
    const { rows } = await pool.query('SELECT key, value FROM settings');
    const r = {}; for (const row of rows) r[row.key] = row.value;
    return { otLimit: parseFloat(r.otLimit) || 36, otWarn: parseFloat(r.otWarn) || 30, weeklyLimit: parseFloat(r.weeklyLimit) || 61, otRestThreshold: parseFloat(r.otRestThreshold) || 4 };
  }
  return fileState.settings || { otLimit: 36, otWarn: 30, weeklyLimit: 61, otRestThreshold: 4 };
}
async function saveSettings(otLimit, otWarn, weeklyLimit, otRestThreshold) {
  if (useDB) {
    if (otLimit !== undefined) await pool.query("INSERT INTO settings (key,value) VALUES ('otLimit',$1) ON CONFLICT (key) DO UPDATE SET value=$1", [String(otLimit)]);
    if (otWarn !== undefined) await pool.query("INSERT INTO settings (key,value) VALUES ('otWarn',$1) ON CONFLICT (key) DO UPDATE SET value=$1", [String(otWarn)]);
    if (weeklyLimit !== undefined) await pool.query("INSERT INTO settings (key,value) VALUES ('weeklyLimit',$1) ON CONFLICT (key) DO UPDATE SET value=$1", [String(weeklyLimit)]);
    if (otRestThreshold !== undefined) await pool.query("INSERT INTO settings (key,value) VALUES ('otRestThreshold',$1) ON CONFLICT (key) DO UPDATE SET value=$1", [String(otRestThreshold)]);
  } else {
    if (otLimit !== undefined) fileState.settings.otLimit = parseFloat(otLimit);
    if (otWarn !== undefined) fileState.settings.otWarn = parseFloat(otWarn);
    if (weeklyLimit !== undefined) fileState.settings.weeklyLimit = parseFloat(weeklyLimit);
    if (otRestThreshold !== undefined) fileState.settings.otRestThreshold = parseFloat(otRestThreshold);
    saveFileState();
  }
}

// ===================== Custom Employees =====================
async function getCustomEmployees() {
  if (useDB) { const { rows } = await pool.query('SELECT emp_id, name, position FROM custom_employees'); const r = {}; for (const row of rows) r[row.emp_id] = { name: row.name, position: row.position }; return r; }
  return fileState.customEmployees || {};
}

// ===================== Hidden Employees (deleted from base) =====================
async function getHiddenEmployees() {
  if (useDB) { const { rows } = await pool.query('SELECT emp_id FROM hidden_employees'); const r = {}; for (const row of rows) r[row.emp_id] = true; return r; }
  return fileState.hiddenEmployees || {};
}
async function hideEmployee(empId) {
  if (useDB) { await pool.query('INSERT INTO hidden_employees (emp_id) VALUES ($1) ON CONFLICT DO NOTHING', [empId]); }
  else { if (!fileState.hiddenEmployees) fileState.hiddenEmployees = {}; fileState.hiddenEmployees[empId] = true; saveFileState(); }
}
async function showEmployee(empId) {
  if (useDB) { await pool.query('DELETE FROM hidden_employees WHERE emp_id=$1', [empId]); }
  else { if (fileState.hiddenEmployees) { delete fileState.hiddenEmployees[empId]; saveFileState(); } }
}
async function saveCustomEmployee(empId, name, position) {
  if (useDB) { await pool.query('INSERT INTO custom_employees (emp_id,name,position) VALUES ($1,$2,$3) ON CONFLICT (emp_id) DO UPDATE SET name=$2,position=$3', [empId, name, position || '设备技术员']); }
  else { fileState.customEmployees[empId] = { name, position: position || '设备技术员' }; saveFileState(); }
}

// ===================== Section Assignments =====================
async function getSectionAssignments() {
  if (useDB) {
    try {
      await pool.query("CREATE TABLE IF NOT EXISTS section_assignments (emp_id TEXT PRIMARY KEY, section TEXT NOT NULL)");
      const { rows } = await pool.query('SELECT emp_id, section FROM section_assignments');
      const r = {}; for (const row of rows) r[row.emp_id] = row.section; return r;
    } catch(e) { return {}; }
  }
  return fileState.sectionAssignments || {};
}
async function saveSectionAssignment(empId, section) {
  if (useDB) {
    try {
      await pool.query("CREATE TABLE IF NOT EXISTS section_assignments (emp_id TEXT PRIMARY KEY, section TEXT NOT NULL)");
      await pool.query('INSERT INTO section_assignments (emp_id,section) VALUES ($1,$2) ON CONFLICT (emp_id) DO UPDATE SET section=$2', [empId, section]);
    } catch(e) { console.warn('saveSection error:', e.message); }
  } else {
    if (!fileState.sectionAssignments) fileState.sectionAssignments = {};
    fileState.sectionAssignments[empId] = section;
    saveFileState();
  }
}

async function deleteEmployee(empId) {
  if (useDB) {
    await pool.query('DELETE FROM custom_employees WHERE emp_id=$1', [empId]);
    await pool.query('DELETE FROM attendance_edits WHERE emp_id=$1', [empId]);
    await pool.query('DELETE FROM daily_edits WHERE emp_id=$1', [empId]);
    await pool.query('DELETE FROM overtime_applications WHERE emp_id=$1', [empId]);
    await pool.query('DELETE FROM section_assignments WHERE emp_id=$1', [empId]);
  } else {
    delete fileState.customEmployees[empId];
    if (fileState.sectionAssignments) delete fileState.sectionAssignments[empId];
    for (var m in fileState.editedData) { if (fileState.editedData[m][empId]) delete fileState.editedData[m][empId]; }
    for (var m in fileState.dailyEdits) { if (fileState.dailyEdits[m][empId]) delete fileState.dailyEdits[m][empId]; }
    fileState.otApplications = fileState.otApplications.filter(function(a){ return a.empId !== empId; });
    saveFileState();
  }
}

// ===================== Rest Schedule =====================
async function getRestSchedule(month) {
  if (useDB) {
    const { rows } = await pool.query('SELECT emp_id, rest_day, rest_type, week_num FROM rest_schedule WHERE month=$1', [month]);
    const r = {};
    for (const row of rows) r[row.emp_id] = { restDay: row.rest_day, restType: row.rest_type, week: row.week_num };
    return r;
  }
  if (!fileState.restSchedule) fileState.restSchedule = {};
  return fileState.restSchedule[month] || {};
}
async function saveRestSchedule(month, assignments) {
  if (useDB) {
    for (const [empId, info] of Object.entries(assignments)) {
      await pool.query(
        'INSERT INTO rest_schedule (month,emp_id,rest_day,rest_type,week_num) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (month,emp_id) DO UPDATE SET rest_day=$3,rest_type=$4,week_num=$5',
        [month, empId, info.restDay, info.restType, info.week]
      );
    }
  } else {
    if (!fileState.restSchedule) fileState.restSchedule = {};
    fileState.restSchedule[month] = assignments;
    saveFileState();
  }
}
async function clearRestSchedule(month) {
  if (useDB) { await pool.query('DELETE FROM rest_schedule WHERE month=$1', [month]); }
  else { if (fileState.restSchedule) { delete fileState.restSchedule[month]; saveFileState(); } }
}

module.exports = {
  initDB, getEditedData, saveAttendanceEdit, getDailyEdits, saveDailyEdit,
  getOTApplications, addOTApplication, updateOTStatus, deleteOTApplication,
  getSettings, saveSettings, getCustomEmployees, saveCustomEmployee,
  getSectionAssignments, saveSectionAssignment, deleteEmployee,
  getHiddenEmployees, hideEmployee, showEmployee,
  getRestSchedule, saveRestSchedule, clearRestSchedule,
};

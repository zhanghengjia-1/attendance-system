const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

const BASE_DATA_FILE = path.join(__dirname, 'data.js');

// Load base attendance data (static, from data.js)
function loadBaseData() {
  const raw = fs.readFileSync(BASE_DATA_FILE, 'utf8');
  const match = raw.match(/var EMBEDDED_DATA = ({[\s\S]*?});/);
  if (!match) throw new Error('Cannot parse data.js');
  return JSON.parse(match[1]);
}

// ===================== API Routes =====================

// Get full data (base + DB state)
app.get('/api/data', async (req, res) => {
  try {
    const base = loadBaseData();
    const [editedData, dailyEdits, otApps, settings, customEmps, sections] = await Promise.all([
      db.getEditedData(), db.getDailyEdits(), db.getOTApplications(),
      db.getSettings(), db.getCustomEmployees(), db.getSectionAssignments()
    ]);
    res.json({
      employees: { ...base.employees, ...customEmps },
      attendance: base.attendance,
      editedData, dailyEdits,
      otApplications: otApps,
      settings,
      customEmployees: customEmps,
      sectionAssignments: sections,
      customEmployees: customEmps
    });
  } catch(e) {
    console.error('GET /api/data error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Compute daily attendance for a specific date (same logic as frontend getMonthData)
function computeNormal(t) {
  if (t===null||t===undefined||t==='/'||t==='') return 0;
  const s = String(t).trim(); if (s==='休'||s==='假') return 0; if (s==='4') return 8;
  const n = parseFloat(s); return isNaN(n)?0:n;
}
function hoursToNum(v) { if (v===null||v===undefined||v==='/'||v==='') return 0; return parseFloat(v)||0; }
function isWeekend(monthStr, day) {
  const m = parseInt(monthStr.replace('2026年','').replace('月',''));
  const dow = new Date(2026, m-1, day).getDay();
  return dow === 0 || dow === 6;
}
function computeTotalsForScript(daily, monthStr) {
  let rh=0, wdo=0, weo=0, ho=0, lb=0;
  for (const d of daily) {
    const n = d._normal||0, l = d._lianban||0, o = d._ot||0;
    lb += l;
    if (isWeekend(monthStr, d.day)) { weo += n+l+o; }
    else { const reg = Math.min(n,8); rh += reg; wdo += Math.max(0,n-8)+l+o; }
  }
  return { regular_hours: Math.round(rh*10)/10, lianban: Math.round(lb*10)/10, weekday_ot: Math.round(wdo*10)/10, weekend_ot: Math.round(weo*10)/10, holiday_ot: Math.round(ho*10)/10, total_hours: Math.round((rh+wdo+weo+ho)*10)/10 };
}

app.get('/api/daily-summary', async (req, res) => {
  try {
    const dateStr = req.query.date;
    if (!dateStr) return res.status(400).json({ error: 'Missing date param (YYYY-MM-DD)' });
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return res.status(400).json({ error: 'Invalid date' });
    const monthStr = `${d.getFullYear()}年${d.getMonth()+1}月`;
    const day = d.getDate();

    const base = loadBaseData();
    const [editedData, dailyEdits, sections] = await Promise.all([
      db.getEditedData(), db.getDailyEdits(), db.getSectionAssignments()
    ]);

    const monthRecords = (base.attendance || {})[monthStr] || [];
    const monthEdits = (dailyEdits || {})[monthStr] || {};
    const editOverrides = (editedData || {})[monthStr] || {};

    const result = [];

    for (const rec of monthRecords) {
      const empId = rec.emp_id;
      const empName = (base.employees || {})[empId] ? base.employees[empId].name : rec.name;
      const daily = rec.daily || [];
      const empEdits = monthEdits[empId] || {};

      // Compute for target day
      const dayRec = daily.find(dd => dd.day === day);
      const ev = empEdits[String(day)];
      let n=0, l=0, o=0;
      if (ev !== undefined && ev !== null) {
        if (typeof ev === 'object') { n = parseFloat(ev.n)||0; l = parseFloat(ev.l)||0; o = parseFloat(ev.o)||0; }
        else { n = parseFloat(ev)||0; }
      } else if (dayRec) {
        n = computeNormal(dayRec.type);
        o = hoursToNum(dayRec.hours);
      }

      // Compute monthly totals the exact same way as getMonthData (filter out future days)
      const now = new Date();
      const todayD = (now.getFullYear() === 2026 && now.getMonth()+1 === d.getMonth()+1) ? now.getDate() : 31;
      const mergedDaily = daily.map(function(dd) {
        const dk = String(dd.day);
        if (dd.day > todayD) return { day: dd.day, _normal: 0, _lianban: 0, _ot: 0 };
        const edit = empEdits[dk];
        if (edit !== undefined) {
          if (typeof edit === 'object' && edit !== null) return { day: dd.day, _normal: parseFloat(edit.n)||0, _lianban: parseFloat(edit.l)||0, _ot: parseFloat(edit.o)||0 };
          else return { day: dd.day, _normal: parseFloat(edit)||0, _lianban: 0, _ot: 0 };
        }
        return { day: dd.day, _normal: computeNormal(dd.type), _lianban: 0, _ot: hoursToNum(dd.hours) };
      });
      const totals = computeTotalsForScript(mergedDaily, monthStr);

      const section = sections[empId] || '未分组';
      const total = n + l + o;

      result.push({ empId, name: empName, section, normal: n, lianban: l, overtime: o, total, monthly: totals.total_hours, monthReg: totals.regular_hours });
    }

    res.json({ date: dateStr, day, month: monthStr, employees: result, sectionAssignments: sections });
  } catch(e) {
    console.error('GET /api/daily-summary error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Save attendance edits (monthly summary level)
app.post('/api/attendance/edit', async (req, res) => {
  try {
    const { month, empId, data } = req.body;
    if (!month || !empId) return res.status(400).json({ error: 'Missing month or empId' });
    await db.saveAttendanceEdit(month, empId, data);
    res.json({ success: true });
  } catch(e) {
    console.error('POST /api/attendance/edit error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Save daily edits
app.post('/api/attendance/daily-edit', async (req, res) => {
  try {
    const { month, empId, day, normal, lianban, ot } = req.body;
    if (!month || !empId || !day) return res.status(400).json({ error: 'Missing fields' });
    await db.saveDailyEdit(month, empId, day, normal, lianban, ot);
    res.json({ success: true });
  } catch(e) {
    console.error('POST /api/attendance/daily-edit error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Get overtime applications
app.get('/api/overtime', async (req, res) => {
  try {
    const apps = await db.getOTApplications();
    res.json(apps);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Submit overtime application
app.post('/api/overtime', async (req, res) => {
  try {
    const { empId, empName, date, type, hours, reason } = req.body;
    if (!empId || !date || !type || !hours) return res.status(400).json({ error: 'Missing fields' });
    const app_ot = {
      id: Date.now(),
      empId, empName: empName || '', date, type, hours: parseFloat(hours),
      reason: reason || '', status: 'pending',
      createdAt: new Date().toISOString()
    };
    await db.addOTApplication(app_ot);
    res.json({ success: true, application: app_ot });
  } catch(e) {
    console.error('POST /api/overtime error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Approve overtime
app.post('/api/overtime/:id/approve', async (req, res) => {
  try {
    await db.updateOTStatus(parseInt(req.params.id), 'approved');
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Reject overtime
app.post('/api/overtime/:id/reject', async (req, res) => {
  try {
    await db.updateOTStatus(parseInt(req.params.id), 'rejected');
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Delete overtime
app.delete('/api/overtime/:id', async (req, res) => {
  try {
    await db.deleteOTApplication(parseInt(req.params.id));
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Batch overtime sync
app.post('/api/overtime/batch', async (req, res) => {
  try {
    for (const app_ot of (req.body || [])) {
      await db.addOTApplication(app_ot);
    }
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Get/Set settings
app.get('/api/settings', async (req, res) => {
  try {
    const settings = await db.getSettings();
    res.json(settings);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/settings', async (req, res) => {
  try {
    const { otLimit, otWarn, weeklyLimit } = req.body;
    await db.saveSettings(otLimit, otWarn, weeklyLimit);
    const settings = await db.getSettings();
    res.json({ success: true, settings });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Save custom employees
app.post('/api/employees', async (req, res) => {
  try {
    const { empId, name, position } = req.body;
    if (!empId || !name) return res.status(400).json({ error: 'Missing empId or name' });
    await db.saveCustomEmployee(empId, name, position);
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Update employee name/position
app.put('/api/employees/:empId', async (req, res) => {
  try {
    const { name, position } = req.body;
    await db.saveCustomEmployee(req.params.empId, name, position);
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Delete employee from all months
app.delete('/api/employees/:empId', async (req, res) => {
  try {
    await db.deleteEmployee(req.params.empId);
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Save section assignments
app.post('/api/sections', async (req, res) => {
  try {
    const { assignments } = req.body; // { empId: section, ... }
    for (const [empId, section] of Object.entries(assignments)) {
      await db.saveSectionAssignment(empId, section);
    }
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Start HTTP server immediately, then init DB in background
app.listen(PORT, () => {
  console.log(`考勤系统后端服务已启动: http://localhost:${PORT}`);
  // Initialize DB asynchronously - do NOT block the server startup
  db.initDB().then(() => {
    console.log('数据存储就绪');
  }).catch(e => {
    console.warn('数据库初始化失败，使用文件回退:', e.message);
  });
});

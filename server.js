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

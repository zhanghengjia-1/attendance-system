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
    const [editedData, dailyEdits, otApps, settings, customEmps, sections, hiddenEmps] = await Promise.all([
      db.getEditedData(), db.getDailyEdits(), db.getOTApplications(),
      db.getSettings(), db.getCustomEmployees(), db.getSectionAssignments(), db.getHiddenEmployees()
    ]);
    // Filter out hidden employees from base
    const filteredEmployees = {};
    for (const [eid, info] of Object.entries(base.employees || {})) {
      if (!hiddenEmps[eid]) filteredEmployees[eid] = info;
    }
    res.json({
      employees: { ...filteredEmployees, ...customEmps },
      attendance: base.attendance,
      editedData, dailyEdits,
      otApplications: otApps,
      settings,
      customEmployees: customEmps,
      sectionAssignments: sections,
      hiddenEmployees: hiddenEmps
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
    const [editedData, dailyEdits, sections, hiddenEmps] = await Promise.all([
      db.getEditedData(), db.getDailyEdits(), db.getSectionAssignments(), db.getHiddenEmployees()
    ]);
    // Filter out hidden employees from base
    for (const hid of Object.keys(hiddenEmps)) {
      if (base.employees[hid]) delete base.employees[hid];
    }

    // Auto-create month if missing (matches frontend getMonthData behavior)
    if (!base.attendance[monthStr]) {
      const mNum = parseInt(monthStr.replace('2026年','').replace('月',''));
      const numDays = new Date(2026, mNum, 0).getDate();
      const refMonth = Object.keys(base.attendance)[0];
      const refData = refMonth ? (base.attendance[refMonth] || []) : [];
      const orderedEmpIds = refData.map(r => r.emp_id);
      const allEmpIds = Object.keys(base.employees);
      for (const eid of allEmpIds) if (orderedEmpIds.indexOf(eid) === -1) orderedEmpIds.push(eid);
      base.attendance[monthStr] = orderedEmpIds.map(eid => {
        const emp = base.employees[eid] || { name: eid, position: '' };
        const emptyDaily = [];
        for (let d = 1; d <= numDays; d++) emptyDaily.push({ day: d, type: '/', type2: '/', hours: '/' });
        return { emp_id: eid, name: emp.name, position: emp.position, daily: emptyDaily, regular_hours: 0, weekday_ot: 0, weekend_ot: 0, holiday_ot: 0, total_hours: 0 };
      });
    }

    const monthRecords = base.attendance[monthStr] || [];
    const monthEdits = (dailyEdits || {})[monthStr] || {};
    const editOverrides = (editedData || {})[monthStr] || {};

    const result = [];

    for (const rec of monthRecords) {
      const empId = rec.emp_id;
      // Skip hidden/deleted employees
      if (!base.employees[empId]) continue;
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
    const { otLimit, otWarn, weeklyLimit, otRestThreshold } = req.body;
    await db.saveSettings(otLimit, otWarn, weeklyLimit, otRestThreshold);
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
    await db.hideEmployee(req.params.empId);
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Restore hidden employee
app.post('/api/employees/:empId/restore', async (req, res) => {
  try {
    await db.showEmployee(req.params.empId);
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

// ===================== Auth & User Management =====================

const USERS_FILE = path.join(__dirname, 'users.json');

function loadUsers() {
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  } catch(e) {
    // Default: one admin user
    return [{ username: 'admin', password: 'admin123', role: 'admin' }];
  }
}
function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

// Login
app.post('/api/auth', (req, res) => {
  const { username, password } = req.body;
  const users = loadUsers();
  const user = users.find(u => u.username === username && u.password === password);
  if (user) {
    res.json({ success: true, role: user.role, username: user.username, isSuperAdmin: user.username === 'admin' });
  } else {
    res.status(401).json({ success: false, error: '用户名或密码错误' });
  }
});

// Check if current user is super admin
function requireSuperAdmin(req, res, next) {
  const { superAdmin } = req.body;
  if (superAdmin) next();
  else res.status(403).json({ error: '仅超级管理员可操作' });
}

// List users (super admin only)
app.get('/api/users', (req, res) => {
  const users = loadUsers();
  res.json(users.map(u => ({ username: u.username, role: u.role })));
});

// Add or update user (super admin only, via body flag)
app.post('/api/users', (req, res) => {
  const { username, password, role, superAdmin } = req.body;
  if (superAdmin !== true) return res.status(403).json({ error: '仅超级管理员可操作' });
  if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });
  let users = loadUsers();
  const idx = users.findIndex(u => u.username === username);
  if (idx >= 0) {
    users[idx] = { username, password, role: role || 'user' };
  } else {
    users.push({ username, password, role: role || 'user' });
  }
  saveUsers(users);
  res.json({ success: true });
});

// Delete user (super admin only)
app.delete('/api/users', (req, res) => {
  const { username, superAdmin } = req.body;
  if (superAdmin !== true) return res.status(403).json({ error: '仅超级管理员可操作' });
  let users = loadUsers();
  const adminCount = users.filter(u => u.role === 'admin').length;
  const target = users.find(u => u.username === username);
  if (!target) return res.status(404).json({ error: '用户不存在' });
  if (target.role === 'admin' && adminCount <= 1) return res.status(400).json({ error: '最后一个管理员不能删除' });
  users = users.filter(u => u.username !== username);
  saveUsers(users);
  res.json({ success: true });
});

// Change own password
app.post('/api/users/change-password', (req, res) => {
  const { username, oldPassword, newPassword } = req.body;
  let users = loadUsers();
  const user = users.find(u => u.username === username && u.password === oldPassword);
  if (!user) return res.status(401).json({ error: '原密码错误' });
  user.password = newPassword;
  saveUsers(users);
  res.json({ success: true });
});

// ===== Rest Schedule (for Feishu notification) =====
function getISOWeek(y, m, d) {
  const dt = new Date(y, m-1, d);
  const dayNum = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  return Math.ceil(((dt - yearStart) / 86400000 + 1) / 7);
}
function getSection(empId, sections) { return sections[empId] || '未分组'; }

app.get('/api/rest-schedule', async (req, res) => {
  try {
    const now = new Date();
    const today = now.getDate();
    const mStr = `${now.getFullYear()}年${now.getMonth()+1}月`;
    const monthKey = now.getMonth() + 1;
    const lastDay = new Date(now.getFullYear(), monthKey, 0).getDate();

    const base = loadBaseData();
    const [dailyEdits, sections, hiddenEmps] = await Promise.all([db.getDailyEdits(), db.getSectionAssignments(), db.getHiddenEmployees()]);
    for (const hid of Object.keys(hiddenEmps || {})) {
      if (base.employees[hid]) delete base.employees[hid];
    }
    const monthEdits = (dailyEdits || {})[mStr] || {};

    // Auto-create month if missing
    if (!base.attendance[mStr]) {
      const numDays = new Date(now.getFullYear(), monthKey, 0).getDate();
      const refMonth = Object.keys(base.attendance)[0];
      const refData = refMonth ? (base.attendance[refMonth] || []) : [];
      const orderedEmpIds = refData.map(r => r.emp_id);
      const allEmpIds = Object.keys(base.employees);
      for (const eid of allEmpIds) if (orderedEmpIds.indexOf(eid) === -1) orderedEmpIds.push(eid);
      base.attendance[mStr] = orderedEmpIds.map(eid => {
        const emp = base.employees[eid] || { name: eid, position: '' };
        const emptyDaily = [];
        for (let d = 1; d <= numDays; d++) emptyDaily.push({ day: d, type: '/', type2: '/', hours: '/' });
        return { emp_id: eid, name: emp.name, position: emp.position, daily: emptyDaily, regular_hours: 0, weekday_ot: 0, weekend_ot: 0, holiday_ot: 0, total_hours: 0 };
      });
    }

    const monthRecords = base.attendance[mStr] || [];

    const WEEKLY_LIMIT = 61, MAX_PER_SECTION_PER_DAY = 1;
    const settings = await db.getSettings();
    const OT_REST_THRESHOLD = parseFloat(settings.otRestThreshold) || 4;
    const data = [];
    // Build merged data like frontend (skip hidden employees)
    for (const rec of monthRecords) {
      if (!base.employees[rec.emp_id]) continue;
      const empEdits = monthEdits[rec.emp_id] || {};
      const daily = (rec.daily || []).map(dd => {
        const dk = String(dd.day);
        const edit = empEdits[dk];
        if (edit) {
          if (typeof edit === 'object') return { day: dd.day, _normal: parseFloat(edit.n)||0, _lianban: parseFloat(edit.l)||0, _ot: parseFloat(edit.o)||0 };
          return { day: dd.day, _normal: parseFloat(edit)||0, _lianban: 0, _ot: 0 };
        }
        return { day: dd.day, _normal: computeNormal(dd.type), _lianban: 0, _ot: hoursToNum(dd.hours) };
      });
      data.push({ emp_id: rec.emp_id, daily: daily });
    }

    // Compute week hours
    const weekHours = {};
    for (const r of data) {
      for (const d of r.daily) {
        if (d.day > today) break;
        const w = getISOWeek(2026, monthKey, d.day);
        if (!weekHours[w]) weekHours[w] = {};
        if (!weekHours[w][r.emp_id]) weekHours[w][r.emp_id] = 0;
        weekHours[w][r.emp_id] += (d._normal||0) + (d._lianban||0) + (d._ot||0);
      }
    }

    // Find first week of month (skip it)
    const firstWeek = getISOWeek(2026, monthKey, 1);

    // Distribute rest
    const dayRest = {}; // section -> day -> count
    const result = [];

    const weekNums = Object.keys(weekHours).map(Number).sort((a,b)=>a-b);
    for (const wk of weekNums) {
      if (wk === firstWeek) continue;

      const restQueue = [];
      for (const empId in weekHours[wk]) {
        if (weekHours[wk][empId] > WEEKLY_LIMIT) {
          restQueue.push({ empId, week: wk, exceeded: weekHours[wk][empId] });
        }
      }
      restQueue.sort((a,b)=>b.exceeded-a.exceeded);

      for (const item of restQueue) {
        const sec = getSection(item.empId, sections);
        if (!dayRest[sec]) dayRest[sec] = {};

        // Find days in next ISO week (Mon-Sat)
        const candidates = [];
        for (let d = 1; d <= lastDay; d++) {
          if (getISOWeek(2026, monthKey, d) === item.week + 1) {
            const dow = new Date(2026, monthKey-1, d).getDay();
            if (dow !== 0) candidates.push(d);
          }
          if (getISOWeek(2026, monthKey, d) > item.week + 1) break;
        }

        let assigned = false;
        for (const cd of candidates) {
          const cnt = dayRest[sec][cd] || 0;
          if (cnt < MAX_PER_SECTION_PER_DAY) {
            dayRest[sec][cd] = cnt + 1;
            const name = (base.employees || {})[item.empId] ? base.employees[item.empId].name : item.empId;
            result.push({ empId: item.empId, name, section: sec, restDay: cd, week: item.week });
            assigned = true;
            break;
          }
        }
        if (!assigned && candidates.length > 0) {
          let bestDay = candidates[0], bestCnt = dayRest[sec][candidates[0]] || 0;
          for (let ci = 1; ci < candidates.length; ci++) {
            const cc = dayRest[sec][candidates[ci]] || 0;
            if (cc < bestCnt) { bestCnt = cc; bestDay = candidates[ci]; }
          }
          dayRest[sec][bestDay] = (dayRest[sec][bestDay]||0)+1;
          const name = (base.employees || {})[item.empId] ? base.employees[item.empId].name : item.empId;
          result.push({ empId: item.empId, name, section: sec, restDay: bestDay, week: item.week });
        }
      }
    }

    // ===== Overtime-based rest: 前一天加班 > OT_REST_THRESHOLD → 下早班 =====
    // Monday checks Saturday (skip Sunday)
    const todayDOW = new Date(now.getFullYear(), monthKey-1, today).getDay();
    const yesterday = todayDOW === 1 ? today - 2 : today - 1;
    if (yesterday >= 1) {
      const otQueue = [];
      for (const r of data) {
        const ydRec = r.daily.find(d => d.day === yesterday);
        if (!ydRec) continue;
        const ot = (ydRec._lianban || 0) + (ydRec._ot || 0);
        if (ot > OT_REST_THRESHOLD) {
          let restOn = today;
          let restDOW = new Date(now.getFullYear(), monthKey-1, restOn).getDay();
          if (restDOW === 0) restOn = today + 1;
          otQueue.push({ empId: r.emp_id, overtime: ot, restOn: restOn });
        }
        // Also check today for tomorrow's preview
        const tdRec = r.daily.find(d => d.day === today);
        if (tdRec) {
          const tdOt = (tdRec._lianban || 0) + (tdRec._ot || 0);
          if (tdOt > OT_REST_THRESHOLD) {
            let restOn2 = today + 1;
            let restDOW2 = new Date(now.getFullYear(), monthKey-1, restOn2).getDay();
            if (restDOW2 === 0) restOn2 = today + 2;
            otQueue.push({ empId: r.emp_id, overtime: tdOt, restOn: restOn2 });
          }
        }
      }
      // Don't sort by overtime - match frontend order (employee list order)

      // Distribute OT rest (separate from week rest)
      const otDayRest = {}; // section -> day -> count
      for (const item of otQueue) {
        const sec = getSection(item.empId, sections);
        if (!otDayRest[sec]) otDayRest[sec] = {};

        // Check if already scheduled (from week-based)
        const alreadyHasRest = result.some(r => r.empId === item.empId && r.restDay === item.restOn);
        if (alreadyHasRest) continue;

        // Find next available day (Mon-Sat, exclude Sunday)
        let chosenDay = item.restOn;
        const existingCount0 = (dayRest[sec] && dayRest[sec][chosenDay]) || 0;
        const otCount0 = (otDayRest[sec][chosenDay] || 0);
        if (existingCount0 + otCount0 >= MAX_PER_SECTION_PER_DAY) {
          let foundDay = null;
          for (let tryDay = today; tryDay <= today + 6; tryDay++) {
            if (tryDay > lastDay) break;
            const tryDOW = new Date(now.getFullYear(), monthKey-1, tryDay).getDay();
            if (tryDOW === 0) continue;
            const ec = (dayRest[sec] && dayRest[sec][tryDay]) || 0;
            const oc = otDayRest[sec][tryDay] || 0;
            if (ec + oc < MAX_PER_SECTION_PER_DAY) { foundDay = tryDay; break; }
          }
          if (foundDay === null) continue;
          chosenDay = foundDay;
        }

        const ec2 = (dayRest[sec] && dayRest[sec][chosenDay]) || 0;
        otDayRest[sec][chosenDay] = (otDayRest[sec][chosenDay] || 0) + 1;
        const name = (base.employees || {})[item.empId] ? base.employees[item.empId].name : item.empId;
        result.push({ empId: item.empId, name, section: sec, restDay: chosenDay, restType: 'ot', overtime: item.overtime });
      }
    }

    // Filter for today and tomorrow only
    const filtered = result.filter(r => r.restDay === today || r.restDay === today + 1);
    res.json({ date: `${now.getFullYear()}-${String(monthKey).padStart(2,'0')}-${String(today).padStart(2,'0')}`, rest: filtered, otRestThreshold: OT_REST_THRESHOLD });
  } catch(e) {
    console.error('GET /api/rest-schedule error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Save rest schedule assignments (from frontend)
app.post('/api/rest-schedule', async (req, res) => {
  try {
    const { month, assignments } = req.body;
    if (!month || !assignments) return res.status(400).json({ error: 'Missing month or assignments' });
    await db.saveRestSchedule(month, assignments);
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Get saved rest schedule
app.get('/api/rest-schedule/saved', async (req, res) => {
  try {
    const { month } = req.query;
    if (!month) return res.status(400).json({ error: 'Missing month param' });
    const schedule = await db.getRestSchedule(month);
    res.json(schedule);
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

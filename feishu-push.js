#!/usr/bin/env node
/**
 * 考勤系统 · 每日推送脚本
 * 推送前一天加班情况到飞书群
 * 用法: node feishu-push.js [日期]
 * 日期可选，默认前一天
 */

const WEBHOOK_URL = 'https://open.feishu.cn/open-apis/bot/v2/hook/30ee6979-4b58-46e6-9f96-1d45b8d78bfc';
const API_BASE = process.env.API_BASE || 'http://localhost:3000';

function getYesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d;
}

function pad(n) { return String(n).padStart(2, '0'); }

function formatDate(date) {
  return `${date.getFullYear()}年${date.getMonth()+1}月${date.getDate()}日`;
}

function monthStr(date) {
  return `${date.getFullYear()}年${date.getMonth()+1}月`;
}

async function main() {
  const dateArg = process.argv[2];
  const targetDate = dateArg ? new Date(dateArg) : getYesterday();
  const mStr = monthStr(targetDate);
  const day = targetDate.getDate();
  const dateLabel = formatDate(targetDate);

  // 1. Fetch data
  let data;
  try {
    const res = await fetch(`${API_BASE}/api/data`);
    data = await res.json();
  } catch(e) {
    console.error('获取数据失败:', e.message);
    process.exit(1);
  }

  const monthRecords = (data.attendance || {})[mStr] || [];
  if (monthRecords.length === 0) {
    console.log(`${mStr} 无数据`);
    return;
  }

  const dailyEdits = data.dailyEdits || {};
  const monthEdits = dailyEdits[mStr] || {};

  const sectionOrder = ['模组','整机','2.5前加工','库房','测包','立库'];

  // Compute normal/ot for a day record (same logic as frontend)
  function computeType(recType, hours) {
    // type can be a code string or a special character
    if (recType === '/' || recType === '休' || !recType) return 0;
    // For numeric type codes: 4=班 (8h), 2/3=special
    const code = parseInt(recType);
    if (code === 4 || code === 5) return 8;
    if (code === 2 || code === 3) return 0; // 休息/请假
    // If it's '班', return 8
    if (String(recType) === '班') return 8;
    return 0;
  }
  function computeOT(hours) {
    const h = parseFloat(hours);
    return isNaN(h) ? 0 : h;
  }

  // 2. Get day data by employee
  const dayData = [];
  for (const rec of monthRecords) {
    const empId = rec.emp_id;
    const empName = (data.employees || {})[empId] ? data.employees[empId].name : rec.name;
    const daily = rec.daily || [];
    const dayRec = daily.find(d => d.day === day);

    // Check for daily edits first
    const empEdit = monthEdits[empId];
    const editVal = empEdit ? empEdit[String(day)] : undefined;

    if (editVal) {
      // Manual edit exists
      var n = parseFloat(editVal.n) || 0, l = parseFloat(editVal.l) || 0, o = parseFloat(editVal.o) || 0;
      var total = n + l + o;
      if (total === 0) continue;
      const sectionR = (data.sectionAssignments || {})[empId];
      dayData.push({
        empId, name: empName, section: sectionR || '未分组',
        normal: n, lianban: l, overtime: o, total
      });
    } else if (dayRec) {
      // Use base import data
      var n = computeType(dayRec.type, dayRec.hours);
      var o = computeOT(dayRec.hours);
      var total = n + o;
      if (total === 0) continue;
      const sectionR = (data.sectionAssignments || {})[empId];
      dayData.push({
        empId, name: empName, section: sectionR || '未分组',
        normal: n, lianban: 0, overtime: o, total
      });
    }
  }

  if (dayData.length === 0) {
    const msg = `📋 ${dateLabel}（周${['日','一','二','三','四','五','六'][new Date(targetDate).getDay()]}）\n无人加班 ✅`;
    await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msg_type: 'text', content: { text: msg } })
    });
    console.log('已推送：无人加班');
    return;
  }

  // 3. Group by section with order
  const sectionGroups = {};
  for (const d of dayData) {
    if (!sectionGroups[d.section]) sectionGroups[d.section] = [];
    sectionGroups[d.section].push(d);
  }

  // 4. Build message
  let msg = `📋 **${dateLabel}** 加班情况\n\n`;
  for (const sec of sectionOrder) {
    if (!sectionGroups[sec]) continue;
    const items = sectionGroups[sec];
    const secTotal = items.reduce((s, i) => s + i.overtime + i.lianban, 0);
    msg += `**${sec}**（加班合计 ${secTotal.toFixed(1)}h）\n`;
    for (const i of items) {
      const parts = [];
      if (i.normal > 0) parts.push(`正常${i.normal}h`);
      if (i.lianban > 0) parts.push(`连班${i.lianban}h`);
      if (i.overtime > 0) parts.push(`加班${i.overtime}h`);
      msg += `  ${i.name}：${parts.join('、')}（合计${i.total}h）\n`;
    }
    msg += '\n';
  }

  // Unassigned
  if (sectionGroups['未分组']) {
    const items = sectionGroups['未分组'];
    msg += `**未分组**\n`;
    for (const i of items) {
      msg += `  ${i.name}：加班${i.overtime}h\n`;
    }
  }

  msg += `\n👥 共 ${dayData.length} 人加班`;

  // 5. Send to Feishu
  const res = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ msg_type: 'text', content: { text: msg } })
  });
  const result = await res.json();
  if (result.StatusCode === 0 || result.code === 0) {
    console.log('✅ 推送成功');
  } else {
    console.error('❌ 推送失败:', JSON.stringify(result));
  }
}

main().catch(e => console.error('脚本错误:', e));

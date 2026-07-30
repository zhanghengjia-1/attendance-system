#!/usr/bin/env node
/**
 * 考勤系统 · 每日出勤推送脚本
 * 推送前一天所有人出勤工时到飞书群（统计表格式）
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

function monthStr(date) {
  return `${date.getFullYear()}年${date.getMonth()+1}月`;
}

function computeNormal(recType) {
  if (recType === '/' || recType === '休' || !recType) return 0;
  const code = parseInt(recType);
  if (code === 4 || code === 5 || String(recType) === '班') return 8;
  return 0;
}

function computeOT(hours) {
  const h = parseFloat(hours);
  return isNaN(h) ? 0 : h;
}

async function main() {
  const dateArg = process.argv[2];
  const targetDate = dateArg ? new Date(dateArg) : getYesterday();
  const mStr = monthStr(targetDate);
  const day = targetDate.getDate();
  const weekday = ['日','一','二','三','四','五','六'][targetDate.getDay()];
  const dateLabel = `${targetDate.getFullYear()}年${targetDate.getMonth()+1}月${targetDate.getDate()}日`;

  // Fetch data
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
  const monthEdits = (dailyEdits[mStr] || {});
  const sectionAssign = data.sectionAssignments || {};

  const sectionOrder = ['模组','整机','2.5前加工','库房','测包','立库'];
  // Collect all employees with their daily data
  const rows = [];
  for (const rec of monthRecords) {
    const empId = rec.emp_id;
    const empName = (data.employees || {})[empId] ? data.employees[empId].name : rec.name;
    const daily = rec.daily || [];
    const dayRec = daily.find(d => d.day === day);
    const editVal = monthEdits[empId] ? monthEdits[empId][String(day)] : undefined;

    let n = 0, l = 0, o = 0;
    if (editVal) {
      n = parseFloat(editVal.n) || 0;
      l = parseFloat(editVal.l) || 0;
      o = parseFloat(editVal.o) || 0;
    } else if (dayRec) {
      n = computeNormal(dayRec.type);
      o = computeOT(dayRec.hours);
    }
    const total = n + l + o;
    const section = sectionAssign[empId] || '未分组';

    rows.push({ name: empName, section, normal: n, lianban: l, overtime: o, total });
  }

  // Sort by section order then name
  rows.sort((a, b) => {
    const ia = sectionOrder.indexOf(a.section), ib = sectionOrder.indexOf(b.section);
    if (ia !== ib) return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
    return a.name.localeCompare(b.name, 'zh');
  });

  // Build summary
  const sectionTotals = {};
  let grandTotalN = 0, grandTotalL = 0, grandTotalO = 0, grandTotalAll = 0;
  for (const r of rows) {
    if (!sectionTotals[r.section]) sectionTotals[r.section] = { n:0, l:0, o:0, total:0, count:0 };
    sectionTotals[r.section].n += r.normal;
    sectionTotals[r.section].l += r.lianban;
    sectionTotals[r.section].o += r.overtime;
    sectionTotals[r.section].total += r.total;
    sectionTotals[r.section].count++;
    grandTotalN += r.normal;
    grandTotalL += r.lianban;
    grandTotalO += r.overtime;
    grandTotalAll += r.total;
  }

  // Build table message
  let msg = `📋 **${dateLabel}（周${weekday}）出勤统计**\n\n`;

  for (const sec of sectionOrder) {
    if (!sectionTotals[sec]) continue;
    const st = sectionTotals[sec];
    msg += `**【${sec}】**（${st.count}人）\n`;
    // Table header
    msg += '姓名\t正常班\t连班\t加班\t合计\n';
    // Filter rows for this section
    const secRows = rows.filter(r => r.section === sec);
    for (const r of secRows) {
      const parts = [r.name];
      parts.push(r.normal > 0 ? String(r.normal) : '-');
      parts.push(r.lianban > 0 ? String(r.lianban) : '-');
      parts.push(r.overtime > 0 ? String(r.overtime) : '-');
      parts.push(String(r.total));
      msg += parts.join('\t') + '\n';
    }
    msg += `小计\t${st.n.toFixed(0)}\t${st.l.toFixed(0)}\t${st.o.toFixed(0)}\t${st.total.toFixed(0)}\n\n`;
  }

  // 未分组
  if (sectionTotals['未分组']) {
    const st = sectionTotals['未分组'];
    msg += `**【未分组】**（${st.count}人）\n`;
    msg += '姓名\t正常班\t连班\t加班\t合计\n';
    const ur = rows.filter(r => r.section === '未分组');
    for (const r of ur) {
      msg += `${r.name}\t${r.normal||'-'}\t${r.lianban||'-'}\t${r.overtime||'-'}\t${r.total}\n`;
    }
    msg += `小计\t${st.n.toFixed(0)}\t${st.l.toFixed(0)}\t${st.o.toFixed(0)}\t${st.total.toFixed(0)}\n\n`;
  }

  // Grand total
  msg += `📊 **全组合计**：${rows.length} 人出勤\n`;
  msg += `正常班 ${grandTotalN.toFixed(0)}h | 连班 ${grandTotalL.toFixed(0)}h | 加班 ${grandTotalO.toFixed(0)}h | **总工时 ${grandTotalAll.toFixed(0)}h**`;

  // Send to Feishu
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

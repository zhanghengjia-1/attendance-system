#!/usr/bin/env node
/**
 * 考勤系统 · 每日出勤推送脚本
 * 推送前一天所有人出勤工时到飞书群（统计表格式）
 * 用法: node feishu-push.js [日期]
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

function pad(s, width) {
  s = String(s);
  // Treat wide chars (Chinese) as taking 2 spaces
  let len = 0;
  for (const ch of s) {
    if (/[\u4e00-\u9fa5]/.test(ch)) len += 2;
    else len += 1;
  }
  return s + ' '.repeat(Math.max(0, width - len));
}

async function main() {
  const dateArg = process.argv[2];
  const targetDate = dateArg ? new Date(dateArg) : getYesterday();
  const mStr = monthStr(targetDate);
  const day = targetDate.getDate();
  const weekday = ['日','一','二','三','四','五','六'][targetDate.getDay()];
  const dateLabel = `${targetDate.getFullYear()}年${targetDate.getMonth()+1}月${targetDate.getDate()}日`;

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
  const rows = [];
  for (const rec of monthRecords) {
    const empId = rec.emp_id;
    const empName = (data.employees || {})[empId] ? data.employees[empId].name : rec.name;
    const daily = rec.daily || [];
    const empEdits = monthEdits[empId] || {};

    // Compute today's data
    const dayRec = daily.find(d => d.day === day);
    const editVal = empEdits[String(day)];
    let n = 0, l = 0, o = 0;
    if (editVal) {
      n = parseFloat(editVal.n) || 0;
      l = parseFloat(editVal.l) || 0;
      o = parseFloat(editVal.o) || 0;
    } else if (dayRec) {
      n = computeNormal(dayRec.type);
      o = computeOT(dayRec.hours);
    }
    const todayTotal = n + l + o;

    // Compute monthly total from ALL daily records (handle base + edits)
    let monthN = 0, monthL = 0, monthO = 0;
    for (const dd of daily) {
      const dk = String(dd.day);
      const ev = empEdits[dk];
      let dn = 0, dl = 0, dOt = 0;
      if (ev) {
        dn = parseFloat(ev.n) || 0;
        dl = parseFloat(ev.l) || 0;
        dOt = parseFloat(ev.o) || 0;
      } else {
        dn = computeNormal(dd.type);
        dOt = computeOT(dd.hours);
      }
      monthN += dn;
      monthL += dl;
      monthO += dOt;
    }
    const monthTotal = monthN + monthL + monthO;

    const section = sectionAssign[empId] || '未分组';

    rows.push({ name: empName, section, normal: n, lianban: l, overtime: o, total: todayTotal, monthly: monthTotal });
  }

  rows.sort((a, b) => {
    const ia = sectionOrder.indexOf(a.section), ib = sectionOrder.indexOf(b.section);
    if (ia !== ib) return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
    return a.name.localeCompare(b.name, 'zh');
  });

  // Group by section, build table sections
  let body = `📋 **${dateLabel}（周${weekday}）出勤统计**\n\n`;

  // Overall summary - card header
  let grandN = 0, grandL = 0, grandO = 0, grandT = 0, grandM = 0;
  const sectionTotals = {};
  for (const r of rows) {
    grandN += r.normal; grandL += r.lianban; grandO += r.overtime; grandT += r.total; grandM += r.monthly;
    if (!sectionTotals[r.section]) sectionTotals[r.section] = { n:0, l:0, o:0, t:0, m:0, count:0 };
    sectionTotals[r.section].n += r.normal;
    sectionTotals[r.section].l += r.lianban;
    sectionTotals[r.section].o += r.overtime;
    sectionTotals[r.section].t += r.total;
    sectionTotals[r.section].m += r.monthly;
    sectionTotals[r.section].count++;
  }

  // Build interactive card using divs only (Feishu table is fragile)
  const elements = [
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**📋 ${dateLabel}（周${weekday}）出勤统计**\n\n**全组**：${rows.length}人 · 正常班 ${grandN.toFixed(0)}h · 加班 ${(grandL + grandO).toFixed(0)}h · **总工时 ${(grandN+grandL+grandO).toFixed(0)}h**`
      }
    },
    { tag: 'hr' }
  ];

  for (const sec of sectionOrder.concat(['未分组'])) {
    if (!sectionTotals[sec]) continue;
    const st = sectionTotals[sec];
    // Section header
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**【${sec}】**（${st.count}人）累计 ${st.m.toFixed(0)}h | 当天 ${st.t.toFixed(0)}h`
      }
    });
    // Build rows
    const secRows = rows.filter(r => r.section === sec);
    // Header
    elements.push({
      tag: 'div',
      fields: [
        { is_short: false, text: { tag: 'lark_md', content: `姓名   | 正常 | 连班 | 加班 | 当天 | 当月` } }
      ]
    });
    // Separator
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: `<font color="grey">--- | --- | --- | --- | --- | ---</font>` }
    });
    // Each employee as a row
    for (const r of secRows) {
      const line = [
        pad(r.name, 8),
        pad(r.normal > 0 ? r.normal.toString() : '-', 4),
        pad(r.lianban > 0 ? r.lianban.toString() : '-', 4),
        pad(r.overtime > 0 ? r.overtime.toString() : '-', 4),
        pad(r.total.toString(), 4),
        r.monthly > 0 ? r.monthly.toFixed(0) : '-'
      ].join('|');
      elements.push({
        tag: 'div',
        text: { tag: 'lark_md', content: line }
      });
    }
    // Subtotal
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**小计**：${st.n.toFixed(0)}h | 连班 ${st.l.toFixed(0)}h | 加班 ${st.o.toFixed(0)}h | 当天 ${st.t.toFixed(0)}h | **当月 ${st.m.toFixed(0)}h**`
      }
    });
    elements.push({ tag: 'hr' });
  }

  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `考勤日报 · ${dateLabel}` }
    },
    elements: elements
  };

  const res = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ msg_type: 'interactive', card: card })
  });
  const result = await res.json();
  if (result.StatusCode === 0 || result.code === 0) {
    console.log('✅ 推送成功');
  } else {
    console.error('❌ 推送失败:', JSON.stringify(result));
  }
}

main().catch(e => console.error('脚本错误:', e));

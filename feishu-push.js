#!/usr/bin/env node
/**
 * 考勤系统 · 每日出勤推送脚本
 * 推送前一天所有人出勤工时到飞书群（统计表格式）
 * 用法: node feishu-push.js [日期]
 */

const WEBHOOK_URL = 'https://open.feishu.cn/open-apis/bot/v2/hook/1a2c6a45-a483-41d7-b464-0adabdb98964';
const API_BASE = process.env.API_BASE || 'http://localhost:3000';

function getYesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d;
}

function pad(s, width) {
  s = String(s);
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
  const weekday = ['日','一','二','三','四','五','六'][targetDate.getDay()];
  const dateLabel = `${targetDate.getFullYear()}年${targetDate.getMonth()+1}月${targetDate.getDate()}日`;
  const dateISO = targetDate.getFullYear()+'-'+String(targetDate.getMonth()+1).padStart(2,'0')+'-'+String(targetDate.getDate()).padStart(2,'0');

  // 1. Fetch computed data from server (same logic as frontend)
  let data;
  try {
    const res = await fetch(`${API_BASE}/api/daily-summary?date=${dateISO}`);
    if (!res.ok) throw new Error('API error: '+res.status);
    data = await res.json();
  } catch(e) {
    console.error('获取数据失败:', e.message);
    process.exit(1);
  }

  const rows = data.employees || [];
  if (rows.length === 0) {
    const msg = `📋 ${dateLabel}（周${weekday}）\n无出勤数据`;
    await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msg_type: 'text', content: { text: msg } })
    });
    console.log('已推送：无数据');
    return;
  }

  const sectionOrder = ['模组','整机','2.5前加工','库房','测包','立库'];

  // Sort by section order then name
  rows.sort((a, b) => {
    const ia = sectionOrder.indexOf(a.section), ib = sectionOrder.indexOf(b.section);
    if (ia !== ib) return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
    return a.name.localeCompare(b.name, 'zh');
  });

  // Compute totals
  let grandN = 0, grandL = 0, grandO = 0, grandT = 0;
  const sectionTotals = {};
  for (const r of rows) {
    grandN += r.normal; grandL += r.lianban; grandO += r.overtime; grandT += r.monthly;
    if (!sectionTotals[r.section]) sectionTotals[r.section] = { n:0, l:0, o:0, t:0, m:0, count:0 };
    sectionTotals[r.section].n += r.normal;
    sectionTotals[r.section].l += r.lianban;
    sectionTotals[r.section].o += r.overtime;
    sectionTotals[r.section].t += r.total;
    sectionTotals[r.section].m += r.monthly;
    sectionTotals[r.section].count++;
  }

  // Build interactive card
  const elements = [
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**📋 ${dateLabel}（周${weekday}）出勤统计**\n\n**全组**：${rows.length}人 · 正常班 ${grandN.toFixed(1)}h · 加班 ${(grandL+grandO).toFixed(1)}h · **总工时 ${(grandN+grandL+grandO).toFixed(1)}h**`
      }
    },
    { tag: 'hr' }
  ];

  for (const sec of sectionOrder.concat(['未分组'])) {
    if (!sectionTotals[sec]) continue;
    const st = sectionTotals[sec];
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**【${sec}】**（${st.count}人）累计 ${st.m.toFixed(1)}h | 当天 ${st.t.toFixed(1)}h`
      }
    });
    const secRows = rows.filter(r => r.section === sec);
    for (const r of secRows) {
      const line = [
        pad(r.name, 8),
        pad(r.normal > 0 ? r.normal.toString() : '-', 5),
        pad(r.lianban > 0 ? r.lianban.toString() : '-', 5),
        pad(r.overtime > 0 ? r.overtime.toString() : '-', 5),
        pad(r.total.toString(), 5),
        r.monthly > 0 ? r.monthly.toFixed(1) : '-'
      ].join('|');
      elements.push({
        tag: 'div',
        text: { tag: 'lark_md', content: line }
      });
    }
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**小计**：${st.n.toFixed(1)}h | 连班 ${st.l.toFixed(1)}h | 加班 ${st.o.toFixed(1)}h | 当天 ${st.t.toFixed(1)}h | **当月 ${st.m.toFixed(1)}h**`
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

'use strict';

/*
 * 余料库存与复用预占页面（独立脚本，通过全局 layoutLatestResult
 * 与 app.js 共享最近一次裁切试排 / 排产 / 比选结果）。
 */

const OC$ = (id) => document.getElementById(id);

const OC_GRAIN_PAPER = {
  'along-width': '沿宽 ↔',
  'along-height': '沿高 ↕',
};
const OC_GRAIN_REQ = {
  any: '不限',
  'along-width': '沿自身宽',
  'along-height': '沿自身高',
};

const ocFmt = (n) => (Math.round(n * 100) / 100).toLocaleString('zh-CN');
const ocMoneyArea = (n) => (n == null ? '—' : ocFmt(n));

async function ocApi(path, options = {}) {
  const resp = await fetch(path, {
    method: options.method || 'GET',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error || '请求失败');
  return data;
}

function ocShowError(id, msg) {
  const box = OC$(id);
  if (!msg) { box.hidden = true; box.textContent = ''; return; }
  box.textContent = msg;
  box.hidden = false;
}

/* ---------------- 视图切换 ---------------- */

function ocShowView(name) {
  const layout = OC$('viewLayout');
  const offcuts = OC$('viewOffcuts');
  layout.hidden = name !== 'layout';
  offcuts.hidden = name !== 'offcuts';
  OC$('navLayout').classList.toggle('active', name === 'layout');
  OC$('navOffcuts').classList.toggle('active', name === 'offcuts');
  if (name === 'offcuts') ocRefresh();
}

/* ---------------- 当前排料结果登记 ---------------- */

async function ocIngestCurrent() {
  const btn = OC$('ingestBtn');
  const result = window.layoutLatestResult;
  if (!result) {
    ocShowError('ingestMsg', '当前没有可登记的排料结果，请先生成裁切 / 排产方案。');
    return;
  }
  const batchId = OC$('ingestBatchId').value.trim();
  btn.disabled = true;
  ocShowError('ingestMsg', '');
  try {
    const data = await ocApi('/api/offcuts/ingest', {
      method: 'POST',
      body: { layout: result, ...(batchId ? { batchId } : {}) },
    });
    const shapeLabel = {
      single: '单张 / 比选', batch: '批量排产', cost: '多纸型成本',
    }[data.shape] || data.shape;
    ocShowError('ingestMsg', '');
    const box = OC$('ingestMsg');
    box.className = 'form-ok';
    box.textContent = `✔ 已从${shapeLabel}结果登记 ${data.ingested} 块余料（批次 ${data.batchId}）`
      + `${data.skipped ? `，跳过 ${data.skipped} 块同批次重复余料` : ''}。`
      + '可切换至「余料库存与复用」查看。';
    box.hidden = false;
    ocUpdateNavBadge(data.summary);
  } catch (e) {
    ocShowError('ingestMsg', e.message);
  } finally {
    btn.disabled = false;
  }
}

/* ---------------- 手工录入 ---------------- */

async function ocCreate() {
  const width = Number(OC$('ocW').value);
  const height = Number(OC$('ocH').value);
  if (!(width > 0) || !(height > 0)) {
    ocShowError('ocCreateMsg', '余料宽高必须为正数。');
    return;
  }
  const kerf = Number(OC$('ocKerf').value);
  if (!(kerf >= 0)) {
    ocShowError('ocCreateMsg', '刀缝宽度必须是非负数。');
    return;
  }
  const body = {
    paperName: OC$('ocName').value.trim(),
    width, height,
    paperGrain: OC$('ocGrain').value,
    kerf,
    orderNo: OC$('ocOrderNo').value.trim() || undefined,
    batchId: OC$('ocBatchId').value.trim() || undefined,
  };
  OC$('ocCreate').disabled = true;
  try {
    const data = await ocApi('/api/offcuts', { method: 'POST', body });
    const box = OC$('ocCreateMsg');
    box.className = 'form-ok';
    box.textContent = `✔ 已录入余料 ${data.offcut.id}（${ocFmt(width)}×${ocFmt(height)} mm）。`;
    box.hidden = false;
    ['ocW', 'ocH', 'ocOrderNo'].forEach((id) => { OC$(id).value = ''; });
    ocUpdateNavBadge(data.summary);
  } catch (e) {
    ocShowError('ocCreateMsg', e.message);
  } finally {
    OC$('ocCreate').disabled = false;
  }
}

/* ---------------- 查询 / 列表 ---------------- */

async function ocRefresh() {
  const params = new URLSearchParams();
  const status = document.querySelector('input[name="ocStatus"]:checked');
  if (status && status.value !== 'all') params.set('status', status.value);
  const minW = OC$('qMinW').value;
  const minH = OC$('qMinH').value;
  if (minW) params.set('minW', minW);
  if (minH) params.set('minH', minH);
  const grain = OC$('qGrain').value;
  if (grain) params.set('grain', grain);
  const kw = OC$('qKw').value.trim();
  if (kw) params.set('q', kw);

  let data;
  try {
    data = await ocApi(`/api/offcuts?${params.toString()}`);
  } catch (e) {
    OC$('ocListWrap').innerHTML = `<div class="form-error">${e.message}</div>`;
    return;
  }
  ocRenderSummary(data.summary);
  ocRenderList(data.offcuts);
  ocRenderAllocations(data.offcuts);
  ocUpdateNavBadge(data.summary);
}

function ocRenderSummary(s) {
  OC$('ocSummary').innerHTML = `
    <div class="stat">库存总数：<b>${s.total}</b> 块</div>
    <div class="stat">可用：<b class="oc-num-avail">${s.available}</b> 块 / ${ocFmt(s.availableArea)} mm²</div>
    <div class="stat">已预占：<b class="oc-num-reserved">${s.reserved}</b> 块 / ${ocFmt(s.reservedArea)} mm²</div>
    <div class="stat">库存总面积：<b>${ocFmt(s.totalArea)}</b> mm²</div>
  `;
}

function ocSourceText(o) {
  const src = o.source || {};
  const typeLabel = {
    single: '单张/比选', batch: '批量', cost: '多纸型', manual: '手工',
  }[src.type] || src.type || '—';
  const sheet = src.sheetIndex ? ` · 第${src.sheetIndex}张` : '';
  const round = src.round ? ` · 轮次${src.round}` : '';
  return `${typeLabel}${sheet}${round} · 批次 ${src.batchId || '—'}`;
}

function ocRenderList(list) {
  const wrap = OC$('ocListWrap');
  if (!list.length) {
    wrap.innerHTML = '<div class="placeholder">没有符合条件的余料。可在「裁切试排」页把排料结果的余料登记入库，或在左侧手工录入。</div>';
    return;
  }
  const rows = list.map((o) => {
    const reserved = o.status === 'reserved';
    const r = o.reservation || null;
    return `
      <tr class="${reserved ? 'oc-row-reserved' : 'oc-row-available'}">
        <td><b>${o.id}</b></td>
        <td>${o.paperName ? o.paperName : '<span class="ord-null">未命名</span>'}</td>
        <td class="num">${ocFmt(o.w)}×${ocFmt(o.h)}</td>
        <td class="num">${ocFmt(o.area)}</td>
        <td class="num">${ocFmt(o.paperWidth)}×${ocFmt(o.paperHeight)}</td>
        <td>${OC_GRAIN_PAPER[o.paperGrain] || o.paperGrain}</td>
        <td class="num">${ocFmt(o.kerf)}</td>
        <td class="num">(${ocFmt(o.x)}, ${ocFmt(o.y)})</td>
        <td class="oc-source">${ocSourceText(o)}${o.source.orderNo ? ` · 订单 ${o.source.orderNo}` : ''}</td>
        <td>${reserved
          ? `<span class="oc-status oc-status-reserved">已预占</span>
             <div class="oc-res-info">单号 <b>${r.allocationId}</b><br />
               成品 ${ocFmt(r.product.width)}×${ocFmt(r.product.height)}
               （${OC_GRAIN_REQ[r.product.grain] || r.product.grain}${r.rotated ? ' · 旋转90°' : ''}）
               ${r.ref ? `<br />单据 ${r.ref}` : ''}</div>`
          : '<span class="oc-status oc-status-available">可用</span>'}</td>
      </tr>`;
  }).join('');
  wrap.innerHTML = `
    <table class="oc-table">
      <thead><tr>
        <th>余料编号</th><th>纸型</th><th class="num">余料 宽×高 (mm)</th>
        <th class="num">面积 (mm²)</th><th class="num">来源纸面 宽×高</th>
        <th>纸张纹向</th><th class="num">刀缝 (mm)</th><th class="num">纸面坐标</th>
        <th>来源（类型 / 张次 / 批次 / 订单）</th><th>状态 / 预占信息</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

/* ---------------- 预占单分组与释放 ---------------- */

function ocRenderAllocations(list) {
  const box = OC$('ocAllocations');
  const reserved = list.filter((o) => o.status === 'reserved');
  if (!reserved.length) {
    box.innerHTML = '';
    return;
  }
  const groups = new Map();
  for (const o of reserved) {
    const aid = o.reservation.allocationId;
    if (!groups.has(aid)) groups.set(aid, []);
    groups.get(aid).push(o);
  }
  const blocks = [...groups.entries()].map(([aid, items]) => {
    const r0 = items[0].reservation;
    const chips = items.map((o) => `
      <span class="oc-chip" title="${ocSourceText(o)}">
        ${o.id} · ${ocFmt(o.w)}×${ocFmt(o.h)}${o.reservation.rotated ? ' ⟳' : ''}
      </span>`).join('');
    return `
      <div class="oc-alloc-group">
        <div class="oc-alloc-head">
          <span>预占单 <b>${aid}</b></span>
          <span>成品 <b>${ocFmt(r0.product.width)}×${ocFmt(r0.product.height)}</b> mm
            （${OC_GRAIN_REQ[r0.product.grain] || r0.product.grain}）</span>
          <span>占用 <b>${items.length}</b> 块</span>
          ${r0.ref ? `<span>单据：<b>${r0.ref}</b></span>` : ''}
          <span class="oc-alloc-time">${new Date(r0.createdAt).toLocaleString('zh-CN')}</span>
          <button type="button" class="btn btn-ghost oc-release" data-allocation="${aid}">释放该预占</button>
        </div>
        <div class="oc-chips">${chips}</div>
      </div>`;
  }).join('');
  box.innerHTML = `<h3>已预占余料（按预占单分组）</h3>${blocks}`;
  box.querySelectorAll('.oc-release').forEach((btn) =>
    btn.addEventListener('click', () => ocRelease({ allocationIds: [btn.dataset.allocation] })));
}

async function ocRelease(body) {
  try {
    await ocApi('/api/offcuts/release', { method: 'POST', body });
    await ocRefresh();
  } catch (e) {
    window.alert(e.message);
  }
}

/* ---------------- 复用预占 ---------------- */

async function ocAllocate() {
  const width = Number(OC$('alW').value);
  const height = Number(OC$('alH').value);
  const quantity = Number(OC$('alQty').value);
  if (!(width > 0) || !(height > 0)) {
    ocShowError('alMsg', '成品宽高必须为正数。');
    return;
  }
  if (!(Number.isInteger(quantity) && quantity >= 1)) {
    ocShowError('alMsg', '预占数量必须是正整数。');
    return;
  }
  const payload = {
    width, height, quantity,
    grain: OC$('alGrain').value,
    ref: OC$('alRef').value.trim() || undefined,
  };
  OC$('alCreate').disabled = true;
  ocShowError('alMsg', '');
  try {
    const data = await ocApi('/api/offcuts/allocate', { method: 'POST', body: payload });
    ocShowAllocationResult(data);
    ocUpdateNavBadge(data.summary);
    if (data.allocated) await ocRefresh();
  } catch (e) {
    ocShowError('alMsg', e.message);
  } finally {
    OC$('alCreate').disabled = false;
  }
}

function ocShowAllocationResult(data) {
  const box = OC$('alMsg');
  box.className = data.allocated ? 'form-ok' : 'form-error';
  if (data.allocated) {
    box.innerHTML = `✔ 已原子预占 <b>${data.reservedCount}</b> 块余料，预占单号
      <b>${data.allocationId}</b>${data.request.ref ? `（单据 ${data.request.ref}）` : ''}；
      可行候选共 ${data.feasibleCount} 块。`;
  } else {
    const cand = data.candidates.length
      ? `当前可行余料仅 <b>${data.feasibleCount}</b> 块：${data.candidates
        .map((c) => `${c.paperName || c.offcutId}（${ocFmt(c.width)}×${ocFmt(c.height)}${c.rotated ? '·旋转' : ''}）`)
        .join('、')}。`
      : '当前没有任何可行余料。';
    box.innerHTML = `⚠ 库存不足：需求 <b>${data.request.quantity}</b> 块，可行仅
      <b>${data.feasibleCount}</b> 块，<b>缺口 ${data.shortfall} 块</b>。
      未扣减任何已占用记录。${cand}<br />
      受阻统计：尺寸不足 ${data.blockedBySize} 块、纹向受限 ${data.blockedByGrain} 块、
      已被预占 ${data.unavailableReserved} 块。`;
  }
  box.hidden = false;
}

/* ---------------- 导航角标 ---------------- */

function ocUpdateNavBadge(summary) {
  if (!summary) return;
  const badge = OC$('navOffcutBadge');
  if (summary.total > 0) {
    badge.textContent = summary.total;
    badge.hidden = false;
  } else {
    badge.hidden = true;
  }
}

/* ---------------- 事件绑定 ---------------- */

OC$('navLayout').addEventListener('click', () => ocShowView('layout'));
OC$('navOffcuts').addEventListener('click', () => ocShowView('offcuts'));
OC$('ingestBtn').addEventListener('click', ocIngestCurrent);
OC$('ocCreate').addEventListener('click', ocCreate);
OC$('alCreate').addEventListener('click', ocAllocate);
OC$('ocRefresh').addEventListener('click', ocRefresh);
document.querySelectorAll('input[name="ocStatus"]').forEach((r) =>
  r.addEventListener('change', ocRefresh));
['qMinW', 'qMinH'].forEach((id) =>
  OC$(id).addEventListener('change', ocRefresh));
OC$('qGrain').addEventListener('change', ocRefresh);
let ocKwTimer = null;
OC$('qKw').addEventListener('input', () => {
  clearTimeout(ocKwTimer);
  ocKwTimer = setTimeout(ocRefresh, 300);
});

window.ocRefreshOffcuts = ocRefresh;

// 页面初始加载库存角标（服务重启后库存为空则不显示）
(async function initBadge() {
  try {
    const data = await ocApi('/api/offcuts');
    ocUpdateNavBadge(data.summary);
  } catch (_) { /* 服务暂不可用时静默 */ }
})();

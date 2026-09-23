'use strict';

/* 余料库存与复用预占页（原生 JS，风格与主页面 app.js 一致） */

const $ = (id) => document.getElementById(id);

const GRAIN_LABEL = { 'along-width': '沿宽 ↔', 'along-height': '沿高 ↕' };
const SOURCE_LABEL = {
  manual: '手工录入',
  single: '单张试排',
  batch: '批量排产',
  cost: '成本排产',
};

function fmt(n) {
  return (Math.round(n * 100) / 100).toLocaleString('zh-CN');
}

function grainLabel(g) {
  return GRAIN_LABEL[g] || g;
}

function showError(id, msg) {
  const box = $(id);
  if (!msg) {
    box.hidden = true;
    box.textContent = '';
    return;
  }
  box.textContent = msg;
  box.hidden = false;
}

async function api(method, url, body) {
  const resp = await fetch(url, {
    method,
    headers: body != null ? { 'Content-Type': 'application/json' } : {},
    body: body != null ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await resp.json(); } catch (_) { data = {}; }
  if (!resp.ok) {
    const err = new Error(data.error || `请求失败（HTTP ${resp.status}）`);
    err.status = resp.status;
    err.data = data;
    throw err;
  }
  return data;
}

/* ---------------- 手工录入行 ---------------- */

function addOcRow(paperName = '', pw = '', ph = '', grain = 'along-width', kerf = '0',
  x = '0', y = '0', w = '', h = '') {
  const row = document.createElement('div');
  row.className = 'oc-row';
  row.innerHTML = `
    <input type="text" class="oc-name" placeholder="纸型名称" value="${paperName}" maxlength="64" />
    <input type="number" class="oc-pw" min="0" step="0.1" placeholder="纸宽" value="${pw}" />
    <input type="number" class="oc-ph" min="0" step="0.1" placeholder="纸高" value="${ph}" />
    <select class="oc-grain">
      <option value="along-width"${grain === 'along-width' ? ' selected' : ''}>沿宽</option>
      <option value="along-height"${grain === 'along-height' ? ' selected' : ''}>沿高</option>
    </select>
    <input type="number" class="oc-kerf" min="0" step="0.1" placeholder="刀缝" value="${kerf}" />
    <input type="number" class="oc-x" min="0" step="0.1" placeholder="x" value="${x}" />
    <input type="number" class="oc-y" min="0" step="0.1" placeholder="y" value="${y}" />
    <input type="number" class="oc-w" min="0" step="0.1" placeholder="余料宽" value="${w}" />
    <input type="number" class="oc-h" min="0" step="0.1" placeholder="余料高" value="${h}" />
    <button type="button" class="del" title="删除该行">✕</button>
  `;
  row.querySelector('.del').addEventListener('click', () => {
    if ($('ocRows').children.length > 1) row.remove();
  });
  $('ocRows').appendChild(row);
}

function readOcRows() {
  const out = [];
  [...$('ocRows').querySelectorAll('.oc-row')].forEach((row, i) => {
    const paperWidth = Number(row.querySelector('.oc-pw').value);
    const paperHeight = Number(row.querySelector('.oc-ph').value);
    const width = Number(row.querySelector('.oc-w').value);
    const height = Number(row.querySelector('.oc-h').value);
    const nameRaw = row.querySelector('.oc-name').value;
    const kerfRaw = row.querySelector('.oc-kerf').value;
    const xRaw = row.querySelector('.oc-x').value;
    const yRaw = row.querySelector('.oc-y').value;
    const blank = !nameRaw.trim() && !row.querySelector('.oc-pw').value && !row.querySelector('.oc-ph').value
      && !row.querySelector('.oc-w').value && !row.querySelector('.oc-h').value;
    if (blank) return;
    const pos = i + 1;
    if (!(paperWidth > 0) || !(paperHeight > 0) || !(width > 0) || !(height > 0)) {
      throw new Error(`第 ${pos} 行：纸面宽高与余料宽高均须为正数。`);
    }
    const rec = {
      paperName: nameRaw.trim(),
      paperWidth, paperHeight,
      grain: row.querySelector('.oc-grain').value,
      width, height,
    };
    if (kerfRaw !== '') {
      const kerf = Number(kerfRaw);
      if (!(kerf >= 0)) throw new Error(`第 ${pos} 行：刀缝须为非负数。`);
      rec.kerf = kerf;
    }
    if (xRaw !== '') {
      const x = Number(xRaw);
      if (!(x >= 0)) throw new Error(`第 ${pos} 行：x 坐标须为非负数。`);
      rec.x = x;
    }
    if (yRaw !== '') {
      const y = Number(yRaw);
      if (!(y >= 0)) throw new Error(`第 ${pos} 行：y 坐标须为非负数。`);
      rec.y = y;
    }
    out.push(rec);
  });
  return out;
}

/* ---------------- 入库 ---------------- */

async function doIngestLayout() {
  showError('ingestMsg');
  const raw = $('ingestJson').value.trim();
  if (!raw) {
    showError('ingestMsg', '请粘贴排料结果 JSON。');
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    showError('ingestMsg', 'JSON 解析失败，请检查格式。');
    return;
  }
  const batch = $('ingestBatch').value.trim();
  const payload = { ...parsed };
  if (batch) payload.batchRef = batch;
  $('ingestBtn').disabled = true;
  try {
    const r = await api('POST', '/api/offcuts/ingest', payload);
    showError('ingestMsg');
    $('ingestMsg').hidden = false;
    $('ingestMsg').className = 'badge-ok';
    $('ingestMsg').textContent =
      `✔ 已入库 ${r.createdCount} 条余料（来源：${SOURCE_LABEL[r.sourceType] || r.sourceType}，批次 ${r.batchRef}）。`;
    $('ingestJson').value = '';
    $('ingestBatch').value = '';
    refresh();
  } catch (e) {
    $('ingestMsg').className = 'form-error';
    showError('ingestMsg', e.message);
  } finally {
    $('ingestBtn').disabled = false;
  }
}

async function doManualIngest() {
  showError('manualMsg');
  let offcuts;
  try {
    offcuts = readOcRows();
  } catch (e) {
    showError('manualMsg', e.message);
    return;
  }
  if (!offcuts.length) {
    showError('manualMsg', '请至少录入一条余料。');
    return;
  }
  const payload = { offcuts };
  const batch = $('manualBatch').value.trim();
  if (batch) payload.batchRef = batch;
  $('manualIngestBtn').disabled = true;
  try {
    const r = await api('POST', '/api/offcuts/ingest', payload);
    showError('manualMsg');
    $('manualMsg').hidden = false;
    $('manualMsg').className = 'badge-ok';
    $('manualMsg').textContent =
      `✔ 已手工入库 ${r.createdCount} 条余料（批次 ${r.batchRef}）。`;
    $('ocRows').innerHTML = '';
    addOcRow();
    $('manualBatch').value = '';
    refresh();
  } catch (e) {
    $('manualMsg').className = 'form-error';
    showError('manualMsg', e.message);
  } finally {
    $('manualIngestBtn').disabled = false;
  }
}

/* ---------------- 预占 ---------------- */

async function doAllocate() {
  showError('allocMsg');
  $('allocResult').hidden = true;
  $('allocResult').innerHTML = '';
  const width = Number($('allocW').value);
  const height = Number($('allocH').value);
  const quantity = Number($('allocQty').value);
  if (!(width > 0) || !(height > 0)) {
    showError('allocMsg', '成品宽高须为正数。');
    return;
  }
  if (!(Number.isInteger(quantity) && quantity >= 1)) {
    showError('allocMsg', '数量须为正整数。');
    return;
  }
  const payload = { width, height, quantity, grain: $('allocGrain').value };
  const note = $('allocNote').value.trim();
  if (note) payload.note = note;

  $('allocBtn').disabled = true;
  try {
    const r = await api('POST', '/api/offcuts/allocate', payload);
    const items = r.items.map((it) => {
      const o = it.offcut;
      return `
        <tr>
          <td><b>${o.id}</b></td>
          <td>${o.paperName ? o.paperName : '<span class="ord-null">未命名</span>'}</td>
          <td class="num">${fmt(o.width)}×${fmt(o.height)}</td>
          <td>${grainLabel(o.grain)}</td>
          <td>${it.rotated ? '⟳90° 旋转' : '不旋转'}</td>
          <td class="num">${fmt(it.placedWidth)}×${fmt(it.placedHeight)}</td>
          <td class="num">${fmt(it.leftoverArea)}</td>
          <td>${o.source.batchRef}</td>
        </tr>`;
    }).join('');
    $('allocResult').innerHTML = `
      <div class="badge-ok">✔ 预占成功：预占单 <b>${r.reservationId}</b>，共 ${r.allocatedCount} 件，占用 ${r.allocatedCount} 条余料。</div>
      <table>
        <thead><tr>
          <th>余料号</th><th>纸型</th><th class="num">余料 宽×高</th><th>纹向</th>
          <th>采用朝向</th><th class="num">占位 宽×高</th><th class="num">剩余面积 mm²</th><th>来源批次</th>
        </tr></thead>
        <tbody>${items}</tbody>
      </table>`;
    $('allocResult').hidden = false;
    refresh();
  } catch (e) {
    if (e.status === 409 && e.data && e.data.shortage) {
      const s = e.data.shortage;
      const req = s.requested;
      $('allocResult').innerHTML = `
        <div class="badge-bad">✖ ${e.message}</div>
        <table class="shortage-table">
          <tbody>
            <tr><th>需求成品</th><td>${fmt(req.width)}×${fmt(req.height)} mm · 纹向${req.grain === 'any' ? '不限' : grainReqText(req.grain)} · ${req.quantity} 件</td></tr>
            <tr><th>可满足</th><td><b>${s.fulfillable}</b> 件</td></tr>
            <tr><th>缺口</th><td class="badge-bad"><b>${s.gap}</b> 件（${s.reason === 'no-feasible-offcut' ? '无可行余料（尺寸或纹向不满足）' : '可用库存不足'}）</td></tr>
            <tr><th>原子性</th><td>本次未预占、未扣减任何余料记录</td></tr>
          </tbody>
        </table>`;
      $('allocResult').hidden = false;
    } else {
      showError('allocMsg', e.message);
    }
  } finally {
    $('allocBtn').disabled = false;
  }
}

function grainReqText(g) {
  return g === 'along-width' ? '沿自身宽' : g === 'along-height' ? '沿自身高' : '不限';
}

/* ---------------- 库存查询 / 展示 ---------------- */

function currentFilter() {
  const p = new URLSearchParams();
  p.set('status', $('fStatus').value);
  if ($('fGrain').value) p.set('grain', $('fGrain').value);
  if ($('fSource').value) p.set('sourceType', $('fSource').value);
  const batch = $('fBatch').value.trim();
  if (batch) p.set('batchRef', batch);
  return p;
}

async function refresh() {
  let data;
  try {
    data = await api('GET', `/api/offcuts?${currentFilter().toString()}`);
  } catch (e) {
    return;
  }
  renderSummary(data.summary);
  renderTable(data.offcuts);
  renderAllocations(data.allocations);
}

function renderSummary(s) {
  $('ocSummary').innerHTML = `
    <div class="stat">记录总数：<b>${s.total}</b> 条</div>
    <div class="stat">可用：<b>${s.available}</b> 条 / ${fmt(s.availableArea)} mm²</div>
    <div class="stat">已预占：<b>${s.reserved}</b> 条 / ${fmt(s.reservedArea)} mm²</div>
    <div class="stat">总面积：<b>${fmt(s.totalArea)}</b> mm²</div>
  `;
}

function sourceCell(o) {
  const parts = [SOURCE_LABEL[o.source.type] || o.source.type];
  if (o.source.paperName) parts.push(o.source.paperName);
  if (o.source.round != null) parts.push(`第${o.source.round}轮`);
  else if (o.source.sheetIndex != null) parts.push(`第${o.source.sheetIndex}张`);
  if (o.source.orderNo) parts.push(`订单:${o.source.orderNo}`);
  return parts.join(' · ');
}

function renderTable(offcuts) {
  if (!offcuts.length) {
    $('ocTableWrap').innerHTML = '<p class="placeholder">没有符合条件的余料记录。</p>';
    return;
  }
  const rows = offcuts.map((o) => {
    const reserved = o.status === 'reserved';
    const res = o.reservation;
    return `
      <tr class="${reserved ? 'is-reserved' : ''}">
        <td><b>${o.id}</b></td>
        <td><span class="status-pill ${reserved ? 'pill-reserved' : 'pill-available'}">${reserved ? '已预占' : '可用'}</span></td>
        <td>${o.paperName ? o.paperName : '<span class="ord-null">未命名</span>'}</td>
        <td class="num">${fmt(o.paperWidth)}×${fmt(o.paperHeight)}</td>
        <td>${grainLabel(o.grain)}</td>
        <td class="num">${fmt(o.kerf)}</td>
        <td class="num">(${fmt(o.x)}, ${fmt(o.y)})</td>
        <td class="num"><b>${fmt(o.width)}×${fmt(o.height)}</b></td>
        <td class="num">${fmt(o.area)}</td>
        <td class="num">${o.source.batchRef}</td>
        <td>${sourceCell(o)}</td>
        <td>${res ? `${res.reservationId}（${grainReqText(res.grain)} ${fmt(res.width)}×${fmt(res.height)}${res.rotated ? ' ⟳90°' : ''} · 第${res.seq}件）` : '—'}</td>
      </tr>`;
  }).join('');
  $('ocTableWrap').innerHTML = `
    <table class="oc-table">
      <thead><tr>
        <th>余料号</th><th>状态</th><th>纸型</th><th class="num">纸面 宽×高</th><th>纹向</th>
        <th class="num">刀缝</th><th class="num">坐标</th><th class="num">余料 宽×高</th><th class="num">面积 mm²</th>
        <th class="num">来源批次</th><th>来源</th><th>预占信息</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function renderAllocations(allocations) {
  if (!allocations.length) {
    $('ocAllocations').innerHTML = '<p class="placeholder">暂无预占单。</p>';
    return;
  }
  const blocks = allocations.map((a) => {
    const req = a.request;
    const ids = a.items.map((it) =>
      `<span class="oc-chip${it.rotated ? ' rotated' : ''}" title="${it.rotated ? '旋转 90° 放置' : '不旋转放置'}，剩余面积 ${fmt(it.leftoverArea)} mm²">${it.offcutId}${it.rotated ? ' ⟳' : ''}</span>`
    ).join(' ');
    return `
      <div class="alloc-card">
        <div class="alloc-card-head">
          <b>${a.reservationId}</b>
          <span>${grainReqText(req.grain)} ${fmt(req.width)}×${fmt(req.height)} mm × ${a.allocatedCount} 件</span>
          <span class="ord-null">${new Date(a.createdAt).toLocaleString('zh-CN')}</span>
          <button type="button" class="btn btn-ghost btn-release" data-id="${a.reservationId}">释放预占</button>
        </div>
        ${a.note ? `<div class="alloc-note">备注：${a.note}</div>` : ''}
        <div class="alloc-chips">${ids}</div>
      </div>`;
  }).join('');
  $('ocAllocations').innerHTML = blocks;
  $('ocAllocations').querySelectorAll('.btn-release').forEach((btn) =>
    btn.addEventListener('click', () => doRelease(btn.dataset.id))
  );
}

async function doRelease(reservationId) {
  if (!window.confirm(`确认释放预占单 ${reservationId}？其名下余料将全部恢复可用。`)) return;
  try {
    await api('POST', `/api/offcuts/release/${encodeURIComponent(reservationId)}`);
    refresh();
  } catch (e) {
    window.alert(e.message);
  }
}

/* ---------------- 由主页面携带排料结果跳转 ---------------- */

function loadIncomingLayout() {
  let payload = null;
  try {
    const raw = sessionStorage.getItem('sheetLayout.offcutIngest.v1');
    if (raw) {
      payload = JSON.parse(raw);
      sessionStorage.removeItem('sheetLayout.offcutIngest.v1');
    }
  } catch (_) { payload = null; }
  if (!payload) return;
  $('ingestBatch').value = payload.batchRef || '';
  $('ingestJson').value = JSON.stringify(payload.body);
  $('ingestJson').focus();
}

/* ---------------- 绑定 ---------------- */

$('ocAddRow').addEventListener('click', () => addOcRow());
$('ingestBtn').addEventListener('click', doIngestLayout);
$('ingestClear').addEventListener('click', () => {
  $('ingestJson').value = '';
  $('ingestBatch').value = '';
  showError('ingestMsg');
});
$('manualIngestBtn').addEventListener('click', doManualIngest);
$('allocBtn').addEventListener('click', doAllocate);
$('refreshBtn').addEventListener('click', refresh);
$('filterBtn').addEventListener('click', refresh);
['fStatus', 'fGrain', 'fSource'].forEach((id) =>
  $(id).addEventListener('change', refresh)
);

addOcRow();
loadIncomingLayout();
refresh();

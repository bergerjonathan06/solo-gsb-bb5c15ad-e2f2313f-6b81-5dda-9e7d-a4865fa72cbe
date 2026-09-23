'use strict';

/**
 * 余料库存与复用预占（offcut inventory & allocation）
 *
 * 把排料结果中每张纸 layout.frees 的自由矩形标准化为可追踪的余料记录
 * （保留纸型宽高/名称、纸张纹向、刀缝、纸面坐标、尺寸与来源批次），
 * 支持：
 *  - 余料录入（手工录入 / 从单张、批量、多纸型成本、方案比选结果批量登记）；
 *  - 余料查询（可用 / 已预占、最小尺寸、关键字）；
 *  - POST /api/offcuts/allocate 原子复用预占：给定成品宽高、数量与纹向要求，
 *    按旋转 / 纹向可行性与“占用后剩余面积最小”确定性选取余料；
 *    一次请求必须预占足量余料，无法满足时不改动任何记录并返回缺口明细；
 *  - 释放预占（按预占单号 / 余料编号）。
 *
 * 库存保存在进程内存中（与本项目“无外部服务或数据库”一致），
 * 重启服务后清空；提供 _resetStore() 仅供测试使用。
 */

const {
  normalizePaperGrain,
  normalizeProductGrain,
  grainAllows,
} = require('./packer');

const EPS = 1e-6;

const round3 = (v) => Math.round(v * 1000) / 1000;

/* ---------------- 内存存储 ---------------- */

const store = {
  seq: 0, // 余料记录序号
  allocSeq: 0, // 预占单号序号
  batchSeq: 0, // 自动来源批次序号
  offcuts: new Map(), // id → 记录
};

/** 仅供测试：清空库存与全部序号 */
function _resetStore() {
  store.seq = 0;
  store.allocSeq = 0;
  store.batchSeq = 0;
  store.offcuts.clear();
}

function newOffcutId() {
  store.seq += 1;
  return `OC-${String(store.seq).padStart(6, '0')}`;
}

function newAllocationId() {
  store.allocSeq += 1;
  return `AL-${String(store.allocSeq).padStart(6, '0')}`;
}

function newBatchId() {
  store.batchSeq += 1;
  return `BATCH-${String(store.batchSeq).padStart(6, '0')}`;
}

/* ---------------- 输入校验 ---------------- */

function positiveNumber(value, subject) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${subject}必须为正数`);
  return n;
}

function nonNegativeNumber(value, subject) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${subject}必须是非负数字`);
  return n;
}

function positiveInteger(value, subject, max = 100000) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${subject}必须是正整数`);
  if (n > max) throw new Error(`${subject}不能超过 ${max}`);
  return n;
}

function normalizeRef(value, subject = '关联单据') {
  if (value == null || value === '') return null;
  const s = String(value).trim();
  if (!s) return null;
  if (s.length > 128) throw new Error(`${subject}长度不能超过 128 个字符`);
  return s;
}

function normalizeBatchId(value) {
  if (value == null || value === '') return newBatchId();
  const s = String(value).trim();
  if (!s) return newBatchId();
  if (s.length > 128) throw new Error('来源批次号长度不能超过 128 个字符');
  return s;
}

/** 规范化单条余料的纸型 / 几何字段（手工录入与结果登记共用） */
function normalizeOffcutShape(raw, pos) {
  const who = pos ? `第 ${pos} 条余料的` : '';
  const width = positiveNumber(raw.width, `${who}宽度`);
  const height = positiveNumber(raw.height, `${who}高度`);
  const kerf = raw.kerf == null || raw.kerf === '' ? 0 : nonNegativeNumber(raw.kerf, `${who}刀缝宽度`);
  const paperGrain = normalizePaperGrain(raw.paperGrain || raw.grain, '余料纸张');
  return { width, height, kerf, paperGrain };
}

/* ---------------- 记录构造 ---------------- */

/**
 * 把一个自由矩形标准化为余料记录。
 * @param {object} free { x, y, w, h }（layout.frees 元素）
 * @param {object} paper { width, height, kerf, grain }（layout.paper）
 * @param {object} meta { type, batchId, sheetIndex, round, paperId, paperName, orderNo }
 */
function buildRecordFromFree(free, paper, meta) {
  const x = Number(free.x) || 0;
  const y = Number(free.y) || 0;
  const w = positiveNumber(free.w, '余料宽度');
  const h = positiveNumber(free.h, '余料高度');
  if (x < -EPS || y < -EPS) throw new Error('余料坐标不能为负');
  if (x + w > paper.width + EPS || y + h > paper.height + EPS) {
    throw new Error('余料矩形超出纸面范围');
  }
  const id = newOffcutId();
  return {
    id,
    paperName: meta.paperName || null,
    paperWidth: round3(paper.width),
    paperHeight: round3(paper.height),
    paperGrain: paper.grain,
    kerf: round3(paper.kerf),
    x: round3(x),
    y: round3(y),
    w: round3(w),
    h: round3(h),
    area: round3(w * h),
    status: 'available', // available（可用） | reserved（已预占）
    source: {
      type: meta.type, // single | batch | cost | manual
      batchId: meta.batchId || null,
      sheetIndex: meta.sheetIndex == null ? null : meta.sheetIndex,
      round: meta.round == null ? null : meta.round,
      paperId: meta.paperId || null,
      orderNo: meta.orderNo == null ? null : meta.orderNo,
      ingestedAt: new Date().toISOString(),
    },
    reservation: null,
  };
}

/* ---------------- 从排料结果登记 ---------------- */

/** 从单张 layout() 结果提取余料记录 */
function offcutsFromLayout(layoutResult, meta) {
  if (!layoutResult || typeof layoutResult !== 'object' || !layoutResult.paper) {
    throw new Error('缺少有效的单张排料结果（需包含 paper 与 frees）');
  }
  const paper = {
    width: positiveNumber(layoutResult.paper.width, '纸张宽度'),
    height: positiveNumber(layoutResult.paper.height, '纸张高度'),
    kerf: layoutResult.paper.kerf == null ? 0 : nonNegativeNumber(layoutResult.paper.kerf, '刀缝宽度'),
    grain: normalizePaperGrain(layoutResult.paper.grain, '纸张'),
  };
  const frees = Array.isArray(layoutResult.frees) ? layoutResult.frees : [];
  return frees.map((free) => buildRecordFromFree(free, paper, meta));
}

/**
 * 识别排料结果形态：
 *  - sheets[].layout 存在 → cost（多纸型成本排产）
 *  - sheets 存在         → batch（批量排产）
 *  - candidates 存在     → compare（方案比选，登记当前/最佳候选）
 *  - paper + frees       → single（单张排样）
 */
function detectResultShape(raw) {
  if (Array.isArray(raw.sheets)) {
    return raw.sheets.length && raw.sheets[0] && raw.sheets[0].layout ? 'cost' : 'batch';
  }
  if (Array.isArray(raw.candidates)) return 'compare';
  if (raw.paper && Array.isArray(raw.frees)) return 'single';
  return null;
}

/**
 * 从排料结果批量登记余料。接受请求体中的 layout / result / data 字段，
 * 也可直接把单张 / 批量 / 成本 / 比选返回作为请求体。
 * 同一来源批次（batchId）下纸型、刀缝、坐标、尺寸完全相同的余料不重复登记。
 *
 * @returns {{ batchId, ingested:number, skipped:number, offcutIds:string[] }}
 */
function ingestOffcuts(input) {
  if (!input || typeof input !== 'object') throw new Error('缺少排料结果');
  const raw = input.layout || input.result || input.data || input;
  const shape = detectResultShape(raw);
  if (!shape) {
    throw new Error('无法识别排料结果（需为单张 layout.frees、批量/成本 sheets 或方案比选 candidates）');
  }
  const batchId = normalizeBatchId(input.batchId);

  const plans = []; // [{ layout, meta }]
  if (shape === 'single') {
    plans.push({
      layout: raw,
      meta: { type: 'single', batchId, sheetIndex: 1 },
    });
  } else if (shape === 'compare') {
    // 方案比选：登记中选方案；全部排不进（best 为 null）时登记首个候选
    const chosen = raw.best
      ? raw.best.layout
      : (raw.candidates[0] && raw.candidates[0].layout);
    if (!chosen) throw new Error('方案比选结果中没有可登记的布局');
    plans.push({
      layout: chosen,
      meta: { type: 'single', batchId, sheetIndex: 1 },
    });
  } else if (shape === 'batch') {
    raw.sheets.forEach((sh, i) => {
      plans.push({
        layout: sh,
        meta: {
          type: 'batch', batchId, sheetIndex: i + 1,
          round: sh.round || i + 1, orderNo: sh.orderNo == null ? null : sh.orderNo,
        },
      });
    });
  } else {
    raw.sheets.forEach((sh, i) => {
      plans.push({
        layout: sh.layout,
        meta: {
          type: 'cost', batchId, sheetIndex: i + 1,
          round: sh.round, paperId: sh.paperId, paperName: sh.paperName,
          orderNo: sh.orderNo == null ? null : sh.orderNo,
        },
      });
    });
  }

  // 同一来源（批次 + 纸张序号）下纸型、刀缝、坐标、尺寸完全相同的
  // 余料不重复登记；跨请求对同一 batchId 重复提交同样去重
  const fingerprints = new Set();
  for (const rec of store.offcuts.values()) fingerprints.add(fingerprintOf(rec));

  const seen = new Set(); // 本次请求内的指纹（与库内指纹一并判重）
  const ingested = [];
  let skipped = 0;
  for (const plan of plans) {
    const records = offcutsFromLayout(plan.layout, plan.meta);
    for (const rec of records) {
      const fp = fingerprintOf(rec);
      if (seen.has(fp) || fingerprints.has(fp)) {
        skipped += 1;
        continue;
      }
      seen.add(fp);
      fingerprints.add(fp);
      store.offcuts.set(rec.id, rec);
      ingested.push(rec);
    }
  }

  return {
    batchId,
    shape,
    ingested: ingested.length,
    skipped,
    offcutIds: ingested.map((r) => r.id),
    summary: inventorySummary(),
  };
}

/* ---------------- 手工录入 ---------------- */

/**
 * 手工录入一条余料（切下后留存的矩形，无原纸面坐标时坐标取 0,0）。
 * @param {object} input { paperName?, width, height, paperGrain?|grain?, kerf?, batchId?, orderNo?, note? }
 */
function createOffcut(input) {
  if (!input || typeof input !== 'object') throw new Error('缺少余料信息');
  const shape = normalizeOffcutShape(input);
  const paperName = input.paperName != null ? String(input.paperName).trim() : '';
  const orderNo = normalizeRef(input.orderNo, '订单号');
  const free = { x: 0, y: 0, w: shape.width, h: shape.height };
  const rec = buildRecordFromFree(free, {
    width: shape.width,
    height: shape.height,
    kerf: shape.kerf,
    grain: shape.paperGrain,
  }, {
    type: 'manual',
    batchId: normalizeBatchId(input.batchId),
    sheetIndex: null,
    paperName: paperName || null,
    orderNo,
  });
  if (input.note != null && input.note !== '') rec.source.note = String(input.note).slice(0, 256);
  store.offcuts.set(rec.id, rec);
  return { offcut: rec, summary: inventorySummary() };
}

/* ---------------- 查询 ---------------- */

function inventorySummary() {
  let available = 0;
  let reserved = 0;
  let availableArea = 0;
  let reservedArea = 0;
  for (const rec of store.offcuts.values()) {
    if (rec.status === 'reserved') {
      reserved += 1;
      reservedArea += rec.area;
    } else {
      available += 1;
      availableArea += rec.area;
    }
  }
  return {
    total: store.offcuts.size,
    available,
    reserved,
    availableArea: round3(availableArea),
    reservedArea: round3(reservedArea),
    totalArea: round3(availableArea + reservedArea),
  };
}

/**
 * 查询余料。
 * @param {object} query
 *   status?: 'all'（缺省）| 'available' | 'reserved'
 *   minW?, minH?: 要求余料某种朝向下至少能容纳 minW×minH
 *   grain?: 仅返回该纸张纹向的余料
 *   q?: 关键字（纸型名称 / 来源批次 / 订单号）
 */
function listOffcuts(query = {}) {
  const status = query.status == null || query.status === '' ? 'all' : String(query.status);
  if (!['all', 'available', 'reserved'].includes(status)) {
    throw new Error('状态筛选必须是 all、available 或 reserved');
  }
  const minW = query.minW == null || query.minW === '' ? null : positiveNumber(query.minW, '最小宽');
  const minH = query.minH == null || query.minH === '' ? null : positiveNumber(query.minH, '最小高');
  let grain = null;
  if (query.grain != null && query.grain !== '') grain = normalizePaperGrain(query.grain, '筛选纹向');
  const kw = query.q != null ? String(query.q).trim().toLowerCase() : '';

  const fitsMin = (rec) => {
    if (minW == null) return true;
    // 允许旋转 90° 比较
    return (rec.w >= minW - EPS && rec.h >= minH - EPS)
      || (rec.w >= minH - EPS && rec.h >= minW - EPS);
  };

  const list = [];
  for (const rec of store.offcuts.values()) {
    if (status !== 'all' && rec.status !== status) continue;
    if (grain && rec.paperGrain !== grain) continue;
    if (!fitsMin(rec)) continue;
    if (kw) {
      const hay = [rec.paperName, rec.source.batchId, rec.source.orderNo, rec.id]
        .filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(kw)) continue;
    }
    list.push(rec);
  }

  // 确定性排序：可用优先（查询已固定状态时无影响）、面积降序、编号升序
  list.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'available' ? -1 : 1;
    if (Math.abs(b.area - a.area) > EPS) return b.area - a.area;
    return offcutSeq(a.id) - offcutSeq(b.id);
  });

  return { summary: inventorySummary(), count: list.length, offcuts: list };
}

function offcutSeq(id) {
  const n = Number(String(id).replace(/^OC-/, ''));
  return Number.isFinite(n) ? n : 0;
}

/** 余料去重指纹：来源（类型/批次/纸张序号/轮次）+ 纸型/刀缝 + 坐标尺寸 */
function fingerprintOf(rec) {
  return [
    rec.source.type, rec.source.batchId, rec.source.sheetIndex, rec.source.round,
    rec.paperWidth, rec.paperHeight, rec.paperGrain, rec.kerf,
    rec.x, rec.y, rec.w, rec.h,
  ].join('|');
}

/* ---------------- 复用预占（原子分配） ---------------- */

/**
 * 计算成品（pw×ph，纹向要求 grain）在余料 rec 上的可行放置。
 * @returns 可行时 { rotated, placedW, placedH, residualArea }，否则 { blocked:'too-small'|'grain-blocked' }
 */
function feasiblePlacement(rec, pw, ph, grain) {
  const fitsNoRotate = pw <= rec.w + EPS && ph <= rec.h + EPS;
  const fitsRotate = ph <= rec.w + EPS && pw <= rec.h + EPS;
  const options = [];
  if (fitsNoRotate && grainAllows(grain, rec.paperGrain, false)) {
    options.push({ rotated: false, placedW: pw, placedH: ph });
  }
  if (fitsRotate && grainAllows(grain, rec.paperGrain, true)) {
    options.push({ rotated: true, placedW: ph, placedH: pw });
  }
  if (options.length === 0) {
    // 几何上任一朝向能放下，但纹向允许的朝向放不下 → 纹向受限；否则尺寸不足
    const geometricFit = fitsNoRotate || fitsRotate;
    return { blocked: geometricFit ? 'grain-blocked' : 'too-small' };
  }
  // 同一余料上两种朝向都可行时，取占用后剩余面积更小的朝向（平局不旋转优先）
  options.sort((a, b) => {
    const ra = rec.area - a.placedW * a.placedH;
    const rb = rec.area - b.placedW * b.placedH;
    if (Math.abs(ra - rb) > EPS) return ra - rb;
    return (a.rotated ? 1 : 0) - (b.rotated ? 1 : 0);
  });
  const pick = options[0];
  return {
    rotated: pick.rotated,
    placedW: round3(pick.placedW),
    placedH: round3(pick.placedH),
    residualArea: round3(rec.area - pick.placedW * pick.placedH),
  };
}

/**
 * 原子复用预占：
 *  1. 仅在“可用”余料中按旋转 / 纹向可行性收集候选；
 *  2. 候选决胜（全部确定性）：占用后剩余面积 ↑小 → 余料面积 ↑小 →
 *     余料短边 ↑小 → 余料长边 ↑小 → 不旋转优先 → 余料编号 ↑小（录入先后）；
 *  3. 可满足（候选数 ≥ 数量）才一次性预占；否则不改动任何记录，返回缺口明细。
 *
 * @param {object} input { width, height, quantity, grain?, ref? }
 */
function allocateOffcuts(input) {
  if (!input || typeof input !== 'object') throw new Error('缺少预占请求');
  const width = positiveNumber(input.width, '成品宽度');
  const height = positiveNumber(input.height, '成品高度');
  const quantity = positiveInteger(input.quantity, '预占数量');
  const grain = normalizeProductGrain(input.grain);
  const ref = normalizeRef(input.ref);

  const candidates = [];
  let blockedTooSmall = 0;
  let blockedGrain = 0;
  let reservedCount = 0;
  for (const rec of store.offcuts.values()) {
    if (rec.status === 'reserved') { reservedCount += 1; continue; }
    const placement = feasiblePlacement(rec, width, height, grain);
    if (placement.blocked) {
      if (placement.blocked === 'grain-blocked') blockedGrain += 1;
      else blockedTooSmall += 1;
      continue;
    }
    candidates.push({ rec, ...placement });
  }

  const request = {
    width: round3(width), height: round3(height), quantity, grain, ref,
  };

  // 无法满足：原子失败——不预占任何余料，返回缺口明细
  if (candidates.length < quantity) {
    candidates.sort(compareCandidates);
    return {
      status: 'shortfall',
      allocated: false,
      request,
      summary: inventorySummary(),
      feasibleCount: candidates.length,
      reservedCount: 0,
      shortfall: quantity - candidates.length,
      blockedBySize: blockedTooSmall,
      blockedByGrain: blockedGrain,
      unavailableReserved: reservedCount,
      candidates: candidates.map((c) => ({
        offcutId: c.rec.id,
        paperName: c.rec.paperName,
        width: c.rec.w,
        height: c.rec.h,
        paperGrain: c.rec.paperGrain,
        rotated: c.rotated,
        residualArea: c.residualArea,
      })),
    };
  }

  // 确定性择优排序后取前 quantity 条，一次性提交（先算后改，保证原子语义）
  candidates.sort(compareCandidates);
  const chosen = candidates.slice(0, quantity);
  const allocationId = newAllocationId();
  const now = new Date().toISOString();
  const reserved = chosen.map((c) => {
    const rec = c.rec;
    rec.status = 'reserved';
    rec.reservation = {
      allocationId,
      product: { width: round3(width), height: round3(height), grain },
      rotated: c.rotated,
      placedW: c.placedW,
      placedH: c.placedH,
      ref,
      createdAt: now,
    };
    return {
      offcutId: rec.id,
      paperName: rec.paperName,
      width: rec.w,
      height: rec.h,
      paperGrain: rec.paperGrain,
      area: rec.area,
      rotated: c.rotated,
      placedW: c.placedW,
      placedH: c.placedH,
      residualArea: c.residualArea,
      source: rec.source,
    };
  });

  return {
    status: 'fulfilled',
    allocated: true,
    allocationId,
    request,
    summary: inventorySummary(),
    feasibleCount: candidates.length,
    reservedCount: reserved.length,
    shortfall: 0,
    reserved,
  };
}

/** 候选决胜：剩余面积小 → 余料面积小 → 短边小 → 长边小 → 不旋转 → 录入先后 */
function compareCandidates(a, b) {
  const keys = [
    () => a.residualArea - b.residualArea,
    () => a.rec.area - b.rec.area,
    () => Math.min(a.rec.w, a.rec.h) - Math.min(b.rec.w, b.rec.h),
    () => Math.max(a.rec.w, a.rec.h) - Math.max(b.rec.w, b.rec.h),
    () => (a.rotated ? 1 : 0) - (b.rotated ? 1 : 0),
    () => offcutSeq(a.rec.id) - offcutSeq(b.rec.id),
  ];
  for (const fn of keys) {
    const d = fn();
    if (Math.abs(d) > EPS) return d;
  }
  return 0;
}

/* ---------------- 释放预占 ---------------- */

/**
 * 释放预占：可按预占单号 allocationIds 或余料编号 offcutIds 释放。
 * 编号不存在或对应余料未预占均返回 HTTP 400（调用方负责，本函数抛错），
 * 全部校验通过后才一次性释放。
 * @returns {{ releasedCount, allocationIds, offcutIds, reservations:[...], summary }}
 */
function releaseAllocations(input) {
  if (!input || typeof input !== 'object') throw new Error('缺少释放请求');
  const allocationIds = normalizeIdList(input.allocationIds, 'allocationIds');
  const offcutIds = normalizeIdList(input.offcutIds, 'offcutIds');
  if (allocationIds.length === 0 && offcutIds.length === 0) {
    throw new Error('需提供要释放的预占单号（allocationIds）或余料编号（offcutIds）');
  }

  const targets = new Map(); // id(offcut) → rec，去重
  for (const aid of allocationIds) {
    const hits = [...store.offcuts.values()].filter((r) => r.reservation
      && r.reservation.allocationId === aid);
    if (hits.length === 0) throw new Error(`预占单号不存在或已释放：${aid}`);
    for (const rec of hits) targets.set(rec.id, rec);
  }
  for (const oid of offcutIds) {
    const rec = store.offcuts.get(oid);
    if (!rec) throw new Error(`余料编号不存在：${oid}`);
    if (rec.status !== 'reserved') throw new Error(`余料 ${oid} 当前未处于预占状态，无需释放`);
    targets.set(rec.id, rec);
  }

  // 校验全部通过后原子释放
  const touchedAllocations = new Set();
  const reservations = [];
  for (const rec of targets.values()) {
    touchedAllocations.add(rec.reservation.allocationId);
    reservations.push({ offcutId: rec.id, allocationId: rec.reservation.allocationId });
    rec.status = 'available';
    rec.reservation = null;
  }
  reservations.sort((a, b) => offcutSeq(a.offcutId) - offcutSeq(b.offcutId));

  return {
    releasedCount: targets.size,
    allocationIds: [...touchedAllocations].sort(),
    offcutIds: reservations.map((r) => r.offcutId),
    reservations,
    summary: inventorySummary(),
  };
}

function normalizeIdList(value, field) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error(`${field} 必须是数组`);
  const out = [];
  for (const v of value) {
    if (typeof v !== 'string' || !v.trim()) throw new Error(`${field} 含无效编号`);
    out.push(v.trim());
  }
  return [...new Set(out)];
}

module.exports = {
  _resetStore,
  inventorySummary,
  offcutsFromLayout,
  ingestOffcuts,
  createOffcut,
  listOffcuts,
  allocateOffcuts,
  releaseAllocations,
  feasiblePlacement,
};

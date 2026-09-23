'use strict';

/**
 * 余料库存与复用预占（offcut inventory & allocation）
 *
 * 把排料结果中每张纸的 layout.frees 标准化为“可追踪余料记录”，保留：
 *  - 纸型（paperName / paperWidth / paperHeight）
 *  - 纹向（grain：along-width / along-height）
 *  - 刀缝（kerf）
 *  - 坐标（x、y，相对来源纸面左上角）与尺寸（width / height / area）
 *  - 来源批次（source.batchRef）及来源类型、第几张纸 / 轮次 / 纸型 / 订单号
 *
 * 余料记录有两种状态：
 *  - available 可用：可被复用预占；
 *  - reserved  已预占：整张余料被某个预占单（allocation）占用，释放后恢复可用。
 *
 * POST /api/offcuts/allocate 的选择规则（确定性）：
 *  给定成品宽高、数量与纹向要求，逐件在“可用余料”中按
 *    旋转 / 纹向可行性（成品纹向须与余料纹向平行，规则同排样 grainAllows）
 *    及最小剩余面积（余料面积 − 成品面积）选择；
 *  平局依次按：余料短边、长边、不旋转优先、余料录入序号（id）决胜。
 *  每件成品占用一整条余料记录（整料预占，不做物理切分）。
 *
 * 原子性：一次请求先在内存中试排完整预占计划，只有凑足数量时才一次性落账；
 *  数量不足时不修改任何记录，直接抛出缺口明细（HTTP 409）：
 *  对相同成品，“最小适配优先”贪心恰使可满足件数达到最大（小料先耗、大料保留）。
 */

const { grainAllows, normalizePaperGrain, normalizeProductGrain } = require('./packer');

const EPS = 1e-6;

const MAX_ALLOCATE_QTY = 100000; // 单次预占件数上限（与成套计划上限同量级）
const MAX_INGEST_RECORDS = 20000; // 单次入库余料条数安全阀
const NAME_MAX = 64;
const NOTE_MAX = 128;
const BATCH_REF_MAX = 64;

const round3 = (v) => Math.round(v * 1000) / 1000;

/** 带 HTTP 状态码的业务错误（数量不足为 409，参数非法为 400，记录不存在为 404） */
class OffcutError extends Error {
  constructor(message, statusCode = 400, extra = null) {
    super(message);
    this.name = 'OffcutError';
    this.statusCode = statusCode;
    if (extra) Object.assign(this, extra);
  }
}

/** 余料库存存储（进程内内存态；单实例部署，重启清空，不依赖外部服务） */
function createOffcutStore() {
  return {
    records: new Map(), // id -> record
    allocations: new Map(), // reservationId -> allocation
    seqOffcut: 0,
    seqAllocation: 0,
    seqBatch: 0,
  };
}

const pad6 = (n) => String(n).padStart(6, '0');
const pad4 = (n) => String(n).padStart(4, '0');

function nextOffcutId(store) {
  store.seqOffcut += 1;
  return `OC-${pad6(store.seqOffcut)}`;
}

function nextAllocationId(store) {
  store.seqAllocation += 1;
  return `RSV-${pad6(store.seqAllocation)}`;
}

function nextBatchRef(store) {
  store.seqBatch += 1;
  return `IN-${pad4(store.seqBatch)}`;
}

/* ---------------- 输入规范化 ---------------- */

function normalizeText(value, field, max, { required = false } = {}) {
  if (value == null || value === '') {
    if (required) throw new OffcutError(`${field}不能为空`);
    return null;
  }
  const s = String(value).trim();
  if (!s) {
    if (required) throw new OffcutError(`${field}不能为空`);
    return null;
  }
  if (s.length > max) throw new OffcutError(`${field}长度不能超过 ${max} 个字符`);
  return s;
}

/** 规范化尺寸 / 坐标等数值字段 */
function positiveNumber(value, field) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new OffcutError(`${field}必须是有效数字`);
  if (n <= 0) throw new OffcutError(`${field}必须大于 0`);
  return n;
}

function nonNegativeNumber(value, field, dflt = 0) {
  if (value == null || value === '') return dflt;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new OffcutError(`${field}必须是非负数字`);
  return n;
}

/**
 * 从一张“纸”的多种形态抽取统一视图（与 stack 模块同样的兼容策略）：
 *  - 成本结果 sheets[i]（{ round, paperId, paperName, ..., layout }）；
 *  - 批量结果 sheets[i]（完整 layout() 返回，可能带 round/orderNo/sets）；
 *  - 单张 layout() 返回（{ paper, frees, ... }）；
 *  - 精简形态（{ paper:{...}, frees:[...] }）。
 */
function extractSheet(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.layout && typeof raw.layout === 'object' && Array.isArray(raw.layout.frees)) {
    return { wrapper: raw, layout: raw.layout };
  }
  if (raw.paper && typeof raw.paper === 'object' && Array.isArray(raw.frees)) {
    return { wrapper: raw, layout: raw };
  }
  return null;
}

/** 依据来源纸张构造一条标准化余料记录（不写库） */
function buildRecord(store, {
  paperName, paperWidth, paperHeight, grain, kerf, x, y, width, height, source,
}) {
  const id = nextOffcutId(store);
  const rec = {
    id,
    status: 'available',
    paperName: paperName || null,
    paperWidth: round3(paperWidth),
    paperHeight: round3(paperHeight),
    grain,
    kerf: round3(kerf),
    x: round3(x),
    y: round3(y),
    width: round3(width),
    height: round3(height),
    area: round3(width * height),
    source,
    reservation: null,
  };
  return rec;
}

/** 把单张纸的 frees 转为记录（公共几何 / 纸型校验） */
function recordsFromSheet(store, sheet, meta, batchRef) {
  const { wrapper, layout } = sheet;
  const paper = layout.paper;
  if (!paper || !(Number(paper.width) > 0) || !(Number(paper.height) > 0)) {
    throw new OffcutError(`${meta.subject}缺少有效的纸面宽高`);
  }
  const kerf = Number(paper.kerf);
  if (!Number.isFinite(kerf) || kerf < 0) {
    throw new OffcutError(`${meta.subject}的刀缝宽度无效`);
  }
  const grain = normalizePaperGrain(paper.grain, meta.subject);
  if (!Array.isArray(layout.frees)) {
    throw new OffcutError(`${meta.subject}缺少余料列表（frees）`);
  }

  const out = [];
  layout.frees.forEach((f, j) => {
    if (!f || typeof f !== 'object') {
      throw new OffcutError(`${meta.subject}第 ${j + 1} 块余料不是有效记录`);
    }
    const fw = Number(f.w != null ? f.w : f.width);
    const fh = Number(f.h != null ? f.h : f.height);
    if (![fw, fh].every((n) => Number.isFinite(n)) || fw <= 0 || fh <= 0) {
      throw new OffcutError(`${meta.subject}第 ${j + 1} 块余料的宽高必须为正`);
    }
    const fx = Number(f.x != null ? f.x : 0);
    const fy = Number(f.y != null ? f.y : 0);
    if (![fx, fy].every((n) => Number.isFinite(n)) || fx < 0 || fy < 0) {
      throw new OffcutError(`${meta.subject}第 ${j + 1} 块余料的坐标必须是非负数字`);
    }
    out.push(buildRecord(store, {
      paperName: meta.paperName,
      paperWidth: paper.width,
      paperHeight: paper.height,
      grain,
      kerf,
      x: fx,
      y: fy,
      width: fw,
      height: fh,
      source: {
        type: meta.sourceType,
        batchRef,
        sheetIndex: meta.sheetIndex,
        round: meta.round,
        paperId: meta.paperId,
        paperName: meta.paperName,
        orderNo: meta.orderNo,
      },
    }));
  });
  return out;
}

/**
 * 余料录入：支持三种形态（自动识别）。
 *  1) 排料结果入库：
 *     - 单张 layout() 返回（含 paper + frees）；
 *     - 方案比选返回的 best.layout / candidates[i].layout（同上）；
 *     - 批量 / 成本排产完整返回（含 sheets，成本逐张为 { layout } 包装）；
 *     - 仅含 { sheets: [...] } 的精简形态。
 *  2) 手工录入：{ offcuts: [{ paperName?, paperWidth, paperHeight, grain?,
 *     kerf?, x?, y?, width, height }] }。
 * 可选 batchRef（来源批次号，≤64 字符；缺省自动生成 IN-0001…）、note（备注）。
 * @returns {{ batchRef, note, sourceType, createdCount, offcuts: Record[] }}
 */
function ingestOffcuts(input, store) {
  if (!input || typeof input !== 'object') {
    throw new OffcutError('请求体必须是对象');
  }
  const batchRef = normalizeText(input.batchRef, '来源批次号', BATCH_REF_MAX) || nextBatchRef(store);
  const note = normalizeText(input.note, '备注', NOTE_MAX);

  let records = [];
  let sourceType = null;

  // 形态 1a：多张纸（批量 / 成本结果，或精简 { sheets }）
  if (Array.isArray(input.sheets)) {
    const isCost = input.sheets.some((s) => s && s.layout && Array.isArray(s.layout.frees));
    sourceType = isCost ? 'cost' : 'batch';
    input.sheets.forEach((raw, i) => {
      const sheet = extractSheet(raw);
      if (!sheet) throw new OffcutError(`第 ${i + 1} 张纸缺少有效的排料结果（paper/frees）`);
      const wrapper = sheet.wrapper || {};
      records.push(...recordsFromSheet(store, sheet, {
        subject: `第 ${i + 1} 张纸`,
        sourceType,
        sheetIndex: i + 1,
        round: Number.isInteger(wrapper.round) ? wrapper.round : null,
        paperId: wrapper.paperId != null ? String(wrapper.paperId) : null,
        paperName: wrapper.paperName != null ? String(wrapper.paperName) : null,
        orderNo: wrapper.orderNo != null ? String(wrapper.orderNo) : null,
      }, batchRef));
    });
  } else if (extractSheet(input)) {
    // 形态 1b：单张排料结果（含 paper + frees）
    sourceType = 'single';
    records = recordsFromSheet(store, extractSheet(input), {
      subject: '排料结果',
      sourceType,
      sheetIndex: null,
      round: null,
      paperId: null,
      paperName: null,
      orderNo: null,
    }, batchRef);
  } else if (Array.isArray(input.offcuts)) {
    // 形态 2：手工录入
    sourceType = 'manual';
    input.offcuts.forEach((raw, i) => {
      const pos = i + 1;
      if (!raw || typeof raw !== 'object') {
        throw new OffcutError(`第 ${pos} 条余料不是有效记录`);
      }
      const paperName = normalizeText(raw.paperName, `第 ${pos} 条余料的纸型名称`, NAME_MAX);
      const paperWidth = positiveNumber(raw.paperWidth, `第 ${pos} 条余料的纸宽`);
      const paperHeight = positiveNumber(raw.paperHeight, `第 ${pos} 条余料的纸高`);
      const grain = normalizePaperGrain(raw.grain, `第 ${pos} 条余料`);
      const kerf = nonNegativeNumber(raw.kerf, `第 ${pos} 条余料的刀缝`, 0);
      const width = positiveNumber(raw.width, `第 ${pos} 条余料的宽`);
      const height = positiveNumber(raw.height, `第 ${pos} 条余料的高`);
      const x = nonNegativeNumber(raw.x, `第 ${pos} 条余料的 x 坐标`, 0);
      const y = nonNegativeNumber(raw.y, `第 ${pos} 条余料的 y 坐标`, 0);
      records.push(buildRecord(store, {
        paperName, paperWidth, paperHeight, grain, kerf, x, y, width, height,
        source: {
          type: 'manual',
          batchRef,
          sheetIndex: null,
          round: null,
          paperId: null,
          paperName,
          orderNo: null,
        },
      }));
    });
  } else {
    throw new OffcutError('入库内容必须是排料结果（paper/frees 或 sheets）或手工余料列表（offcuts）');
  }

  if (records.length === 0) {
    throw new OffcutError('排料结果中没有可入库的余料（frees 为空）');
  }
  if (records.length > MAX_INGEST_RECORDS) {
    throw new OffcutError(`单次入库余料不能超过 ${MAX_INGEST_RECORDS} 条（当前 ${records.length} 条）`);
  }

  for (const rec of records) store.records.set(rec.id, rec);

  return {
    batchRef,
    note,
    sourceType,
    createdCount: records.length,
    offcuts: records.map(publicRecord),
  };
}

/* ---------------- 查询 ---------------- */

/** 汇总计数（面积单位 mm²） */
function buildSummary(store) {
  let total = 0;
  let available = 0;
  let reserved = 0;
  let availableArea = 0;
  let reservedArea = 0;
  for (const rec of store.records.values()) {
    total += 1;
    if (rec.status === 'reserved') {
      reserved += 1;
      reservedArea += rec.area;
    } else {
      available += 1;
      availableArea += rec.area;
    }
  }
  return {
    total,
    available,
    reserved,
    availableArea: round3(availableArea),
    reservedArea: round3(reservedArea),
    totalArea: round3(availableArea + reservedArea),
  };
}

/**
 * 查询余料库存。
 * @param {object} filter { status?: 'available'|'reserved'|'all',
 *   grain?: 'along-width'|'along-height', sourceType?, batchRef? }
 */
function queryOffcuts(filter = {}, store) {
  const status = filter.status == null || filter.status === '' || filter.status === 'all'
    ? 'all'
    : String(filter.status);
  if (status !== 'all' && status !== 'available' && status !== 'reserved') {
    throw new OffcutError('状态筛选必须是 available（可用）或 reserved（已预占）');
  }
  let grain = null;
  if (filter.grain != null && filter.grain !== '') {
    grain = normalizePaperGrain(filter.grain, '纹向筛选');
  }
  const sourceType = filter.sourceType != null && filter.sourceType !== ''
    ? String(filter.sourceType)
    : null;
  if (sourceType && !['manual', 'single', 'batch', 'cost'].includes(sourceType)) {
    throw new OffcutError('来源筛选必须是 manual / single / batch / cost');
  }
  const batchRef = filter.batchRef != null && String(filter.batchRef).trim()
    ? String(filter.batchRef).trim()
    : null;

  const out = [...store.records.values()]
    .filter((rec) => (status === 'all' ? true : rec.status === status))
    .filter((rec) => (grain ? rec.grain === grain : true))
    .filter((rec) => (sourceType ? rec.source.type === sourceType : true))
    .filter((rec) => (batchRef ? rec.source.batchRef === batchRef : true))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(publicRecord);

  return { summary: buildSummary(store), offcuts: out, allocations: listAllocations(store) };
}

/** 预占单的对外视图 */
function publicAllocation(alloc) {
  return {
    reservationId: alloc.reservationId,
    note: alloc.note,
    createdAt: alloc.createdAt,
    request: { ...alloc.request },
    allocatedCount: alloc.items.length,
    items: alloc.items.map((it) => ({
      offcutId: it.offcutId,
      rotated: it.rotated,
      placedWidth: it.placedWidth,
      placedHeight: it.placedHeight,
      leftoverArea: it.leftoverArea,
    })),
  };
}

function listAllocations(store) {
  return [...store.allocations.values()]
    .sort((a, b) => (a.reservationId < b.reservationId ? -1 : 1))
    .map(publicAllocation);
}

/** 余料记录的对外视图（含预占信息） */
function publicRecord(rec) {
  return {
    id: rec.id,
    status: rec.status,
    paperName: rec.paperName,
    paperWidth: rec.paperWidth,
    paperHeight: rec.paperHeight,
    grain: rec.grain,
    kerf: rec.kerf,
    x: rec.x,
    y: rec.y,
    width: rec.width,
    height: rec.height,
    area: rec.area,
    source: { ...rec.source },
    reservation: rec.reservation ? { ...rec.reservation } : null,
  };
}

/* ---------------- 预占（原子分配） ---------------- */

/**
 * 在给定候选余料上为一件成品收集可行朝向候选。
 * 纹向规则与排样完全一致：未旋转时成品宽 ∥ 余料宽；旋转 90° 后互换。
 */
function orientationCandidates(rec, width, height, grain) {
  const cands = [];
  if (
    grainAllows(grain, rec.grain, false) &&
    width <= rec.width + EPS && height <= rec.height + EPS
  ) {
    cands.push({ rec, rotated: false, placedWidth: width, placedHeight: height });
  }
  if (
    grainAllows(grain, rec.grain, true) &&
    height <= rec.width + EPS && width <= rec.height + EPS
  ) {
    cands.push({ rec, rotated: true, placedWidth: height, placedHeight: width });
  }
  return cands;
}

/**
 * 预占主入口：给定成品宽高、数量、纹向要求，按最小剩余面积确定性选料。
 * 数量不足时抛 OffcutError(409)，不修改任何记录。
 * @param {object} input { width, height, quantity, grain?: 'any'|'along-width'|..., note? }
 */
function allocateOffcuts(input, store) {
  if (!input || typeof input !== 'object') {
    throw new OffcutError('请求体必须是对象');
  }
  const width = positiveNumber(input.width, '成品宽');
  const height = positiveNumber(input.height, '成品高');
  const quantity = Number(input.quantity);
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new OffcutError('预占数量必须是正整数');
  }
  if (quantity > MAX_ALLOCATE_QTY) {
    throw new OffcutError(`单次预占数量不能超过 ${MAX_ALLOCATE_QTY}`);
  }
  const grain = normalizeProductGrain(input.grain, '成品');
  const note = normalizeText(input.note, '备注', NOTE_MAX);

  // 先在“工作集”上试排出完整计划，全部凑足后才一次性落账（原子预占）
  const pool = new Set(
    [...store.records.values()].filter((rec) => rec.status === 'available')
  );
  const pieceArea = width * height;
  const plan = [];

  for (let k = 0; k < quantity; k++) {
    let best = null;
    for (const rec of pool) {
      for (const cand of orientationCandidates(rec, width, height, grain)) {
        const leftover = rec.area - pieceArea;
        const key = [
          leftover,
          Math.min(rec.width, rec.height),
          Math.max(rec.width, rec.height),
          cand.rotated ? 1 : 0,
          rec.id, // 录入序号（id 单调）最终决胜，保证确定性
        ];
        if (!best || lexLess(key, best.key)) {
          best = { ...cand, leftover, key };
        }
      }
    }
    if (!best) break; // 现存可用余料都放不下（尺寸或纹向）
    pool.delete(best.rec);
    plan.push(best);
  }

  if (plan.length < quantity) {
    // 原子性：不落账、不扣减任何记录
    const fulfillable = plan.length;
    const gap = quantity - fulfillable;
    throw new OffcutError(
      gap === quantity
        ? `没有可满足该成品（${round3(width)}×${round3(height)} mm，纹向${grain}）的可用余料，缺口 ${gap} 件`
        : `可用余料仅能满足 ${fulfillable} / ${quantity} 件，缺口 ${gap} 件；本次未预占任何余料`,
      409,
      {
        code: 'OFFCUT_SHORTAGE',
        shortage: {
          requested: { width: round3(width), height: round3(height), grain, quantity },
          fulfillable,
          gap,
          reason: fulfillable === 0 ? 'no-feasible-offcut' : 'insufficient-stock',
        },
      }
    );
  }

  // 凑足：一次性落账
  const reservationId = nextAllocationId(store);
  const createdAt = new Date().toISOString();
  const request = {
    width: round3(width),
    height: round3(height),
    grain,
    quantity,
  };
  const items = plan.map((p) => ({
    offcutId: p.rec.id,
    rotated: p.rotated,
    placedWidth: round3(p.placedWidth),
    placedHeight: round3(p.placedHeight),
    leftoverArea: round3(p.leftover),
  }));

  const alloc = { reservationId, note, createdAt, request, items };
  store.allocations.set(reservationId, alloc);

  plan.forEach((p, i) => {
    const rec = p.rec;
    rec.status = 'reserved';
    rec.reservation = {
      reservationId,
      width: round3(width),
      height: round3(height),
      grain,
      rotated: p.rotated,
      note,
      createdAt,
      seq: i + 1, // 该成品在本预占单中的件序
    };
  });

  return {
    reservationId,
    note,
    createdAt,
    request,
    allocatedCount: items.length,
    items: items.map((it) => ({ ...it, offcut: publicRecord(store.records.get(it.offcutId)) })),
    summary: buildSummary(store),
  };
}

/** 数组字典序比较（数字键；id 为等宽零填充字符串，按字符串比较即录入顺序） */
function lexLess(a, b) {
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (typeof x === 'number' && typeof y === 'number') {
      if (Math.abs(x - y) > EPS) return x < y;
    } else if (x !== y) {
      return x < y;
    }
  }
  return false;
}

/* ---------------- 释放预占 ---------------- */

/**
 * 释放整张预占单：其名下全部余料恢复可用，预占单删除。
 * @param {string} reservationId
 */
function releaseAllocation(reservationId, store) {
  const id = normalizeText(reservationId, '预占单号', NAME_MAX, { required: true });
  const alloc = store.allocations.get(id);
  if (!alloc) {
    throw new OffcutError(`预占单不存在：${id}`, 404);
  }
  for (const it of alloc.items) {
    const rec = store.records.get(it.offcutId);
    // 余料记录可能已被其他途径移除（理论上内存态不会），防御性判空
    if (rec && rec.reservation && rec.reservation.reservationId === id) {
      rec.status = 'available';
      rec.reservation = null;
    }
  }
  store.allocations.delete(id);
  return {
    released: id,
    releasedCount: alloc.items.length,
    items: alloc.items.map((it) => it.offcutId),
    summary: buildSummary(store),
  };
}

module.exports = {
  createOffcutStore,
  ingestOffcuts,
  queryOffcuts,
  allocateOffcuts,
  releaseAllocation,
  listAllocations,
  buildSummary,
  OffcutError,
};

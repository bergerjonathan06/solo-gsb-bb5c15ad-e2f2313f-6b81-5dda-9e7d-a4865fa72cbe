'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const { layout, layoutBatch, layoutCompare } = require('../src/packer');
const { layoutCostBatch } = require('../src/cost');
const {
  createOffcutStore,
  ingestOffcuts,
  queryOffcuts,
  allocateOffcuts,
  releaseAllocation,
} = require('../src/offcuts');

const EPS = 1e-6;

/** 生成一张必然带若干余料的排料结果（小成品 + 大纸） */
function sampleLayout(grain = 'along-width', kerf = 3) {
  return layout({
    paperW: 889, paperH: 1194, paperGrain: grain, kerf,
    products: [{ name: '封面', width: 210, height: 285, quantity: 2, grain: 'any' }],
  });
}

test('单张 layout.frees 标准化为余料记录：保留纸型/纹向/刀缝/坐标/尺寸/来源批次', () => {
  const store = createOffcutStore();
  const r = sampleLayout('along-height', 5);
  assert.ok(r.frees.length > 0);
  const result = ingestOffcuts({ ...r, batchRef: 'BATCH-1' }, store);
  assert.equal(result.sourceType, 'single');
  assert.equal(result.batchRef, 'BATCH-1');
  assert.equal(result.createdCount, r.frees.length);

  const q = queryOffcuts({}, store);
  assert.equal(q.offcuts.length, r.frees.length);
  for (let i = 0; i < q.offcuts.length; i++) {
    const rec = q.offcuts[i];
    const f = r.frees.find((x) => x.x === rec.x && x.y === rec.y);
    assert.ok(f, '记录坐标应与某块 frees 对应');
    assert.equal(rec.width, f.w);
    assert.equal(rec.height, f.h);
    assert.equal(rec.area, f.area);
    assert.equal(rec.paperWidth, 889);
    assert.equal(rec.paperHeight, 1194);
    assert.equal(rec.grain, 'along-height');
    assert.equal(rec.kerf, 5);
    assert.equal(rec.status, 'available');
    assert.equal(rec.source.type, 'single');
    assert.equal(rec.source.batchRef, 'BATCH-1');
    assert.match(rec.id, /^OC-\d{6}$/);
  }
  // 汇总
  assert.equal(q.summary.total, r.frees.length);
  assert.equal(q.summary.available, r.frees.length);
  assert.equal(q.summary.reserved, 0);
  assert.ok(Math.abs(q.summary.availableArea - r.frees.reduce((s, f) => s + f.area, 0)) < EPS);
});

test('缺省来源批次号自动生成且单调', () => {
  const store = createOffcutStore();
  const a = ingestOffcuts(sampleLayout(), store);
  const b = ingestOffcuts(sampleLayout(), store);
  assert.equal(a.batchRef, 'IN-0001');
  assert.equal(b.batchRef, 'IN-0002');
});

test('批量 / 成本排产结果整体入库：逐张 frees 与来源元数据', () => {
  const store = createOffcutStore();
  const batch = layoutBatch({
    paperW: 300, paperH: 200, kerf: 2, maxSheets: 5,
    products: [{ width: 120, height: 90, quantity: 7 }],
  });
  assert.ok(batch.sheets.length >= 2);
  const freeCount = batch.sheets.reduce((s, sh) => s + sh.frees.length, 0);
  const result = ingestOffcuts(batch, store);
  assert.equal(result.sourceType, 'batch');
  assert.equal(result.createdCount, freeCount);
  const sheet2 = result.offcuts.find((o) => o.source.sheetIndex === 2);
  assert.ok(sheet2);
  assert.equal(sheet2.source.type, 'batch');

  // 成本结果
  const store2 = createOffcutStore();
  const cost = layoutCostBatch({
    kerf: 2,
    papers: [
      { name: '大纸', width: 600, height: 500, grain: 'along-width', price: 2, stock: 3 },
      { name: '小纸', width: 400, height: 300, grain: 'along-width', price: 0.5, stock: 3 },
    ],
    products: [{ width: 100, height: 80, quantity: 9 }],
  });
  assert.ok(cost.sheets.length >= 1);
  const costFreeCount = cost.sheets.reduce((s, sh) => s + sh.layout.frees.length, 0);
  const r2 = ingestOffcuts(cost, store2);
  assert.equal(r2.sourceType, 'cost');
  assert.equal(r2.createdCount, costFreeCount);
  const anyCost = r2.offcuts[0];
  assert.ok(anyCost.source.paperName);
  assert.ok(anyCost.source.round >= 1);
});

test('方案比选 best.layout 可直接入库', () => {
  const store = createOffcutStore();
  const cmp = layoutCompare({
    paperW: 400, paperH: 300, kerf: 2,
    products: [{ width: 100, height: 80, quantity: 3 }],
  });
  assert.ok(cmp.best);
  const result = ingestOffcuts(cmp.best.layout, store);
  assert.equal(result.sourceType, 'single');
  assert.ok(result.createdCount > 0);
});

test('手工录入余料：默认刀缝 0 / 坐标 0，缺省纹向沿宽', () => {
  const store = createOffcutStore();
  const result = ingestOffcuts({
    batchRef: 'MAN-1',
    offcuts: [
      { paperName: 'A3余料', paperWidth: 297, paperHeight: 420, width: 200, height: 150 },
      { paperWidth: 297, paperHeight: 420, grain: 'along-height', kerf: 3, x: 10, y: 20, width: 100, height: 80 },
    ],
  }, store);
  assert.equal(result.sourceType, 'manual');
  assert.equal(result.createdCount, 2);
  const [a, b] = result.offcuts;
  assert.equal(a.paperName, 'A3余料');
  assert.equal(a.kerf, 0);
  assert.equal(a.x, 0);
  assert.equal(a.y, 0);
  assert.equal(a.grain, 'along-width');
  assert.equal(a.area, 30000);
  assert.equal(b.grain, 'along-height');
  assert.equal(b.x, 10);
  assert.equal(b.y, 20);
});

test('入库校验：空 frees、尺寸非法、纹向非法、批次号超长均报错', () => {
  const store = createOffcutStore();
  assert.throws(() => ingestOffcuts({}, store), /入库内容/);
  assert.throws(() => ingestOffcuts({ offcuts: [] }, store), /没有可入库的余料|余料列表/);
  assert.throws(() => ingestOffcuts({
    offcuts: [{ paperWidth: 297, paperHeight: 420, width: 0, height: 100 }],
  }, store), /宽/);
  assert.throws(() => ingestOffcuts({
    offcuts: [{ paperWidth: 297, paperHeight: 420, width: 100, height: 100, grain: 'x' }],
  }, store), /纹向/);
  assert.throws(() => ingestOffcuts({ batchRef: 'x'.repeat(65), offcuts: [
    { paperWidth: 297, paperHeight: 420, width: 100, height: 100 },
  ] }, store), /来源批次号/);
});

test('查询筛选：状态 / 纹向 / 来源类型 / 来源批次', () => {
  const store = createOffcutStore();
  ingestOffcuts({ batchRef: 'G1', ...sampleLayout('along-width') }, store);
  ingestOffcuts({ batchRef: 'G2', ...sampleLayout('along-height') }, store);
  const all = queryOffcuts({}, store);
  assert.ok(all.offcuts.length >= 2);

  const g1 = queryOffcuts({ batchRef: 'G1' }, store);
  assert.ok(g1.offcuts.every((o) => o.source.batchRef === 'G1'));
  const gh = queryOffcuts({ grain: 'along-height' }, store);
  assert.ok(gh.offcuts.length > 0);
  assert.ok(gh.offcuts.every((o) => o.grain === 'along-height'));
  const manual = queryOffcuts({ sourceType: 'manual' }, store);
  assert.equal(manual.offcuts.length, 0);
  assert.throws(() => queryOffcuts({ status: 'weird' }, store), /状态筛选/);
});

test('预占基本流程：最小剩余面积选料、状态翻转为已预占、汇总更新', () => {
  const store = createOffcutStore();
  ingestOffcuts({
    offcuts: [
      { paperName: '大料', paperWidth: 300, paperHeight: 300, width: 300, height: 300 }, // 90000
      { paperName: '中料', paperWidth: 200, paperHeight: 200, width: 200, height: 200 }, // 40000
      { paperName: '小料', paperWidth: 100, paperHeight: 100, width: 100, height: 100 }, // 10000
    ],
  }, store);

  // 成品 90×90：应选中最小能放下的“小料”（剩余 1900 最小）
  const result = allocateOffcuts({ width: 90, height: 90, quantity: 1 }, store);
  assert.equal(result.allocatedCount, 1);
  assert.equal(result.items[0].offcut.area, 10000);
  assert.equal(result.items[0].rotated, false);
  assert.equal(result.items[0].leftoverArea, 1900);
  assert.match(result.reservationId, /^RSV-\d{6}$/);

  const q = queryOffcuts({}, store);
  assert.equal(q.summary.available, 2);
  assert.equal(q.summary.reserved, 1);
  const reserved = q.offcuts.find((o) => o.status === 'reserved');
  assert.equal(reserved.reservation.reservationId, result.reservationId);
  assert.equal(reserved.reservation.width, 90);
  // 预占单也在查询结果中
  assert.equal(q.allocations.length, 1);
  assert.equal(q.allocations[0].allocatedCount, 1);
});

test('多件预占：每件各占一条记录（整料预占），按最小适配依次消耗', () => {
  const store = createOffcutStore();
  ingestOffcuts({
    offcuts: [
      { paperWidth: 100, paperHeight: 100, width: 100, height: 100 },
      { paperWidth: 120, paperHeight: 120, width: 120, height: 120 },
      { paperWidth: 200, paperHeight: 200, width: 200, height: 200 },
    ],
  }, store);
  const result = allocateOffcuts({ width: 90, height: 90, quantity: 3 }, store);
  const areas = result.items.map((it) => it.offcut.area).sort((a, b) => a - b);
  assert.deepEqual(areas, [10000, 14400, 40000]);
  assert.equal(result.allocatedCount, 3);
  const ids = new Set(result.items.map((it) => it.offcutId));
  assert.equal(ids.size, 3);
  assert.equal(queryOffcuts({}, store).summary.available, 0);
});

test('旋转可行：旋转后能放入时选择旋转方向，方形余料平局不旋转', () => {
  const store = createOffcutStore();
  ingestOffcuts({
    offcuts: [
      { paperWidth: 100, paperHeight: 300, width: 100, height: 300 }, // 仅旋转能放 200×90
    ],
  }, store);
  const result = allocateOffcuts({ width: 200, height: 90, quantity: 1 }, store);
  assert.equal(result.items[0].rotated, true);
  assert.equal(result.items[0].placedWidth, 90);
  assert.equal(result.items[0].placedHeight, 200);
});

test('纹向可行性：纹向不允许的朝向不可选；几何够但纹向不符则缺口', () => {
  const store = createOffcutStore();
  // 余料纹向沿宽：成品要求沿自身宽，仅不旋转（成品宽 ∥ 余料宽）可行
  ingestOffcuts({
    offcuts: [
      { paperWidth: 100, paperHeight: 300, grain: 'along-width', width: 100, height: 300 },
    ],
  }, store);
  // 成品 200×90 要求沿自身宽：不旋转需要 200 宽（不足）；旋转需要 90 宽但纹向相反 → 不可行
  try {
    allocateOffcuts({ width: 200, height: 90, grain: 'along-width', quantity: 1 }, store);
    assert.fail('应因纹向/尺寸缺口抛错');
  } catch (e) {
    assert.equal(e.statusCode, 409);
    assert.equal(e.code, 'OFFCUT_SHORTAGE');
    assert.equal(e.shortage.gap, 1);
    assert.equal(e.shortage.fulfillable, 0);
    assert.equal(e.shortage.reason, 'no-feasible-offcut');
  }
  // 任何记录都未被预占（原子性）
  assert.equal(queryOffcuts({}, store).summary.reserved, 0);

  // 成品要求沿自身高：在沿宽余料上仅旋转可行（成品宽 ∥ 余料高）
  const store2 = createOffcutStore();
  ingestOffcuts({
    offcuts: [{ paperWidth: 100, paperHeight: 300, grain: 'along-width', width: 100, height: 300 }],
  }, store2);
  const ok = allocateOffcuts({ width: 200, height: 90, grain: 'along-height', quantity: 1 }, store2);
  assert.equal(ok.items[0].rotated, true);

  // 沿高余料 + 成品要求沿自身宽 → 旋转可行
  const store3 = createOffcutStore();
  ingestOffcuts({
    offcuts: [{ paperWidth: 100, paperHeight: 300, grain: 'along-height', width: 100, height: 300 }],
  }, store3);
  const ok3 = allocateOffcuts({ width: 200, height: 90, grain: 'along-width', quantity: 1 }, store3);
  assert.equal(ok3.items[0].rotated, true);
});

test('数量不足：返回缺口明细且原子不扣减（部分可行时也不扣）', () => {
  const store = createOffcutStore();
  ingestOffcuts({
    offcuts: [
      { paperWidth: 100, paperHeight: 100, width: 100, height: 100 },
      { paperWidth: 120, paperHeight: 120, width: 120, height: 120 },
    ],
  }, store);
  try {
    allocateOffcuts({ width: 90, height: 90, quantity: 3 }, store);
    assert.fail('应因库存不足抛错');
  } catch (e) {
    assert.equal(e.statusCode, 409);
    assert.deepEqual(e.shortage.requested, { width: 90, height: 90, grain: 'any', quantity: 3 });
    assert.equal(e.shortage.fulfillable, 2);
    assert.equal(e.shortage.gap, 1);
    assert.equal(e.shortage.reason, 'insufficient-stock');
  }
  // 原子性：两条记录仍全部可用
  const q = queryOffcuts({}, store);
  assert.equal(q.summary.available, 2);
  assert.equal(q.summary.reserved, 0);
  assert.equal(q.allocations.length, 0);
});

test('已预占记录不参与后续分配；释放后恢复可用', () => {
  const store = createOffcutStore();
  ingestOffcuts({
    offcuts: [
      { paperWidth: 100, paperHeight: 100, width: 100, height: 100 },
      { paperWidth: 120, paperHeight: 120, width: 120, height: 120 },
    ],
  }, store);
  const a = allocateOffcuts({ width: 90, height: 90, quantity: 1 }, store);
  assert.equal(a.items[0].offcut.area, 10000); // 小料被占
  // 再次预占：小料不参与，选 120 料
  const b = allocateOffcuts({ width: 90, height: 90, quantity: 1 }, store);
  assert.equal(b.items[0].offcut.area, 14400);
  // 第三次无料可占
  assert.throws(
    () => allocateOffcuts({ width: 90, height: 90, quantity: 1 }, store),
    (e) => e.statusCode === 409
  );

  const released = releaseAllocation(a.reservationId, store);
  assert.equal(released.releasedCount, 1);
  assert.deepEqual(released.items, [a.items[0].offcutId]);
  const q = queryOffcuts({ status: 'available' }, store);
  assert.equal(q.offcuts.length, 1);
  assert.equal(q.offcuts[0].area, 10000);
  assert.equal(q.offcuts[0].reservation, null);
  // 释放后小料重新可被预占
  const c = allocateOffcuts({ width: 90, height: 90, quantity: 1 }, store);
  assert.equal(c.items[0].offcut.area, 10000);

  // 重复释放 → 404
  assert.throws(() => releaseAllocation(a.reservationId, store), (e) => e.statusCode === 404);
});

test('确定性：同输入两次独立库存的预占选择序列完全一致', () => {
  function runAreas() {
    const store = createOffcutStore();
    ingestOffcuts({
      offcuts: [
        { paperWidth: 300, paperHeight: 200, width: 300, height: 200 },
        { paperWidth: 150, paperHeight: 150, width: 150, height: 150 },
        { paperWidth: 180, paperHeight: 140, width: 180, height: 140 },
        { paperWidth: 150, paperHeight: 150, width: 150, height: 150 },
      ],
    }, store);
    return allocateOffcuts({ width: 100, height: 100, quantity: 3 }, store)
      .items.map((it) => it.offcut.area);
  }
  const seq = runAreas();
  assert.deepEqual(runAreas(), seq);
  // 150×150 两条完全同形且剩余面积最小：按录入顺序先消耗（第一条）
  assert.deepEqual(seq.slice(0, 2), [22500, 22500]);
});

test('平局决胜：等剩余面积时短边/长边/不旋转/录入顺序', () => {
  const store = createOffcutStore();
  ingestOffcuts({
    offcuts: [
      { paperWidth: 200, paperHeight: 100, width: 200, height: 100 }, // 面积 20000，短边 100
      { paperWidth: 100, paperHeight: 200, width: 100, height: 200 }, // 同面积，短边 100（全等）
    ],
  }, store);
  const r = allocateOffcuts({ width: 80, height: 80, quantity: 1 }, store);
  // 全等余料：不旋转两向都可行，按录入顺序（先录入者）
  assert.equal(r.items[0].offcutId, 'OC-000001');
  assert.equal(r.items[0].rotated, false);
});

test('预占参数校验', () => {
  const store = createOffcutStore();
  ingestOffcuts({ offcuts: [{ paperWidth: 300, paperHeight: 300, width: 300, height: 300 }] }, store);
  assert.throws(() => allocateOffcuts({ width: 0, height: 10, quantity: 1 }, store), /成品宽/);
  assert.throws(() => allocateOffcuts({ width: 10, height: 10, quantity: 0 }, store), /正整数/);
  assert.throws(() => allocateOffcuts({ width: 10, height: 10, quantity: 1.5 }, store), /正整数/);
  assert.throws(() => allocateOffcuts({ width: 10, height: 10, quantity: 1, grain: 'x' }, store), /纹向/);
});

test('端到端守恒：入库面积 = 可用面积 + 已预占面积', () => {
  const store = createOffcutStore();
  ingestOffcuts({ batchRef: 'E2E', ...sampleLayout() }, store);
  const before = queryOffcuts({}, store).summary;
  const product = { width: 100, height: 100, quantity: 2, grain: 'any' };
  const alloc = allocateOffcuts(product, store);
  const after = queryOffcuts({}, store).summary;
  assert.equal(after.total, before.total);
  assert.equal(after.available + after.reserved, before.total);
  assert.ok(Math.abs(after.totalArea - before.totalArea) < EPS);
  assert.ok(Math.abs(
    after.reservedArea - alloc.items.reduce((s, it) => s + it.offcut.area, 0)
  ) < EPS);
  releaseAllocation(alloc.reservationId, store);
  const restored = queryOffcuts({}, store).summary;
  assert.equal(restored.available, before.available);
  assert.ok(Math.abs(restored.availableArea - before.availableArea) < EPS);
});

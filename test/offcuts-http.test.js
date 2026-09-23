'use strict';

const assert = require('node:assert');
const { test, after } = require('node:test');
const http = require('node:http');

// server.js 单例化了余料库存（进程内内存态），本文件只做 HTTP 链路与状态码校验；
// 选择 / 原子性等算法语义见 offcuts.test.js（对 createOffcutStore 独立测试）。
const app = require('../server');

const server = app.listen(0);
after(() => server.close());

function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port: server.address().port,
      path: urlPath,
      method,
      headers: payload
        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
        : {},
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let json = null;
        try { json = raw ? JSON.parse(raw) : null; } catch (_) { /* 非 JSON */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('健康检查', async () => {
  const r = await request('GET', '/api/health');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true });
});

test('余料入库 → 查询 → 原子预占（不足 409 且不扣减）→ 释放，HTTP 全链路', async () => {
  // 手工入库两条
  const ing = await request('POST', '/api/offcuts/ingest', {
    batchRef: 'HTTP-1',
    offcuts: [
      { paperName: '余料A', paperWidth: 100, paperHeight: 100, width: 100, height: 100 },
      { paperName: '余料B', paperWidth: 200, paperHeight: 200, grain: 'along-height', width: 200, height: 200 },
    ],
  });
  assert.equal(ing.status, 200);
  assert.equal(ing.json.createdCount, 2);
  assert.equal(ing.json.batchRef, 'HTTP-1');

  // 查询
  const q = await request('GET', '/api/offcuts?status=available');
  assert.equal(q.status, 200);
  const mine = q.json.offcuts.filter((o) => o.source.batchRef === 'HTTP-1');
  assert.equal(mine.length, 2);

  // 数量不足 → 409，含缺口明细
  const bad = await request('POST', '/api/offcuts/allocate', {
    width: 90, height: 90, quantity: 5, grain: 'any',
  });
  assert.equal(bad.status, 409);
  assert.equal(bad.json.code, 'OFFCUT_SHORTAGE');
  assert.ok(bad.json.shortage.gap >= 1);

  // 参数非法 → 400
  const invalid = await request('POST', '/api/offcuts/allocate', { width: -1, height: 90, quantity: 1 });
  assert.equal(invalid.status, 400);

  // 纹向筛选可行的预占（沿高余料 + 成品沿自身高，不旋转）
  const ok = await request('POST', '/api/offcuts/allocate', {
    width: 90, height: 90, quantity: 1, note: 'HTTP 预占',
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.allocatedCount, 1);
  assert.equal(ok.json.note, 'HTTP 预占');
  const reservationId = ok.json.reservationId;

  // 已预占记录以 reserved 状态可查
  const reserved = await request('GET', '/api/offcuts?status=reserved');
  assert.equal(reserved.status, 200);
  assert.ok(reserved.json.offcuts.some((o) => o.id === ok.json.items[0].offcutId));

  // 释放
  const rel = await request('POST', `/api/offcuts/release/${encodeURIComponent(reservationId)}`);
  assert.equal(rel.status, 200);
  assert.equal(rel.json.released, reservationId);
  assert.equal(rel.json.releasedCount, 1);

  // 重复释放 → 404
  const again = await request('POST', `/api/offcuts/release/${encodeURIComponent(reservationId)}`);
  assert.equal(again.status, 404);
});

test('排料结果可直接入库：提交 /api/layout 返回体到 ingest', async () => {
  const layout = await request('POST', '/api/layout', {
    paperW: 400, paperH: 300, kerf: 2,
    products: [{ width: 100, height: 80, quantity: 2 }],
  });
  assert.equal(layout.status, 200);
  assert.ok(layout.json.frees.length > 0);
  const ing = await request('POST', '/api/offcuts/ingest', {
    batchRef: 'HTTP-LAYOUT',
    ...layout.json,
  });
  assert.equal(ing.status, 200);
  assert.equal(ing.json.createdCount, layout.json.frees.length);
  const first = ing.json.offcuts[0];
  assert.equal(first.paperWidth, 400);
  assert.equal(first.paperHeight, 300);
  assert.equal(first.kerf, 2);
});

test('入库空 frees 返回 400', async () => {
  const r = await request('POST', '/api/offcuts/ingest', { foo: 1 });
  assert.equal(r.status, 400);
});

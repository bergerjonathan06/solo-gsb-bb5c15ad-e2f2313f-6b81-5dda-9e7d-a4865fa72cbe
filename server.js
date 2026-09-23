'use strict';

const path = require('node:path');
const express = require('express');
const { layout, layoutBatch, layoutCompare } = require('./src/packer');
const { layoutCostBatch } = require('./src/cost');
const { stackSchedule } = require('./src/stack');
const { workOrder, workOrderCsv } = require('./src/workorder');
const { workOrderProgress } = require('./src/progress');
const { samplingPlan } = require('./src/sampling');
const {
  createOffcutStore,
  ingestOffcuts,
  queryOffcuts,
  allocateOffcuts,
  releaseAllocation,
  OffcutError,
} = require('./src/offcuts');

// 余料库存为进程内内存态（单实例；重启清空，不依赖外部存储）
const offcutStore = createOffcutStore();

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// 叠纸排程会回传多张纸的完整切割树（最多 500 张），放宽请求体上限
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/api/layout', (req, res) => {
  try {
    const body = req.body || {};
    const result = layout(body);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message || '输入无效' });
  }
});

// 方案比选：同一输入按三种确定性策略分别试排，按比选目标择优
app.post('/api/layout/compare', (req, res) => {
  try {
    const body = req.body || {};
    const result = layoutCompare(body);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message || '输入无效' });
  }
});

// 批量排产：逐张排样直到完成 / 达到上限 / 某张纸无进展
app.post('/api/layout/batch', (req, res) => {
  try {
    const body = req.body || {};
    const result = layoutBatch(body);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message || '输入无效' });
  }
});

// 多纸型成本排产：2～8 种候选纸逐轮按单位面积成本择优
app.post('/api/layout/cost', (req, res) => {
  try {
    const body = req.body || {};
    const result = layoutCostBatch(body);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message || '输入无效' });
  }
});

// 叠纸裁切排程：复用批量/多纸型排产结果，把各张纸的断头台切割树
// 按合批规则（区域宽高、刀向、刀位、刀缝一致）与父刀先后约束转换为刀次
app.post('/api/layout/stack', (req, res) => {
  try {
    const body = req.body || {};
    const result = stackSchedule(body);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message || '输入无效' });
  }
});

// 执行工单：在叠纸排程结果上按班次容量（每班最多刀次、每批最多纸张）
// 做稳定拓扑拆分，输出班次/刀次清单、跨班次依赖与未分配刀；?format=csv 直接下载
app.post('/api/layout/stack/work-order', (req, res) => {
  try {
    const body = req.body || {};
    const format = typeof req.query.format === 'string'
      ? req.query.format
      : (typeof body.format === 'string' ? body.format : 'json');
    const result = workOrder(body);
    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="work-order.csv"');
      res.send(workOrderCsv(result));
      return;
    }
    if (format !== 'json') {
      res.status(400).json({ error: 'format 仅支持 json 或 csv' });
      return;
    }
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message || '输入无效' });
  }
});

// 现场进度：为工单中每个已分配刀次汇总全部成员纸张的父刀依赖，
// 接收已完成全局刀号，返回可立即执行/仍阻塞刀次、待完成父刀与班次/整单完成率
app.post('/api/layout/stack/work-order/progress', (req, res) => {
  try {
    const body = req.body || {};
    const result = workOrderProgress(body);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message || '输入无效' });
  }
});

// 裁切抽检计划：把每个已分配全局刀次作为必覆盖目标，一张纸被抽中即覆盖
// 其参与的全部刀次；按新增覆盖刀次→参与刀次总数→纸张序号逐轮选纸
app.post('/api/layout/stack/work-order/sampling', (req, res) => {
  try {
    const body = req.body || {};
    const result = samplingPlan(body);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message || '输入无效' });
  }
});

/* ---------------- 余料库存与复用预占 ---------------- */

// 余料入库：把排料结果（单张 layout / 批量 / 成本结果的 frees）或手工录入
// 标准化为可追踪余料记录（纸型、纹向、刀缝、坐标、尺寸、来源批次）
app.post('/api/offcuts/ingest', (req, res) => {
  try {
    const result = ingestOffcuts(req.body || {}, offcutStore);
    res.json(result);
  } catch (err) {
    offcutError(res, err);
  }
});

// 余料查询：可用 / 已预占，可按状态、纹向、来源类型、来源批次筛选
app.get('/api/offcuts', (req, res) => {
  try {
    const result = queryOffcuts(req.query || {}, offcutStore);
    res.json(result);
  } catch (err) {
    offcutError(res, err);
  }
});

// 复用预占：给定成品宽高、数量、纹向要求，按旋转/纹向可行性及最小剩余面积
// 确定性选料；一次请求原子预占足量余料，不足时不扣减任何记录并返回缺口明细（409）
app.post('/api/offcuts/allocate', (req, res) => {
  try {
    const result = allocateOffcuts(req.body || {}, offcutStore);
    res.json(result);
  } catch (err) {
    offcutError(res, err);
  }
});

// 释放预占：按预占单号释放其名下全部余料，恢复可用
app.post('/api/offcuts/release/:reservationId', (req, res) => {
  try {
    const result = releaseAllocation(req.params.reservationId, offcutStore);
    res.json(result);
  } catch (err) {
    offcutError(res, err);
  }
});

function offcutError(res, err) {
  if (err instanceof OffcutError) {
    const body = { error: err.message || '请求无效' };
    if (err.code) body.code = err.code;
    if (err.shortage) body.shortage = err.shortage;
    res.status(err.statusCode || 400).json(body);
    return;
  }
  res.status(400).json({ error: err.message || '请求无效' });
}

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`单张纸裁切试排服务已启动: http://localhost:${PORT}`);
  });
}

module.exports = app;

/* core.js 单元测试 —— node:test 零依赖。
   覆盖：iou / estimateDist（按类尺寸）/ Tracker（确认、悬停存活、老化分级、
   恒速预测、匹配闸门）/ MotionGate（预热、静态、阈值边界、运动框）/
   CFG 不变量 / index.html 内联脚本语法守护。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { CFG, estimateDist, iou, Tracker, MotionGate } = require('../web/core.js');

// 检出构造器：bbox [x,y,w,h] 归一化，cx/cy 为中心
function mk(x, y, w, h, cls = 'drone') {
  return { cls, conf: 0.9, bbox: [x, y, w, h], cx: x + w / 2, cy: y + h / 2 };
}

// ==================== iou ====================

test('iou 完全重合为 1（浮点容差）', () => {
  assert.ok(Math.abs(iou([0.1, 0.1, 0.2, 0.2], [0.1, 0.1, 0.2, 0.2]) - 1) < 1e-9);
});

test('iou 完全分离为 0', () => {
  assert.equal(iou([0, 0, 0.1, 0.1], [0.5, 0.5, 0.1, 0.1]), 0);
});

test('iou 半重叠为 1/3', () => {
  const v = iou([0, 0, 10, 10], [0, 5, 10, 10]);
  assert.ok(Math.abs(v - 1 / 3) < 1e-9, `半重叠应约为 ${1 / 3}，实际 ${v}`);
});

test('iou 包含关系为 16/100', () => {
  assert.ok(Math.abs(iou([0, 0, 10, 10], [2, 2, 4, 4]) - 0.16) < 1e-9);
});

test('iou 退化框（宽或高为 0）为 0', () => {
  assert.equal(iou([0, 0, 0, 10], [0, 0, 5, 5]), 0);
  assert.equal(iou([0, 0, 5, 5], [0, 0, 5, 0]), 0);
});

// ==================== estimateDist ====================

test('estimateDist 无人机数值回归（针孔模型）', () => {
  // apparent=(54/1080)*3.6e-3=1.8e-4；D=(4.4e-3*0.35)/1.8e-4=8.5555…
  const d = estimateDist(54, 1080, 'drone');
  assert.ok(Math.abs(d - 8.5556) < 1e-3, `drone 距离应约为 8.556m，实际 ${d}`);
});

test('estimateDist 鸟按 0.20m 尺寸，比无人机近', () => {
  const bird = estimateDist(54, 1080, 'bird');
  assert.ok(Math.abs(bird - 4.8889) < 1e-3, `bird 距离应约为 4.889m，实际 ${bird}`);
  assert.ok(bird < estimateDist(54, 1080, 'drone'));
});

test('estimateDist 未知类别回退默认尺寸（与 drone 一致）', () => {
  assert.equal(estimateDist(54, 1080, 'ufo'), estimateDist(54, 1080, 'drone'));
});

test('estimateDist 零尺寸框返回 null', () => {
  assert.equal(estimateDist(0, 1080, 'drone'), null);
});

// ==================== Tracker ====================

test('Tracker 两次检出达到确认计数', () => {
  const tr = new Tracker();
  tr.update([mk(0.4, 0.4, 0.2, 0.2)], 0);
  const out = tr.update([mk(0.4, 0.4, 0.2, 0.2)], 500);
  assert.equal(out.length, 1);
  const t = tr.tracks.get(out[0].id);
  assert.equal(t.count, 2);
  assert.equal(t.confirmed, true);
});

test('Tracker 悬停存活：巡检 5s 间隔刷新，已确认轨迹不被 2s 老化杀死', () => {
  // 悬停目标无帧差运动 → 只能靠 patrolInterval=5s 巡检检出；
  // 修复前 maxAge=2s < 5s → 轨迹被反复删除、确认计数清零、永远无法告警。
  const tr = new Tracker();
  tr.update([mk(0.4, 0.4, 0.2, 0.2)], 0);
  tr.update([mk(0.4, 0.4, 0.2, 0.2)], 500);
  for (const t of [5000, 10000, 11000]) {
    tr.update([mk(0.4, 0.4, 0.2, 0.2)], t);
    const track = tr.tracks.get(1);
    assert.ok(track, `t=${t}ms：已确认轨迹应存活（分级老化窗 ${CFG.confirmedMaxAge}ms）`);
    assert.equal(track.confirmed, true);
    assert.equal(track.count, 2 + [5000, 10000, 11000].indexOf(t) + 1);
  }
});

test('Tracker 未确认目标 2s 快速老化，远处新检出建新轨迹', () => {
  const tr = new Tracker();
  tr.update([mk(0.1, 0.1, 0.2, 0.2)], 0);          // id1，cx=0.2
  tr.update([mk(0.7, 0.7, 0.2, 0.2)], 2500);       // cx=0.8，距 0.85 > 0.35 闸门
  assert.equal(tr.tracks.get(1), undefined, '未确认轨迹 2500ms 后应被老化删除');
  const t2 = tr.tracks.get(2);
  assert.ok(t2, '应新建轨迹 id=2');
  assert.equal(t2.count, 1);
  assert.equal(t2.confirmed, false);
});

test('Tracker 恒速预测：加速目标在秒级检测间隔下不碎裂', () => {
  const tr = new Tracker();
  tr.update([mk(0.0, 0.4, 0.2, 0.2)], 0);          // cx=0.10
  tr.update([mk(0.1, 0.4, 0.2, 0.2)], 1000);       // cx=0.20 → vx≈0.04（平滑后）
  const out = tr.update([mk(0.2, 0.4, 0.2, 0.2)], 2000); // cx=0.30，预测位 0.24
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 1, '应匹配同一条轨迹而非新建');
  assert.equal(tr.tracks.get(1).count, 3);
});

test('Tracker 匹配闸门：远距检出判为新目标（归一化口径 0.35）', () => {
  const tr = new Tracker();
  tr.update([mk(0.05, 0.4, 0.2, 0.2)], 0);         // cx=0.15
  tr.update([mk(0.8, 0.4, 0.2, 0.2)], 200);        // cx=0.90，距 0.75 > 0.35
  assert.equal(tr.tracks.size, 2, '应并存两条轨迹');
  assert.ok(tr.tracks.get(1) && tr.tracks.get(2));
});

// ==================== MotionGate ====================

const GW = 96, GH = 54;
function baseGray() { return new Uint8Array(GW * GH).fill(100); }

test('MotionGate 首帧只预热不触发', () => {
  const g = new MotionGate();
  assert.deepEqual(g.detect(baseGray(), GW, GH), []);
});

test('MotionGate 静止画面不触发，lastRatio 为 0', () => {
  const g = new MotionGate();
  g.detect(baseGray(), GW, GH);
  assert.deepEqual(g.detect(baseGray(), GW, GH), []);
  assert.equal(g.lastRatio, 0);
});

test('MotionGate 单像素运动低于面积门槛不触发', () => {
  const g = new MotionGate();
  g.detect(baseGray(), GW, GH);
  const f = baseGray();
  f[5 * GW + 10] = 130;                             // 1/5184 ≈ 0.00019 ≤ 0.003
  assert.deepEqual(g.detect(f, GW, GH), []);
  assert.ok(g.lastRatio > 0 && g.lastRatio <= CFG.minAreaRatio);
});

test('MotionGate 16 像素块越过面积门槛，运动框覆盖变化区', () => {
  const g = new MotionGate();
  g.detect(baseGray(), GW, GH);
  const f = baseGray();
  for (let dy = 0; dy < 4; dy++)
    for (let dx = 0; dx < 4; dx++)
      f[(5 + dy) * GW + (10 + dx)] = 130;           // 16/5184 ≈ 0.00309 > 0.003
  const boxes = g.detect(f, GW, GH);
  assert.equal(boxes.length, 1);
  assert.deepEqual(boxes[0], { x: 10, y: 5, w: 3, h: 3 });
  assert.ok(g.lastRatio > CFG.minAreaRatio);
});

test('MotionGate 像素差阈值边界：恰为 25 不触发，26 触发', () => {
  // 小网格 8×4=32 像素：1 像素变化占比 0.03125 必过面积门槛，只考验差值阈值
  let g = new MotionGate();
  g.detect(new Uint8Array(32).fill(100), 8, 4);
  const f25 = new Uint8Array(32).fill(100); f25[0] = 125;
  assert.deepEqual(g.detect(f25, 8, 4), [], '差值恰为 25 不应触发（严格大于）');
  g = new MotionGate();
  g.detect(new Uint8Array(32).fill(100), 8, 4);
  const f26 = new Uint8Array(32).fill(100); f26[0] = 126;
  assert.equal(g.detect(f26, 8, 4).length, 1, '差值 26 应触发');
});

// ==================== CFG 不变量与产物完整性 ====================

test('CFG 不变量：已确认老化窗必须大于巡检间隔（悬停存活的前提）', () => {
  assert.ok(CFG.confirmedMaxAge > CFG.patrolInterval,
    `confirmedMaxAge(${CFG.confirmedMaxAge}) 必须 > patrolInterval(${CFG.patrolInterval})`);
});

test('index.html 内联脚本语法守护（抽取后不得残留旧定义）', () => {
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const m = html.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/);
  assert.ok(m, '内联脚本块应存在');
  assert.doesNotThrow(() => new Function(m[1]), '内联脚本语法应合法');
  assert.match(html, /<script src="\.\/core\.js"><\/script>/, '应引入 core.js');
  for (const legacy of ['const CFG = {', 'function iou(', 'class Tracker', 'class MotionGate']) {
    assert.ok(!m[1].includes(legacy), `旧定义不应残留：${legacy}`);
  }
});

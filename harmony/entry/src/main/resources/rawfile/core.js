/* ============================================================
   core.js - 反无人机监控 · 纯逻辑核心（零 DOM 依赖，可单测）
   ------------------------------------------------------------
   从 index.html 内联脚本抽取：配置 / 距离估算 / IoU / 目标跟踪 /
   帧差运动门控。浏览器端由 index.html 以 <script src> 先行加载
   （经典 script 顶层 const 跨 script 可见）；Node 端经文件尾部的
   module.exports 直接 require，供 node:test 单元测试使用。
   ============================================================ */
"use strict";

// ---------- 配置(与 Python 管线对齐) ----------
const CFG = {
  motionThresh: 25,        // 帧差阈值
  minAreaRatio: 0.003,     // 运动面积门槛(占门控网格)：~15px@96×54，抑制传感器噪声/AE 抖动
  confirmCount: 2,         // 多帧确认次数
  matchMaxDist: 0.35,      // 跟踪匹配的最大中心距(归一化坐标；超过即视为新目标)
  motionDetInterval: 400,  // 快系统检出运动时，慢系统检测的最小间隔(ms)
  patrolInterval: 5000,    // 无运动时巡检间隔(ms)
  reconfirmInterval: 30000,// 已确认目标的重复告警间隔(ms)
  maxAge: 2000,            // 未确认目标老化(ms)：瞬态噪声快速消亡
  confirmedMaxAge: 12000,  // 已确认目标老化(ms)：必须 > 巡检间隔——悬停目标无帧差运动，
                           // 靠巡检续命，若老化窗 < 巡检间隔，确认计数会被反复清零（悬停必丢）
  iouThresh: 0.1,
  focalMeters: 4.4e-3,     // 手机等效焦距(米)
  sensorHM: 3.6e-3,        // 传感器高度(米)
  droneSizeM: 0.35,        // 兜底目标实际尺寸(米, Mavic级)
  // 距离估算按类别取目标实际尺寸（粗估口径：尺寸假设直接决定绝对距离）
  sizeByClass: { drone: 0.35, bird: 0.20 },
};

// ---------- 几何：距离估算(针孔模型) ----------
function estimateDist(bboxHpx, frameHpx, cls){
  // D = (f * H_obj * frameH) / (h_px * sensorH)
  // 注意：数字变焦只是 canvas 中心裁剪，检测始终在全帧上进行，
  // 目标在全帧中的像素高度不随 zoom 变化——故这里不能除以 zoom
  const sizeM = (cls && CFG.sizeByClass[cls]) || CFG.droneSizeM;
  const normalized = bboxHpx / frameHpx;          // 占画面高度比例
  const apparent = normalized * CFG.sensorHM;      // 像平面高度(米)
  if(apparent<=0) return null;
  return (CFG.focalMeters * sizeM) / apparent;
}

// ---------- IoU（框格式统一为 [x,y,w,h] 归一化数组） ----------
function iou(a,b){
  const x1=Math.max(a[0],b[0]),y1=Math.max(a[1],b[1]);
  const x2=Math.min(a[0]+a[2],b[0]+b[2]),y2=Math.min(a[1]+a[3],b[1]+b[3]);
  const iw=Math.max(0,x2-x1),ih=Math.max(0,y2-y1);
  if(iw<=0||ih<=0) return 0;
  const inter=iw*ih, ua=a[2]*a[3]+b[2]*b[3]-inter;
  return ua>0?inter/ua:0;
}

// ---------- 目标跟踪器(IoU+中心距离, 恒速预测, 分级老化) ----------
class Tracker{
  constructor(){ this.tracks=new Map(); this.nextId=1; }
  update(dets,now){
    const active=new Set();
    for(const d of dets){
      let best=null,bestScore=1e9;
      for(const [id,t] of this.tracks){
        if(active.has(id)) continue;
        // 恒速预测：两次检测间隔 0.4~5s，快速目标直接比对新位置必然错配
        const dt=(now-t.last)/1000;
        const px=t.cx+(t.vx||0)*dt, py=t.cy+(t.vy||0)*dt;
        const shiftX=px-t.cx, shiftY=py-t.cy;
        const pred=[t.box[0]+shiftX,t.box[1]+shiftY,t.box[2],t.box[3]];
        const dist=Math.hypot(px-d.cx,py-d.cy);
        const i=iou(pred,d.bbox);
        const score=dist - i*200;   // IoU 优先,中心距离兜底
        if(score<bestScore){bestScore=score;best=id;}
      }
      // 匹配闸门：中心距超 matchMaxDist（归一化）即视为新目标——
      // 否则任意两个检出永远互相匹配（坐标是 0-1，而阈值若是像素口径形同虚设）
      if(best!==null && bestScore<CFG.matchMaxDist){
        const t=this.tracks.get(best);
        const dt=(now-t.last)/1000;
        if(dt>0.01){
          const vx=(d.cx-t.cx)/dt, vy=(d.cy-t.cy)/dt;
          t.vx=(t.vx||0)*0.6+vx*0.4; t.vy=(t.vy||0)*0.6+vy*0.4;  // 速度一阶平滑
        }
        t.box=d.bbox.slice(); t.cx=d.cx; t.cy=d.cy; t.cls=d.cls;
        t.last=now; t.count++;
        active.add(best);
        if(t.count>=CFG.confirmCount) t.confirmed=true;
        d.trackId=best; d.dup=t.count;
      }else{
        const id=this.nextId++;
        this.tracks.set(id,{id,box:d.bbox.slice(),cx:d.cx,cy:d.cy,vx:0,vy:0,
          cls:d.cls,last:now,count:1,confirmed:false});
        active.add(id); d.trackId=id; d.dup=1;
      }
    }
    // 分级老化：未确认噪声快速消亡；已确认目标给更长存活窗
    for(const [id,t] of this.tracks){
      const ttl = t.confirmed ? CFG.confirmedMaxAge : CFG.maxAge;
      if(now-t.last>ttl) this.tracks.delete(id);
    }
    return [...this.tracks.values()].filter(t=>active.has(t.id));
  }
  getConfirmed(){ return [...this.tracks.values()].filter(t=>t.confirmed); }
}

// ---------- 帧差运动门控(快系统)：逐帧廉价运行，有运动才升级慢系统检测 ----------
class MotionGate{
  constructor(){ this.prev=null; this.lastRatio=0; }
  // gray: 扁平灰度数组；返回降采样坐标系运动框，无运动返回 []
  // lastRatio: 本帧运动像素占比（供遥测采集，做离线阈值校准）
  detect(gray,gw,gh){
    this.lastRatio=0;
    if(this.prev===null || this.prev.length!==gray.length){
      this.prev=gray;   // gray 每帧新建，可直接持有
      return [];
    }
    let cnt=0,minX=gw,maxX=0,minY=gh,maxY=0;
    for(let i=0;i<gray.length;i++){
      if(Math.abs(gray[i]-this.prev[i])>CFG.motionThresh){
        cnt++;
        const x=i%gw, y=(i/gw)|0;
        if(x<minX)minX=x; if(x>maxX)maxX=x; if(y<minY)minY=y; if(y>maxY)maxY=y;
      }
    }
    this.prev=gray;
    this.lastRatio=cnt/gw/gh;
    if(!cnt || this.lastRatio<=CFG.minAreaRatio) return [];
    return [{x:minX,y:minY,w:maxX-minX,h:maxY-minY}];
  }
}

// ---------- Node 单测入口（浏览器端 module 未定义，此块不执行） ----------
if (typeof module!=='undefined' && module.exports) {
  module.exports = { CFG, estimateDist, iou, Tracker, MotionGate };
}

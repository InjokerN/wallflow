// 网页壁纸的 postMessage 桥：把调节项与光标事件转发进沙箱里的壁纸页面。
//
// 背景：壁纸 HTML 是第三方内容（工坊导入 / 云端下载），iframe 不能再给
// allow-same-origin（否则壁纸页能摘掉自己的沙箱、反过来调后端 API）。
// 沙箱化之后宿主拿不到页面里的 wallpaperPropertyListener，所以由这里
// 在 HTML 响应里注入一小段适配脚本：页面收 postMessage，桥转发给
// wallpaperPropertyListener / 合成鼠标事件 —— WE 的接入协议保持不变，
// 壁纸包不需要任何改动，导出 / 打包也不受影响（磁盘文件不动）。
//
// 只对「作为文档加载的 HTML」注入（Sec-Fetch-Dest = document/iframe/frame，
// 且路径在 /media 或 /api/v1/we/media 下）；静态子资源、SSE、API JSON 一律直通。
// 文档响应做小额缓冲（壁纸 HTML 几十~几百 KB），注入后修正 Content-Length。
import path from 'node:path';

const BRIDGE = "<script>(function(){var q=[],n=0;function deliver(m){try{var lp=window.wallpaperPropertyListener;if(lp&&typeof lp.applyUserProperties===\"function\"){lp.applyUserProperties(m.payload);}else if(n++<600){q.push(m);}}catch(e){}}function deliverFps(m){try{var lp=window.wallpaperPropertyListener;if(lp&&typeof lp.applyGeneralProperties===\"function\"){lp.applyGeneralProperties({fps:m.fps});return true;}return false;}catch(e){return false;}}var fpsPending=null;var t=setInterval(function(){while(q.length){deliver(q.shift());}if(fpsPending!==null&&deliverFps({fps:fpsPending})){fpsPending=null;}if(n>600){clearInterval(t);}},100);window.addEventListener(\"keydown\",function(ev){if(ev.key===\"Escape\"){try{window.parent.postMessage({source:\"wallflow-bridge\",type:\"wf-esc\"},\"*\");}catch(e){}}},true);window.addEventListener(\"message\",function(ev){var d=ev.data;if(!d||d.source!==\"wallflow-host\")return;if(d.type===\"wf-props\"){deliver(d);return;}if(d.type===\"wf-fps\"){fpsPending=d.fps;deliverFps(d);return;}if(d.type===\"wf-cursor\"){try{var x=d.x,y=d.y,btn=d.buttons||0;var Ctor=/^pointer/.test(d.event)?(window.PointerEvent||window.MouseEvent):window.MouseEvent;if(!Ctor)return;var e2=new Ctor(d.event,{bubbles:true,cancelable:true,composed:true,view:window,clientX:x,clientY:y,screenX:x,screenY:y,button:0,buttons:btn,pointerId:1,pointerType:\"mouse\",isPrimary:true});var tgt=document.elementFromPoint(x,y)||document.body||document.documentElement;if(tgt)tgt.dispatchEvent(e2);}catch(e){}}});})();</script>";
const MAX_BUFFER = 8 * 1024 * 1024;

export function bridgeMiddleware() {
  return (req, res, next) => {
    const p = req.path || '';
    if (!p.startsWith('/media/') && !p.startsWith('/api/v1/we/media/')) return next();

    const dest = String(req.headers['sec-fetch-dest'] || '').toLowerCase();
    const maybeDoc = dest
      ? (dest === 'document' || dest === 'iframe' || dest === 'frame')
      : (p.endsWith('.html') || !path.extname(p));
    if (!maybeDoc) return next();

    const chunks = [];
    let done = false;
    const origWrite = res.write.bind(res);
    const origEnd = res.end.bind(res);
    res.write = function (chunk, ...args) {
      if (done) return origWrite(chunk, ...args);
      const enc = typeof args[0] === 'string' ? args[0] : undefined;
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, enc));
      return true;
    };
    res.end = function (chunk, ...args) {
      if (done) return origEnd(chunk, ...args);
      done = true;
      if (chunk) {
        const enc = typeof args[0] === 'string' ? args[0] : undefined;
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, enc));
      }
      let body = Buffer.concat(chunks);
      const ct = String(res.getHeader('Content-Type') || '');
      // 超 8MB 的"疑似文档"（比如直接用标签页打开大视频）不注入，原样发出
      if (/^text\/html\b/i.test(ct) && body.length <= MAX_BUFFER) {
        body = Buffer.concat([Buffer.from(BRIDGE, 'utf8'), body]);
        res.setHeader('Content-Length', body.length);
        res.removeHeader('Transfer-Encoding');
      }
      return origEnd(body);
    };
    next();
  };
}

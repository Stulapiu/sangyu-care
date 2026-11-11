/* ============================================================
   桑榆智援 · 语音 / 手写识别适配层
   ------------------------------------------------------------
   ★ 接入真实服务的位置集中在本文件 ★

   1) 语音识别（ASR）：把下方 config.endpoint 填成你的识别服务地址，
      config.apiKey 填密钥，即自动从「原型演示」切换为真实调用。
      约定：POST {endpoint}
            Header: Authorization: Bearer <apiKey>
            Body  : FormData  audio=<Blob>  format=webm  dialect=zhongyuan
            Resp  : { "text": "识别出的文本" }
      如果你用讯飞/智谱等需要签名的服务，请在 requestASR() 里补充签名逻辑，
      保持返回 { text } 即可，其余页面代码无需改动。

   2) 手写识别：同理，填写 config.handwritingEndpoint。
      约定：POST 图片 Blob，返回 { "text": "..." }

   3) 语音播报使用浏览器内置语音合成（Web Speech API），无需密钥。
   ============================================================ */
(function (global) {
  'use strict';

  const CFG_KEY = 'SY_SPEECH_CFG_V1';
  const D = global.SY_DATA;

  const DEFAULTS = {
    provider: 'auto',          // auto = 中继服务在线就真识别，否则退回原型演示
    endpoint: 'http://localhost:8124/asr',   // asr-relay/asr_server.py 提供的接口
    apiKey: 'local-relay',     // 中继不走鉴权，真实讯飞密钥放在 asr-relay/config.json
    appId: '',                 // 讯飞 APPID（服务端配置，这里仅展示）
    appSecret: '',             // 讯飞 APISecret（服务端配置，切勿放前端）
    dialect: 'zhongyuan',      // 方言参数：中原官话
    language: 'zh-CN',
    handwritingEndpoint: '',   // 手写识别接口地址（预留）
    handwritingKey: '',
    ttsEnabled: true,
    ttsRate: 0.95
  };

  function loadConfig() {
    try {
      const raw = localStorage.getItem(CFG_KEY);
      const saved = raw ? JSON.parse(raw) : null;
      const cfg = Object.assign({}, DEFAULTS);
      // 存下来是空串的字段视为「没配」，用默认值兜底，避免误清空后整个识别失效
      if (saved && typeof saved === 'object') {
        Object.keys(saved).forEach(k => {
          const v = saved[k];
          if (v !== '' && v !== null && v !== undefined) cfg[k] = v;
        });
      }
      return cfg;
    } catch (e) { return Object.assign({}, DEFAULTS); }
  }
  function saveConfig(patch) {
    const next = Object.assign(loadConfig(), patch || {});
    localStorage.setItem(CFG_KEY, JSON.stringify(next));
    return next;
  }
  function isConfigured() {
    const c = loadConfig();
    return !!(c.endpoint && c.apiKey) && c.provider !== 'mock';
  }

  /* ---------------- 中继服务探测 ----------------
     老人端一打开就问一次 /health：
       在线  → 真识别（讯飞方言听写）
       离线  → 安静地退回原型演示，绝不报错、绝不白屏
     ---------------------------------------------------- */
  let relayOk = null;          // null=还没探过  true=在线  false=离线
  function probe() {
    const c = loadConfig();
    if (!c.endpoint) { relayOk = false; return Promise.resolve(false); }
    const base = c.endpoint.replace(/\/asr\/?$/, '');
    return fetch(base + '/health', { cache: 'no-store' })
      .then(r => r.json())
      .then(j => { relayOk = !!(j && j.ok && j.configured); return relayOk; })
      .catch(() => { relayOk = false; return false; });
  }

  function realMode() {
    const c = loadConfig();
    if (c.provider === 'mock') return false;
    if (!c.endpoint || !c.apiKey) return false;
    if (c.provider === 'custom') return true;      // 手动指定，失败也让上层感知
    return relayOk === true;                        // auto：只有探到才用真的
  }

  function relayState() { return relayOk; }
  function isHandwritingConfigured() {
    const c = loadConfig();
    return !!(c.handwritingEndpoint && c.handwritingKey);
  }

  /* ---------------- 麦克风录音 ---------------- */
  let recorder = null, chunks = [], stream = null;

  function startRecording() {
    return new Promise((resolve, reject) => {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        reject(new Error('当前浏览器不支持麦克风采集')); return;
      }
      navigator.mediaDevices.getUserMedia({ audio: true }).then(s => {
        stream = s;
        chunks = [];
        try { recorder = new MediaRecorder(s); } catch (e) { reject(e); return; }
        recorder.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
        recorder.start();
        resolve();
      }).catch(err => reject(err));
    });
  }

  function stopRecording() {
    return new Promise(resolve => {
      if (!recorder || recorder.state === 'inactive') { resolve(null); return; }
      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: 'audio/webm' });
        if (stream) stream.getTracks().forEach(t => t.stop());
        resolve(blob);
      };
      recorder.stop();
    });
  }

  /* ---------------- 真实 ASR 调用 ---------------- */
  async function requestASR(blob) {
    const cfg = loadConfig();
    if (!cfg.endpoint) throw new Error('未配置语音识别接口');
    const fd = new FormData();
    fd.append('audio', blob, 'speech.webm');
    fd.append('format', 'webm');
    fd.append('dialect', cfg.dialect);
    fd.append('language', cfg.language);

    const headers = {};
    if (cfg.apiKey) headers['Authorization'] = 'Bearer ' + cfg.apiKey;

    const res = await fetch(cfg.endpoint, { method: 'POST', headers, body: fd });
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }

    // 中继约定：{ ok, text } / { ok:false, error }
    if (data && data.ok === false) throw new Error(data.error || '识别失败');
    if (!res.ok) throw new Error('识别服务返回 ' + res.status);

    const text = (data && (data.text || data.result))
      || (data && data.data && data.data.text) || '';
    if (!text) throw new Error('识别结果为空');
    return text;
  }

  /* ---------------- 原型演示：模拟识别 ---------------- */
  let sampleIdx = 0;
  function nextSample() {
    const s = D.asrSamples[sampleIdx % D.asrSamples.length];
    sampleIdx++;
    return s;
  }

  /**
   * 开始一次语音输入
   * @param {Object} o
   *   onPartial(text)  实时中间结果
   *   onFinal(text, meta) 最终结果
   *   onError(err)
   *   onLevel(v)       0~1 音量（用于波形动画，模拟模式随机）
   */
  function listen(o) {
    o = o || {};
    let stopped = false, timers = [], rafId = null, audioCtx = null, analyser = null;

    const cfg = loadConfig();

    function cleanup() {
      timers.forEach(clearTimeout);
      timers = [];
      if (rafId) cancelAnimationFrame(rafId);
      if (audioCtx) { try { audioCtx.close(); } catch (e) {} audioCtx = null; }
    }

    const useReal = realMode();

    if (useReal) {
      // —— 真实链路 ——
      startRecording().then(() => {
        // 音量回调
        try {
          audioCtx = new (window.AudioContext || window.webkitAudioContext)();
          const src = audioCtx.createMediaStreamSource(stream);
          analyser = audioCtx.createAnalyser();
          analyser.fftSize = 512;
          src.connect(analyser);
          const buf = new Uint8Array(analyser.frequencyBinCount);
          const loop = () => {
            if (stopped) return;
            analyser.getByteFrequencyData(buf);
            let sum = 0;
            for (let i = 0; i < buf.length; i++) sum += buf[i];
            o.onLevel && o.onLevel(Math.min(1, sum / buf.length / 90));
            rafId = requestAnimationFrame(loop);
          };
          loop();
        } catch (e) {}
      }).catch(err => {
        o.onError && o.onError(err);
      });
    } else {
      // —— 原型演示：不占用麦克风，仅模拟声压 ——
      const tick = () => {
        if (stopped) return;
        o.onLevel && o.onLevel(0.28 + Math.random() * 0.62);
        rafId = requestAnimationFrame(tick);
      };
      rafId = requestAnimationFrame(tick);
    }

    return {
      stop() {
        if (stopped) return;
        stopped = true;
        cleanup();

        if (useReal) {
          stopRecording().then(async blob => {
            if (!blob) { o.onError && o.onError(new Error('未采集到音频')); return; }
            try {
              const text = await requestASR(blob);
              o.onFinal && o.onFinal(text, { real: true });
            } catch (err) {
              o.onError && o.onError(err);
            }
          });
          return;
        }

        // 模拟：逐字吐字，营造真实识别过程
        const full = nextSample();
        let i = 0;
        const step = () => {
          i += Math.max(1, Math.round(full.length / 14));
          o.onPartial && o.onPartial(full.slice(0, Math.min(i, full.length)));
          if (i < full.length) timers.push(setTimeout(step, 85));
          else o.onFinal && o.onFinal(full, { real: false });
        };
        timers.push(setTimeout(step, 220));
      }
    };
  }

  /* ---------------- 手写识别 ---------------- */
  async function recognizeHandwriting(dataUrl) {
    const cfg = loadConfig();
    if (cfg.handwritingEndpoint && cfg.handwritingKey) {
      const blob = await (await fetch(dataUrl)).blob();
      const fd = new FormData();
      fd.append('image', blob, 'handwriting.png');
      const res = await fetch(cfg.handwritingEndpoint, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + cfg.handwritingKey },
        body: fd
      });
      if (!res.ok) throw new Error('手写识别服务返回 ' + res.status);
      const data = await res.json();
      return { text: data.text || '', simulated: false };
    }
    // 原型演示：返回一条示意结果
    await new Promise(r => setTimeout(r, 900));
    const pool = ['家里水管漏水了', '需要送一份午饭', '灯泡坏了看不见', '想申请高龄补贴'];
    return { text: pool[Math.floor(Math.random() * pool.length)], simulated: true };
  }

  /* ---------------- 语音播报 ---------------- */
  let voicesCache = [];
  function voices() {
    if (voicesCache.length) return voicesCache;
    voicesCache = (global.speechSynthesis && speechSynthesis.getVoices()) || [];
    return voicesCache;
  }
  if (global.speechSynthesis) {
    speechSynthesis.onvoiceschanged = () => { voicesCache = speechSynthesis.getVoices(); };
  }

  function speak(text, opts) {
    opts = opts || {};
    const cfg = loadConfig();
    return new Promise(resolve => {
      if (!cfg.ttsEnabled || !global.speechSynthesis) { resolve(false); return; }
      try { speechSynthesis.cancel(); } catch (e) {}
      const u = new SpeechSynthesisUtterance(text);
      u.lang = cfg.language || 'zh-CN';
      u.rate = opts.rate || cfg.ttsRate || 0.95;
      u.pitch = 1.02;
      const list = voices();
      const zh = list.find(v => /zh[-_]CN/i.test(v.lang) && /Xiaoxiao|Huihui|Yaoyao|Ting|Chinese/i.test(v.name))
        || list.find(v => /zh/i.test(v.lang));
      if (zh) u.voice = zh;
      u.onend = () => resolve(true);
      u.onerror = () => resolve(false);
      setTimeout(() => { try { speechSynthesis.speak(u); } catch (e) { resolve(false); } }, 60);
      // 兜底：部分环境不触发 onend
      setTimeout(() => resolve(true), Math.min(16000, 1200 + text.length * 190));
    });
  }
  function stopSpeak() { try { speechSynthesis.cancel(); } catch (e) {} }

  global.Speech = {
    DEFAULTS, loadConfig, saveConfig, isConfigured, isHandwritingConfigured,
    probe, realMode, relayState,
    listen, recognizeHandwriting, speak, stopSpeak,
    supportsMic: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
    supportsTTS: !!global.speechSynthesis
  };
})(window);

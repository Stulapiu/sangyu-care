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
    handwritingEndpoint: 'http://localhost:8124/hw',   // 本机中继 → DeepSeek 视觉识别
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

  /* ---------------- 麦克风环境诊断 ----------------
     三种情况下按钮点了没反应，原因各不相同，必须分别说清楚：
       1) file:// 打开 → 浏览器直接不给 mediaDevices（最常见的坑）
       2) 没起中继   → 以前会静默走演示，看起来像「麦克风坏了」
       3) 权限被拒 / 设备被占用
     ---------------------------------------------------- */
  const MIC_INSECURE = '当前是本地文件打开，浏览器不允许用麦克风；请用 http://localhost:8123 或线上 https 地址打开';

  function micEnv() {
    const secure = !!global.isSecureContext;
    const hasGUM = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    const SR = global.SpeechRecognition || global.webkitSpeechRecognition;
    return {
      secure: secure,
      hasGUM: hasGUM,
      supported: secure && hasGUM,
      browserASR: !!(secure && SR),      // 浏览器原生识别（Edge/Chrome），不需要中继
      insecure: !secure
    };
  }

  function toMicError(err) {
    const n = (err && err.name) || '';
    const env = micEnv();
    if (env.insecure) return new Error(MIC_INSECURE);
    if (n === 'NotAllowedError' || n === 'PermissionDeniedError' || n === 'not-allowed')
      return new Error('麦克风权限被拒绝了，点地址栏左边的锁形图标允许麦克风后重试');
    if (n === 'NotFoundError' || n === 'DevicesNotFoundError' || n === 'audio-capture')
      return new Error('没有检测到麦克风，检查一下设备有没有插好');
    if (n === 'NotReadableError' || n === 'TrackStartError')
      return new Error('麦克风被别的程序占用了（微信、会议软件之类），关掉再试');
    return new Error((err && err.message) || '麦克风没启动起来');
  }

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
  function withTimeout(promise, ms, msg) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(msg)), ms);
      promise.then(v => { clearTimeout(t); resolve(v); },
                   e => { clearTimeout(t); reject(e); });
    });
  }

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

    let res;
    try {
      res = await withTimeout(
        fetch(cfg.endpoint, { method: 'POST', headers, body: fd }),
        25000,
        '识别服务 25 秒没回应，看看 asr-relay 窗口是不是报错了');
    } catch (e) {
      if (e && e.message && e.message.indexOf('没回应') >= 0) throw e;
      throw new Error('连不上本机识别服务（' + (e.message || '网络错误') + '），确认 asr-relay 已启动');
    }
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

    /* ---- 音量条：拿到麦克风才画，拿不到也不影响识别 ---- */
    let meterStream = null, meterOwned = false;
    function startMeter(existing) {
      if (!existing && !micEnv().supported) return Promise.resolve(false);
      const p = existing ? Promise.resolve(existing) : navigator.mediaDevices.getUserMedia({ audio: true });
      return p.then(s => {
        if (!existing) { meterStream = s; meterOwned = true; }
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const src = audioCtx.createMediaStreamSource(s);
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
        return true;
      }).catch(() => false);
    }
    function releaseMeter() {
      if (meterOwned && meterStream) {
        try { meterStream.getTracks().forEach(t => t.stop()); } catch (e) {}
      }
      meterStream = null; meterOwned = false;
    }

    /* ---- 浏览器原生识别：中继没起时的真实兜底（Edge / Chrome 自带） ---- */
    let recog = null, brFinal = '', brInterim = '';
    function startBrowserASR() {
      const SR = global.SpeechRecognition || global.webkitSpeechRecognition;
      try { recog = new SR(); } catch (e) { o.onError && o.onError(toMicError(e)); return; }
      recog.lang = cfg.language || 'zh-CN';
      recog.continuous = true;
      recog.interimResults = true;
      recog.maxAlternatives = 1;
      recog.onresult = ev => {
        brInterim = '';
        for (let i = ev.resultIndex; i < ev.results.length; i++) {
          const r = ev.results[i];
          const t = (r[0] && r[0].transcript) || '';
          if (r.isFinal) brFinal += t; else brInterim += t;
        }
        o.onPartial && o.onPartial((brFinal + brInterim).slice(0, 200));
      };
      recog.onerror = ev => {
        const code = (ev && ev.error) || '';
        if (code === 'no-speech' || code === 'aborted') return;
        if (code === 'network' || code === 'service-not-allowed') {
          o.onError && o.onError(new Error('这台机器连不上在线语音识别，换 Chrome/Edge 或启动本地识别服务再试'));
          return;
        }
        o.onError && o.onError(toMicError({ name: code }));
      };
      recog.onend = () => {
        // 浏览器因静音自己截断：已经有字就当用户说完了
        if (!stopped && (brFinal + brInterim).trim()) stop();
      };
      try { recog.start(); } catch (e) { o.onError && o.onError(toMicError(e)); }
      startMeter();
    }

    /* ---- 选路：中继 > 浏览器原生识别 > 演示 ---- */
    const env = micEnv();
    let mode = 'mock';
    if (cfg.provider !== 'mock') {
      if (realMode()) mode = 'relay';
      else if (env.browserASR) mode = 'browser';
    }

    if (mode === 'relay') {
      startRecording().then(() => startMeter(stream)).catch(err => {
        o.onError && o.onError(toMicError(err));
      });
    } else if (mode === 'browser') {
      startBrowserASR();
    } else if (env.insecure) {
      // 双击 html 用 file:// 打开时，浏览器根本不给麦克风，必须说清楚
      o.onError && o.onError(new Error(MIC_INSECURE));
    } else {
      // —— 原型演示：不占用麦克风，仅模拟声压 ——
      const tick = () => {
        if (stopped) return;
        o.onLevel && o.onLevel(0.28 + Math.random() * 0.62);
        rafId = requestAnimationFrame(tick);
      };
      rafId = requestAnimationFrame(tick);
    }

    function stop() {
      if (stopped) return;
      stopped = true;

      if (mode === 'relay') {
        withTimeout(stopRecording(), 6000, '录音没停下来').then(async blob => {
          cleanup(); releaseMeter();
          if (!blob || !blob.size) {
            o.onError && o.onError(new Error('这次没采到声音，说慢一点、多说两秒再点停止'));
            return;
          }
          if (blob.size < 1200) {
            o.onError && o.onError(new Error('说话时间太短了，多说两句再点停止'));
            return;
          }
          try {
            const text = await requestASR(blob);
            o.onFinal && o.onFinal(text, { real: true, engine: 'relay' });
          } catch (err) {
            const m = (err && err.message) || '';
            o.onError && o.onError(new Error(/连不上|没回应/.test(m) ? m : '识别服务出错了：' + m));
          }
        }).catch(err => {
          cleanup(); releaseMeter();
          o.onError && o.onError(new Error(err.message || '录音失败'));
        });
        return;
      }

      if (mode === 'browser') {
        try { recog && recog.stop(); } catch (e) {}
        // 停止后浏览器往往还要一会儿才吐出最后一段结果，等 1.3 秒再判断，
        // 否则用户刚说完就点停止，会被误判成「没听到」。
        const finish = () => {
          cleanup(); releaseMeter();
          const text = (brFinal + brInterim).trim();
          if (text) o.onFinal && o.onFinal(text, { real: true, engine: 'browser' });
          else o.onError && o.onError(new Error('没听到声音，靠近一点再说一次'));
        };
        timers.push(setTimeout(finish, 1300));
        return;
      }

      cleanup(); releaseMeter();
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

    return { stop, mode: function () { return mode; } };
  }

  /* ---------------- 手写识别 ----------------
     链路：canvas 待 base64 → 本机中继 /hw → DeepSeek 视觉模型 → 文字
     密钥放在 asr-relay/config.json，不进前端。
     ---------------------------------------------------- */
  function pageIsLocal() {
    try {
      const h = location.hostname;
      if (location.protocol === 'file:') return true;
      return h === 'localhost' || h === '127.0.0.1' || h === '[::1]'
        || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h);
    } catch (e) { return false; }
  }
  function endpointIsLocal(ep) {
    try {
      const h = new URL(ep, location.href).hostname;
      return h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
    } catch (e) { return false; }
  }

  async function recognizeHandwriting(dataUrl) {
    const cfg = loadConfig();
    const ep = cfg.handwritingEndpoint;
    const pool = ['家里水管漏水了', '需要送一份午饭', '灯泡坏了看不见', '想申请高龄补贴'];
    const simulate = reason => ({ text: pool[Math.floor(Math.random() * pool.length)], simulated: true, error: reason });

    // 本地中继只在本机/局域网页面里尝试，避免线上站点每次都刷失败日志
    if (ep && (!endpointIsLocal(ep) || pageIsLocal())) {
      try {
        const blob = await (await fetch(dataUrl)).blob();
        const fd = new FormData();
        fd.append('image', blob, 'handwriting.png');
        const headers = {};
        if (cfg.handwritingKey) headers['Authorization'] = 'Bearer ' + cfg.handwritingKey;
        const res = await fetch(ep, { method: 'POST', headers, body: fd });
        const data = await res.json().catch(() => null);
        const text = ((data && data.text) || '').trim();
        if (res.ok && data && data.ok !== false && text) {
          return { text: text, simulated: false, engine: (data && data.engine) || 'deepseek' };
        }
        return simulate((data && data.error) || ('识别服务返回 ' + res.status));
      } catch (e) {
        return simulate('连不上本机识别服务（' + (e.message || '网络错误') + '）');
      }
    }

    await new Promise(r => setTimeout(r, 900));
    return simulate(ep ? '线上环境未连接本机识别服务' : '未配置手写识别服务');
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
    probe, realMode, relayState, micEnv, toMicError, pageIsLocal,
    listen, recognizeHandwriting, speak, stopSpeak,
    supportsMic: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
    supportsBrowserASR: !!(global.SpeechRecognition || global.webkitSpeechRecognition),
    supportsTTS: !!global.speechSynthesis
  };
})(window);

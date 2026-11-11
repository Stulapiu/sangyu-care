/* ============================================================
   桑榆智援 · Dify 智能体接入层
   ------------------------------------------------------------
   ★ 智能体接口集中在本文件 ★

   工作流：Dify「桑榆智援 · 诉求研判」
   入参  ：text（老人原话）、profile（老人档案 JSON）
   出参  ：result（结构化 JSON 字符串）

   未配置 API Key 时自动降级为本地规则（store.js 的 classify），
   页面功能不受影响，只是不显示「AI 研判」标记。
   ============================================================ */
(function (global) {
  'use strict';

  const CFG_KEY = 'SY_DIFY_CFG_V1';

  /* 公开演示版：不内置任何 API Key。
     想看真实 AI 研判，在「社区端 → 设置」里填自己的 Dify 地址与 Key；
     不填也能完整走流程——研判自动降级为本地规则，只是不显示「AI 研判」标记。 */
  const DEFAULTS = {
    enabled: true,
    baseUrl: '',        // 例：http://localhost:8080（Dify 服务地址，不含 /v1）
    apiKey: '',         // 例：app-xxxxxxxx（Dify 应用的 API Key）
    timeout: 20000
  };

  function loadConfig() {
    try {
      const raw = localStorage.getItem(CFG_KEY);
      return Object.assign({}, DEFAULTS, raw ? JSON.parse(raw) : {});
    } catch (e) { return Object.assign({}, DEFAULTS); }
  }

  function saveConfig(patch) {
    const next = Object.assign(loadConfig(), patch || {});
    try { localStorage.setItem(CFG_KEY, JSON.stringify(next)); } catch (e) {}
    return next;
  }

  function isConfigured() {
    const c = loadConfig();
    return !!(c.enabled && c.baseUrl && c.apiKey);
  }

  /* Dify 工作流对外约定的字段，允许缺省。
     ★ 类型词表必须和 store.js 的 TYPE_LIST 对齐 ★
     工作流里用的是「家政保洁 / 康复护理」，系统里是「家政 / 健康咨询」，
     这里做一次别名归一，否则工单会落到不存在的类目上（筛选和统计都会漏）。 */
  const TYPES = ['助餐', '居家保洁', '家电维修', '水电故障', '健康咨询', '政策咨询', '家政', '其他'];
  const TYPE_ALIAS = {
    '家政保洁': '家政', '保洁': '居家保洁', '家居保洁': '居家保洁',
    '康复护理': '家政', '护理': '家政'
  };
  const URGENCIES = ['紧急', '较急', '一般'];

  function normalize(obj) {
    if (!obj || typeof obj !== 'object') return null;
    // 家政保洁 / 康复护理 这类工作流旧词表映射到系统八类上
    if (TYPE_ALIAS[obj.type]) obj = Object.assign({}, obj, { type: TYPE_ALIAS[obj.type] });
    const type = TYPES.indexOf(obj.type) >= 0 ? obj.type : '其他';
    const urgency = URGENCIES.indexOf(obj.urgency) >= 0 ? obj.urgency : '一般';
    const tags = Array.isArray(obj.tags) ? obj.tags.slice(0, 4).map(String) : [];
    /* valid 允许三种写法：布尔、'true'/'false' 字符串、1/0。
       工作流没给就返回 undefined，交给 store.js 的本地规则兜底。 */
    let valid;
    if (typeof obj.valid === 'boolean') valid = obj.valid;
    else if (obj.valid === 'true' || obj.valid === 1) valid = true;
    else if (obj.valid === 'false' || obj.valid === 0) valid = false;
    return {
      type,
      urgency,
      title: String(obj.title || '').slice(0, 40),
      summary: String(obj.summary || '').slice(0, 120),
      suggest: String(obj.suggest || '').slice(0, 120),
      reply: String(obj.reply || '').slice(0, 160),
      missing: Array.isArray(obj.missing) ? obj.missing.slice(0, 4).map(String) : [],
      tags,
      valid,
      invalidReason: String(obj.invalid_reason || obj.invalidReason || '').slice(0, 60)
    };
  }

  /* 把老人档案压成一段短文本，避免请求体过大 */
  function profileText(elder) {
    if (!elder) return '';
    return [
      '姓名：' + (elder.name || ''),
      '年龄：' + (elder.age || ''),
      '住址：' + [elder.building, elder.unit].filter(Boolean).join(' '),
      '健康状况：' + (Array.isArray(elder.health) ? elder.health.join('、') : (elder.health || '')),
      '独居：' + (elder.livingAlone ? '是' : '否'),
      '紧急联系人：' + (elder.guardian || '') + '（' + (elder.phone || '') + '）'
    ].join('\n');
  }

  /**
   * 调用 Dify 工作流做诉求研判
   * @returns {Promise<null|{type,urgency,title,summary,suggest,reply,missing,tags}>}
   */
  function judge(payload) {
    const cfg = loadConfig();
    if (!isConfigured()) return Promise.resolve(null);

    const text = String((payload && payload.text) || '').trim();
    if (!text) return Promise.resolve(null);

    const url = cfg.baseUrl.replace(/\/+$/, '') + '/v1/workflows/run';
    const body = {
      inputs: {
        text: text,
        profile: profileText(payload.elder)
      },
      response_mode: 'blocking',
      user: 'elder-' + ((payload.elder && payload.elder.id) || 'demo')
    };

    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = setTimeout(() => { if (ctrl) ctrl.abort(); }, cfg.timeout || 20000);

    return fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + cfg.apiKey
      },
      body: JSON.stringify(body),
      signal: ctrl ? ctrl.signal : undefined
    }).then(res => {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(json => {
      const outputs = (json && json.data && json.data.outputs) || {};
      let raw = outputs.result;
      if (typeof raw === 'string') {
        try { raw = JSON.parse(raw); } catch (e) { return null; }
      }
      return normalize(raw);
    }).catch(err => {
      console.warn('[Dify] 研判失败，已降级为本地规则：', err.message);
      return null;
    }).then(out => {
      clearTimeout(timer);
      return out;
    });
  }

  global.Dify = {
    loadConfig, saveConfig, isConfigured, judge, profileText,
    TYPES, URGENCIES
  };
})(window);

/* ============================================================
   桑榆智援 · 数据层与业务规则
   - localStorage 持久化（原型演示用）
   - 分类 / 派单 / 补全 / 风险研判 / 统计 均为本地规则引擎
   ============================================================ */
(function (global) {
  'use strict';

  const DB_KEY = 'SY_DB_V1';
  const DAY = 86400000;
  const D = global.SY_DATA;

  const TYPE_LIST = ['助餐', '水电故障', '家电维修', '健康咨询', '居家保洁', '政策咨询', '家政', '其他'];
  const TYPE_EN = {
    '助餐': 'meal', '水电故障': 'water', '家电维修': 'appliance', '健康咨询': 'health',
    '居家保洁': 'clean', '政策咨询': 'policy', '家政': 'service', '其他': 'other'
  };
  const STATUS = {
    '待接单': { tone: 'amber', step: 0 },
    '已接单': { tone: 'blue', step: 1 },
    '处理中': { tone: 'violet', step: 2 },
    '已完成': { tone: 'green', step: 3 }
  };
  const SOURCE_TONE = { '语音': 'blue', '打字': 'green', '手写': 'violet', '紧急': 'red' };

  /* 紧急度 / 状态排序权重：数值越小越靠前 */
  const URG_RANK = { '紧急': 0, '较急': 1, '一般': 2 };
  const ST_RANK = { '待接单': 0, '已接单': 1, '处理中': 2, '已完成': 3 };

  /* 登录保持时长：老人端长期免登录，社区端按工作日有效期 */
  const SESSION_TTL = { elder: 180 * DAY, admin: 12 * 3600 * 1000 };

  /* ---------------- 小工具 ---------------- */
  const pad = n => String(n).padStart(2, '0');

  function fmtTime(ts, withYear) {
    const d = new Date(ts);
    const y = d.getFullYear(), m = pad(d.getMonth() + 1), dd = pad(d.getDate());
    const hh = pad(d.getHours()), mm = pad(d.getMinutes());
    return (withYear ? y + '-' : '') + m + '-' + dd + ' ' + hh + ':' + mm;
  }
  function fmtDate(ts) {
    const d = new Date(ts);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function fmtClock(ts) {
    const d = new Date(ts);
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function fromNow(ts) {
    const diff = Date.now() - ts;
    const min = Math.floor(diff / 60000);
    if (min < 1) return '刚刚';
    if (min < 60) return min + ' 分钟前';
    const h = Math.floor(min / 60);
    if (h < 24) return h + ' 小时前';
    const dd = Math.floor(h / 24);
    if (dd < 30) return dd + ' 天前';
    return Math.floor(dd / 30) + ' 个月前';
  }
  function dayKey(ts) {
    const d = new Date(ts);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function uid(prefix) {
    return prefix + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase();
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  /* ---------------- 规则引擎 ---------------- */
  const RULES = [
    { type: '家政', re: /(陪(着|同)?|陪同|代买|代购|代办|带我|跑一趟)/ },
    { type: '助餐', re: /(饭|餐|吃|菜|粥|面条|挂面|面食|包子|馒头|送饭|订饭)/ },
    { type: '健康咨询', re: /(血压|血糖|头晕|头昏|胸闷|胸口|疼|痛|药|医生|医院|不舒服|失眠|睡不着|发烧|感冒|喘)/ },
    { type: '水电故障', re: /(水管|漏水|下水|堵|灯|灯泡|电灯|暖气|热水|跳闸|插座|水龙头|积水|停水|停电)/ },
    { type: '家电维修', re: /(空调|电视|洗衣机|冰箱|遥控|电饭锅|风扇|微波炉|热水器|家电)/ },
    { type: '居家保洁', re: /(打扫|保洁|擦|洗|收拾|油烟机|卫生|床单|拖地)/ },
    { type: '政策咨询', re: /(补贴|政策|申请|材料|年审|保险|待遇|津贴|手续|怎么办)/ }
  ];

  const URGENT_RE = /(胸口|喘不上|站不住|摔|出血|昏|晕倒|疼得厉害|救|不行了|急)/;
  const SOON_RE = /(漏水|不热|看不见|快吃完|晚上|疼|冷|没水|没电|堵)/;
  const PLACE_RE = /(厨房|卫生间|厕所|客厅|卧室|阳台|屋里|楼道)/;

  function classify(text) {
    const t = String(text || '');
    let type = '其他';
    for (const r of RULES) { if (r.re.test(t)) { type = r.type; break; } }
    let urgency = '一般';
    if (URGENT_RE.test(t)) urgency = '紧急';
    else if (SOON_RE.test(t)) urgency = '较急';
    const tags = [];
    if (PLACE_RE.test(t)) tags.push(t.match(PLACE_RE)[1] + '');
    if (/独居|一个人|没人/.test(t)) tags.push('独居');
    if (/听力|听不清|耳背/.test(t)) tags.push('听力');
    return { type, urgency, tags };
  }

  function assigneeFor(type) {
    const s = D.staff.find(st => st.handles.indexOf(type) > -1);
    return s ? s.id : 'S01';
  }

  /* ---------------- 无效 / 误触诉求识别 ----------------
     双层判断：智能体给了明确结论就以智能体为准；
     智能体没结论（未配置 / 超时 / 降级）时用下面的本地规则兜底，
     保证「没有 Key 也能演示」这条约束不被破坏。
     ---------------------------------------------------- */

  // 整句就是寒暄、试音、误触 —— 整句匹配，不会误伤「你好，我饿了」这类真诉求
  const JUNK_EXACT = /^(测试|测一下|试试|试一下|随便说|喂+|喂喂|在吗|在不在|你好|您好|哈+|呵+|嗯+|哦+|啊+|唉|嗯嗯|1+|123+|111+|000+|test|hello|hi|nihao|asdf+|\.+)$/i;
  const JUNK_HINT = /(测试一下|随便说说|按错|点错|误触|不小心|没事|没啥事|不用了|不要了|算了|发错了)/;
  // 真实诉求的最低限度特征：命中分类关键词、或出现这些实义字、或语句足够长
  const MEANING_RE = /(饿|吃|饭|餐|菜|粥|面|水|电|灯|气|热|冷|疼|痛|药|病|医院|医生|晕|摔|买|送|帮|来|修|坏|漏|堵|脏|洗|扫|钱|补贴|办|证|看|听|走|动)/;

  function stripPunct(s) {
    return String(s || '').replace(/[\s，。,.、！!？?~～…·—\-_*#@'"“”‘’()（）]/g, '');
  }

  /**
   * 判断一条诉求是否属于「疑似无效 / 误触」
   * @param {string} text 老人原话
   * @param {object} [ai] 智能体研判结果（可含 valid / invalidReason）
   * @returns {{suspect:boolean, reason:string, by:'llm'|'rule'}}
   */
  function triage(text, ai) {
    const t = String(text || '').trim();
    const clean = stripPunct(t);

    // 1) 智能体明确判定无效 → 直接采信
    if (ai && ai.valid === false) {
      return { suspect: true, reason: ai.invalidReason || '智能体判定为非有效诉求', by: 'llm' };
    }
    // 2) 智能体明确判定有效 → 直接采信
    if (ai && ai.valid === true) {
      return { suspect: false, reason: '', by: 'llm' };
    }

    // 3) 本地兜底规则
    if (!clean) return { suspect: true, reason: '内容为空', by: 'rule' };
    if (JUNK_EXACT.test(clean)) return { suspect: true, reason: '整句为寒暄 / 试音 / 误触', by: 'rule' };
    if (/^[0-9a-zA-Z]{1,3}$/.test(clean)) return { suspect: true, reason: '仅输入数字或字母', by: 'rule' };

    const cls = classify(t);
    const hasType = cls.type !== '其他';
    const hasMeaning = MEANING_RE.test(clean);

    // 一句话说不清、又没有任何可识别特征，长度还特别短 → 转为「待确认」而不是丢弃
    if (!hasType && !hasMeaning && clean.length <= 4) {
      return { suspect: true, reason: '内容过短且无可识别诉求特征', by: 'rule' };
    }
    if (JUNK_HINT.test(clean) && !hasType) {
      return { suspect: true, reason: '疑似误触或非诉求内容', by: 'rule' };
    }
    return { suspect: false, reason: '', by: 'rule' };
  }

  const TRIAGE_LABEL = { normal: '有效诉求', suspect: '疑似无效' };

  /* 档案完整性校验 + 自动补全 */
  function autoFill(text, elder) {
    const missing = [];
    const filled = {};
    if (!elder.address) { missing.push('住址'); } else { filled.address = elder.address; }
    if (!elder.guardianPhone) { missing.push('紧急联系人电话'); } else { filled.guardian = elder.guardian + ' ' + elder.guardianPhone; }
    if (!elder.phone) { missing.push('本人电话'); } else { filled.phone = elder.phone; }
    const place = PLACE_RE.test(text) ? text.match(PLACE_RE)[1] : '';
    filled.location = place ? elder.building + ' ' + elder.unit + ' ' + place : elder.building + ' ' + elder.unit;
    const needMed = /(药|医院|就诊|复查)/.test(text);
    filled.extra = needMed ? '需同步社区卫生服务站' : '';
    return { missing, filled, complete: missing.length === 0 };
  }

  function matchPolicies(elder) {
    if (!elder) return [];
    return D.policies.filter(p => {
      const m = p.match || {};
      if (m.minAge && elder.age < m.minAge) return false;
      if (m.tags && !m.tags.some(t => elder.tags.indexOf(t) > -1)) return false;
      return true;
    });
  }

  /* ---------------- 持久化 ---------------- */
  function seed() {
    const tickets = D.ticketSeed.map((row, i) => {
      const [days, elderId, type, source, status, content, urgency, assignee, resp] = row;
      const elder = D.elders.find(e => e.id === elderId);
      const createdAt = D.ago(days, 8 + (i % 9), (i * 7) % 60);
      const accepted = status === '待接单' ? null : createdAt + (resp || 20) * 60000;
      const processing = ['处理中', '已完成'].indexOf(status) > -1 ? (accepted || createdAt) + 12 * 60000 : null;
      const done = status === '已完成' ? (processing || accepted || createdAt) + 46 * 60000 : null;
      return {
        id: 'GD' + fmtDate(createdAt).replace(/-/g, '') + '-' + pad(i + 1),
        elderId,
        elderName: elder ? elder.name : '—',
        building: elder ? elder.building : '—',
        unit: elder ? elder.unit : '',
        type, source, status,
        urgency,
        content,
        aiTags: classify(content).tags,
        assignee: assignee || (status === '待接单' ? null : assigneeFor(type)),
        createdAt, acceptedAt: accepted, processingAt: processing, doneAt: done,
        responseMin: status === '待接单' ? null : (resp || 20),
        messages: [],
        note: '',
        repeated: false,
        escalated: source === '紧急'
      };
    });
    // 标记重复求助：同一老人 + 同一类型 + 7 天内出现两次
    const seen = {};
    tickets.slice().sort((a, b) => a.createdAt - b.createdAt).forEach(t => {
      const k = t.elderId + '|' + t.type;
      if (seen[k] && t.createdAt - seen[k] < 7 * DAY) { t.repeated = true; t.repeatOf = seen[k + 'id']; }
      seen[k] = t.createdAt; seen[k + 'id'] = t.id;
    });

    const db = {
      version: 1,
      elders: JSON.parse(JSON.stringify(D.elders)),
      staff: JSON.parse(JSON.stringify(D.staff)),
      tickets,
      alertsRead: [],
      noticeRead: [],
      createdAt: Date.now()
    };
    localStorage.setItem(DB_KEY, JSON.stringify(db));
    return db;
  }

  let db = null;
  const listeners = [];
  const extListeners = [];

  /* 老数据补字段：新增 triage 后历史工单要补齐，否则收件箱分不出「疑似无效」
     返回 true 表示有改动，需要落盘 */
  function migrate() {
    if (!db || !db.tickets) return false;
    let dirty = false;
    db.tickets.forEach(t => {
      if (!t.triage) {
        const v = triage(t.content, null);
        t.triage = v.suspect ? 'suspect' : 'normal';
        t.triageReason = v.reason;
        t.triageBy = v.by;
        dirty = true;
      }
      if (t.repeated == null) { t.repeated = false; dirty = true; }
    });
    return dirty;
  }

  function persist() {
    try {
      const raw = JSON.stringify(db);
      localStorage.setItem(DB_KEY, raw);
      lastRaw = raw;                 // 自己写的不算外部变更，避免轮询重复刷新
    } catch (e) { /* 忽略配额错误 */ }
    if (SYNC.on && SYNC.ready) schedulePush();
  }

  function load() {
    try {
      const raw = localStorage.getItem(DB_KEY);
      db = raw ? JSON.parse(raw) : seed();
      if (!db || !db.tickets) db = seed();
    } catch (e) { db = seed(); }
    if (migrate()) persist();        // 补完字段就地保存，避免每次打开都重算
    return db;
  }
  function save() {
    persist();
    listeners.forEach(fn => { try { fn(db); } catch (e) {} });
  }
  function onChange(fn) { listeners.push(fn); }
  /* 只关心「别的标签页改了什么」的订阅者（后台列表刷新用它，避免自己写库时重复重绘） */
  function onExternal(fn) { extListeners.push(fn); }
  function reset() {
    localStorage.removeItem(DB_KEY);
    load();
    listeners.forEach(fn => fn(db));
    if (SYNC.on) push(true);         // 共享模式下要连服务端一起清，否则下次拉取会"复活"
  }

  /* ---------------- 跨标签页同步 ----------------
     根因：每个页面加载时把 localStorage 读进内存快照，
     save() 只通知本页的 listeners。老人端在 A 标签提交，
     社区端在 B 标签却还是旧快照 —— 这就是「提交后后台不显示」。
     解决：监听 storage 事件 + 轮询兜底，任何一侧变更都重新装载。
     ---------------------------------------------------- */
  function notify() {
    listeners.forEach(fn => { try { fn(db); } catch (e) {} });
  }

  function reload() {
    let raw = null;
    try { raw = localStorage.getItem(DB_KEY); } catch (e) { return false; }
    if (!raw) return false;
    if (raw === lastRaw) return false;
    let next = null;
    try { next = JSON.parse(raw); } catch (e) { return false; }
    if (!next || !next.tickets) return false;
    lastRaw = raw;
    db = next;
    if (migrate()) persist();
    notify();
    extListeners.forEach(fn => { try { fn(db); } catch (e) {} });
    return true;
  }

  let lastRaw = null;
  try { lastRaw = localStorage.getItem(DB_KEY); } catch (e) {}

  if (typeof window !== 'undefined' && window.addEventListener) {
    // 其他标签页写入时浏览器会广播 storage 事件（本页写入不触发，正好）
    window.addEventListener('storage', e => {
      if (!e || e.key === DB_KEY || e.key === null) reload();
    });
  }

  let watchTimer = null;
  function watchExternal(ms) {
    if (watchTimer) return;
    watchTimer = setInterval(reload, ms || 4000);
    // 页面重新可见时立刻补一次，切回来就能看到新单
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) reload();
    });
    window.addEventListener('focus', reload);
  }

  /* ---------------- 局域网共享同步 ----------------
     解决：A 电脑老人端提交，B 电脑社区端后台收不到。
     原因：数据原本只存在各浏览器的 localStorage 里，跨机器天然隔离。
     做法：业务逻辑一行不动，只加"推快照 / 拉快照"。
       1. 页面在 http://<主机>:8123/... 时，同步服务默认取 <主机>:8125，
          换热点换了 IP 也不用改配置（跟着地址自动走）；
       2. 提交后把整份快照推给服务端，服务端按工单 id 合并；
       3. 每 1.5 秒拉一次合并结果，变了就重绘。
     服务没起 = 静默退回纯本地模式，页面照旧能跑，不白屏不报错。
     ---------------------------------------------------- */
  const SYNC_KEY = 'SY_SYNC_V1';
  const SYNC_TTL = 1500;
  const SYNC = {
    base: '', on: false, rev: -1, ready: false, timer: null,
    fail: 0, pushing: false, pending: false, pushTimer: null
  };

  function syncBase() {
    try {
      const q = new URLSearchParams(location.search).get('sync');
      if (q) return String(q).replace(/\/+$/, '');
      const v = localStorage.getItem(SYNC_KEY);
      if (v) return String(v).replace(/\/+$/, '');
      /* 默认：同主机、8125 端口（页面在 8123，服务在 8125）。
         公开演示版只在「本机 / 局域网」自动启用——线上托管时没有同步服务，
         猜出来的地址必然连不上，白白刷三条失败日志，所以直接不启用。
         想手动指定仍可用 ?sync=http://IP:8125 或 localStorage 的 SY_SYNC_V1。 */
      if (!/^https?:/.test(location.protocol) || !location.hostname) return '';
      const host = location.hostname;
      const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '[::1]' ||
        /^10\./.test(host) || /^192\.168\./.test(host) ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(host);
      return isLocal ? location.protocol + '//' + host + ':8125' : '';
    } catch (e) { /* file:// 打开时不启用 */ }
    return '';
  }

  /* 同一张工单的最后变动时刻：新建 / 接单 / 推进 / 完成里取最大。
     服务端和前端用同一套规则，合并结果才一致。 */
  function ticketChange(t) {
    return Math.max(t.createdAt || 0, t.acceptedAt || 0, t.processingAt || 0,
      t.doneAt || 0, t.updatedAt || 0);
  }

  /* 本地与服务端合并：工单按 id 取较新的那份，不是整份覆盖。
     整份覆盖会踩一个坑：刚提交、还没推上去的单，会被一次旧轮询结果冲掉。 */
  function mergeDb(local, remote) {
    if (!local || !local.tickets) return remote;
    if (!remote || !remote.tickets) return local;
    const out = Object.assign({}, remote);          // 档案类以最后一次写入为准
    const map = {};
    (local.tickets || []).forEach(t => { if (t && t.id) map[t.id] = t; });
    (remote.tickets || []).forEach(t => {
      if (!t || !t.id) return;
      const cur = map[t.id];
      if (!cur) { map[t.id] = t; return; }
      const a = ticketChange(cur), b = ticketChange(t);
      let win;
      if (a !== b) win = a > b ? cur : t;
      else win = (ST_RANK[cur.status] || 0) >= (ST_RANK[t.status] || 0) ? cur : t;
      win = Object.assign({}, win);
      const msgs = [];
      const seen = {};
      ((cur.messages || []).concat(t.messages || [])).forEach(m => {
        if (!m) return;
        const k = (m.at || '') + '|' + (m.from || '') + '|' + (m.text || '');
        if (seen[k]) return;
        seen[k] = 1;
        msgs.push(m);
      });
      if (msgs.length) { msgs.sort((x, y) => (x.at || 0) - (y.at || 0)); win.messages = msgs; }
      map[t.id] = win;
    });
    out.tickets = Object.keys(map).map(k => map[k])
      .sort((x, y) => (x.createdAt || 0) - (y.createdAt || 0));
    ['alertsRead', 'noticeRead'].forEach(k => {
      const u = [], s = {};
      (local[k] || []).concat(remote[k] || []).forEach(v => {
        if (s[v]) return; s[v] = 1; u.push(v);
      });
      out[k] = u;
    });
    return out;
  }

  /* 接收服务端的合并结果：只在内容真变了的时候替换并重绘，避免无谓闪烁 */
  function adopt(payload) {
    if (!payload || !payload.db || !payload.db.tickets) return false;
    if (typeof payload.rev === 'number') SYNC.rev = payload.rev;
    const next = mergeDb(db, payload.db);
    let raw = '', cur = '';
    try { raw = JSON.stringify(next); cur = JSON.stringify(db); } catch (e) { return false; }
    if (raw === cur) return false;
    db = next;
    migrate();                       // 老结构补字段（triage / repeated）
    try {
      const fixed = JSON.stringify(db);
      localStorage.setItem(DB_KEY, fixed);
      lastRaw = fixed;               // 服务端写入不算本地新写入，免得又推回去
    } catch (e) {}
    notify();
    extListeners.forEach(fn => { try { fn(db); } catch (e) {} });
    return true;
  }

  function push(isReset) {
    if (!SYNC.on || !SYNC.base) return;
    if (SYNC.pushing) { SYNC.pending = true; return; }
    SYNC.pushing = true;
    let body = '';
    try { body = JSON.stringify({ db: db, reset: !!isReset }); } catch (e) { SYNC.pushing = false; return; }
    fetch(SYNC.base + '/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body
    }).then(r => r.json()).then(res => {
      SYNC.fail = 0;
      if (res && res.ok) adopt(res);
    }).catch(() => { SYNC.fail++; }).then(() => {
      SYNC.pushing = false;
      if (SYNC.pending) { SYNC.pending = false; schedulePush(); }
    });
  }

  function schedulePush() {
    if (SYNC.pushTimer) return;
    SYNC.pushTimer = setTimeout(() => { SYNC.pushTimer = null; push(false); }, 250);
  }

  function pull() {
    if (!SYNC.on || !SYNC.base) return;
    fetch(SYNC.base + '/sync', { cache: 'no-store' })
      .then(r => r.json())
      .then(res => {
        if (!res || !res.ok) throw new Error('bad');
        SYNC.fail = 0;
        // rev 没变说明服务端没新东西，直接跳过；
        // 也顺手挡掉「旧请求晚到」的情况：迟到的 rev 更小，不会把新单冲掉
        if (typeof res.rev === 'number' && res.rev <= SYNC.rev) return;
        adopt(res);
      })
      .catch(() => {
        SYNC.fail++;
        if (SYNC.fail === 3) console.warn('[SY] 共享服务连不上，已退回本地模式：' + SYNC.base);
      });
  }

  function startSync() {
    const base = syncBase();
    if (!base || typeof fetch !== 'function') return false;
    SYNC.base = base;
    SYNC.on = true;
    const begin = () => {
      SYNC.ready = true;
      SYNC.timer = setInterval(pull, SYNC_TTL);
    };
    // 开机先拉：服务端有数据就以它为准，没有就把本地这份（种子）推上去当基线
    fetch(base + '/sync', { cache: 'no-store' })
      .then(r => r.json())
      .then(res => {
        SYNC.rev = (res && typeof res.rev === 'number') ? res.rev : -1;
        if (res && res.ok && res.db && res.db.tickets && res.db.tickets.length) adopt(res);
        begin();
        if (!res || !res.db || !res.db.tickets || !res.db.tickets.length) push(false);
      })
      .catch(() => {
        // 服务没起：纯本地照跑，每 5 秒探一次，中途启动能自动接上
        console.info('[SY] 未检测到共享服务 ' + base + '，使用本地模式');
        SYNC.ready = false;
        SYNC.timer = setInterval(() => {
          fetch(base + '/sync', { cache: 'no-store' }).then(r => r.json()).then(res => {
            if (!res || !res.ok) return;
            clearInterval(SYNC.timer);
            SYNC.rev = (typeof res.rev === 'number') ? res.rev : -1;
            if (res.db && res.db.tickets && res.db.tickets.length) adopt(res);
            begin();
            if (!res.db || !res.db.tickets || !res.db.tickets.length) push(false);
          }).catch(() => {});
        }, 5000);
      });
    return true;
  }

  function syncStatus() {
    return { on: SYNC.on, ready: SYNC.ready, base: SYNC.base, rev: SYNC.rev, fail: SYNC.fail };
  }

  /* ---------------- 查询 ---------------- */
  function elderById(id) { return db.elders.find(e => e.id === id); }
  function staffById(id) { return db.staff.find(s => s.id === id); }
  function ticketById(id) { return db.tickets.find(t => t.id === id); }
  function ticketsOf(elderId) {
    return db.tickets.filter(t => t.elderId === elderId).sort((a, b) => b.createdAt - a.createdAt);
  }
  function activeTicketOf(elderId) {
    return ticketsOf(elderId).find(t => t.status !== '已完成');
  }

  /* ---------------- 排序与合并 ----------------
     排序规则（收件箱）：紧急度 → 处置进度 → 提交时间倒序
       紧急度：紧急 > 较急 > 一般
       进度 ：待接单 > 已接单 > 处理中 > 已完成
     即「未接单的排在最前，同紧急度按进度推」，已完结的自然沉到最后。
     ---------------------------------------------------- */
  function sortTickets(list) {
    return (list || []).slice().sort((a, b) => {
      const ua = URG_RANK[a.urgency], ub = URG_RANK[b.urgency];
      const sa = ST_RANK[a.status], sb = ST_RANK[b.status];
      return (ua === undefined ? 3 : ua) - (ub === undefined ? 3 : ub) ||
        (sa === undefined ? 9 : sa) - (sb === undefined ? 9 : sb) ||
        b.createdAt - a.createdAt;
    });
  }

  /**
   * 把「同一老人 + 同一诉求类型」的工单合并成一条展示
   * @returns {Array<{key,elderId,elderName,building,unit,type,items,rep,count,openCount,contents}>}
   */
  function groupTickets(list) {
    const map = {};
    const order = [];
    sortTickets(list).forEach(t => {
      const key = t.elderId + '|' + t.type;
      if (!map[key]) {
        map[key] = { key, elderId: t.elderId, elderName: t.elderName, building: t.building, unit: t.unit, type: t.type, items: [] };
        order.push(key);
      }
      map[key].items.push(t);
    });

    return order.map(k => {
      const g = map[k];
      // items 已按「紧急 → 进度 → 时间」排好，第一条就是代表件
      const rep = g.items[0];
      const latest = g.items.slice().sort((a, b) => b.createdAt - a.createdAt)[0];
      const opened = g.items.filter(x => x.status !== '已完成');
      return Object.assign(g, {
        rep,
        latest,
        count: g.items.length,
        openCount: opened.length,
        ids: g.items.map(x => x.id),
        openIds: opened.map(x => x.id),
        open: opened.length > 0,
        // 组内最紧迫的紧急度 / 最靠前的进度
        urgency: rep.urgency || '一般',
        status: rep.status,
        createdAt: latest.createdAt,
        triage: g.items.some(x => x.triage !== 'suspect') ? 'normal' : 'suspect'
      });
    }).sort((a, b) => {
      const ua = URG_RANK[a.urgency], ub = URG_RANK[b.urgency];
      const sa = ST_RANK[a.status], sb = ST_RANK[b.status];
      return (ua === undefined ? 3 : ua) - (ub === undefined ? 3 : ub) ||
        (sa === undefined ? 9 : sa) - (sb === undefined ? 9 : sb) ||
        b.createdAt - a.createdAt;
    });
  }

  /** 取某条工单所属的合并组（抽屉里用） */
  function groupOf(ticketId) {
    const t = ticketById(ticketId);
    if (!t) return null;
    const list = groupTickets(db.tickets.filter(x => x.elderId === t.elderId && x.type === t.type));
    return list[0] || null;
  }

  /* ---------------- 登录 ----------------
     老人端默认「记住我」：第一次登录后写入 localStorage，
     之后直接打开 index.html / elder.html 都会自动进主页，
     不用再输 ID 和密码（老人最容易卡在这一步）。

     ★ 两端会话分开存 ★
       老人端 → localStorage（长期免登录）
       社区端 → sessionStorage（跟着标签页走）
     否则同一个浏览器里登了社区端，会把老人端顶下线，
     演示时「老人端 + 社区端」两个标签页就没法并存。
     ---------------------------------------------------- */
  const KEY_ELDER = 'SY_SESSION_ELDER';
  const KEY_ADMIN = 'SY_SESSION_ADMIN';
  const KEY_LAST = 'SY_LAST_ROLE';
  function keyOf(role) { return role === 'elder' ? KEY_ELDER : KEY_ADMIN; }

  function writeSession(s, remember) {
    const k = keyOf(s.role);
    const raw = JSON.stringify(Object.assign({}, s, { remember: !!remember }));
    try {
      if (s.role === 'elder' && remember) {
        localStorage.setItem(k, raw);
        sessionStorage.removeItem(k);
      } else {
        sessionStorage.setItem(k, raw);
        if (s.role === 'elder') localStorage.removeItem(k);
      }
      localStorage.setItem(KEY_LAST, s.role);
    } catch (e) {}
  }

  function readSession(role) {
    const k = keyOf(role);
    let raw = null;
    try { raw = role === 'elder' ? (localStorage.getItem(k) || sessionStorage.getItem(k)) : sessionStorage.getItem(k); } catch (e) {}
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  }

  function login(idRaw, pw, role, remember) {
    const id = String(idRaw || '').trim();
    if (!id) return { ok: false, msg: '请输入唯一 ID' };
    if (!pw) return { ok: false, msg: '请输入密码' };
    const keep = remember === undefined ? role === 'elder' : !!remember;
    if (role === 'elder') {
      const e = db.elders.find(x => x.id.toUpperCase() === id.toUpperCase());
      if (!e) return { ok: false, msg: '未找到该 ID 对应的老人档案，请联系社区网格员' };
      if (e.password !== pw) return { ok: false, msg: '密码不正确，请重试' };
      const s = { role: 'elder', id: e.id, name: e.name, at: Date.now() };
      writeSession(s, keep);
      return { ok: true, session: Object.assign({}, s, { remember: keep }) };
    }
    const a = D.accounts.admin;
    if (id !== a.id) return { ok: false, msg: '未找到该工号，请输入社区工作人员工号' };
    if (pw !== a.password) return { ok: false, msg: '密码不正确，请重试' };
    const s = { role: 'admin', id: a.id, name: a.name, org: a.org, at: Date.now() };
    writeSession(s, keep);
    return { ok: true, session: Object.assign({}, s, { remember: keep }) };
  }

  function validate(s) {
    if (!s) return null;
    const ttl = SESSION_TTL[s.role] || SESSION_TTL.admin;
    if (s.at && Date.now() - s.at > ttl) { logout(s.role); return null; }
    return s;
  }

  /* session() 不带参：老人端优先（登录页判断用）；带 role：精确取 */
  function session(role) {
    if (role) return validate(readSession(role));
    return validate(readSession('elder')) || validate(readSession('admin'));
  }

  function lastRole() {
    try { return localStorage.getItem(KEY_LAST) || 'elder'; } catch (e) { return 'elder'; }
  }

  /* 每次进入页面续期一次（超过 1 小时才重写，避免频繁写盘） */
  function touchSession(role) {
    const r = role || 'elder';
    const s = session(r);
    if (!s) return null;
    if (Date.now() - (s.at || 0) < 3600 * 1000) return s;
    const next = Object.assign({}, s, { at: Date.now() });
    writeSession(next, s.remember !== false);
    return next;
  }

  function logout(role) {
    const r = role || 'elder';
    try { localStorage.removeItem(keyOf(r)); sessionStorage.removeItem(keyOf(r)); } catch (e) {}
    try { localStorage.removeItem(KEY_LAST); } catch (e) {}
  }
  function requireRole(role, fallback) {
    const s = session(role);
    if (!s || s.role !== role) { location.replace(fallback || 'index.html'); return null; }
    if (role === 'elder' && !elderById(s.id)) { location.replace('index.html'); return null; }
    return s;
  }

  /* ---------------- 写操作 ---------------- */
  function createTicket(payload) {
    const elder = elderById(payload.elderId);
    const cls = classify(payload.content);
    // 类型必须落在系统八类里，智能体给了没见过的类目就退回本地分类
    let type = payload.type || cls.type;
    if (TYPE_LIST.indexOf(type) < 0) type = cls.type;
    const tv = triage(payload.content, payload.ai || null);
    const now = Date.now();
    const t = {
      id: 'GD' + fmtDate(now).replace(/-/g, '') + '-' + String(db.tickets.length + 1).padStart(3, '0'),
      elderId: payload.elderId,
      elderName: elder ? elder.name : payload.elderName || '—',
      building: elder ? elder.building : '—',
      unit: elder ? elder.unit : '',
      type,
      source: payload.source || '语音',
      status: '待接单',
      urgency: payload.urgency || cls.urgency,
      content: payload.content,
      aiTags: cls.tags,
      assignee: null,
      createdAt: now,
      acceptedAt: null, processingAt: null, doneAt: null,
      responseMin: null,
      messages: [],
      note: payload.note || '',
      repeated: false,
      escalated: payload.source === '紧急',
      triage: tv.suspect ? 'suspect' : 'normal',
      triageReason: tv.reason,
      triageBy: tv.by
    };
    // 重复求助识别
    const prev = db.tickets.find(x => x.elderId === t.elderId && x.type === t.type && now - x.createdAt < 7 * DAY);
    if (prev) { t.repeated = true; t.repeatOf = prev.id; }
    db.tickets.unshift(t);
    save();
    return t;
  }

  /* 批量推进：同一老人同一诉求被合并展示后，操作要作用到整组 */
  function acceptMany(ids, staffId) {
    (ids || []).forEach(id => {
      const t = ticketById(id);
      if (t && t.status === '待接单') acceptTicket(id, staffId);
    });
    return (ids || []).map(ticketById).filter(Boolean);
  }

  function advanceMany(ids) {
    (ids || []).forEach(id => {
      const t = ticketById(id);
      if (t && t.status !== '已完成') advanceTicket(id);
    });
    return (ids || []).map(ticketById).filter(Boolean);
  }

  /* 把疑似无效的工单恢复为有效诉求 */
  function markValid(id, by) {
    const t = ticketById(id);
    if (!t) return null;
    t.triage = 'normal';
    t.triageReason = '';
    t.triageBy = by || 'manual';
    save();
    return t;
  }

  function acceptTicket(id, staffId) {
    const t = ticketById(id);
    if (!t) return null;
    t.status = '已接单';
    t.assignee = staffId || t.assignee || assigneeFor(t.type);
    t.acceptedAt = Date.now();
    t.responseMin = Math.max(1, Math.round((t.acceptedAt - t.createdAt) / 60000));
    save();
    return t;
  }

  function advanceTicket(id) {
    const t = ticketById(id);
    if (!t) return null;
    if (t.status === '待接单') return acceptTicket(id);
    if (t.status === '已接单') { t.status = '处理中'; t.processingAt = Date.now(); }
    else if (t.status === '处理中') { t.status = '已完成'; t.doneAt = Date.now(); }
    save();
    return t;
  }

  function transferTicket(id, staffId, reason) {
    const t = ticketById(id);
    if (!t) return null;
    t.assignee = staffId;
    t.status = t.status === '待接单' ? '已接单' : t.status;
    if (!t.acceptedAt) { t.acceptedAt = Date.now(); t.responseMin = Math.max(1, Math.round((t.acceptedAt - t.createdAt) / 60000)); }
    t.messages.push({ from: 'system', text: '工单已转派至 ' + (staffById(staffId) || {}).name + (reason ? '（' + reason + '）' : ''), at: Date.now() });
    save();
    return t;
  }

  function addMessage(id, from, text) {
    const t = ticketById(id);
    if (!t) return null;
    t.messages.push({ from, text, at: Date.now() });
    save();
    return t;
  }

  function addElder(data) {
    const id = data.id || ('E' + String(1001 + db.elders.length).slice(-4));
    const item = Object.assign({
      id, password: '123456', name: '', gender: '男', age: 70,
      phone: '', building: '1号楼', unit: '', grid: '第一网格',
      address: '', guardian: '', guardianPhone: '',
      tags: [], dialect: '中原官话', careLevel: '一般',
      since: fmtDate(Date.now()), note: ''
    }, data, { id });
    db.elders.push(item);
    save();
    return item;
  }

  function updateElder(id, patch) {
    const e = elderById(id);
    if (!e) return null;
    Object.assign(e, patch);
    save();
    return e;
  }

  /* ---------------- 研判 ---------------- */
  function riskList() {
    const out = [];
    const now = Date.now();
    db.elders.forEach(e => {
      const list = ticketsOf(e.id);
      const recent7 = list.filter(t => now - t.createdAt < 7 * DAY).length;
      const prev7 = list.filter(t => now - t.createdAt >= 7 * DAY && now - t.createdAt < 14 * DAY).length;
      const last = list[0];
      const silentDays = last ? Math.round((now - last.createdAt) / DAY) : 999;

      if (recent7 >= 4 && recent7 > prev7) {
        out.push({
          id: 'R-surge-' + e.id, level: '高', kind: '诉求激增', elderId: e.id, elderName: e.name,
          title: e.name + ' 近 7 天提交 ' + recent7 + ' 次诉求', at: last ? last.createdAt : now,
          desc: '较前一周（' + prev7 + ' 次）明显上升。' + D.alertNotes.surge
        });
      }
      if (silentDays >= 60 && e.tags.indexOf('独居') > -1) {
        out.push({
          id: 'R-silence-' + e.id, level: '高', kind: '失访风险', elderId: e.id, elderName: e.name,
          title: e.name + ' 已 ' + silentDays + ' 天无诉求记录',
          at: now - silentDays * DAY,
          desc: '独居高龄老人长期零诉求。' + D.alertNotes.silence
        });
      }
      const last5 = list.slice(0, 5);
      const healthRecent = last5.filter(t => t.type === '健康咨询').length;
      if (healthRecent >= 3) {
        out.push({
          id: 'R-shift-' + e.id, level: '中', kind: '类型突变', elderId: e.id, elderName: e.name,
          title: e.name + ' 近期健康类诉求集中出现', at: last.createdAt,
          desc: D.alertNotes.shift
        });
      }
    });

    // 群体性共性问题：同楼栋同类型 7 天内 >= 2（助餐等日常类不计入）
    const cluster = {};
    const CLUSTER_TYPES = ['水电故障', '家电维修', '健康咨询'];
    db.tickets.filter(t => now - t.createdAt < 7 * DAY && CLUSTER_TYPES.indexOf(t.type) > -1).forEach(t => {
      const k = t.building + '|' + t.type;
      (cluster[k] = cluster[k] || []).push(t);
    });
    Object.keys(cluster).forEach(k => {
      const arr = cluster[k];
      if (arr.length >= 2) {
        const [building, type] = k.split('|');
        out.push({
          id: 'R-cluster-' + k, level: '中', kind: '群体共性', building, type,
          title: building + ' 近 7 天出现 ' + arr.length + ' 起「' + type + '」诉求',
          at: Math.max.apply(null, arr.map(x => x.createdAt)),
          desc: D.alertNotes.cluster
        });
      }
    });

    return out.sort((a, b) => (b.level === '高') - (a.level === '高') || b.at - a.at);
  }

  function repeatTickets() {
    return db.tickets.filter(t => t.repeated).sort((a, b) => b.createdAt - a.createdAt);
  }

  function seasonHint() {
    const m = new Date().getMonth() + 1;
    const winter = [11, 12, 1, 2, 3].indexOf(m) > -1;
    const summer = [6, 7, 8].indexOf(m) > -1;
    const recent = db.tickets.filter(t => Date.now() - t.createdAt < 30 * DAY);
    const share = type => recent.length ? Math.round(recent.filter(t => t.type === type).length / recent.length * 100) : 0;
    const topBuildings = type => {
      const m2 = {};
      recent.filter(t => t.type === type).forEach(t => { m2[t.building] = (m2[t.building] || 0) + 1; });
      return Object.keys(m2).sort((a, b) => m2[b] - m2[a]).slice(0, 2);
    };

    if (winter) {
      const t = topBuildings('水电故障');
      return {
        season: '采暖季', title: '提前排查供暖与管线防冻',
        text: '近 30 天水电故障类诉求占 ' + share('水电故障') + '%' +
          (t.length ? '，' + t.join('、') + ' 相对集中' : '') +
          '。建议本周内完成管线巡检，并预置管件、阀门等备料。',
        types: ['水电故障']
      };
    }
    if (summer) {
      const t = topBuildings('健康咨询');
      return {
        season: '高温季', title: '关注中暑与用电负荷',
        text: '近 30 天健康咨询类诉求占 ' + share('健康咨询') + '%' +
          (t.length ? '，' + t.join('、') + ' 相对集中' : '') +
          '。建议开放社区纳凉点，并排查老旧线路。',
        types: ['健康咨询', '家电维修']
      };
    }
    return {
      season: '春秋季', title: '适合开展集中上门服务',
      text: '气温暖和、诉求量平稳，适合安排适老化改造施工与集中体检，减少对老人的重复打扰。',
      types: []
    };
  }

  function multiRoleList() {
    const now = Date.now();
    const out = [];
    db.elders.forEach(e => {
      const recent = ticketsOf(e.id).filter(t => now - t.createdAt < 30 * DAY);
      const kinds = {};
      recent.forEach(t => { kinds[t.type] = 1; });
      const hasHealth = kinds['健康咨询'];
      const hasService = kinds['居家保洁'] || kinds['家政'] || kinds['助餐'];
      if (hasHealth && hasService) {
        out.push({
          elderId: e.id, elderName: e.name, building: e.building, unit: e.unit,
          kinds: Object.keys(kinds), count: recent.length,
          desc: D.alertNotes.multi
        });
      }
    });
    return out;
  }

  /* ---------------- 统计 ---------------- */
  function stats() {
    const now = Date.now();
    const all = db.tickets;
    const today = all.filter(t => dayKey(t.createdAt) === dayKey(now));
    // 待接单只统计有效诉求，疑似无效单独计数，否则会把「乱按一下」也算成待办
    const pending = all.filter(t => t.status === '待接单' && t.triage !== 'suspect');
    const doing = all.filter(t => t.status === '处理中' || t.status === '已接单');
    const done = all.filter(t => t.status === '已完成');
    const responded = all.filter(t => t.responseMin != null);
    const avg = responded.length ? Math.round(responded.reduce((s, t) => s + t.responseMin, 0) / responded.length) : 0;
    const doneToday = all.filter(t => t.doneAt && dayKey(t.doneAt) === dayKey(now)).length;
    return {
      total: all.length,
      today: today.length,
      pending: pending.length,
      doing: doing.length,
      done: done.length,
      doneToday,
      avgResponse: avg,
      completionRate: all.length ? Math.round(done.length / all.length * 100) : 0,
      repeated: all.filter(t => t.repeated).length,
      urgent: all.filter(t => t.urgency === '紧急' && t.status !== '已完成').length,
      suspect: all.filter(t => t.triage === 'suspect' && t.status !== '已完成').length,
      residents: db.elders.length
    };
  }

  function byType() {
    const map = {};
    TYPE_LIST.forEach(t => { map[t] = 0; });
    db.tickets.forEach(t => { map[t.type] = (map[t.type] || 0) + 1; });
    return TYPE_LIST.map(t => ({ type: t, count: map[t], en: TYPE_EN[t] })).filter(x => x.count > 0)
      .sort((a, b) => b.count - a.count);
  }

  function byBuilding() {
    const map = {};
    db.elders.forEach(e => { map[e.building] = map[e.building] || 0; });
    db.tickets.forEach(t => { map[t.building] = (map[t.building] || 0) + 1; });
    return Object.keys(map).map(k => ({ building: k, count: map[k] }))
      .sort((a, b) => a.building.localeCompare(b.building, 'zh'));
  }

  function bySource() {
    const map = { '语音': 0, '打字': 0, '手写': 0, '紧急': 0 };
    db.tickets.forEach(t => { map[t.source] = (map[t.source] || 0) + 1; });
    return Object.keys(map).map(k => ({ source: k, count: map[k] }));
  }

  function trend(days) {
    const n = days || 14;
    const out = [];
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i); d.setHours(0, 0, 0, 0);
      const k = dayKey(d.getTime());
      out.push({
        key: k,
        label: (d.getMonth() + 1) + '/' + d.getDate(),
        count: db.tickets.filter(t => dayKey(t.createdAt) === k).length,
        done: db.tickets.filter(t => t.doneAt && dayKey(t.doneAt) === k).length
      });
    }
    return out;
  }

  function heatByBuilding() {
    // 楼栋 × 近 7 天
    const rows = byBuilding().map(x => x.building);
    const cols = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      cols.push({ key: dayKey(d.getTime()), label: (d.getMonth() + 1) + '/' + d.getDate() });
    }
    return {
      rows, cols,
      value: (b, k) => db.tickets.filter(t => t.building === b && dayKey(t.createdAt) === k).length
    };
  }

  function responseByType() {
    return byType().map(x => {
      const list = db.tickets.filter(t => t.type === x.type && t.responseMin != null);
      const avg = list.length ? Math.round(list.reduce((s, t) => s + t.responseMin, 0) / list.length) : 0;
      return { type: x.type, avg, count: list.length };
    });
  }

  function monthlyLedger() {
    const month = new Date().getMonth() + 1;
    const list = db.tickets.filter(t => new Date(t.createdAt).getMonth() + 1 === month);
    const byT = {};
    list.forEach(t => { byT[t.type] = (byT[t.type] || 0) + 1; });
    return {
      month, total: list.length,
      done: list.filter(t => t.status === '已完成').length,
      byType: Object.keys(byT).map(k => ({ type: k, count: byT[k] })).sort((a, b) => b.count - a.count),
      avgResponse: list.filter(t => t.responseMin).length
        ? Math.round(list.filter(t => t.responseMin).reduce((s, t) => s + t.responseMin, 0) / list.filter(t => t.responseMin).length)
        : 0,
      list
    };
  }

  function csvOfLedger() {
    const rows = [['工单编号', '提交时间', '老人', '楼栋', '类型', '来源', '状态', '负责人', '响应时长(分钟)', '诉求内容']];
    monthlyLedger().list.forEach(t => {
      rows.push([
        t.id, fmtTime(t.createdAt, true), t.elderName, t.building + t.unit, t.type, t.source, t.status,
        (staffById(t.assignee) || {}).name || '未指派', t.responseMin == null ? '' : t.responseMin, t.content
      ]);
    });
    return rows.map(r => r.map(c => '"' + String(c).replace(/"/g, '""') + '"').join(',')).join('\r\n');
  }

  /* ---------------- 对外 ---------------- */
  load();
  startSync();

  global.SY = {
    // 常量
    TYPE_LIST, TYPE_EN, STATUS, SOURCE_TONE, URG_RANK, ST_RANK, TRIAGE_LABEL,
    // 工具
    fmtTime, fmtDate, fmtClock, fromNow, dayKey, escapeHtml, pad,
    // 数据
    get db() { return db; },
    elders: () => db.elders,
    staff: () => db.staff,
    tickets: () => db.tickets,
    policies: () => db.policies,
    elderById, staffById, ticketById, ticketsOf, activeTicketOf,
    sortTickets, groupTickets, groupOf,
    // 认证
    login, session, logout, requireRole, touchSession, lastRole,
    // 写
    createTicket, acceptTicket, advanceTicket, acceptMany, advanceMany, markValid,
    transferTicket, addMessage, addElder, updateElder,
    // 规则
    classify, assigneeFor, autoFill, matchPolicies, triage,
    riskList, repeatTickets, seasonHint, multiRoleList,
    // 统计
    stats, byType, byBuilding, bySource, trend, heatByBuilding, responseByType, monthlyLedger, csvOfLedger,
    // 其他
    onChange, onExternal, reset, load, reload, watchExternal,
    startSync, syncStatus,
    seed
  };
})(window);

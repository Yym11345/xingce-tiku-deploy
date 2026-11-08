/* 行测真题库 · 本地离线刷题站
   数据: data/*.json   状态: localStorage */
'use strict';

const MODS = [['01','政治理论'],['02','常识判断'],['03','言语理解与表达'],['04','数量关系'],['05','判断推理'],['06','资料分析']];
const MNAME = Object.fromEntries(MODS);
const MCOLOR = {'01':'#7c5cff','02':'#0ea5a5','03':'#3b6cf6','04':'#e08b1a','05':'#c2410c','06':'#16a34a'};
const SHARD = 600;
const LETTERS = 'ABCDEFGH';

/* ---------------- 小工具 ---------------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const fmt = n => n.toLocaleString('en-US');
const pct = (a, b) => b ? Math.round(a / b * 100) : 0;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('on'), 1700);
}
const hhmmss = ms => {
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60);
  return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(s % 60).padStart(2, '0');
};
const dayKey = d => (d || new Date()).toLocaleDateString('sv');
const todayKey = () => dayKey();

/* ---------------- 数据层 ---------------- */
const _cache = new Map();
function J(url) {
  if (_cache.has(url)) return _cache.get(url);
  const p = fetch(url).then(r => { if (!r.ok) throw new Error('加载失败: ' + url); return r.json(); });
  _cache.set(url, p);
  return p;
}
const D = {
  meta: () => J('data/meta.json'),
  papers: () => J('data/papers.json'),
  buckets: () => J('data/buckets.json'),
  index: () => J('data/index.json'),
  mat: () => J('data/mat.json'),
  shard: k => J('data/qs/' + k + '.json'),
};
async function getQs(locs) {
  const need = [...new Set(locs.map(l => Math.floor(l / SHARD)))];
  const shards = await Promise.all(need.map(k => D.shard(k)));
  const map = new Map(need.map((k, i) => [k, shards[i]]));
  return locs.map(l => map.get(Math.floor(l / SHARD))[l % SHARD]);
}
const getQ = async loc => (await getQs([loc]))[0];
async function getMat(q) {
  if (q.g == null || q.g < 0) return '';
  const m = await D.mat();
  const g = m[q.p] && m[q.p][q.m];
  return (g && g[q.g]) || '';
}

/* ---------------- 本地存储（按账号隔离） ---------------- */
const NS = { cur: '' };   // '' = 未登录/本地模式；'.u<用户名>' = 某个账号
const LS = {
  key(k) { return 'xc' + NS.cur + '.' + k; },
  get(k, d) { try { const v = localStorage.getItem(LS.key(k)); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(LS.key(k), JSON.stringify(v)); } catch (e) {} },
  getRaw(ns, k) { try { const v = localStorage.getItem('xc' + ns + '.' + k); return v ? JSON.parse(v) : null; } catch (e) { return null; } },
  delRaw(ns, k) { try { localStorage.removeItem('xc' + ns + '.' + k); } catch (e) {} },
};
function setNs(name) { NS.cur = name ? '.u' + name : ''; }

// 首次登录时，把登录前攒在本机的记录迁移到该账号名下（仅当账号里还没有数据）
function migrateGuestToUser(name) {
  const ns = '.u' + name;
  for (const k of ['wrong', 'star', 'log', 'paper']) {
    const g = LS.getRaw('', k);
    if (!g) continue;
    const cur = LS.getRaw(ns, k);
    const empty = !cur || (Array.isArray(cur) ? cur.length === 0 : Object.keys(cur).length === 0);
    if (!empty) continue;
    try { localStorage.setItem('xc' + ns + '.' + k, JSON.stringify(g)); } catch (e) {}
    LS.delRaw('', k);
  }
}
const Store = {
  wrong: () => LS.get('wrong', {}),
  star: () => LS.get('star', {}),
  log: () => LS.get('log', []),
  paperP: () => LS.get('paper', {}),
  addLog(rec) {
    const l = Store.log(); l.push(rec);
    LS.set('log', l.length > 30000 ? l.slice(-30000) : l);
    Sync.touch();
  },
  markWrong(q, loc, ok) {
    const w = Store.wrong();
    if (!ok) {
      w[q.id] = { n: ((w[q.id] || {}).n || 0) + 1, t: Date.now(), loc, m: q.m };
      LS.set('wrong', w);
      Sync.touch();
      return false;
    }
    if (w[q.id]) { delete w[q.id]; LS.set('wrong', w); Sync.touch(); return true; }
    return false;
  },
  toggleStar(q, loc) {
    const s = Store.star();
    if (s[q.id]) { delete s[q.id]; LS.set('star', s); Sync.touch(); return false; }
    s[q.id] = { t: Date.now(), loc, m: q.m }; LS.set('star', s); Sync.touch(); return true;
  },
};

/* ---------------- 账号（用户名 + 密码） ---------------- */
const Auth = {
  user: null,        // {name}
  server: null,      // null 未知 / true 可用 / false 本地版无账号服务
  redirect: null,    // 被门禁拦下前的目标地址
  busy: false,

  async init() {
    try {
      const r = await fetch('api/auth/me', { credentials: 'same-origin', cache: 'no-store' });
      if (!r.ok) { this.server = false; setNs(''); return; }
      const d = await r.json();
      this.server = true;
      this.user = (d && d.user) || null;
      setNs(this.user ? this.user.name : '');
      if (this.user) await Sync.afterLogin(true);
    } catch (e) { this.server = false; setNs(''); }
  },

  async post(url, body) {
    const r = await fetch(url, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    let d = {};
    try { d = await r.json(); } catch (e) {}
    return { ok: r.ok, status: r.status, data: d };
  },

  async login(username, password) {
    const r = await this.post('api/auth/login', { username, password });
    if (!r.ok) return { ok: false, error: r.data.error || '登录失败，请重试' };
    this.user = r.data.user;
    migrateGuestToUser(this.user.name);
    setNs(this.user.name);
    await Sync.afterLogin(false);
    return { ok: true };
  },

  async register(username, password) {
    const r = await this.post('api/auth/register', { username, password });
    if (!r.ok) return { ok: false, error: r.data.error || '注册失败，请重试' };
    this.user = r.data.user;
    migrateGuestToUser(this.user.name);
    setNs(this.user.name);
    await Sync.afterLogin(false);
    return { ok: true };
  },

  async changePwd(oldPw, newPw) {
    const r = await this.post('api/auth/password', { old: oldPw, new: newPw });
    if (!r.ok) return { ok: false, error: r.data.error || '修改失败，请重试' };
    return { ok: true };
  },

  async logout() {
    try { await this.post('api/auth/logout', {}); } catch (e) {}
    this.user = null;
    setNs('');
    Sync.reset();
  },
};

/* ---------------- 云端同步 ---------------- */
const Sync = {
  timer: null, state: 'idle', at: 0,

  reset() { clearTimeout(this.timer); this.timer = null; this.state = 'idle'; },

  touch() {
    if (!Auth.user) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.push(), 3000);
  },

  async pull() {
    try {
      const r = await fetch('api/sync', { credentials: 'same-origin', cache: 'no-store' });
      if (!r.ok) return null;
      const d = await r.json();
      return (d && d.data) || {};
    } catch (e) { return null; }
  },

  async push() {
    if (!Auth.user) return;
    this.state = 'saving';
    const payload = { data: { wrong: Store.wrong(), star: Store.star(), log: Store.log() } };
    try {
      const r = await fetch('api/sync', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      this.state = r.ok ? 'ok' : 'error';
      this.at = Date.now();
    } catch (e) { this.state = 'error'; }
    syncNav();
  },

  // 登录后：把云端数据与本机数据合并，再回写
  async afterLogin(silent) {
    const remote = await this.pull();
    if (remote && (remote.wrong || remote.star || remote.log)) {
      const lw = Store.wrong(), ls = Store.star(), ll = Store.log();
      const nw = mergeMap(lw, remote.wrong);
      const ns = mergeMap(ls, remote.star);
      const nl = mergeLogs(ll, remote.log);
      LS.set('wrong', nw); LS.set('star', ns); LS.set('log', nl);
    }
    await this.push();
    syncNav();
    if (!silent) toast('已登录，学习记录已同步');
  },
};

function mergeMap(local, remote) {
  const out = { ...local };
  for (const [k, v] of Object.entries(remote || {})) {
    const cur = out[k];
    if (!cur) { out[k] = v; continue; }
    const newer = (v && v.t || 0) > (cur.t || 0) ? v : cur;
    out[k] = { ...newer, n: Math.max(v && v.n || 1, cur.n || 1) };
  }
  return out;
}

function mergeLogs(local, remote) {
  const seen = new Set(), out = [];
  for (const r of [...(local || []), ...(remote || [])]) {
    if (!r || !r.id) continue;
    const key = r.id + '|' + r.t;
    if (seen.has(key)) continue;
    seen.add(key); out.push(r);
  }
  out.sort((a, b) => (a.t || 0) - (b.t || 0));
  return out.length > 30000 ? out.slice(-30000) : out;
}

/* ---------------- 会话 ---------------- */
let RUN = null, TIMER = null;
function saveRun() { try { sessionStorage.setItem('xc.run', JSON.stringify(RUN)); } catch (e) {} }
function loadRun() { try { RUN = JSON.parse(sessionStorage.getItem('xc.run') || 'null'); } catch (e) { RUN = null; } }
function startRun(kind, title, locs, opt = {}) {
  RUN = { kind, title, locs, idx: 0, ans: {}, judged: {}, res: {}, t0: Date.now(), paper: opt.paper ?? null, done: false };
  saveRun(); location.hash = '#/run';
}

/* ---------------- 路由 ---------------- */
const routes = [];
const route = (re, fn) => routes.push({ re, fn });
function nav() {
  const h = location.hash.slice(1) || '/home';
  const [path, qs] = h.split('?');
  const query = new URLSearchParams(qs || '');
  for (const r of routes) {
    const m = path.match(r.re);
    if (m) { render(r.fn, m, query); return; }
  }
  location.hash = '#/home';
}
async function render(fn, m, query) {
  if (TIMER) { clearInterval(TIMER); TIMER = null; }
  document.onkeydown = null;
  // 登录门禁：线上版必须登录才能做题；本地离线版（无账号服务）不拦
  const path = (location.hash.slice(1) || '/home').split('?')[0];
  if (Auth.server === true && !Auth.user && path !== '/account') {
    Auth.redirect = location.hash;
    location.hash = '#/account';
    return;
  }
  const view = $('#view');
  syncNav();
  view.innerHTML = '<div class="empty"><p>加载中…</p></div>';
  try { await fn(view, m, query); }
  catch (e) {
    console.error(e);
    view.innerHTML = `<div class="empty"><div class="big">!</div><p>出错了：${esc(e.message)}</p><a class="btn" href="#/home">返回首页</a></div>`;
  }
  window.scrollTo(0, 0); syncNav();
}
function syncNav() {
  const p = (location.hash.slice(1) || '/home').split('?')[0];
  $$('#nav a').forEach(a => {
    const r = a.dataset.r;
    a.classList.toggle('on', p === '/' + r || (r === 'papers' && p.startsWith('/paper')));
  });
  const w = Object.keys(Store.wrong()).length, s = Object.keys(Store.star()).length;
  $('#nWrong').textContent = w || ''; $('#nStar').textContent = s || '';
  const lg = Store.log();
  if (lg.length) {
    const ok = lg.filter(x => x.ok).length;
    $('#sideProg').innerHTML = `<div class="mini-prog"><span>累计 ${fmt(lg.length)} 题</span><span>正确率 ${pct(ok, lg.length)}%</span></div>
      <div class="mini-bar"><i style="width:${pct(ok, lg.length)}%"></i></div>`;
  } else $('#sideProg').innerHTML = '';
  drawAcct();
}

function drawAcct() {
  const el = $('#acct');
  if (!el) return;
  if (Auth.server === false) {
    el.innerHTML = `<div class="acct" style="cursor:default">
      <span class="av guest">本</span>
      <span class="nm"><b>本地模式</b><span>未连接账号服务</span></span></div>`;
    const h = $('#sideHint'); if (h) h.textContent = '数据全部本地，断网可用';
    return;
  }
  if (Auth.user) {
    const st = Sync.state === 'saving' ? '同步中…' : (Sync.state === 'error' ? '同步失败' : '已同步');
    el.innerHTML = `<div class="acct" id="acctBtn">
      <span class="av">${esc(Auth.user.name.slice(0, 1).toUpperCase())}</span>
      <span class="nm"><b>${esc(Auth.user.name)}</b><span>${st}</span></span>
      <span class="dot-on"></span></div>`;
    const h = $('#sideHint'); if (h) h.textContent = '学习记录已按账号保存';
  } else {
    el.innerHTML = `<div class="acct" id="acctBtn">
      <span class="av guest">?</span>
      <span class="nm"><b>未登录</b><span>登录后跨设备同步</span></span></div>`;
    const h = $('#sideHint'); if (h) h.textContent = '数据全部本地，断网可用';
  }
  const b = $('#acctBtn');
  if (b) b.onclick = () => location.hash = '#/account';
}
function streakDays() {
  const days = new Set(Store.log().map(x => x.d));
  let s = 0;
  for (let i = 0; i < 400; i++) {
    const d = new Date(); d.setDate(d.getDate() - i);
    if (days.has(dayKey(d))) s++;
    else if (i > 0) break;
  }
  return s;
}

/* ---------------- 首页 ---------------- */
route(/^\/home$/, async v => {
  const [meta, papers, lg] = await Promise.all([D.meta(), D.papers(), Store.log()]);
  const ok = lg.filter(x => x.ok).length;
  const w = Object.keys(Store.wrong()).length;
  const maxQ = Math.max(...meta.mods.map(x => x.q));
  const last = LS.get('lastPaper', null);
  const pIdx = last != null ? papers.papers[last] : null;

  v.innerHTML = `
  <div class="hero">
    <h2>行测真题库 · 2016–2026</h2>
    <p>${fmt(meta.papers)} 套卷 · ${fmt(meta.total)} 题 · ${fmt(meta.kps.length)} 个考点 · 全离线可用</p>
    <div class="stats">
      <div><b>${fmt(meta.total)}</b><span>题库总量</span></div>
      <div><b>${fmt(lg.length)}</b><span>累计作答</span></div>
      <div><b>${lg.length ? pct(ok, lg.length) + '%' : '—'}</b><span>总正确率</span></div>
      <div><b>${streakDays()}</b><span>连续打卡（天）</span></div>
    </div>
    <div class="cta">
      ${pIdx ? `<a class="btn" href="#/paper/${pIdx.i}">继续上次</a>` : ''}
      <a class="btn" href="#/random?n=10">随机 10 题</a>
      <a class="btn solid" href="#/drill">开始专项练习</a>
    </div>
  </div>

  <div class="sec-title"><h3>六大模块</h3><span>点开按模块抽题</span></div>
  <div class="grid g3">
    ${meta.mods.map(m => {
      const sub = meta.subs.filter(s => s.m === m.c);
      const ml = lg.filter(x => x.m === m.c);
      return `<div class="card mod-card" data-mod="${m.c}">
        <div class="top"><span class="dot" style="background:${MCOLOR[m.c]}"></span><h4>${m.n}</h4><span class="n">${fmt(m.q)} 题</span></div>
        <div class="bar"><i style="width:${(m.q / maxQ * 100).toFixed(1)}%;background:${MCOLOR[m.c]}"></i></div>
        <div class="foot"><span>${sub.length} 个题型</span><span>${ml.length ? '正确率 ' + pct(ml.filter(x => x.ok).length, ml.length) + '%' : '未练习'}</span></div>
      </div>`;
    }).join('')}
  </div>

  <div class="sec-title"><h3>三种刷题方式</h3><span>对应三种复习目标</span></div>
  <div class="grid g3">
    ${wayCard('套卷模考', '按真实试卷顺序做，交卷后统一判分，最接近考场状态。', '#/papers', '选择试卷')}
    ${wayCard('专项突破', '锁定模块 / 题型 / 考点，即时判分，专治薄弱环节。', '#/drill', '配置练习')}
    ${wayCard('错题复盘', w ? `当前有 ${w} 道错题待消灭，重做答对即移出。` : '做错的题自动进错题本，答对即移出。', '#/wrong', '打开错题本')}
  </div>

  <div class="sec-title"><h3>高频考点 TOP 12</h3><span>按题量排序 · 复习性价比最高的部分</span></div>
  <div class="kplist">
    ${meta.kps.slice(0, 12).map(k => `<div class="kpitem" data-kp="${k.m}|${esc(k.k)}">
      <div class="r1"><b>${esc(k.k)}</b><em>${fmt(k.n)}</em></div>
      <div class="bar"><i style="width:${(k.n / meta.kps[0].n * 100).toFixed(0)}%;background:${MCOLOR[k.m]}"></i></div>
    </div>`).join('')}
  </div>`;

  $$('.mod-card', v).forEach(el => el.onclick = () => location.hash = '#/drill?m=' + el.dataset.mod);
  $$('.kpitem', v).forEach(el => el.onclick = () => {
    const [m, k] = el.dataset.kp.split('|');
    location.hash = '#/drill?m=' + m + '&k=' + encodeURIComponent(k);
  });
});
const wayCard = (t, d, href, btn) => `<div class="card" style="padding:18px">
  <h4 style="margin:0 0 6px;font-size:15px">${t}</h4>
  <p style="margin:0 0 14px;font-size:12.5px;color:var(--ink2);line-height:1.7;min-height:42px">${d}</p>
  <a class="btn sm" href="${href}">${btn} →</a></div>`;

/* ---------------- 套卷列表 ---------------- */
route(/^\/papers$/, async (v, m, q) => {
  const [data, meta] = await Promise.all([D.papers(), D.meta()]);
  const P = data.papers, prog = Store.paperP();
  let fy = q.get('y') || 'all', fr = q.get('r') || 'all';
  const years = [...new Set(P.map(p => p.y))].sort((a, b) => b - a);

  function draw() {
    const arr = P.filter(p => (fy === 'all' || p.y == fy) && (fr === 'all' || p.r === fr));
    $('#plist').innerHTML = arr.length ? arr.map(p => {
      const pr = prog[p.i], done = pr && pr.done;
      const dn = pr ? Object.values(pr.ans || {}).filter(Boolean).length : 0;
      return `<div class="pitem ${done ? 'done' : ''}" data-i="${p.i}">
        <div class="yr">${p.y}</div>
        <div class="tt"><b>${esc(p.t)}</b><span>${esc(p.r)} · ${p.n} 题 · ${Object.keys(p.m).length} 个模块</span></div>
        <div class="mods">${Object.keys(p.m).map(c => `<i>${MNAME[c].slice(0, 2)}</i>`).join('')}</div>
        <div class="go">${pr ? (done ? '已做 ' + pct(dn, p.n) + '%' : '继续 ' + pct(dn, p.n) + '%') : '开始 →'}</div>
      </div>`;
    }).join('') : '<div class="empty"><p>这个筛选下没有试卷</p></div>';
    $('#cnt').textContent = `共 ${arr.length} 套`;
    $$('.pitem', v).forEach(el => el.onclick = () => location.hash = '#/paper/' + el.dataset.i);
  }

  v.innerHTML = `
    <h1 class="pg">套卷练习</h1>
    <p class="sub">按真实试卷做题：可选整卷模考（交卷后统一判分），也可只做某一模块。</p>
    <div class="card filters">
      <div class="frow"><label>年份</label><div class="chips" id="fy">
        <button class="chip ${fy === 'all' ? 'on' : ''}" data-v="all">全部</button>
        ${years.map(y => `<button class="chip ${fy == y ? 'on' : ''}" data-v="${y}">${y}</button>`).join('')}
      </div></div>
      <div class="frow"><label>地区</label><div class="chips" id="fr">
        <button class="chip ${fr === 'all' ? 'on' : ''}" data-v="all">全部</button>
        ${meta.regions.map(r => `<button class="chip ${fr === r.r ? 'on' : ''}" data-v="${esc(r.r)}">${esc(r.r)}<span class="c">${r.n}</span></button>`).join('')}
      </div></div>
    </div>
    <div class="sec-title" style="margin:0 0 10px"><h3 style="font-size:14px" id="cnt"></h3></div>
    <div class="plist" id="plist"></div>`;

  $('#fy').onclick = e => { const b = e.target.closest('.chip'); if (!b) return; fy = b.dataset.v; location.hash = `#/papers?y=${fy}&r=${encodeURIComponent(fr)}`; };
  $('#fr').onclick = e => { const b = e.target.closest('.chip'); if (!b) return; fr = b.dataset.v; location.hash = `#/papers?y=${fy}&r=${encodeURIComponent(fr)}`; };
  draw();
});

/* ---------------- 单卷 ---------------- */
route(/^\/paper\/(\d+)$/, async (v, m) => {
  const idx = +m[1];
  const data = await D.papers();
  const p = data.papers[idx];
  if (!p) { location.hash = '#/papers'; return; }
  LS.set('lastPaper', idx);
  const prog = Store.paperP()[idx];
  const answered = prog ? Object.values(prog.ans || {}).filter(Boolean).length : 0;
  const allLocs = () => Object.keys(p.m).reduce((a, c) => { const [st, n] = p.m[c]; for (let i = 0; i < n; i++) a.push(st + i); return a; }, []);

  v.innerHTML = `
  <div class="pbar"><a class="btn ghost sm" href="#/papers">← 返回</a>
    <div class="ttl">${esc(p.t)}</div><div class="spacer"></div>
    <div class="meta">${p.y} · ${esc(p.r)} · ${p.n} 题</div></div>

  ${prog ? `<div class="card result" style="gap:18px">
    <div><div class="score">${pct(answered, p.n)}<small>%</small></div><span class="muted" style="font-size:12px">已作答 ${answered}/${p.n}</span></div>
    <div class="cells">
      <div><b>${prog.done ? '已交卷' : '进行中'}</b><span>状态</span></div>
      <div><b>${prog.ts ? new Date(prog.ts).toLocaleDateString('zh-CN') : '—'}</b><span>最近作答</span></div>
    </div>
    <div class="spacer"></div>
    <div class="row">
      <button class="btn primary" id="resume">${prog.done ? '重看解析' : '继续做题'}</button>
      <button class="btn" id="restart">重新开始</button>
    </div>
  </div>` : ''}

  <div class="sec-title"><h3>选择范围</h3><span>整卷按真实顺序：政治理论 → 常识 → 言语 → 数量 → 判断 → 资料</span></div>
  <div class="rows">
    <div class="card" style="padding:16px 18px;display:flex;align-items:center;gap:14px;cursor:pointer" id="all">
      <div style="flex:0 0 30px;height:30px;border-radius:9px;background:var(--accent-soft);color:var(--accent);display:grid;place-items:center;font-weight:700">整</div>
      <div style="flex:1"><b style="font-size:14.5px">整卷练习</b><div class="muted" style="font-size:12px">全部 ${p.n} 题，交卷后统一判分</div></div>
      <span class="btn sm primary">开始</span>
    </div>
    ${Object.entries(p.m).map(([c, [st, n]]) => `<div class="card" style="padding:14px 18px;display:flex;align-items:center;gap:14px;cursor:pointer" data-c="${c}">
      <div style="flex:0 0 30px;height:30px;border-radius:9px;background:${MCOLOR[c]}1a;color:${MCOLOR[c]};display:grid;place-items:center;font-weight:700">${MNAME[c].slice(0, 1)}</div>
      <div style="flex:1"><b style="font-size:14px">${MNAME[c]}</b><div class="muted" style="font-size:12px">${n} 题</div></div>
      <span class="btn sm">练习</span>
    </div>`).join('')}
  </div>`;

  const beginPaper = () => {
    const locs = allLocs();
    if (prog) {
      RUN = { kind: 'paper', title: p.t, locs, idx: prog.idx || 0, ans: prog.ans || {}, judged: prog.judged || {}, res: prog.res || {}, t0: Date.now(), paper: idx, done: !!prog.done };
      saveRun(); location.hash = '#/run';
    } else startRun('paper', p.t, locs, { paper: idx });
  };
  $('#all').onclick = beginPaper;
  $$('[data-c]', v).forEach(el => el.onclick = () => {
    const c = el.dataset.c, [st, n] = p.m[c];
    const locs = []; for (let i = 0; i < n; i++) locs.push(st + i);
    startRun('part', p.t + ' · ' + MNAME[c], locs, { paper: idx });
  });
  if (prog) {
    $('#resume').onclick = beginPaper;
    $('#restart').onclick = () => {
      const pp = Store.paperP(); delete pp[idx]; LS.set('paper', pp);
      startRun('paper', p.t, allLocs(), { paper: idx });
    };
  }
});

/* ---------------- 专项练习 ---------------- */
route(/^\/drill$/, async (v, m, q) => {
  const [meta, bk] = await Promise.all([D.meta(), D.buckets()]);
  const N = meta.total;
  const st = { m: q.get('m') || 'all', t: q.get('t') || 'all', k: q.get('k') || 'all', y: 'all', r: 'all', n: 20, dedupe: true, order: 'rand' };
  const uniqSet = new Set(bk.uniq);

  const qm = new Array(N), qt = new Array(N), qk = new Array(N), qy = new Array(N), qr = new Array(N);
  for (const [c, arr] of Object.entries(bk.mod)) for (const l of arr) qm[l] = c;
  for (const [key, arr] of Object.entries(bk.sub)) { const t = key.split('|')[1]; for (const l of arr) qt[l] = t; }
  for (const [key, arr] of Object.entries(bk.kp)) { const k = key.split('|')[1]; for (const l of arr) qk[l] = k; }
  for (const [y, arr] of Object.entries(bk.year)) for (const l of arr) qy[l] = +y;
  for (const [r, arr] of Object.entries(bk.region)) for (const l of arr) qr[l] = r;

  const years = meta.years.map(x => x.y).sort((a, b) => b - a);

  function match() {
    const pool = st.m === 'all' ? null : bk.mod[st.m];
    const out = [];
    const push = l => out.push(l);
    if (pool) {
      for (const l of pool) {
        if (qt[l] !== st.t && st.t !== 'all') continue;
        if (qk[l] !== st.k && st.k !== 'all') continue;
        if (qy[l] !== st.y && st.y !== 'all') continue;
        if (qr[l] !== st.r && st.r !== 'all') continue;
        if (st.dedupe && !uniqSet.has(l)) continue;
        push(l);
      }
    } else {
      for (let l = 0; l < N; l++) {
        if (st.t !== 'all' && qt[l] !== st.t) continue;
        if (st.k !== 'all' && qk[l] !== st.k) continue;
        if (st.y !== 'all' && qy[l] !== st.y) continue;
        if (st.r !== 'all' && qr[l] !== st.r) continue;
        if (st.dedupe && !uniqSet.has(l)) continue;
        push(l);
      }
    }
    return out;
  }

  const chip = (g, val, label, on, cnt) =>
    `<button class="chip ${on ? 'on' : ''}" data-g="${g}" data-v="${esc(val)}">${label}${cnt != null ? `<span class="c">${fmt(cnt)}</span>` : ''}</button>`;

  function drawFilters() {
    const subs = meta.subs.filter(s => st.m === 'all' || s.m === st.m);
    let kps = meta.kps.filter(k => (st.m === 'all' || k.m === st.m) && (st.t === 'all' || k.t === st.t) && k.k !== k.t);
    if (st.k !== 'all' && !kps.some(k => k.k === st.k)) kps = [{ m: st.m, k: st.k, n: 0 }, ...kps];
    if (st.m === 'all') kps = kps.slice(0, 30);

    $('#filters').innerHTML = `
      <div class="frow"><label>模块</label><div class="chips">
        ${chip('m', 'all', '全部', st.m === 'all')}
        ${MODS.map(([c, n]) => chip('m', c, n, st.m === c, meta.mods.find(x => x.c === c).q)).join('')}
      </div></div>
      <div class="frow"><label>题型</label><div class="chips">
        ${chip('t', 'all', '全部', st.t === 'all')}
        ${subs.map(s => chip('t', s.t, esc(s.t), st.t === s.t, s.n)).join('')}
      </div></div>
      <div class="frow"><label>考点</label><div class="chips">
        ${chip('k', 'all', '全部', st.k === 'all')}
        ${kps.map(k => chip('k', k.k, esc(k.k), st.k === k.k, k.n)).join('')}
      </div></div>
      <div class="frow"><label>年份</label><div class="chips">
        ${chip('y', 'all', '不限', st.y === 'all')}
        ${years.map(y => chip('y', y, y, st.y === y)).join('')}
      </div></div>
      <div class="frow"><label>地区</label><div class="chips">
        ${chip('r', 'all', '不限', st.r === 'all')}
        ${meta.regions.slice(0, 20).map(r => chip('r', r.r, esc(r.r), st.r === r.r)).join('')}
      </div></div>
      <div class="frow"><label>题量</label><div class="chips">
        ${[10, 20, 30, 50, 100].map(n => chip('n', n, n + ' 题', st.n === n)).join('')}
      </div></div>
      <div class="frow"><label>其他</label><div class="chips">
        ${chip('dedupe', 1, '去掉跨省重复题', st.dedupe)}
        ${chip('order', 1, st.order === 'rand' ? '随机顺序' : '按年份顺序', true)}
      </div></div>`;
  }

  function drawCount() {
    const n = match().length;
    $('#cnt').textContent = fmt(n);
    $('#start').disabled = n === 0;
    $('#start').textContent = n ? `开始练习（${Math.min(n, st.n)} 题）` : '没有符合条件的题';
  }

  v.innerHTML = `
  <h1 class="pg">专项练习</h1>
  <p class="sub">按「模块 → 题型 → 考点」三级筛选，边做边判。提分效率最高的方式：把时间压在错得最多的那一类上。</p>
  <div class="card filters" id="filters"></div>
  <div class="card" style="padding:16px 20px;display:flex;align-items:center;gap:16px;flex-wrap:wrap">
    <div><b style="font-size:26px;font-variant-numeric:tabular-nums" id="cnt">0</b><span class="muted" style="font-size:12px;margin-left:6px">题符合条件</span></div>
    <div class="spacer"></div>
    <a class="btn ghost sm" href="#/kp">看考点地图</a>
    <button class="btn primary" id="start">开始练习</button>
  </div>`;

  $('#filters').onclick = e => {
    const b = e.target.closest('.chip'); if (!b) return;
    const g = b.dataset.g, val = b.dataset.v;
    if (g === 'm') { st.m = val; st.t = 'all'; st.k = 'all'; }
    else if (g === 't') { st.t = val; st.k = 'all'; }
    else if (g === 'k') st.k = val;
    else if (g === 'y') st.y = val;
    else if (g === 'r') st.r = val;
    else if (g === 'n') st.n = +val;
    else if (g === 'dedupe') st.dedupe = !st.dedupe;
    else if (g === 'order') st.order = st.order === 'rand' ? 'seq' : 'rand';
    drawFilters(); drawCount();
  };

  drawFilters(); drawCount();

  $('#start').onclick = () => {
    let locs = match();
    if (st.order === 'rand') for (let i = locs.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [locs[i], locs[j]] = [locs[j], locs[i]]; }
    locs = locs.slice(0, st.n);
    const name = [st.m === 'all' ? '全模块' : MNAME[st.m], st.t !== 'all' ? st.t : '', st.k !== 'all' ? st.k : ''].filter(Boolean).join(' · ');
    startRun('drill', '专项：' + name, locs);
  };
});

/* ---------------- 考点地图 ---------------- */
route(/^\/kp$/, async v => {
  const meta = await D.meta();
  const max = meta.kps[0].n;
  v.innerHTML = `<h1 class="pg">考点地图</h1>
  <p class="sub">${meta.kps.length} 个考点按模块聚合。题量越大，说明该考点在真题中出现越多，复习性价比越高。点任意考点直接开练。</p>
  ${MODS.map(([c, n]) => {
    const ks = meta.kps.filter(k => k.m === c);
    if (!ks.length) return '';
    return `<div class="kpgroup">
      <h4><i style="background:${MCOLOR[c]}"></i>${n}<span class="muted" style="font-weight:400">· ${ks.length} 个考点 · ${fmt(ks.reduce((a, b) => a + b.n, 0))} 题</span></h4>
      <div class="kplist">
        ${ks.map(k => `<div class="kpitem" data-m="${c}" data-k="${esc(k.k)}">
          <div class="r1"><b>${esc(k.k)}</b><em>${fmt(k.n)}</em></div>
          <div class="bar"><i style="width:${(k.n / max * 100).toFixed(1)}%;background:${MCOLOR[c]}"></i></div>
        </div>`).join('')}
      </div></div>`;
  }).join('')}`;
  $$('.kpitem', v).forEach(el => el.onclick = () => location.hash = `#/drill?m=${el.dataset.m}&k=${encodeURIComponent(el.dataset.k)}`);
});

/* ---------------- 错题本 / 收藏 ---------------- */
route(/^\/wrong$/, async v => {
  const w = Store.wrong();
  const ids = Object.keys(w).sort((a, b) => w[b].t - w[a].t);
  v.innerHTML = `<h1 class="pg">错题本</h1>
  <p class="sub">做错的题自动进来，重做答对后自动移出。当前 ${ids.length} 题。</p>
  <div class="row" style="margin-bottom:16px">
    <button class="btn primary" id="redo" ${ids.length ? '' : 'disabled'}>重做全部错题</button>
    <button class="btn" id="clear" ${ids.length ? '' : 'disabled'}>清空</button>
  </div>
  <div id="list"></div>`;
  $('#redo').onclick = () => startRun('drill', '错题重做', ids.map(id => w[id].loc).filter(x => x != null));
  $('#clear').onclick = () => { if (confirm('确定清空错题本？')) { LS.set('wrong', {}); nav(); } };
  if (!ids.length) { $('#list').innerHTML = '<div class="empty"><div class="big">○</div><p>还没有错题，去做几道题吧</p><a class="btn primary" href="#/drill">开始练习</a></div>'; return; }

  const qs = await getQs(ids.map(id => w[id].loc));
  $('#list').innerHTML = `<div class="rows">${qs.map((q, i) => `<div class="qrow">
    <div class="idx">${i + 1}</div>
    <div class="txt">${q.s.replace(/\n/g, ' ')}</div>
    <div class="r"><span class="tag red">错 ${w[ids[i]].n || 1} 次</span>
      <div class="row" style="gap:6px">
        <button class="btn sm" data-do="${w[ids[i]].loc}">重做</button>
        <button class="btn sm ghost" data-del="${q.id}">移除</button>
      </div></div></div>`).join('')}</div>`;
  $('#list').onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.do != null) startRun('drill', '错题重做', [+b.dataset.do]);
    if (b.dataset.del) { const ww = Store.wrong(); delete ww[b.dataset.del]; LS.set('wrong', ww); nav(); }
  };
});

route(/^\/star$/, async v => {
  const s = Store.star();
  const ids = Object.keys(s).sort((a, b) => s[b].t - s[a].t);
  v.innerHTML = `<h1 class="pg">收藏</h1><p class="sub">共 ${ids.length} 题。做题时点「收藏」即可加入。</p><div id="list"></div>`;
  if (!ids.length) { $('#list').innerHTML = '<div class="empty"><div class="big">○</div><p>还没有收藏的题</p></div>'; return; }
  const qs = await getQs(ids.map(id => s[id].loc));
  $('#list').innerHTML = `<div class="rows">${qs.map((q, i) => `<div class="qrow">
    <div class="idx">${i + 1}</div><div class="txt">${q.s.replace(/\n/g, ' ')}</div>
    <div class="r"><span class="tag">${MNAME[q.m]} · ${esc(q.t)}</span>
      <div class="row" style="gap:6px"><button class="btn sm" data-do="${s[ids[i]].loc}">重做</button>
      <button class="btn sm ghost" data-del="${q.id}">移除</button></div></div></div>`).join('')}</div>`;
  $('#list').onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.do != null) startRun('drill', '收藏重做', [+b.dataset.do]);
    if (b.dataset.del) { const ss = Store.star(); delete ss[b.dataset.del]; LS.set('star', ss); nav(); }
  };
});

/* ---------------- 我的 / 账号 ---------------- */
const UNAME_RE = /^[A-Za-z0-9_\u4e00-\u9fa5]{2,20}$/;

route(/^\/account$/, async v => {
  if (Auth.server === false) {
    v.innerHTML = `<h1 class="pg">我的</h1>
      <p class="sub">当前运行的是本地离线版，没有账号服务。</p>
      <div class="card" style="padding:22px 24px;max-width:600px">
        <p style="margin:0 0 12px;font-size:13.5px;line-height:1.8">
          本地版把学习记录存在这台电脑的浏览器里，<b>不联网、不需要登录</b>，关掉浏览器也不会丢。</p>
        <p style="margin:0;font-size:12.5px;color:var(--ink2);line-height:1.8">
          如果你用的是线上版（<span class="muted">xingce-tiku.apps.workbuddy.host</span>），这里会显示登录入口，
          登录后错题本、收藏和学习统计会跟着账号走，换设备也能接着做。</p>
      </div>`;
    return;
  }

  if (Auth.user) return renderProfile(v);
  return renderAuth(v);
});

function renderAuth(v, mode) {
  let tab = mode || 'login';
  const draw = () => {
    v.innerHTML = `
    <h1 class="pg">我的</h1>
    <p class="sub">登录后即可开始做题。错题本、收藏和学习统计都保存到账号里，换设备也能接着做。</p>
    ${Auth.redirect ? `<div class="card" style="padding:11px 16px;margin-bottom:16px;background:#fff8ec;border-color:#f4e3c4;font-size:12.5px;color:#8a5a12">
      需要先登录才能做题，登录后会自动回到你刚才的页面。</div>` : ''}
    <div class="auth-wrap">
      <div class="auth-card">
        <h2>${tab === 'login' ? '登录' : '注册新账号'}</h2>
        <p class="lead">${tab === 'login' ? '用用户名和密码登录。' : '取一个用户名，设置密码即可，不需要手机号或邮箱。'}</p>
        <div class="auth-tabs">
          <button data-t="login" class="${tab === 'login' ? 'on' : ''}">登录</button>
          <button data-t="reg" class="${tab === 'reg' ? 'on' : ''}">注册</button>
        </div>
        <form id="af" autocomplete="on">
          <div class="field">
            <label for="u">用户名</label>
            <input id="u" name="username" type="text" autocomplete="username" placeholder="2–20 位，中文/字母/数字/下划线" maxlength="20" />
          </div>
          <div class="field">
            <label for="p">密码</label>
            <input id="p" name="password" type="password" autocomplete="${tab === 'login' ? 'current-password' : 'new-password'}" placeholder="6–64 位" maxlength="64" />
            <div class="ferr" id="err"></div>
          </div>
          <button class="auth-btn" id="go" type="submit">${tab === 'login' ? '登录' : '注册并登录'}</button>
        </form>
        <div class="auth-note">
          ${tab === 'login'
            ? '还没有账号？点上面的「注册」，几秒钟就好。'
            : '注册即登录。用户名注册后不可修改，请记牢密码——目前没有找回密码功能。'}
        </div>
      </div>
    </div>`;

    $$('.auth-tabs button', v).forEach(b => b.onclick = () => { tab = b.dataset.t; draw(); });
    const form = $('#af', v), err = $('#err', v), u = $('#u', v), p = $('#p', v), go = $('#go', v);
    u.oninput = () => { err.textContent = ''; u.classList.remove('bad'); };
    p.oninput = () => { err.textContent = ''; p.classList.remove('bad'); };

    form.onsubmit = async e => {
      e.preventDefault();
      const name = u.value.trim(), pw = p.value;
      if (!UNAME_RE.test(name)) {
        err.textContent = '用户名需 2–20 位，只能用中文、字母、数字或下划线';
        u.classList.add('bad'); u.focus(); return;
      }
      if (pw.length < 6 || pw.length > 64) {
        err.textContent = '密码长度需 6–64 位';
        p.classList.add('bad'); p.focus(); return;
      }
      go.disabled = true; go.textContent = tab === 'login' ? '登录中…' : '注册中…';
      const r = tab === 'login' ? await Auth.login(name, pw) : await Auth.register(name, pw);
      if (!r.ok) {
        err.textContent = r.error;
        go.disabled = false;
        go.textContent = tab === 'login' ? '登录' : '注册并登录';
        return;
      }
      syncNav();
      const to = Auth.redirect;
      Auth.redirect = null;
      if (to && to !== '#/account') location.hash = to;
      else nav();
    };
    u.focus();
  };
  draw();
}

function renderProfile(v) {
  const lg = Store.log(), ok = lg.filter(x => x.ok).length;
  const w = Object.keys(Store.wrong()).length, s = Object.keys(Store.star()).length;
  const stMap = {
    ok: ['已同步', ''], saving: ['同步中…', 'warn'], error: ['同步失败', 'warn'], idle: ['待同步', 'off'],
  };
  const st = stMap[Sync.state] || stMap.idle;
  const when = Sync.at ? new Date(Sync.at).toLocaleTimeString('zh-CN') : '—';

  v.innerHTML = `
  <h1 class="pg">我的</h1>
  <p class="sub">学习记录已绑定到账号，换设备登录同一账号即可继续。</p>

  <div class="card acct-head">
    <div class="av-big">${esc(Auth.user.name.slice(0, 1).toUpperCase())}</div>
    <div style="flex:1">
      <h2>${esc(Auth.user.name)}</h2>
      <p>已登录 · 记录自动同步</p>
    </div>
    <span class="pill ${st[1]}">${st[0]}</span>
  </div>

  <div class="sec-title"><h3>云端数据</h3><span>每次做题后自动保存</span></div>
  <div class="card" style="padding:6px 22px 12px">
    <div class="sync-row"><span class="k">累计作答</span><span class="v">${fmt(lg.length)} 题</span><span class="muted" style="font-size:11.5px">正确率 ${lg.length ? pct(ok, lg.length) + '%' : '—'}</span></div>
    <div class="sync-row"><span class="k">错题本</span><span class="v">${w} 题</span></div>
    <div class="sync-row"><span class="k">收藏</span><span class="v">${s} 题</span></div>
    <div class="sync-row"><span class="k">最近同步</span><span class="v">${when}</span></div>
  </div>

  <div class="row" style="margin-top:20px">
    <button class="btn primary" id="now">立即同步</button>
    <button class="btn" id="out">退出登录</button>
  </div>

  <div class="sec-title"><h3>账号安全</h3><span>修改密码后，其他设备上的登录会被退出</span></div>
  <div class="card" style="padding:16px 22px">
    <button class="btn" id="pwdToggle">修改密码</button>
    <form id="pwdForm" style="display:none;margin-top:16px;max-width:360px">
      <div class="field">
        <label for="po">原密码</label>
        <input id="po" type="password" autocomplete="current-password" maxlength="64" placeholder="当前使用的密码" />
      </div>
      <div class="field">
        <label for="pn">新密码</label>
        <input id="pn" type="password" autocomplete="new-password" maxlength="64" placeholder="6–64 位" />
      </div>
      <div class="field">
        <label for="pn2">确认新密码</label>
        <input id="pn2" type="password" autocomplete="new-password" maxlength="64" placeholder="再输一次" />
        <div class="ferr" id="perr"></div>
      </div>
      <div class="row">
        <button class="btn primary" id="pwdGo" type="submit">确认修改</button>
        <button class="btn ghost" id="pwdCancel" type="button">取消</button>
      </div>
    </form>
  </div>

  <div class="auth-note" style="max-width:620px;margin-top:22px">
    退出登录后本机不再保留该账号的记录（记录都在云端，重新登录即恢复）。目前没有找回密码功能，请记牢密码。
  </div>`;

  $('#pwdToggle').onclick = () => {
    const f = $('#pwdForm');
    f.style.display = f.style.display === 'none' ? 'block' : 'none';
    if (f.style.display === 'block') $('#po').focus();
  };
  $('#pwdCancel').onclick = () => {
    $('#pwdForm').style.display = 'none';
    ['#po', '#pn', '#pn2'].forEach(s => { $(s).value = ''; });
    $('#perr').textContent = '';
  };
  $('#pwdForm').onsubmit = async e => {
    e.preventDefault();
    const po = $('#po').value, pn = $('#pn').value, pn2 = $('#pn2').value;
    const perr = $('#perr'), go = $('#pwdGo');
    if (!po) { perr.textContent = '请输入原密码'; $('#po').focus(); return; }
    if (pn.length < 6 || pn.length > 64) { perr.textContent = '新密码长度需 6–64 位'; $('#pn').focus(); return; }
    if (pn !== pn2) { perr.textContent = '两次输入的新密码不一致'; $('#pn2').focus(); return; }
    if (pn === po) { perr.textContent = '新密码不能与原密码相同'; $('#pn').focus(); return; }
    perr.textContent = '';
    go.disabled = true; go.textContent = '提交中…';
    const r = await Auth.changePwd(po, pn);
    go.disabled = false; go.textContent = '确认修改';
    if (!r.ok) { perr.textContent = r.error; return; }
    toast('密码已修改');
    $('#pwdForm').style.display = 'none';
    ['#po', '#pn', '#pn2'].forEach(s => { $(s).value = ''; });
  };

  $('#now').onclick = async () => {
    const b = $('#now'); b.disabled = true; b.textContent = '同步中…';
    await Sync.afterLogin(true);
    b.disabled = false; b.textContent = '立即同步';
    toast('已同步');
    nav();
  };
  $('#out').onclick = async () => {
    if (!confirm('退出登录？本机将不再显示该账号的记录（云端已保存，重新登录即可恢复）。')) return;
    await Auth.logout();
    toast('已退出');
    nav();
  };
}

/* ---------------- 统计 ---------------- */
route(/^\/stats$/, async v => {
  const lg = Store.log();
  const ok = lg.filter(x => x.ok).length;
  const td = lg.filter(x => x.d === todayKey());
  const last14 = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const key = dayKey(d);
    last14.push({ n: lg.filter(x => x.d === key).length, label: (d.getMonth() + 1) + '/' + d.getDate() });
  }
  const mx = Math.max(1, ...last14.map(x => x.n));
  const byMod = MODS.map(([c, n]) => {
    const a = lg.filter(x => x.m === c);
    return { c, n, t: a.length, ok: a.filter(x => x.ok).length };
  });

  v.innerHTML = `<h1 class="pg">学习统计</h1>
  <p class="sub">数据全部保存在本机浏览器，不上传任何地方。</p>
  <div class="statgrid">
    <div class="statbox"><span>累计作答</span><b>${fmt(lg.length)}</b></div>
    <div class="statbox"><span>总正确率</span><b>${lg.length ? pct(ok, lg.length) + '%' : '—'}</b></div>
    <div class="statbox"><span>今日作答</span><b>${td.length}</b></div>
    <div class="statbox"><span>连续打卡</span><b>${streakDays()} 天</b></div>
  </div>
  <div class="sec-title"><h3>最近 14 天</h3><span>每天作答题数</span></div>
  <div class="card" style="padding:16px 20px">
    <div class="bars">${last14.map(x => `<div class="b"><i style="height:${x.n ? Math.max(6, x.n / mx * 100) : 0}%"></i><em>${x.label}</em></div>`).join('')}</div>
  </div>
  <div class="sec-title"><h3>分模块正确率</h3><span>找出真正拖后腿的模块</span></div>
  <div class="card" style="padding:8px 20px">
    ${byMod.map(m => {
      const p = m.t ? pct(m.ok, m.t) : 0;
      return `<div class="mrow"><div class="nm">${m.n}</div>
        <div class="track">${m.t ? `<i style="width:${p}%;background:${MCOLOR[m.c]}"></i>` : ''}</div>
        <div class="pct">${m.t ? `${m.ok}/${m.t} · ${p}%` : '未练习'}</div></div>`;
    }).join('')}
  </div>
  <div class="row" style="margin-top:20px">
    <button class="btn" id="exp">导出学习记录</button>
    <button class="btn ghost" id="reset">清空全部记录</button>
  </div>`;

  $('#exp').onclick = () => {
    const blob = new Blob([JSON.stringify({ log: lg, wrong: Store.wrong(), star: Store.star() }, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'xingce-record-' + todayKey() + '.json'; a.click();
  };
  $('#reset').onclick = () => {
    if (!confirm('将清空作答记录、错题本、收藏，确定？')) return;
    ['wrong', 'star', 'log', 'paper'].forEach(k => localStorage.removeItem('xc.' + k));
    nav();
  };
});

/* ---------------- 做题 ---------------- */
route(/^\/run$/, async v => {
  if (!RUN) loadRun();
  if (!RUN || !RUN.locs.length) { location.hash = '#/home'; return; }
  const total = RUN.locs.length;
  const isPaper = RUN.kind === 'paper';
  if (!RUN.res) RUN.res = {};

  v.innerHTML = `
  <div class="pbar">
    <button class="btn ghost sm" id="quit">← 退出</button>
    <div class="ttl">${esc(RUN.title)}</div>
    <div class="prog"><i id="pbar" style="width:0%"></i></div>
    <div class="meta" id="pos">1/${total}</div>
    <div class="timer" id="timer">0:00</div>
    ${isPaper ? '<button class="btn primary sm" id="submit">交卷</button>' : ''}
  </div>
  <div class="pwrap">
    <div id="qbox"></div>
    <aside class="sheet">
      <h5><span>答题卡</span><span id="sheetstat"></span></h5>
      <div class="nums" id="nums"></div>
      <div class="legend">
        <span><i style="background:#f4f6fa"></i>未做</span>
        <span><i style="background:#e8edf9"></i>已选</span>
        <span><i style="background:#dcf3e4"></i>对</span>
        <span><i style="background:#fbdcdc"></i>错</span>
      </div>
      <div class="stat"><span id="s1">答对 0</span><span id="s2">答错 0</span></div>
    </aside>
  </div>`;

  const tick = () => { const t = $('#timer'); if (t) t.textContent = hhmmss(Date.now() - RUN.t0); };
  tick(); TIMER = setInterval(tick, 1000);

  $('#quit').onclick = () => {
    const back = isPaper && RUN.paper != null ? '#/paper/' + RUN.paper : '#/home';
    if (isPaper && !RUN.done) savePaperProgress();
    RUN = null; sessionStorage.removeItem('xc.run'); location.hash = back;
  };
  if (isPaper) $('#submit').onclick = () => {
    const un = RUN.locs.filter((_, i) => !RUN.ans[i]).length;
    if (un && !confirm(`还有 ${un} 题未作答，确定交卷？`)) return;
    judgeAll(); savePaperProgress(); draw();
  };

  let curQ = null;
  async function draw() {
    const i = RUN.idx, loc = RUN.locs[i], q = await getQ(loc);
    curQ = q;
    const sel = RUN.ans[i] || '';
    const judged = !!RUN.judged[i];
    const multi = q.a.length > 1;
    const mat = (await getMat(q)).trim();
    const box = $('#qbox');

    box.innerHTML = `<div class="qcard">
      <div class="qhead">
        <span class="no">第 ${i + 1} / ${total} 题</span>
        <span class="tag blue">${MNAME[q.m]}</span>
        <span class="tag">${esc(q.t)}</span>
        ${q.k && q.k !== q.t ? `<span class="tag">${esc(q.k)}</span>` : ''}
        ${multi ? '<span class="tag">多选</span>' : ''}
        <span class="spacer"></span>
        <button class="btn sm ghost" id="star">${Store.star()[q.id] ? '★ 已收藏' : '☆ 收藏'}</button>
      </div>
      ${mat ? `<details class="mat" ${q.m === '06' ? 'open' : ''}><summary>材料（点击展开／收起）</summary><div class="mbody">${mat}</div></details>` : ''}
      <div class="stem">${q.s.replace(/\n/g, '<br>')}</div>
      <div class="opts" id="opts">
        ${q.o.map((o, k) => {
          const L = q.L[k] || LETTERS[k];
          let cls = 'opt';
          if (judged) {
            cls += ' locked';
            if (q.a.includes(L)) cls += ' right';
            else if (sel.includes(L)) cls += ' wrong';
          } else if (sel.includes(L)) cls += ' sel';
          const mark = judged ? (q.a.includes(L) ? '正确答案' : (sel.includes(L) ? '你选的' : '')) : '';
          const plain = !o || o.replace(/<[^>]+>/g, '').trim() === L;
          return `<button class="${cls}" data-l="${L}"><span class="k">${L}</span><span class="v">${plain ? '<i class="muted">（见图）</i>' : o}</span>${mark ? `<span class="mark">${mark}</span>` : ''}</button>`;
        }).join('')}
      </div>
      ${multi && !judged ? `<div class="row" style="margin-top:14px"><button class="btn primary" id="ok">确认答案（${sel || '未选'}）</button><span class="muted" style="font-size:12px">多选题：选完点确认</span></div>` : ''}
      ${judged ? expHtml(q, sel) : ''}
      <div class="acts">
        <button class="btn" id="prev" ${i === 0 ? 'disabled' : ''}>← 上一题</button>
        <button class="btn" id="next" ${i === total - 1 ? 'disabled' : ''}>下一题 →</button>
        <div class="kbd">快捷键 A–H 选择 · ← → 翻页 · 空格下一题</div>
      </div>
    </div>`;
    drawSheet();

    $$('.opt', box).forEach(b => b.onclick = () => choose(b.dataset.l, multi));
    const okb = $('#ok'); if (okb) okb.onclick = () => { if (instant) judge(i, q); else go(i + 1); };
    $('#prev').onclick = () => go(i - 1);
    $('#next').onclick = () => go(i + 1);
    $('#star').onclick = () => { const on = Store.toggleStar(q, loc); toast(on ? '已收藏' : '已取消收藏'); syncNav(); draw(); };
  }

  const expHtml = (q, sel) => {
    const right = sel === q.a;
    return `<div class="exp">
      <div class="eh"><b>${right ? '✓ 回答正确' : (sel ? '✗ 回答错误' : '○ 未作答')}</b>
        <span class="ans">正确答案 <b class="${right ? '' : 'no'}">${q.a}</b>${sel && !right ? ` · 你的答案 <b class="no">${sel}</b>` : ''}</span></div>
      <div class="body">${q.e ? q.e.replace(/\n/g, '<br>') : '<i class="muted">（本题无解析）</i>'}</div>
    </div>`;
  };

  const instant = RUN.kind !== 'paper';   // 整卷模式交卷前不判分

  function choose(L, multi) {
    const i = RUN.idx;
    if (RUN.judged[i]) return;
    if (multi) {
      const cur = new Set((RUN.ans[i] || '').split('').filter(Boolean));
      cur.has(L) ? cur.delete(L) : cur.add(L);
      RUN.ans[i] = [...cur].sort().join('');
      saveRun(); draw();
    } else {
      RUN.ans[i] = L; saveRun(); draw();
      if (instant) judge(i, curQ);
      else if (isPaper) savePaperProgress();
    }
  }

  function judge(i, q) {
    const sel = RUN.ans[i] || '';
    if (!sel) { toast('请先选择答案'); return; }
    const ok = sel === q.a;
    RUN.judged[i] = true;
    RUN.res[i] = ok ? 1 : 0;
    Store.addLog({ id: q.id, m: q.m, ok, d: todayKey(), t: Date.now() });
    const removed = Store.markWrong(q, RUN.locs[i], ok);
    if (ok && removed) toast('答对了，已移出错题本');
    saveRun(); syncNav(); draw();
  }

  function judgeAll() {
    getQs(RUN.locs).then(qs => {
      qs.forEach((q, i) => {
        if (RUN.judged[i]) return;
        const sel = RUN.ans[i] || '';
        RUN.judged[i] = true;
        if (!sel) return;
        const ok = sel === q.a;
        RUN.res[i] = ok ? 1 : 0;
        Store.addLog({ id: q.id, m: q.m, ok, d: todayKey(), t: Date.now() });
        Store.markWrong(q, RUN.locs[i], ok);
      });
      RUN.done = true;
      saveRun(); savePaperProgress(); syncNav(); draw();
    });
  }

  function savePaperProgress() {
    if (RUN.paper == null) return;
    const p = Store.paperP();
    p[RUN.paper] = { ans: RUN.ans, judged: RUN.judged, res: RUN.res, idx: RUN.idx, done: RUN.done, ts: Date.now() };
    LS.set('paper', p);
  }

  function drawSheet() {
    const answered = RUN.locs.filter((_, i) => RUN.ans[i]).length;
    $('#pos').textContent = `${RUN.idx + 1}/${total}`;
    $('#pbar').style.width = (answered / total * 100).toFixed(1) + '%';
    let right = 0, bad = 0;
    const showNums = total <= 400;
    $('#nums').innerHTML = showNums ? RUN.locs.map((l, i) => {
      let cls = '';
      if (RUN.res[i] === 1) { cls = 'ok'; right++; }
      else if (RUN.res[i] === 0) { cls = 'no'; bad++; }
      else if (RUN.ans[i]) cls = 'done';
      return `<button class="${cls} ${i === RUN.idx ? 'cur' : ''}" data-i="${i}">${i + 1}</button>`;
    }).join('') : `<div class="muted" style="grid-column:1/-1;font-size:12px;line-height:1.7">本次共 ${total} 题，题量较大，答题卡省略。用「上一题／下一题」逐题推进。</div>`;
    $('#sheetstat').textContent = `${answered}/${total}`;
    $('#s1').textContent = '答对 ' + right;
    $('#s2').textContent = '答错 ' + bad;
    $$('#nums button').forEach(b => b.onclick = () => go(+b.dataset.i));
  }

  function go(i) {
    if (i < 0 || i >= total) return;
    RUN.idx = i; saveRun();
    if (isPaper) savePaperProgress();
    draw();
  }

  document.onkeydown = e => {
    const tag = (e.target.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    const k = e.key.toUpperCase();
    if (k.length === 1 && LETTERS.includes(k)) {
      if (!curQ) return;
      const idx = curQ.L.indexOf(k);
      if (idx >= 0) { e.preventDefault(); choose(k, curQ.a.length > 1); }
      return;
    }
    if (e.key === 'ArrowLeft') { e.preventDefault(); go(RUN.idx - 1); }
    if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); go(RUN.idx + 1); }
    if (e.key === 'Enter') { const b = $('#ok'); if (b) b.click(); }
  };

  draw();
});

/* ---------------- 随机练习 ---------------- */
route(/^\/random$/, async (v, m, q) => {
  const [meta, bk] = await Promise.all([D.meta(), D.buckets()]);
  const n = Math.max(1, Math.min(200, +(q.get('n') || 10)));
  const fm = q.get('m') || 'all';
  const pool = (fm === 'all' ? bk.uniq : bk.mod[fm] || []).slice();
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  const locs = pool.slice(0, n);
  if (!locs.length) { location.hash = '#/home'; return; }
  startRun('drill', fm === 'all' ? '随机练习' : '随机 · ' + MNAME[fm], locs);
});

/* ---------------- 单题深链 ---------------- */
route(/^\/q\/(\d+)$/, async (v, m) => {
  const idx = await D.index();
  const pos = idx.qids.indexOf(+m[1]);
  if (pos < 0) { v.innerHTML = '<div class="empty"><p>没有找到这道题</p></div>'; return; }
  startRun('drill', '单题查看', [idx.locs[pos]]);
});

/* ---------------- 启动 ---------------- */
window.addEventListener('hashchange', nav);
async function boot() {
  loadRun();
  await Auth.init();
  nav();
  D.meta(); D.papers();
}
// 关页面前尽量把未同步的记录推上去
window.addEventListener('pagehide', () => {
  if (!Auth.user || !Sync.timer) return;
  clearTimeout(Sync.timer); Sync.timer = null;
  try {
    const body = JSON.stringify({ data: { wrong: Store.wrong(), star: Store.star(), log: Store.log() } });
    (navigator.sendBeacon && navigator.sendBeacon('api/sync', new Blob([body], { type: 'application/json' })))
      || fetch('api/sync', { method: 'POST', credentials: 'same-origin', keepalive: true, headers: { 'Content-Type': 'application/json' }, body });
  } catch (e) {}
});
if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', boot);
else boot();

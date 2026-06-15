/* My Attention popup redesign — interactive mock.
   Three version frames stay in sync: clicking a tab / sub-tab / size updates all. */

const VERSIONS = [
  { id: 'a', name: 'A · Linear 精修', note: '贴现有品牌', dot: '#5e6ad2' },
  { id: 'b', name: 'B · sayso 风格', note: '黑主色 · 软卡片 · 薄荷点缀', dot: '#2edda8' },
  { id: 'c', name: 'C · 大胆版', note: 'violet / 深色侧栏', dot: '#6d3bf5' },
];

const TABS = [
  { id: 'translate', label: '翻译', icon: 'languages' },
  { id: 'transcribe', label: '转写', icon: 'mic' },
  { id: 'record', label: '记录', icon: 'layers' },
  { id: 'summary', label: '总结', icon: 'brain' },
  { id: 'settings', label: '设置', icon: 'settings' },
];

const state = { tab: 'translate', transMode: 'sim', sumTab: 'summary', size: 'm' };

/* ---------------- panel renderers ---------------- */
const ic = (n) => `<i data-lucide="${n}"></i>`;

function panelTranslate() {
  const sim = state.transMode === 'sim';
  const stream = sim
    ? `<div class="stream">
         <span class="live">实时字幕</span>
         <div class="line"><div class="src">EN · The model learns representations…</div><div class="dst">模型学习数据的内部表征，而非死记硬背。</div></div>
         <div class="line"><div class="src">EN · …which generalize to new tasks.</div><div class="dst">这些表征能泛化到新任务上。</div></div>
       </div>`
    : `<div class="stream">
         <div class="line"><div class="src">原文 · Attention is all you need.</div><div class="dst">注意力就是你所需要的一切。</div></div>
         <div class="line"><div class="src">原文 · Each token attends to every other.</div><div class="dst">每个 token 都关注其他所有 token。</div></div>
         <div class="hint">${ic('book-open-text')} 整页对照 · 译文显示在原文下方</div>
       </div>`;
  return `
    <div class="subseg" data-sub="trans">
      <button data-mode="sim" class="${sim ? 'on' : ''}">同声传译</button>
      <button data-mode="immersive" class="${!sim ? 'on' : ''}">沉浸式翻译</button>
    </div>
    <div class="field-row">
      <div class="field"><label>目标语言</label><div class="select">中文 ${ic('chevron-down')}</div></div>
      <div class="field"><label>源语言</label><div class="select">自动检测 ${ic('chevron-down')}</div></div>
    </div>
    ${stream}
    <div class="foot-row">
      <button class="cta">${ic('play')} ${sim ? '开始传译' : '翻译整页'}</button>
      <span class="status">状态：<b>待机</b></span>
    </div>`;
}

function panelTranscribe() {
  return `
    <div class="empty">
      <div class="glyph">${ic('mic')}</div>
      <h3>转写功能开发中</h3>
      <p>实时语音转文字，会议与音视频内容自动成稿。</p>
      <span class="pill-soon">即将上线</span>
    </div>`;
}

function panelRecord() {
  const rec = (icn, t, plat, time, tag) => `
    <div class="rec">
      <div class="ic">${ic(icn)}</div>
      <div class="body">
        <div class="t">${t}</div>
        <div class="m"><span class="tag">${tag}</span><span>${plat}</span><span>·</span><span>${time}</span></div>
      </div>
    </div>`;
  return `
    <div class="toolbar">
      <div class="search">${ic('search')}<input placeholder="搜索记录…"></div>
      <div class="chip">${ic('calendar')} 今天</div>
      <div class="chip">${ic('git-merge')} 合并</div>
    </div>
    ${rec('message-square', '关于 Transformer 注意力机制的讨论', 'ChatGPT', '12:40', '对话')}
    ${rec('highlighter', '"涌现能力随规模出现" — 高亮划词', 'arxiv.org', '11:02', '划词')}
    ${rec('clock', '停留 8 分钟 · 深度阅读', 'Anthropic Blog', '09:25', '停留')}
    ${rec('message-square', 'RAG 检索增强生成方案对比', 'Kimi', '昨天', '对话')}`;
}

function panelSummary() {
  const onSum = state.sumTab === 'summary';
  const body = onSum
    ? `<button class="cta full">${ic('zap')} 生成总结</button>
       <div class="hint">${ic('info')} 需在设置页配置 LLM API Key</div>
       <div class="report">
         <h4>今日注意力报告</h4>
         <div class="sk"></div><div class="sk s2"></div><div class="sk s3"></div><div class="sk s4"></div>
       </div>`
    : `<button class="cta full soft">${ic('compass')} 基于此报告推荐源头</button>
       <div class="rec"><div class="ic">${ic('rss')}</div><div class="body"><div class="t">Distill.pub — 可视化机器学习</div><div class="m"><span class="tag">推荐</span><span>匹配「注意力」</span></div></div></div>
       <div class="rec"><div class="ic">${ic('rss')}</div><div class="body"><div class="t">The Batch · DeepLearning.AI</div><div class="m"><span class="tag">推荐</span><span>匹配「LLM」</span></div></div></div>`;
  return `
    <div class="subseg" data-sub="sum">
      <button data-sum="summary" class="${onSum ? 'on' : ''}">总结</button>
      <button data-sum="discover" class="${!onSum ? 'on' : ''}">发现</button>
    </div>
    ${body}`;
}

function panelSettings() {
  const sw = (on) => `<div class="sw ${on ? 'on' : ''}"></div>`;
  return `
    <div class="sgroup">
      <div class="gh">基础设置</div>
      <div class="srow"><div><div class="l">自动保存对话</div><div class="d">在支持的 AI 页面自动保存</div></div>${sw(true)}</div>
    </div>
    <div class="sgroup">
      <div class="gh">记录范围</div>
      <div class="srow"><div class="l">启用网页记录</div>${sw(true)}</div>
      <div class="srow"><div class="l">启用划词记录</div>${sw(true)}</div>
      <div class="srow"><div class="l">启用停留记录</div>${sw(false)}</div>
    </div>
    <div class="sgroup">
      <div class="gh">模型</div>
      <div class="srow"><div style="flex:1"><div class="l">LLM API Key</div><div class="kinput">sk-••••••••••••••••3a9f</div></div></div>
      <div class="srow"><div class="l">服务平台</div><div class="select" style="width:auto">OpenAI ${ic('chevron-down')}</div></div>
    </div>
    <div class="sgroup">
      <div class="gh danger">存储管理</div>
      <div class="srow"><div class="l">导出全部数据</div><div class="chip">${ic('download')} 导出</div></div>
      <div class="srow"><div><div class="l danger">清空所有数据</div><div class="d">永久删除，不可恢复</div></div><button class="danger-btn">清空</button></div>
    </div>`;
}

const PANELS = {
  translate: { title: '翻译', sub: '同声传译 · 沉浸式', body: panelTranslate },
  transcribe: { title: '转写', sub: '语音转文字', body: panelTranscribe },
  record: { title: '记录', sub: '对话 · 划词 · 停留', body: panelRecord },
  summary: { title: '总结', sub: '总结 · 发现', body: panelSummary },
  settings: { title: '设置', sub: '', body: panelSettings },
};

/* ---------------- frame assembly ---------------- */
function railHTML() {
  return TABS.map((t) =>
    `<button class="rail-btn ${state.tab === t.id ? 'on' : ''}" data-tab="${t.id}">
       ${ic(t.icon)}<span>${t.label}</span>
     </button>`).join('');
}

function mainHTML() {
  const p = PANELS[state.tab];
  const head = p.title === '设置'
    ? `<div class="phead"><div><h2>设置</h2></div></div>`
    : `<div class="phead">
         <div><h2>${p.title}</h2>${p.sub ? `<div class="sub">${p.sub}</div>` : ''}</div>
         ${state.tab === 'record' ? `<button class="icon-btn">${ic('git-merge')}</button>` : ''}
       </div>`;
  return `${head}<div class="pbody">${p.body()}</div>`;
}

function renderFrames() {
  const stage = document.getElementById('stage');
  stage.innerHTML = VERSIONS.map((v) => `
    <div class="frame-wrap">
      <div class="frame-label"><span class="dot" style="background:${v.dot}"></span>${v.name} <small>${v.note}</small></div>
      <div class="popup" data-version="${v.id}" data-size="${state.size}">
        <div class="main">${mainHTML()}</div>
        <div class="rail">${railHTML()}</div>
      </div>
    </div>`).join('');
  if (window.lucide) lucide.createIcons();
}

/* ---------------- events ---------------- */
document.addEventListener('click', (e) => {
  const tabBtn = e.target.closest('.rail-btn');
  if (tabBtn) { state.tab = tabBtn.dataset.tab; return renderFrames(); }

  const modeBtn = e.target.closest('[data-mode]');
  if (modeBtn) { state.transMode = modeBtn.dataset.mode; return renderFrames(); }

  const sumBtn = e.target.closest('[data-sum]');
  if (sumBtn) { state.sumTab = sumBtn.dataset.sum; return renderFrames(); }

  const sw = e.target.closest('.sw');
  if (sw) { sw.classList.toggle('on'); return; }

  const sizeBtn = e.target.closest('[data-size-opt]');
  if (sizeBtn) {
    state.size = sizeBtn.dataset.sizeOpt;
    document.querySelectorAll('[data-size-opt]').forEach((b) => b.classList.toggle('on', b === sizeBtn));
    document.querySelectorAll('.popup').forEach((p) => (p.dataset.size = state.size));
  }
});

renderFrames();

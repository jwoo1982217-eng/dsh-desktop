
(function () {
  'use strict';
  var embedded=new URLSearchParams(location.search).get('embedded')==='1';
  if(embedded)document.body.classList.add('embedded');

  /* ── 七层定义：ring 决定环半径，z 决定纵深平面 ───────────────── */
  var LAYERS = {
    soul:    { label: '写作', color: '#ffd166', ring: 0.95, z: -330 },
    user:    { label: '偏好',     color: '#7ee8fa', ring: 1.45, z: -220 },
    rules:   { label: '归档',     color: '#ffa66b', ring: 1.95, z: -110 },
    project: { label: '项目',     color: '#c9a7ff', ring: 2.45, z: 0 },
    topic:   { label: '知识',     color: '#8ab4ff', ring: 2.95, z: 110 },
    fact:    { label: '记录',     color: '#9dffc9', ring: 3.45, z: 220 },
    lesson:  { label: '进度',     color: '#ff8fb8', ring: 3.95, z: 330 }
  };
  var LEVEL_ORDER = ['soul', 'user', 'rules', 'project', 'topic', 'fact', 'lesson'];
  var STATUS_LABEL = { active: '有效', archived: '已归档', stale: '已完结' };

  var canvas = document.getElementById('sky');
  var ctx = canvas.getContext('2d');
  var $ = function (id) { return document.getElementById(id); };
  var detailEl = $('detail'), tipEl = $('tip'), toastEl = $('toast');

  var W = 0, H = 0, CX = 0, CY = 0, dpr = 1;
  var rotX = 0.34, rotY = -0.65, zoom = 1, autoRotate = false;
  var DATA = null, NODES = [], LINKS = [], OFFSETS = new Map();
  var hidden = new Set(), selected = null, hovered = null;
  var recalled=null, recallRequest=0, searchTimer;
  var search = '', includeAll = false, workspace = null, workspaces = [];
  var dragging = null, moved = 0, lx = 0, ly = 0;
  var stars = [];

  for (var i = 0; i < 320; i++) {
    stars.push({ x: Math.random(), y: Math.random(), r: Math.random() * 0.9 + 0.2, a: Math.random() * 0.5 + 0.08, p: Math.random() * 6.28 });
  }

  function hash(s) {
    var h = 2166136261;
    for (var k = 0; k < s.length; k++) { h ^= s.charCodeAt(k); h = Math.imul(h, 16777619); }
    return ((h >>> 0) % 10000) / 10000;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function short(s, n) { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; }
  function fmt(ms) {
    if (!ms) return '—';
    var d = new Date(ms);
    var p = function (x) { return x < 10 ? '0' + x : '' + x; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function hexA(hex, a) {
    var n = parseInt(hex.slice(1), 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }
  function toast(text) {
    toastEl.textContent = text;
    toastEl.classList.add('show');
    setTimeout(function () { toastEl.classList.remove('show'); }, 1600);
  }

  /* ── 布局：每条记忆落在自己那一层的同心环上 ───────────────────── */
  function buildNodes(items) {
    var groups = {};
    items.forEach(function (it) { (groups[it.level] = groups[it.level] || []).push(it); });
    var nodes = [];
    LEVEL_ORDER.forEach(function (level) {
      var arr = groups[level] || [], meta = LAYERS[level];
      if (!meta) return;
      arr.forEach(function (it, idx) {
        var key = it.uid || it.id;
        var a = (idx / Math.max(1, arr.length)) * Math.PI * 2 + hash(key) * 0.5;
        var rr = meta.ring * 78 + (hash(key + 'r') - 0.5) * 54;
        var off = OFFSETS.get(key) || { x: 0, y: 0 };
        var bx = Math.cos(a) * rr, by = Math.sin(a) * rr * 0.56;
        nodes.push({
          id: key, rawId: it.id, workspaceName: it.source, sourceUrl: it.sourceUrl, truncated: it.truncated,
          level: level, content: it.content, title: it.title,
          importance: it.importance || 1, keywords: it.keywords || [], status: it.status || 'active',
          project: it.project, subcategory: it.subcategory, goal: it.goal,
          corrected: it.corrected, hitCount: it.hitCount, createdAt: it.createdAt,
          updatedAt: it.updatedAt, sourceSession: it.sourceSession,
          color: meta.color,
          x: bx + off.x, y: by + off.y, baseX: bx, baseY: by,
          z: meta.z + (hash(key + 'z') - 0.5) * 80,
          radius: 2.4 + Math.min(6, it.importance || 1) * 0.95
        });
      });
    });
    return nodes;
  }

  function buildLinks(nodes) {
    var byId=new Map(nodes.map(function(n){return [n.id,n];}));
    return (DATA && DATA.edges || []).filter(function(e){return byId.has(e.from)&&byId.has(e.to);}).map(function(e){return [byId.get(e.from),byId.get(e.to),e];});
  }
  /* ── 3D 投影 ──────────────────────────────────────────────────── */
  function project(p) {
    var cy = Math.cos(rotY), sy = Math.sin(rotY);
    var x1 = p.x * cy - p.z * sy, z1 = p.x * sy + p.z * cy;
    var cx = Math.cos(rotX), sx = Math.sin(rotX);
    var y1 = p.y * cx - z1 * sx, z2 = p.y * sx + z1 * cx;
    var persp = 620 / (620 + z2);
    return { x: CX + x1 * persp * zoom, y: CY + y1 * persp * zoom, z: z2, s: persp * zoom };
  }

  function visible(n) { return !hidden.has(n.level); }
  function matches(n) {
    if (!search) return true;
    if(recalled)return recalled.items.some(function(r){return r.id===n.id;});
    var s = search.toLowerCase();
    return (n.content + ' ' + (n.title || '') + ' ' + (n.project || '') + ' ' + n.keywords.join(' ')).toLowerCase().indexOf(s) >= 0;
  }

  function draw() {
    var g = ctx.createRadialGradient(CX, CY, 100, CX, CY, Math.max(W, H) * 0.85);
    g.addColorStop(0, '#151b3a'); g.addColorStop(1, '#05070f');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

    var t = Date.now() / 1000;
    for (var s = 0; s < stars.length; s++) {
      var st = stars[s];
      ctx.globalAlpha = st.a * (0.65 + 0.35 * Math.sin(t * 1.4 + st.p));
      ctx.fillStyle = '#cdd8ff';
      ctx.beginPath(); ctx.arc(st.x * W, st.y * H, st.r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;

    // 七层同心环 + 层名
    LEVEL_ORDER.forEach(function (level) {
      if (hidden.has(level)) return;
      var meta = LAYERS[level], pts = [];
      for (var k = 0; k <= 72; k++) {
        var a = (k / 72) * Math.PI * 2;
        pts.push(project({ x: Math.cos(a) * meta.ring * 78, y: Math.sin(a) * meta.ring * 78 * 0.56, z: meta.z }));
      }
      ctx.strokeStyle = hexA(meta.color, 0.13); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
      for (var q = 1; q < pts.length; q++) ctx.lineTo(pts[q].x, pts[q].y);
      ctx.stroke();
      var tag = project({ x: meta.ring * 78 + 26, y: 0, z: meta.z });
      ctx.fillStyle = hexA(meta.color, 0.62);
      ctx.font = '12px "PingFang SC","Microsoft YaHei",sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(meta.label, tag.x, tag.y);
    });

    // 关联线
    ctx.lineWidth = 1;
    for (var l = 0; l < LINKS.length; l++) {
      var A = LINKS[l][0], B = LINKS[l][1];
      if (!visible(A) || !visible(B)) continue;
      var pa = project(A), pb = project(B);
      var alpha = Math.max(0.05, 0.3 - (pa.z + pb.z) / 2600);
      if (!matches(A) || !matches(B)) alpha *= 0.3;
      if (selected && (A.id === selected.id || B.id === selected.id)) alpha = 0.75;
      ctx.strokeStyle = selected && (A.id === selected.id || B.id === selected.id)
        ? hexA(selected.color, alpha) : 'rgba(150,180,255,' + alpha + ')';
      ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
    }

    // 中心「此刻」
    var core = project({ x: 0, y: 0, z: 0 });
    var cr = 22 * core.s;
    var cg = ctx.createRadialGradient(core.x, core.y, 0, core.x, core.y, cr * 3.4);
    cg.addColorStop(0, 'rgba(255,246,220,.95)');
    cg.addColorStop(0.3, 'rgba(255,220,160,.32)');
    cg.addColorStop(1, 'rgba(255,220,160,0)');
    ctx.fillStyle = cg; ctx.beginPath(); ctx.arc(core.x, core.y, cr * 3.4, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff6e0'; ctx.beginPath(); ctx.arc(core.x, core.y, cr * 0.5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(232,236,255,.65)'; ctx.font = '12px "PingFang SC",sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('此刻', core.x, core.y + cr * 3.4 + 16);

    // 光点（远的先画）
    var order = NODES.map(function (n, idx) { return { n: n, i: idx }; })
      .filter(function (o) { return visible(o.n); })
      .sort(function (a, b) { return project(b.n).z - project(a.n).z; });
    for (var oi = 0; oi < order.length; oi++) {
      var n = order[oi].n, p = project(n);
      var rr = Math.max(1.7, n.radius * p.s);
      var sel = selected && selected.id === n.id;
      var hov = hovered && hovered.id === n.id;
      var alpha = 1;
      if (n.status !== 'active') alpha *= 0.4;
      if (!matches(n)) alpha *= 0.12;
      var haloR = rr * (sel ? 4.2 : hov ? 3.4 : 2.6);
      var hg = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, haloR);
      hg.addColorStop(0, hexA(n.color, (sel ? 0.65 : 0.28) * alpha));
      hg.addColorStop(1, hexA(n.color, 0));
      ctx.fillStyle = hg; ctx.beginPath(); ctx.arc(p.x, p.y, haloR, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = n.color; ctx.beginPath(); ctx.arc(p.x, p.y, rr * (sel ? 1.3 : 1), 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = hexA(n.color, 0.6); ctx.lineWidth = 1.4;
      if (n.status !== 'active') ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.arc(p.x, p.y, rr * 1.75, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      if (sel || hov) {
        ctx.fillStyle = sel ? '#ffffff' : 'rgba(232,236,255,.92)';
        ctx.font = (sel ? '600 ' : '400 ') + Math.max(12, Math.round(14 * p.s)) + 'px "PingFang SC","Microsoft YaHei",sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(short(n.title || n.content, 16), p.x, p.y - Math.max(14, rr * 3.4));
      }
    }
  }

  function hitTest(x, y) {
    var best = null, bestD = 1e9;
    for (var i = 0; i < NODES.length; i++) {
      var n = NODES[i];
      if (!visible(n) || !matches(n)) continue;
      var p = project(n);
      var r = Math.max(3, n.radius * p.s) + 14;
      var d = Math.hypot(p.x - x, p.y - y);
      if (d < r && d < bestD) { bestD = d; best = n; }
    }
    return best;
  }

  /* ── 详情面板 ─────────────────────────────────────────────────── */
  function showDetail(n) {
    if (!n) { detailEl.classList.remove('show'); return; }
    var meta = LAYERS[n.level] || { label: n.level, color: '#8ab4ff' };
    var statusColor = n.status === 'active' ? '#9dffc9' : n.status === 'archived' ? '#8b96c4' : '#ffc86b';
    var stars = '★'.repeat(Math.min(5, Math.max(1, n.importance))) + '<span style="color:#4b557c">' + '☆'.repeat(Math.max(0, 5 - Math.min(5, n.importance))) + '</span>';
    var kws = (n.keywords || []).slice(0, 14).map(function (k) { return '<span>' + esc(k) + '</span>'; }).join('');
    var rel = NODES.filter(function (m) {
      return (DATA.edges || []).some(function(e){return (e.from===n.id&&e.to===m.id)||(e.to===n.id&&e.from===m.id);});
    }).slice(0, 5).map(function (m) {
      var edge=(DATA.edges||[]).find(function(e){return (e.from===n.id&&e.to===m.id)||(e.to===n.id&&e.from===m.id);});
      return '<a data-id="'+esc(m.id)+'">'+esc(short(m.title||m.content,30))+' <small>('+esc(edge.kind==='link'?'笔记链接':'共同标签：'+(edge.tags||[]).join('、'))+')</small></a>';
    }).join('');
    var html = '<div class="badges">'
      + '<span class="badge" style="color:' + meta.color + ';border-color:' + hexA(meta.color, .55) + '">' + esc(meta.label) + '</span>'
      + '<span class="badge ghost" style="color:' + statusColor + '">' + esc(STATUS_LABEL[n.status] || n.status) + '</span>'
      + (n.corrected ? '<span class="badge ghost">用户纠正</span>' : '')
      + '</div>'
      + '<div class="d-time">更新 ' + esc(fmt(n.updatedAt)) + '　·　创建 ' + esc(fmt(n.createdAt)) + '</div>'
      + '<div class="d-title">' + esc(short(n.title || n.content, 26)) + '</div>'
      + '<div class="rule"></div>'
      + '<dl class="grid">'
      + '<dt>内容</dt><dd>来源原文，按需引用</dd>'
      + (n.workspaceName ? '<dt>工作区</dt><dd>' + esc(n.workspaceName) + '</dd>' : '')
      + '<dt>项目</dt><dd>' + esc(n.project || '—') + '</dd>'
      + '<dt>子类</dt><dd>' + esc(n.subcategory || '—') + '</dd>'

      + (n.goal ? '<dt>目标</dt><dd>' + esc(n.goal) + '</dd>' : '')
      + '<dt>来源会话</dt><dd>' + esc(short(n.sourceSession || '—', 26)) + '</dd>'
      + '</dl>'
      + (kws ? '<div class="kw">' + kws + '</div>' : '<div class="rule"></div>')
      + (n.reasons?'<p class="empty-note">联想依据：'+esc(why(n))+'</p>':'') + '<div class="d-content">' + esc(n.content) + '</div>'
      + (n.truncated ? '<p class="empty-note">当前展示前 12000 字符，可分段读取完整原文。</p><button id="read-more">继续读取原文</button>' : '')
      + (embedded&&(n.id.indexOf('knowledge:')===0||n.id.indexOf('summary:')===0) ? '<p><button class="d-source" id="open-note">在知识库中打开</button></p>' : '<p><a class="d-source" href="'+esc(n.sourceUrl||'/knowledge-base')+'">打开来源知识库</a></p>')
      + (rel ? '<div class="rel"><div class="t">关联记忆</div>' + rel + '</div>' : '')
      + '<div class="d-foot">' + esc(n.rawId || n.id) + '<button id="copy-id">复制 ID</button></div>';
    detailEl.innerHTML = html;
    detailEl.classList.add('show');
    detailEl.querySelectorAll('.rel a').forEach(function (a) {
      a.addEventListener('click', function () {
        var target = NODES.find(function (m) { return m.id === a.getAttribute('data-id'); });
        if (target) { selected = target; showDetail(target); }
      });
    });
    var more=$('read-more');
    if(more)more.addEventListener('click',async function(){try{var d=await api('/meow-constellation/api/read?id='+encodeURIComponent(n.id)+'&offset='+n.content.length);if(!d.ok)throw Error(d.error);n.content+=d.item.content;n.truncated=d.item.nextOffset!==null;showDetail(n);}catch(e){toast(e.message);}});
    var openNote=$('open-note');
    if(openNote)openNote.addEventListener('click',function(){parent.postMessage({type:'dsh-memory-constellation:open-note',id:n.id},location.origin);});
    var copy = $('copy-id');
    if (copy) copy.addEventListener('click', function () {
      if (navigator.clipboard) navigator.clipboard.writeText(n.rawId || n.id).then(function () { toast('ID 已复制'); });
    });
  }

  function select(n) {
    selected = n;
    if (n) { autoRotate = false; $('autorotate').checked = false; }
    showDetail(n);
  }

  /* ── 数据获取 ─────────────────────────────────────────────────── */
  function setStatus(text, demo) {
    $('status').innerHTML = '<span class="dot' + (demo ? ' demo' : '') + '"></span>' + (demo ? '演示数据' : '实时连接')
      + '　·　<b>' + (DATA ? DATA.total : 0) + '</b> 条<br><b id="status-sub">' + esc(text) + '</b>';
  }

  function applyData(d, silent) {
    var changed = !DATA || d.mtime !== DATA.mtime || d.workspace !== DATA.workspace || d.includeAll !== DATA.includeAll;
    DATA = d;
    if (changed) {
      NODES = buildNodes(d.items);
      LINKS = buildLinks(NODES);
      if (!silent) toast('已同步 · ' + d.total + ' 条记忆');
      if (selected) {
        var keep = NODES.find(function (n) { return n.id === selected.id; });
        selected = keep || null;
        showDetail(selected);
      }
      updateLegend(); renderResults();if(search)recallSearch();
    }
    setStatus(d.workspaceName + ' · ' + d.edges.length + ' 条关联' + (d.limited ? ' · 仅展示最近 500 条，可用工具检索全部' : '') + (d.graphLimited ? ' · 关联范围沿用知识库最近 120 篇' : '') + ' · 更新于 ' + fmt(d.generatedAt), false);
  }

  function showError(error) { DATA=null; NODES=[]; LINKS=[]; selected=null; showDetail(null); updateLegend(); renderResults(); setStatus('连接失败：'+error.message,false); }
  function why(n){return (n.reasons||[]).map(function(r){return r.kind==='relation'?'关联自 '+r.title+'（'+(r.edge==='link'?'笔记链接':'共同标签')+'）':r.kind==='semantic'?'语义相关':r.kind==='keyword'?'关键词命中':'历史关键词';}).join(' · ');}
  function renderResults(){
    var rows=search?(recalled?recalled.items:[]):NODES.filter(function(n){return visible(n);}).slice(0,30);
    $('results').innerHTML=rows.length?rows.map(function(n){return '<button data-id="'+esc(n.id)+'">'+esc(short(n.title||n.content,40))+(search?'<small style="display:block;margin-top:4px">'+esc(why(n))+'</small>':'')+'</button>';}).join(''):'<p class="empty-note">'+(search&&!recalled?'正在联想查找…':DATA?'没有匹配的记忆':'等待知识库连接')+'</p>';
    if(recalled&&recalled.warnings.length)$('results').insertAdjacentHTML('beforeend','<p class="empty-note">'+esc(recalled.warnings.join(' '))+'</p>');
    $('results').querySelectorAll('button').forEach(function(b){b.addEventListener('click',function(){var found=rows.find(function(n){return n.id===b.dataset.id;}),node=NODES.find(function(n){return n.id===b.dataset.id;});if(!node&&found)node=buildNodes([found])[0];if(node){node.reasons=found.reasons;select(node);}});});
  }
  async function recallSearch(){var request=++recallRequest;if(!search){recalled=null;renderResults();return;}try{var data=await api('/meow-constellation/api/search?q='+encodeURIComponent(search)+'&scope='+encodeURIComponent(workspace||'__all__'));if(request!==recallRequest)return;if(!data.ok)throw Error(data.error);recalled=data;renderResults();}catch(e){if(request!==recallRequest)return;recalled={items:[],warnings:[e.message]};renderResults();}}
  function updateLegend() {
    var counts = {};
    NODES.forEach(function (n) { counts[n.level] = (counts[n.level] || 0) + 1; });
    $('legend').innerHTML = LEVEL_ORDER.map(function (level) {
      var m = LAYERS[level];
      return '<div class="legend-row' + (hidden.has(level) ? ' off' : '') + '" data-level="' + level + '">'
        + '<i class="swatch" style="background:' + m.color + ';color:' + m.color + '"></i>'
        + '<span class="name">' + m.label + '</span><span class="num">' + (counts[level] || 0) + '</span></div>';
    }).join('');
    $('layer-total').textContent = NODES.length + ' 条';
    $('legend').querySelectorAll('.legend-row').forEach(function (row) {
      row.addEventListener('click', function () {
        var lv = row.getAttribute('data-level');
        if (hidden.has(lv)) hidden.delete(lv); else hidden.add(lv);
        row.classList.toggle('off', hidden.has(lv)); renderResults();
      });
    });
  }

  function api(url) {
    return fetch(url, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  function loadWorkspaces() {
    return api('/meow-constellation/api/workspaces').then(function (d) {
      if (!d.ok) throw new Error(d.error || 'no workspaces');
      workspaces = d.workspaces || [];
      var sel = $('workspace');
      var allActive = workspaces.reduce(function (sum, w) { return sum + (w.activeTotal || 0); }, 0);
      var opts = ['<option value="__all__">全部来源 · ' + allActive + ' 条</option>'];
      opts = opts.concat(workspaces.map(function (w) {
        return '<option value="' + esc(w.path) + '">' + esc(w.name) + ' · ' + (w.activeTotal || 0) + ' 条</option>';
      }));
      sel.innerHTML = opts.join('');
      if (!workspace && d.current) { workspace = d.current; sel.value = workspace; }
    });
  }

  function loadMemories(silent) {
    var q = new URLSearchParams();
    if (workspace === '__all__') q.set('scope', 'all');
    else if (workspace) q.set('dir', workspace);
    if (includeAll) q.set('all', '1');
    // 静默轮询带上上次 mtime：库没变时服务端只回一个轻量标记，省掉整包传输
    if (silent && DATA && DATA.mtime) q.set('since', String(DATA.mtime));
    return api('/meow-constellation/api/memories?' + q.toString()).then(function (d) {
      if (!d.ok) throw new Error(d.error || 'no data');
      if (d.unchanged) return;
      applyData(d, silent);
    }).catch(function (e) {
      showError(e);
    });
  }

  /* ── 交互 ─────────────────────────────────────────────────────── */
  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    CX = W / 2; CY = H / 2 + 18;
  }

  canvas.addEventListener('mousedown', function (e) {
    var n = hitTest(e.clientX, e.clientY);
    dragging = { type: n ? 'node' : 'view', node: n, x: e.clientX, y: e.clientY,
      ox: n ? ((OFFSETS.get(n.id) || {}).x || 0) : 0, oy: n ? ((OFFSETS.get(n.id) || {}).y || 0) : 0 };
    moved = 0; lx = e.clientX; ly = e.clientY;
    if (n) autoRotate = false, $('autorotate').checked = false;
    canvas.style.cursor = 'grabbing';
  });
  window.addEventListener('mousemove', function (e) {
    var dx = e.clientX - lx, dy = e.clientY - ly;
    if (dragging) {
      moved += Math.abs(dx) + Math.abs(dy);
      if (dragging.type === 'view') {
        rotY += dx * 0.006; rotX += dy * 0.005;
        rotX = Math.max(-1.2, Math.min(1.2, rotX));
      } else {
        var off = {
          x: dragging.ox + (e.clientX - dragging.x) / zoom,
          y: dragging.oy + (e.clientY - dragging.y) / zoom
        };
        OFFSETS.set(dragging.node.id, off);
        dragging.node.x = dragging.node.baseX + off.x;
        dragging.node.y = dragging.node.baseY + off.y;
      }
      lx = e.clientX; ly = e.clientY;
    } else {
      var hit = hitTest(e.clientX, e.clientY);
      if (hit !== hovered) {
        hovered = hit;
        canvas.style.cursor = hit ? 'pointer' : 'grab';
      }
      if (hit) {
        tipEl.style.display = 'block';
        tipEl.style.left = (e.clientX + 16) + 'px';
        tipEl.style.top = (e.clientY + 16) + 'px';
        tipEl.textContent = '[' + LAYERS[hit.level].label + '] ' + short(hit.title || hit.content, 34);
      } else tipEl.style.display = 'none';
    }
  });
  window.addEventListener('mouseup', function (e) {
    if (dragging && moved < 6) {
      var hit = hitTest(e.clientX, e.clientY);
      if (hit) select(hit);
      else { selected = null; showDetail(null); }
    }
    dragging = null;
    canvas.style.cursor = 'grab';
  });
  canvas.addEventListener('wheel', function (e) {
    e.preventDefault();
    zoom *= e.deltaY > 0 ? 0.92 : 1.08;
    zoom = Math.max(0.5, Math.min(2.4, zoom));
  }, { passive: false });

  $('search').addEventListener('input', function (e) { search = e.target.value.trim(); recalled=null;recallRequest++;clearTimeout(searchTimer);renderResults();searchTimer=setTimeout(recallSearch,250); });
  $('workspace').addEventListener('change', function (e) { workspace = e.target.value; loadMemories(false); });
  $('all').addEventListener('change', function (e) { includeAll = e.target.checked; loadMemories(false); });
  $('autorotate').addEventListener('change', function (e) { autoRotate = e.target.checked; });
  $('refresh').addEventListener('click', function () { loadMemories(false); });
  $('reset').addEventListener('click', function () {
    OFFSETS.clear();
    NODES = buildNodes(DATA ? DATA.items : []);
    LINKS = buildLinks(NODES);
    rotX = 0.34; rotY = -0.65; zoom = 1;
    selected = null; showDetail(null);
    toast('视角与位置已重置');
  });

  function loop() {
    if (!document.hidden) { if (autoRotate && !dragging) rotY += 0.0012; draw(); }
    requestAnimationFrame(loop);
  }

  window.addEventListener('resize', resize);
  resize();
  updateLegend();
  setStatus('读取 DSH 知识库与记忆摘要', false);
  loop();

  loadWorkspaces().catch(showError)
    .then(function () { return loadMemories(false); })
    .then(function () {
      setInterval(function () { if (!document.hidden) loadMemories(true); }, 4000);
    });

  // 只读调试钩子：便于自动化冒烟与人工排查，不参与渲染。
  window.__mc = {
    get nodes() { return NODES; },
    get data() { return DATA; },
    get selected() { return selected; },
    select: function (n) { select(n); },
    hitTest: hitTest,
    project: project,
    draw: draw,
    buildNodes: buildNodes,
    buildLinks: buildLinks
  };
  window.__mcReady = true;
})();

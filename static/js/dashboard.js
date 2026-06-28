/* dashboard.js – METUCube Ground Station live message view */

const socket = io();

/* ── State ──────────────────────────────────────────────── */
const S = {
  messages:    [],          // All received this session (max 3000)
  selected:    new Set(),   // Checked db_ids
  paused:      false,
  connected:   false,
  autoScroll:  true,
  totalCount:  0,
  startTime:   null,
  filterSenders:   new Set(),
  filterReceivers: new Set(),
  filterMsgIds:    new Set(),
  filterSeqTypes:  new Set(),
  filterSearch:    '',
  filterSelected:  false,
  sortCol:     'db_id',
  sortDir:     1,           // 1=asc, -1=desc
};

/* Nodes & msg defs loaded from server */
let nodeMap   = {};   // int_id → {name, short, color}
let msgDefMap = {};   // int_id → {name, description}

/* Pending DOM updates (batch) */
let pending    = [];
let scheduled  = false;

/* ── DOM refs ───────────────────────────────────────────── */
const $  = id => document.getElementById(id);
const $$ = sel => document.querySelectorAll(sel);

const tbody     = $('msg-tbody');
const emptyRow  = $('empty-row');
const toast_cnt = $('toast-container');

/* ── Socket events ──────────────────────────────────────── */
socket.on('connect', () => fetchStatus());

socket.on('new_message', msg => {
  if (S.paused) return;
  S.totalCount++;
  S.messages.push(msg);
  if (S.messages.length > 3000) S.messages.shift();
  pending.push(msg);
  if (!scheduled) { scheduled = true; requestAnimationFrame(flush); }
  updateCounter();
});

socket.on('status_change', st => applyStatus(st));
socket.on('messages_cleared', () => { S.messages = []; S.selected.clear(); pending = []; tbody.innerHTML = ''; showEmpty(); updateCounter(); });
socket.on('message_updated', ({db_id, requested_db_id}) => {
  const m = S.messages.find(x => x.db_id === db_id);
  if (m) m.requested_db_id = requested_db_id;
  const cell = document.querySelector(`[data-dbid="${db_id}"] .req-cell`);
  if (cell) cell.innerHTML = renderReqCell(m);
});

/* ── Batch DOM flush ────────────────────────────────────── */
function flush() {
  scheduled = false;
  const msgs = pending.splice(0);
  const frag = document.createDocumentFragment();
  msgs.forEach(m => { if (passFilter(m)) { frag.appendChild(buildRow(m)); } });
  tbody.appendChild(frag);

  // Trim to 500 DOM rows max
  while (tbody.rows.length > 500) tbody.deleteRow(0);

  if (emptyRow && tbody.rows.length > 0) emptyRow.style.display = 'none';

  if (S.autoScroll) {
    const wrap = document.querySelector('.table-wrap');
    if (wrap) wrap.scrollTop = wrap.scrollHeight;
  }
}

/* ── Build a table row ──────────────────────────────────── */
function buildRow(m) {
  const tr = document.createElement('tr');
  tr.dataset.dbid = m.db_id;
  tr.className = 'new-row';
  
  // Eğer bizim gönderdiğimiz mesaj ise özel class ekle
  if (m.is_sent) tr.classList.add('sent-row');
  if (S.selected.has(m.db_id)) tr.classList.add('selected-row');

  const segBtn = (m.seg_group != null)
    ? `<button class="seg-chain-btn" title="Segment zinciri gör" onclick="openSegModal(${m.seg_group},event)">⛓</button>`
    : '';

  tr.innerHTML = `
    <td><input type="checkbox" class="row-check" ${S.selected.has(m.db_id)?'checked':''} onchange="toggleSelect(${m.db_id},this,event)"></td>
    <td class="cell-id">${m.is_sent ? '<span style="color:#0284c7;font-weight:bold;">📤</span> ' : ''}${m.db_id}</td>
    <td class="cell-time">${m.ts_str}</td>
    <td><code class="cell-pri">${m.priority}</code></td>
    <td>${nodeBadge(m.sender_id, m.sender_short, m.sender_color)}</td>
    <td>${nodeBadge(m.receiver_id, m.receiver_short, m.receiver_color)}</td>
    <td><strong style="font-size:11.5px">${esc(m.message_name)}</strong><span class="text-muted" style="font-size:10px;margin-left:4px">${m.message_id_hex}</span></td>
    <td>${seqBadge(m)}${segBtn}</td>
    <td style="font-family:var(--font-mono);font-size:10.5px">${m.seq_count}</td>
    <td class="cell-data">${m.data_hex || '–'}</td>
    <td class="cell-desc">${esc(m.message_desc)}</td>
    <td class="req-cell">${renderReqCell(m)}</td>
    <td><button class="btn btn-ghost btn-sm" onclick="openDetailModal(${m.db_id},event)">···</button></td>
  `;

  tr.addEventListener('dblclick', () => openDetailModal(m.db_id));
  return tr;
}

function renderReqCell(m) {
  if (!m) return '';
  if (m.requested_db_id != null)
    return `<a href="#" onclick="scrollToMsg(${m.requested_db_id},event)">#${m.requested_db_id}</a>`;
  return `<button class="btn btn-ghost btn-sm" style="font-size:10px;padding:2px 5px" onclick="openReqForm(${m.db_id},event)">+ Link</button>`;
}

function nodeBadge(id, short, color) {
  return `<span class="node-badge" style="background:${color || '#888'}" title="0x${id.toString(16).toUpperCase()}">${esc(short || '??')}</span>`;
}

function seqBadge(m) {
  const border = m.seq_type_color;
  const bg     = m.seq_type_bg;
  const col    = m.seq_type_color;
  return `<span class="seq-badge" style="border-color:${border};background:${bg};color:${col}" title="${esc(m.seq_type_label)}">${m.seq_type_name}</span>`;
}

function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

/* ── Filter logic ───────────────────────────────────────── */
function passFilter(m) {
  if (S.filterSelected && !S.selected.has(m.db_id)) return false;
  if (S.filterSenders.size   && !S.filterSenders.has(m.sender_id))   return false;
  if (S.filterReceivers.size && !S.filterReceivers.has(m.receiver_id)) return false;
  if (S.filterMsgIds.size    && !S.filterMsgIds.has(m.message_id))    return false;
  if (S.filterSeqTypes.size  && !S.filterSeqTypes.has(m.seq_type))    return false;
  if (S.filterSearch) {
    const q = S.filterSearch;
    const hay = (m.sender_name + m.receiver_name + m.message_name + m.data_hex + m.message_desc).toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

function rebuildTable() {
  tbody.innerHTML = '';
  const visible = S.messages.filter(passFilter);
  const frag = document.createDocumentFragment();
  visible.slice(-500).forEach(m => frag.appendChild(buildRow(m)));
  tbody.appendChild(frag);
  if (visible.length === 0) showEmpty(); else if (emptyRow) emptyRow.style.display = 'none';
}

function showEmpty() {
  if (emptyRow) emptyRow.style.display = '';
}

/* ── Chip filters ───────────────────────────────────────── */
function buildNodeChips(nodes, containerId, filterSet, rebuildKey) {
  const cont = $(containerId);
  if (!cont) return;
  cont.innerHTML = '';
  nodes.forEach(n => {
    const id  = parseInt(n.id, 16);
    const el  = document.createElement('span');
    el.className = 'chip active';
    el.style.borderColor = n.color;
    el.style.color       = n.color;
    el.innerHTML = `<span class="chip-dot" style="background:${n.color}"></span>${n.short || n.name}`;
    el.addEventListener('click', () => {
      el.classList.toggle('active');
      if (el.classList.contains('active')) filterSet.delete(id);
      else filterSet.add(id);
      rebuildTable();
    });
    cont.appendChild(el);
  });
}

function buildSeqChips() {
  const cont = $('seq-chips');
  if (!cont) return;
  const defs = [
    {key:0b11, name:'UNSEG', color:'#2563EB', bg:'#DBEAFE'},
    {key:0b01, name:'FIRST', color:'#059669', bg:'#D1FAE5'},
    {key:0b00, name:'CONT',  color:'#6B7280', bg:'#F3F4F6'},
    {key:0b10, name:'LAST',  color:'#DC2626', bg:'#FEE2E2'},
  ];
  cont.innerHTML = '';
  defs.forEach(d => {
    const el = document.createElement('span');
    el.className = 'chip active';
    el.style.borderColor = d.color;
    el.style.color       = d.color;
    el.textContent = d.name;
    el.addEventListener('click', () => {
      el.classList.toggle('active');
      if (el.classList.contains('active')) S.filterSeqTypes.delete(d.key);
      else S.filterSeqTypes.add(d.key);
      rebuildTable();
    });
    cont.appendChild(el);
  });
}

/* ── Selection ──────────────────────────────────────────── */
function toggleSelect(dbId, cb, ev) {
  ev.stopPropagation();
  if (cb.checked) S.selected.add(dbId);
  else            S.selected.delete(dbId);
  const tr = cb.closest('tr');
  if (tr) tr.classList.toggle('selected-row', cb.checked);
  updateSelCount();
}

function updateSelCount() {
  const el = $('sel-count');
  if (el) el.textContent = S.selected.size > 0 ? `${S.selected.size} seçili` : '';
  const btnSel = $('btn-filter-sel');
  if (btnSel) btnSel.disabled = S.selected.size === 0;
}

/* ── Counter / status ───────────────────────────────────── */
function updateCounter() {
  const el = $('stat-count'); if (el) el.textContent = S.totalCount.toLocaleString();
}

let _lastCount = 0, _lastTime = Date.now();
setInterval(() => {
  const now  = Date.now();
  const diff = S.totalCount - _lastCount;
  const secs = (now - _lastTime) / 1000;
  const el   = $('stat-rate');
  if (el) el.textContent = (diff / secs).toFixed(1);
  _lastCount = S.totalCount;
  _lastTime  = now;

  const upEl = $('stat-uptime');
  if (upEl && S.startTime) {
    const s = Math.floor((Date.now() - S.startTime) / 1000);
    upEl.textContent = `${String(Math.floor(s/3600)).padStart(2,'0')}:${String(Math.floor((s%3600)/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
  }
}, 1000);

function applyStatus(st) {
  S.connected = st.connected;
  S.paused    = st.paused;
  if (st.connected && !S.startTime) S.startTime = Date.now();

  const pill   = $('status-pill');
  const pillTx = $('status-text');
  if (pill) {
    pill.className = 'status-pill' + (st.paused ? ' paused' : st.connected ? ' connected' : st.error ? ' error' : '');
  }
  if (pillTx) {
    pillTx.textContent = st.paused ? '⏸ Durduruldu' : st.connected ? `● ${st.port}` : st.error ? '✕ Hata' : '○ Bağlı değil';
  }

  const btnConn = $('btn-connect');
  const btnDisc = $('btn-disconnect');
  if (btnConn) btnConn.disabled = st.connected;
  if (btnDisc) btnDisc.disabled = !st.connected;

  const btnPause  = $('btn-pause');
  const btnResume = $('btn-resume');
  if (btnPause)  { btnPause.disabled  = !st.connected || st.paused; btnPause.classList.toggle('d-none', st.paused); }
  if (btnResume) { btnResume.disabled = !st.paused;  btnResume.classList.toggle('d-none', !st.paused); }
}

async function fetchStatus() {
  try {
    const r = await fetch('/api/status');
    const st = await r.json();
    applyStatus(st);
    S.totalCount = st.message_count || 0;
    updateCounter();
  } catch(e) {}
}

/* ── Connect / Disconnect ───────────────────────────────── */
async function connect() {
  const port     = $('port-select').value;
  const baudrate = $('baudrate-inp').value || 2000000;
  const speed    = $('can-speed-sel').value;
  if (!port) { toast('Port seçiniz', 'error'); return; }
  const r  = await fetch('/api/connect', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({port, baudrate:+baudrate, can_speed:+speed})});
  const d  = await r.json();
  if (!d.ok) toast('Bağlantı başarısız', 'error');
}
async function disconnect() {
  await fetch('/api/disconnect', {method:'POST'});
}
async function pauseCapture() {
  await fetch('/api/pause', {method:'POST'});
}
async function resumeCapture() {
  await fetch('/api/resume', {method:'POST'});
}
async function clearMessages() {
  if (!confirm('Tüm mesajlar silinsin mi?')) return;
  await fetch('/api/messages/clear', {method:'POST'});
}

/* ── Export ─────────────────────────────────────────────── */
function exportCSV() {
  let url = '/api/export?';
  if (S.filterSenders.size)   url += [...S.filterSenders].map(x=>`sender=0x${x.toString(16)}`).join('&') + '&';
  if (S.filterReceivers.size) url += [...S.filterReceivers].map(x=>`receiver=0x${x.toString(16)}`).join('&') + '&';
  if (S.filterMsgIds.size)    url += [...S.filterMsgIds].map(x=>`msg_id=0x${x.toString(16)}`).join('&') + '&';
  window.location.href = url;
}

/* ── Port list ──────────────────────────────────────────── */
async function loadPorts() {
  const sel = $('port-select');
  if (!sel) return;
  try {
    const r = await fetch('/api/ports');
    const ports = await r.json();
    sel.innerHTML = ports.length
      ? ports.map(p => `<option value="${esc(p.device)}">${esc(p.device)} – ${esc(p.description)}</option>`).join('')
      : '<option value="">Port bulunamadı</option>';
  } catch(e) { sel.innerHTML = '<option value="">Yüklenemedi</option>'; }
}

/* ── Scroll to message ──────────────────────────────────── */
function scrollToMsg(dbId, ev) {
  if (ev) ev.preventDefault();
  const tr = document.querySelector(`[data-dbid="${dbId}"]`);
  if (tr) { tr.scrollIntoView({behavior:'smooth', block:'center'}); tr.classList.add('new-row'); setTimeout(()=>tr.classList.remove('new-row'), 700); }
  else toast(`Mesaj #${dbId} DOM'da değil`, 'info');
}

/* ── Auto-scroll toggle ─────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  const wrap = document.querySelector('.table-wrap');
  if (wrap) {
    wrap.addEventListener('scroll', () => {
      S.autoScroll = wrap.scrollTop + wrap.clientHeight >= wrap.scrollHeight - 30;
    });
  }
});

/* ── Detail modal ───────────────────────────────────────── */
function openDetailModal(dbId, ev) {
  if (ev) ev.stopPropagation();
  const m = S.messages.find(x => x.db_id === dbId);
  if (!m) return;

  // Mesaj haritasından bu ID'ye ait layout tanımını çek
  const currentDef = msgDefMap[m.message_id] || {};
  const layoutStr = currentDef.layout || '';
  
  // Payload'u decode et
  const parsedParams = parsePayloadByLayout(m.data, layoutStr);
  
  // Çözülen parametreleri şık badge'ler halinde HTML'e dök
// openDetailModal içindeki parser bölümünü bununla değiştir:
  
  let parsedHtml = '';
  if (m.seq_type_name !== 'UNSEG') {
    // Eğer paket bir segmentin parçasıysa, tekil parse işlemi tehlikelidir
    parsedHtml = `<div style="padding:10px; background:#FFFBEB; color:#D97706; border:1px solid #FDE68A; border-radius:4px; font-size:11.5px;">
      <strong>⚠️ Bu bir segment parçasıdır.</strong> Veri layout'u 8 byte'lık tekil parçalara değil, bütünsel veriye uygulanır. Doğru çözümlenmiş hali görmek için <strong>Segment Zincirini</strong> inceleyin.
    </div>`;
  } else {
    // UNSEG ise normal parse et
    const currentDef = msgDefMap[m.message_id] || {};
    const layoutStr = currentDef.layout || '';
    const parsedParams = parsePayloadByLayout(m.data, layoutStr);
    
    if (parsedParams.length > 0) {
      parsedHtml = `<div style="display:flex; flex-direction:column; gap:6px;">`;
      parsedParams.forEach((p, idx) => {
        parsedHtml += `
          <div style="display:flex; align-items:center; gap:8px; background:var(--gray-50); padding:4px 8px; border-radius:4px; border:1px solid var(--border);">
            <span style="font-size:10px; font-weight:bold; background:var(--black); color:#fff; padding:2px 5px; border-radius:3px; font-family:var(--font-mono);">Param_${idx}</span>
            <span style="color:var(--red); font-family:var(--font-mono); font-size:11px; font-weight:600;">[${p.type}]</span>
            <span style="font-family:var(--font-mono); font-weight:bold; color:var(--gray-900); font-size:13px; margin-left:auto;">${p.val}</span>
          </div>`;
      });
      parsedHtml += `</div>`;
    } else {
      parsedHtml = '<span class="text-muted">Tanımlı layout yok veya payload boş.</span>';
    }
  }

  const body = $('detail-body');
  body.innerHTML = `
    <div class="detail-grid">
      <span class="dl">DB ID</span>           <span class="dv dv-mono">#${m.db_id}</span>
      <span class="dl">Zaman</span>           <span class="dv dv-mono">${m.ts_str}</span>
      <span class="dl">Ham CAN ID</span>      <span class="dv dv-mono">${m.raw_id}</span>
      <span class="dl">Frame Tipi</span>      <span class="dv">${m.frame_type}</span>
      <hr class="detail-sep">
      <span class="dl">Öncelik</span>         <span class="dv"><code class="cell-pri">${m.priority}</code></span>
      <span class="dl">Gönderen</span>        <span class="dv">${nodeBadge(m.sender_id,m.sender_short,m.sender_color)} <small class="text-muted">${m.sender_name}</small></span>
      <span class="dl">Alıcı</span>           <span class="dv">${nodeBadge(m.receiver_id,m.receiver_short,m.receiver_color)} <small class="text-muted">${m.receiver_name}</small></span>
      <span class="dl">Mesaj ID</span>        <span class="dv dv-mono">${m.message_id_hex} – <strong>${esc(m.message_name)}</strong></span>
      <span class="dl">Açıklama</span>        <span class="dv" style="color:var(--gray-600)">${esc(m.message_desc) || '–'}</span>
      <hr class="detail-sep">
      
      <span class="dl" style="color:var(--black); font-weight:bold;">Çözülmüş Veri</span>
      <span class="dv">${parsedHtml}</span>
      <hr class="detail-sep">
      
      <span class="dl">Seq Type</span>        <span class="dv">${seqBadge(m)} <small class="text-muted">${esc(m.seq_type_label)}</small></span>
      <span class="dl">Seq Count</span>       <span class="dv dv-mono">${m.seq_count}</span>
      ${m.seg_group != null ? `<span class="dl">Segment Grubu</span><span class="dv"><button class="btn btn-sm btn-secondary" onclick="openSegModal(${m.seg_group})">#${m.seg_group} – Zinciri Gör</button></span>` : ''}
      <hr class="detail-sep">
      <span class="dl">Veri (Hex)</span>      <span class="dv dv-mono" style="word-break:break-all">${m.data_hex || '–'}</span>
      <span class="dl">Veri (Dec)</span>      <span class="dv dv-mono" style="font-size:10.5px">${m.data.map(b=>b.toString().padStart(3,'0')).join(' ') || '–'}</span>
    </div>
    <div class="detail-section" style="margin-top:16px">
      <div class="dl" style="margin-bottom:8px">İSTEK BAĞLANTISI</div>
      ${m.requested_db_id != null
        ? `<p>Bu mesaj <a href="#" onclick="scrollToMsg(${m.requested_db_id},event)">#${m.requested_db_id}</a> mesajına yanıt olarak işaretlenmiş.</p>
           <button class="btn btn-sm btn-danger" onclick="clearReq(${m.db_id})" style="margin-top:8px">Bağlantıyı kaldır</button>`
        : `<div class="req-form">
             <span class="text-muted fs-11">Yanıt verilen istek #:</span>
             <input id="req-input" class="inp" type="number" min="1" placeholder="Mesaj #" style="width:120px">
             <button class="btn btn-primary btn-sm" onclick="setReq(${m.db_id})">Kaydet</button>
           </div>`
      }
    </div>`;
  openModal('detail-modal');
}

async function setReq(dbId) {
  const val = parseInt($('req-input').value);
  if (!val) return;
  await fetch(`/api/messages/${dbId}/request`, {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({requested_db_id: val})});
  closeModal('detail-modal');
  toast('Bağlantı kaydedildi', 'success');
}
async function clearReq(dbId) {
  await fetch(`/api/messages/${dbId}/request`, {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({requested_db_id: null})});
  closeModal('detail-modal');
}

/* ── Segment modal ──────────────────────────────────────── */
async function openSegModal(groupId, ev) {
  if (ev) ev.stopPropagation();
  const r  = await fetch(`/api/segment/${groupId}`);
  const ms = await r.json();
  if (!ms.length) { toast('Segment bulunamadı', 'error'); return; }

  const first = ms[0];
  $('seg-modal-title').textContent    = `Segment Grubu #${groupId}`;
  $('seg-modal-subtitle').textContent = `${first.sender_short} → ${first.receiver_short} | ${first.message_name} | ${ms.length} paket`;

  const chain = $('seg-chain');
  chain.innerHTML = '';
  const combined = [];

  ms.forEach((m, i) => {
    if (i > 0) {
      const arr = document.createElement('div');
      arr.className = 'seg-arrow'; arr.textContent = '→';
      chain.appendChild(arr);
    }
    const card = document.createElement('div');
    card.className = `seg-card${m.seq_type_name==='FIRST'?' s-first':m.seq_type_name==='LAST'?' s-last':''}`;
    card.innerHTML = `
      <div class="seg-card-tag" style="color:${m.seq_type_color}">${m.seq_type_name}</div>
      <div class="seg-card-id">#${m.db_id} · ${m.ts_str}</div>
      <div class="seg-card-data">${m.data_hex || '–'}</div>`;
    chain.appendChild(card);
    combined.push(...m.data);
  });

  const combEl = $('seg-combined');
  combEl.textContent = combined.map(b=>b.toString(16).toUpperCase().padStart(2,'0')).join(' ') || '–';

  const statusEl = $('seg-status');
  const isComplete = ms.some(m => m.seq_type_name === 'LAST');
  statusEl.textContent = isComplete ? '✓ Tamamlandı' : '⋯ Eksik paket var';
  statusEl.style.color = isComplete ? '#059669' : '#D97706';

  // openSegModal fonksiyonunun sonlarına, openModal('seg-modal'); satırından hemen önce şunu ekle:
  
  // 1. İlgili mesaj tanımını bul ve layout'u çek
  const currentDef = msgDefMap[first.message_id] || {};
  const layoutStr = currentDef.layout || '';
  
  // 2. Birleştirilmiş (reassembled) tam veriyi (combined) parse et
  const parsedParams = parsePayloadByLayout(combined, layoutStr);
  const parsedContainer = $('seg-parsed');
  
  if (!isComplete) {
     parsedContainer.innerHTML = '<span style="color:#D97706; font-size:11px;">⚠️ Tüm parçalar henüz ulaşmadığı için veri ayrıştırılamıyor...</span>';
  } else if (parsedParams.length > 0) {
    let pHtml = `<div style="display:flex; flex-direction:column; gap:6px;">`;
    parsedParams.forEach((p, idx) => {
      pHtml += `
        <div style="display:flex; align-items:center; gap:8px; background:#fff; padding:4px 8px; border-radius:4px; border:1px solid var(--border);">
          <span style="font-size:10px; font-weight:bold; background:var(--black); color:#fff; padding:2px 5px; border-radius:3px; font-family:var(--font-mono);">Param_${idx}</span>
          <span style="color:var(--red); font-family:var(--font-mono); font-size:11px; font-weight:600;">[${p.type}]</span>
          <span style="font-family:var(--font-mono); font-weight:bold; color:var(--gray-900); font-size:13px; margin-left:auto;">${p.val}</span>
        </div>`;
    });
    pHtml += `</div>`;
    parsedContainer.innerHTML = pHtml;
  } else {
    parsedContainer.innerHTML = '<span class="text-muted" style="font-size:11.5px;">Bu mesaj ID için tanımlı bir layout bulunamadı.</span>';
  }
    
  openModal('seg-modal');
}

/* ── Req form shortcut ──────────────────────────────────── */
function openReqForm(dbId, ev) {
  if (ev) ev.stopPropagation();
  openDetailModal(dbId);
}

/* ── Filter: show only selected ─────────────────────────── */
function toggleFilterSelected() {
  S.filterSelected = !S.filterSelected;
  const btn = $('btn-filter-sel');
  if (btn) { btn.classList.toggle('btn-primary', S.filterSelected); btn.classList.toggle('btn-secondary', !S.filterSelected); }
  rebuildTable();
}

/* ── Search ─────────────────────────────────────────────── */
function onSearch(ev) {
  S.filterSearch = ev.target.value.toLowerCase().trim();
  rebuildTable();
}

/* ── Modal helpers ──────────────────────────────────────── */
function openModal(id)  { const el = $(id); if (el) el.classList.add('open'); }
function closeModal(id) { const el = $(id); if (el) el.classList.remove('open'); }
window.addEventListener('keydown', e => { if (e.key === 'Escape') $$('.modal-overlay').forEach(m=>m.classList.remove('open')); });

/* ── Telecommand Send Logic ─────────────────────────────── */

// Hex input'u otomatik boşluklu formata sokan yardımcı
function formatHexInput(e) {
  let val = e.target.value.replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
  let formatted = val.match(/.{1,2}/g)?.join(' ') || '';
  e.target.value = formatted;
}

/* dashboard.js içindeki ilgili fonksiyonların revize edilmiş hali */

function openSendModal() {
  if (!S.connected) {
    toast('Mesaj göndermek için önce CAN adaptörüne bağlanmalısın.', 'error');
    return;
  }

  const nodesHtml = Object.values(nodeMap).map(n => 
    `<option value="${parseInt(n.id, 16)}">${esc(n.short)} - ${esc(n.name)}</option>`
  ).join('');

  // Hem Gönderen hem Alıcı listesini doldur
  $('send-sender').innerHTML = nodesHtml;
  $('send-receiver').innerHTML = nodesHtml;

  // Mesaj listesini doldur
  const msgSel = $('send-msg-id');
  msgSel.innerHTML = Object.values(msgDefMap).map(m => 
    `<option value="${parseInt(m.id, 16)}">[0x${parseInt(m.id, 16).toString(16).padStart(3,'0').toUpperCase()}] ${esc(m.name)}</option>`
  ).join('');

  openModal('send-modal');
}

async function submitSendMessage() {
  const sender_id   = parseInt($('send-sender').value); // Artık arayüzden dinamik geliyor
  const receiver_id = parseInt($('send-receiver').value);
  const msg_id      = parseInt($('send-msg-id').value);
  const priority    = parseInt($('send-priority').value);
  
  const hexStr = $('send-data').value.replace(/\s+/g, '');
  
  if (hexStr.length > 16) {
    toast('Geçersiz payload! Maksimum 8 byte veri gönderebilirsin.', 'error');
    return;
  }

  const payload = [];
  for (let i = 0; i < hexStr.length; i += 2) {
    payload.push(parseInt(hexStr.substring(i, i + 2), 16));
  }

  const reqData = {
    sender_id, // Seçilen kaynak node id'si
    receiver_id,
    msg_id,
    priority,
    seq_type: 3, // UNSEG
    seq_count: 0,
    payload
  };

  try {
    const r = await fetch('/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reqData)
    });
    
    const res = await r.json();
    if (res.ok) {
      toast('Telecommand başarıyla iletildi!', 'success');
      closeModal('send-modal');
    } else {
      toast('Mesaj CAN Bus üzerine yazılamadı.', 'error');
    }
  } catch (e) {
    toast('Sunucu ile iletişim koptu.', 'error');
  }
}

/* ── Toast ──────────────────────────────────────────────── */
function toast(msg, type='info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  toast_cnt.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

/* ── Init ───────────────────────────────────────────────── */
async function init() {
  await loadPorts();
  await fetchStatus();

  // Load mappings for chips
  try {
    const [nRes, mRes] = await Promise.all([fetch('/api/nodes'), fetch('/api/message_defs')]);
    const nodes = await nRes.json();
    const defs  = await mRes.json();

    nodes.forEach(n => { try { nodeMap[parseInt(n.id,16)] = n; } catch(e){} });
    defs.forEach(d =>  { try { msgDefMap[parseInt(d.id,16)] = d; } catch(e){} });

    buildNodeChips(nodes, 'sender-chips',   S.filterSenders,   'sender');
    buildNodeChips(nodes, 'receiver-chips', S.filterReceivers, 'receiver');
    buildSeqChips();
  } catch(e) { console.error('Mapping yüklenemedi', e); }
}

/* ── Binary Payload Deserializer (Little-Endian) ────────────────── */
function parsePayloadByLayout(dataArray, layoutStr) {
  if (!layoutStr || !dataArray || dataArray.length === 0) return [];
  
  const types = layoutStr.split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
  
  // JavaScript Array'ini binary ArrayBuffer'a dönüştür
  const buffer = new Uint8Array(dataArray).buffer;
  const view = new DataView(buffer);
  
  let offset = 0;
  const parsedFields = [];
  
  for (const type of types) {
    // Eğer gelen veri pakedi tanımlanan yapıdan daha kısaysa (veya boşsa) güvenli şekilde kırıl
    if (offset >= dataArray.length) break;
    
    switch (type) {
      case 'bool':
        parsedFields.push({ type: 'bool', size: 1, val: view.getUint8(offset) !== 0 });
        offset += 1;
        break;
      case 'uint8':
        parsedFields.push({ type: 'uint8', size: 1, val: view.getUint8(offset) });
        offset += 1;
        break;
      case 'uint16':
        if (offset + 2 <= dataArray.length) {
          parsedFields.push({ type: 'uint16', size: 2, val: view.getUint16(offset, true) }); // true = Little Endian
          offset += 2;
        }
        break;
      case 'uint32':
        if (offset + 4 <= dataArray.length) {
          parsedFields.push({ type: 'uint32', size: 4, val: view.getUint32(offset, true) });
          offset += 4;
        }
        break;
      case 'int32':
        if (offset + 4 <= dataArray.length) {
          parsedFields.push({ type: 'int32', size: 4, val: view.getInt32(offset, true) });
          offset += 4;
        }
        break;
      case 'float':
        if (offset + 4 <= dataArray.length) {
          // IEEE 754 Single-Precision Float decode işlemi
          parsedFields.push({ type: 'float', size: 4, val: Number(view.getFloat32(offset, true).toFixed(5)) });
          offset += 4;
        }
        break;
      default:
        // Bilinmeyen veya hatalı yazılmış bir tip varsa atla
        break;
    }
  }
  return parsedFields;
}

document.addEventListener('DOMContentLoaded', init);

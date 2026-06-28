/* admin.js – METUCube Ground Station admin panel */

/* ── Tab navigation ─────────────────────────────────────── */
function showTab(name) {
  document.querySelectorAll('.admin-section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.admin-nav-item').forEach(i => i.classList.remove('active'));
  const sec = document.getElementById('sec-' + name);
  const nav = document.querySelector(`[data-tab="${name}"]`);
  if (sec) sec.classList.add('active');
  if (nav) nav.classList.add('active');
  document.querySelector('.admin-topbar h1').textContent =
    { nodes: 'Node Eşleştirme', messages: 'Mesaj Tanımları' }[name] || 'Admin';
}

/* ── Toast ──────────────────────────────────────────────── */
function toast(msg, type = 'success') {
  const cnt = document.getElementById('toast-container');
  const el  = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  cnt.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

/* ══════════════════════════════════════════════════════════
   NODES
══════════════════════════════════════════════════════════ */
let nodes = [];

async function loadNodes() {
  const r = await fetch('/api/nodes');
  nodes   = await r.json();
  renderNodes();
}

function renderNodes() {
  const tbody = document.getElementById('nodes-tbody');
  tbody.innerHTML = '';
  nodes.forEach((n, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>
        <input class="edit-inp" value="${esc(n.id)}" onchange="nodes[${i}].id=this.value" style="width:80px">
      </td>
      <td>
        <input class="edit-inp" value="${esc(n.name)}" onchange="nodes[${i}].name=this.value">
      </td>
      <td>
        <input class="edit-inp" value="${esc(n.short||'')}" onchange="nodes[${i}].short=this.value" style="width:80px">
      </td>
      <td style="white-space:nowrap">
        <input type="color" class="color-swatch" value="${n.color||'#888888'}"
          oninput="nodes[${i}].color=this.value;this.nextElementSibling.textContent=this.value"
          style="margin-right:6px">
        <span style="font-size:11px;font-family:var(--font-mono)">${n.color||''}</span>
        <span class="node-badge" style="background:${n.color||'#888'};margin-left:8px">${esc(n.short||n.name)}</span>
      </td>
      <td class="actions">
        <button class="btn btn-danger btn-sm" onclick="deleteNode(${i})">🗑</button>
      </td>`;
    // update preview on color/name change
    tr.querySelectorAll('.edit-inp').forEach(inp => {
      inp.addEventListener('input', () => {
        const badge = tr.querySelector('.node-badge');
        if (badge) badge.textContent = nodes[i].short || nodes[i].name;
      });
    });
    tbody.appendChild(tr);
  });
}

function addNode() {
  nodes.push({ id: '0x00', name: 'Yeni Node', short: 'NEW', color: '#888888' });
  renderNodes();
  // scroll to bottom
  const tbody = document.getElementById('nodes-tbody');
  tbody.lastElementChild?.scrollIntoView({ behavior: 'smooth' });
}

function deleteNode(i) {
  if (!confirm('Bu node silinsin mi?')) return;
  nodes.splice(i, 1);
  renderNodes();
}

async function saveNodes() {
  try {
    await fetch('/api/nodes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(nodes),
    });
    toast('Node eşleştirmesi kaydedildi ✓');
  } catch (e) {
    toast('Kaydetme hatası', 'error');
  }
}

function exportNodes() {
  const rows = [['id', 'name', 'short', 'color'], ...nodes.map(n => [n.id, n.name, n.short||'', n.color||''])];
  downloadCSV(rows, 'node_map.csv');
}

function importNodes(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    const rows = parseCSV(e.target.result);
    if (rows.length < 2) { toast('CSV boş veya hatalı', 'error'); return; }
    const header = rows[0].map(h => h.toLowerCase());
    const idIdx  = header.indexOf('id');
    const nmIdx  = header.indexOf('name');
    const shIdx  = header.indexOf('short');
    const coIdx  = header.indexOf('color');
    nodes = rows.slice(1).map(r => ({
      id:    r[idIdx]  || '0x00',
      name:  r[nmIdx]  || '',
      short: r[shIdx]  || '',
      color: r[coIdx]  || '#888888',
    }));
    renderNodes();
    toast(`${nodes.length} node içe aktarıldı`);
  };
  reader.readAsText(file);
  input.value = '';
}

/* ══════════════════════════════════════════════════════════
   MESSAGE DEFS
══════════════════════════════════════════════════════════ */
let msgDefs = [];

async function loadMsgDefs() {
  const r  = await fetch('/api/message_defs', { cache: 'no-store' });
  msgDefs  = await r.json();
  renderMsgDefs();
}

// admin.js içindeki fonksiyonları bu şekilde revize et:

function renderMsgDefs() {
  const tbody = document.getElementById('msgs-tbody');
  tbody.innerHTML = '';
  msgDefs.forEach((d, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>
        <input class="edit-inp" value="${esc(d.id)}" onchange="msgDefs[${i}].id=this.value" style="width:90px;font-family:var(--font-mono)">
      </td>
      <td>
        <input class="edit-inp" value="${esc(d.name)}" onchange="msgDefs[${i}].name=this.value">
      </td>
<td>
        <input class="edit-inp" value="${esc(d.layout || '')}" onchange="msgDefs[${i}].layout=this.value" placeholder="Örn: uint32,float,bool" style="font-family:var(--font-mono); font-size:11px;">
      </td>
      <td>
        <input class="edit-inp" value="${esc(d.description||'')}" onchange="msgDefs[${i}].description=this.value">
      </td>
      <td class="actions">
        <button class="btn btn-danger btn-sm" onclick="deleteMsgDef(${i})">🗑</button>
      </td>`;
    tbody.appendChild(tr);
  });
}

function addMsgDef() {
  msgDefs.push({ id: '0x000', name: 'Yeni Mesaj', layout: '', description: '' });
  renderMsgDefs();
  document.getElementById('msgs-tbody').lastElementChild?.scrollIntoView({ behavior: 'smooth' });
}

function exportMsgDefs() {
  const rows = [['id', 'name', 'description', 'layout'], ...msgDefs.map(d => [d.id, d.name, d.description||'', d.layout||''])];
  downloadCSV(rows, 'message_map.csv');
}

function importMsgDefs(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    const rows = parseCSV(e.target.result);
    if (rows.length < 2) { toast('CSV boş veya hatalı', 'error'); return; }
    const header = rows[0].map(h => h.toLowerCase().trim());
    const idIdx  = header.indexOf('id');
    const nmIdx  = header.indexOf('name');
    const dcIdx  = header.indexOf('description');
    const lyIdx  = header.indexOf('layout'); // Yeni index
    
    msgDefs = rows.slice(1).map(r => ({
      id:          r[idIdx]  || '0x000',
      name:        r[nmIdx]  || '',
      description: r[dcIdx]  || '',
      layout:      lyIdx !== -1 ? r[lyIdx] || '' : '',
    }));
    renderMsgDefs();
    toast(`${msgDefs.length} mesaj tanımı içe aktarıldı`);
  };
  reader.readAsText(file);
  input.value = '';
}

function deleteMsgDef(i) {
  if (!confirm('Bu mesaj tanımı silinsin mi?')) return;
  msgDefs.splice(i, 1);
  renderMsgDefs();
}

async function saveMsgDefs() {
  try {
    await fetch('/api/message_defs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msgDefs),
    });
    toast('Mesaj tanımları kaydedildi ✓');
  } catch (e) {
    toast('Kaydetme hatası', 'error');
  }
}


/* ── CSV utilities ──────────────────────────────────────── */
function parseCSV(text) {
  return text.trim().split('\n').map(line =>
    line.split(',').map(cell => cell.trim().replace(/^"|"$/g, ''))
  );
}

function downloadCSV(rows, filename) {
  const content = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob    = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const a       = document.createElement('a');
  a.href        = URL.createObjectURL(blob);
  a.download    = filename;
  a.click();
}

function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ── Init ───────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  loadNodes();
  loadMsgDefs();
  showTab('nodes');
});

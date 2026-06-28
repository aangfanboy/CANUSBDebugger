#!/usr/bin/env python3
"""
app.py – METUCube Ground Station Flask/SocketIO backend
Çalıştırmak için:
    pip install -r requirements.txt
    python app.py
"""

import csv
import io
import json
import os
import threading
import time
from datetime import datetime

from flask import Flask, jsonify, render_template, request, send_file
from flask_socketio import SocketIO
from serial.tools import list_ports

from can_reader import CANReader

# ─── Flask & SocketIO ────────────────────────────────────────────────────────
app = Flask(__name__)
app.config['SECRET_KEY'] = 'metucube-gs-2024'
socketio = SocketIO(app, cors_allowed_origins='*', async_mode='threading')

# ─── Dizinler ────────────────────────────────────────────────────────────────
BASE        = os.path.dirname(__file__)
DATA_DIR    = os.path.join(BASE, 'data')
LOGS_DIR    = os.path.join(BASE, 'logs')
NODE_FILE   = os.path.join(DATA_DIR, 'node_map.csv')
MSGDEF_FILE = os.path.join(DATA_DIR, 'message_map.csv')
os.makedirs(DATA_DIR, exist_ok=True)
os.makedirs(LOGS_DIR, exist_ok=True)

# ─── Sabit varsayılanlar ─────────────────────────────────────────────────────
DEFAULT_NODES = [
    {'id': '0x00', 'name': 'Main On-Board Computer',                      'short': 'OBC',   'color': '#1D4ED8'},
    {'id': '0x01', 'name': 'Attitude Determination and Control Computer', 'short': 'ADCC',  'color': '#7C3AED'},
    {'id': '0x02', 'name': 'Communications Card',                         'short': 'COMMS', 'color': '#059669'},
    {'id': '0x03', 'name': 'Electronic Power System Card',                'short': 'EPS',   'color': '#D97706'},
    {'id': '0x04', 'name': 'Maximum Power Point Tracking Card',           'short': 'MPPT',  'color': '#0891B2'},
    {'id': '0x05', 'name': 'Payload Card',                                'short': 'PLD',   'color': '#BE185D'},
    {'id': '0x0F', 'name': 'All to Receive',                              'short': 'ALL',   'color': '#374151'},
]

# app.py içindeki ilgili alanları bu şekilde revize et:

DEFAULT_MESSAGES = [
    {'id': '0x065', 'name': 'Heartbeat',     'description': 'Periodic heartbeat signal', 'layout': 'uint8,uint8'},
    {'id': '0x066', 'name': 'Housekeeping',  'description': 'Housekeeping telemetry data', 'layout': 'uint32,float'},
    {'id': '0x067', 'name': 'Telemetry',     'description': 'General telemetry packet', 'layout': ''},
    {'id': '0x068', 'name': 'Telecommand',   'description': 'Uplink command packet', 'layout': ''},
    {'id': '0x069', 'name': 'ACK',           'description': 'Acknowledgement / command success', 'layout': 'uint8'},
    {'id': '0x06A', 'name': 'NACK',          'description': 'Negative acknowledgement / error', 'layout': 'uint8'},
]

SEQ_TYPE_INFO = {
    0b00: {'name': 'CONT',  'label': 'Continuation', 'color': '#6B7280', 'bg': '#F3F4F6'},
    0b01: {'name': 'FIRST', 'label': 'First Packet',  'color': '#059669', 'bg': '#D1FAE5'},
    0b10: {'name': 'LAST',  'label': 'Last Packet',   'color': '#DC2626', 'bg': '#FEE2E2'},
    0b11: {'name': 'UNSEG', 'label': 'Unsegmented',   'color': '#2563EB', 'bg': '#DBEAFE'},
}

# ─── Global durum ────────────────────────────────────────────────────────────
_lock           = threading.Lock()
all_messages    = []
msg_counter     = 0
session_start   = None
session_csv     = None
paused          = False
conn_status     = {'connected': False, 'port': None, 'can_speed': None, 'error': None}

# Segment grupları: (sender, receiver, msg_id) → {'group_id': int, 'db_ids': [...]}
seg_groups      = {}
seg_group_ctr   = 0

# ─── CSV yardımcıları ────────────────────────────────────────────────────────
def _load_csv(path, defaults, fields):
    if not os.path.exists(path):
        _save_csv(path, defaults, fields)
        return defaults
    rows = []
    with open(path, newline='', encoding='utf-8') as f:
        for row in csv.DictReader(f):
            rows.append(row)
    return rows

def _save_csv(path, rows, fields):
    print("save_csv")
    print(path)
    print(rows)
    print(fields)
    with open(path, 'w', newline='', encoding='utf-8') as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction='ignore')
        w.writeheader()
        w.writerows(rows)

def load_nodes():
    return _load_csv(NODE_FILE, DEFAULT_NODES, ['id', 'name', 'short', 'color'])

def save_nodes(nodes):
    _save_csv(NODE_FILE, nodes, ['id', 'name', 'short', 'color'])

def load_msg_defs():
    return _load_csv(MSGDEF_FILE, DEFAULT_MESSAGES, ['id', 'name', 'description', 'layout'])

def save_msg_defs(defs):
    _save_csv(MSGDEF_FILE, defs, ['id', 'name', 'description', 'layout'])

def _defs_map():
    m = {}
    for d in load_msg_defs():
        try:
            m[int(d['id'], 16)] = {
                'name': d.get('name', d['id']), 
                'description': d.get('description', ''),
                'layout': d.get('layout', '') # Yeni alan
            }
        except Exception:
            pass
    return m

def _nodes_map():
    """int_id → {name, short, color}"""
    m = {}
    for n in load_nodes():
        try:
            m[int(n['id'], 16)] = {
                'name':  n.get('name', n['id']),
                'short': n.get('short', n['id']),
                'color': n.get('color', '#888888'),
            }
        except Exception:
            pass
    return m

# ─── Oturum CSV ──────────────────────────────────────────────────────────────
_CSV_FIELDS = [
    'db_id', 'ts_str', 'raw_id', 'priority',
    'sender_name', 'sender_hex', 'receiver_name', 'receiver_hex',
    'message_name', 'message_id_hex', 'seq_type_name', 'seq_count',
    'data_hex', 'message_desc', 'seg_group', 'requested_db_id',
]

def _append_csv(entry: dict):
    if not session_csv:
        return
    exists = os.path.exists(session_csv)
    try:
        with open(session_csv, 'a', newline='', encoding='utf-8') as f:
            w = csv.DictWriter(f, fieldnames=_CSV_FIELDS, extrasaction='ignore')
            if not exists:
                w.writeheader()
            w.writerow(entry)
    except Exception as e:
        print(f'CSV yazma hatası: {e}')

# ─── Mesaj işleme ────────────────────────────────────────────────────────────
def on_can_message(msg):
    global msg_counter, seg_group_ctr

    node_map = _nodes_map()
    def_map  = _defs_map()

    src  = node_map.get(msg.sender_id,   {'name': f'Node 0x{msg.sender_id:X}',   'short': f'0x{msg.sender_id:X}',   'color': '#888'})
    dst  = node_map.get(msg.receiver_id, {'name': f'Node 0x{msg.receiver_id:X}', 'short': f'0x{msg.receiver_id:X}', 'color': '#888'})
    mdef = def_map.get(msg.message_id,   {'name': f'0x{msg.message_id:03X}',     'description': ''})
    seq  = SEQ_TYPE_INFO.get(msg.seq_type, {'name': '??', 'label': 'Unknown', 'color': '#888', 'bg': '#EEE'})

    seg_key   = (msg.sender_id, msg.receiver_id, msg.message_id)
    seg_group = None

    with _lock:
        msg_counter += 1
        db_id = msg_counter

        # Segment gruplaması
        if msg.seq_type == 0b01:               # First
            seg_group_ctr += 1
            seg_group = seg_group_ctr
            seg_groups[seg_key] = {'group_id': seg_group, 'db_ids': [db_id], 'complete': False}
        elif msg.seq_type in (0b00, 0b10):     # Continuation / Last
            if seg_key in seg_groups:
                seg_groups[seg_key]['db_ids'].append(db_id)
                seg_group = seg_groups[seg_key]['group_id']
                if msg.seq_type == 0b10:
                    seg_groups[seg_key]['complete'] = True

        entry = {
            'db_id':          db_id,
            'timestamp':      msg.timestamp,
            'ts_str':         datetime.fromtimestamp(msg.timestamp).strftime('%H:%M:%S.%f')[:-3],
            'raw_id':         f'0x{msg.raw_id:08X}',
            'priority':       f'{msg.priority:02b}',
            'sender_id':      msg.sender_id,
            'sender_hex':     f'0x{msg.sender_id:X}',
            'sender_name':    src['name'],
            'sender_short':   src['short'],
            'sender_color':   src['color'],
            'receiver_id':    msg.receiver_id,
            'receiver_hex':   f'0x{msg.receiver_id:X}',
            'receiver_name':  dst['name'],
            'receiver_short': dst['short'],
            'receiver_color': dst['color'],
            'message_id':     msg.message_id,
            'message_id_hex': f'0x{msg.message_id:03X}',
            'message_name':   mdef['name'],
            'message_desc':   mdef['description'],
            'seq_type':       msg.seq_type,
            'seq_type_name':  seq['name'],
            'seq_type_label': seq['label'],
            'seq_type_color': seq['color'],
            'seq_type_bg':    seq['bg'],
            'seq_count':      msg.seq_count,
            'data':           list(msg.data),
            'data_hex':       ' '.join(f'{b:02X}' for b in msg.data),
            'frame_type':     msg.frame_type,
            'seg_group':      seg_group,
            'requested_db_id': None,
        }

        all_messages.append(entry)
        _append_csv(entry)

    socketio.emit('new_message', entry)


def on_status_change(status_type: str, detail: str):
    global conn_status, session_start, session_csv
    if status_type == 'connected':
        conn_status.update(connected=True, port=detail, error=None)
        session_start = time.time()
        ts = datetime.now().strftime('%Y%m%d_%H%M%S')
        session_csv = os.path.join(LOGS_DIR, f'session_{ts}.csv')
    elif status_type == 'disconnected':
        conn_status.update(connected=False, port=None)
    elif status_type == 'error':
        conn_status.update(connected=False, error=detail)
    socketio.emit('status_change', {**conn_status, 'paused': paused})


can_reader = CANReader(on_message=on_can_message, on_status=on_status_change)

# ─── Rotalar – Sayfalar ──────────────────────────────────────────────────────
@app.route('/')
def index():
    return render_template('index.html')

@app.route('/admin')
def admin():
    return render_template('admin.html')

# ─── Rotalar – API ───────────────────────────────────────────────────────────
@app.route('/api/ports')
def api_ports():
    ports = [{'device': p.device, 'description': p.description or p.device}
             for p in list_ports.comports()]
    return jsonify(ports)


@app.route('/api/status')
def api_status():
    with _lock:
        count = len(all_messages)
    uptime = round(time.time() - session_start, 1) if session_start else 0
    return jsonify({**conn_status, 'paused': paused, 'message_count': count, 'uptime_s': uptime})


@app.route('/api/connect', methods=['POST'])
def api_connect():
    data      = request.json or {}
    port      = data.get('port')
    baudrate  = int(data.get('baudrate', 2_000_000))
    can_speed = int(data.get('can_speed', 500_000))
    if not port:
        return jsonify({'error': 'Port belirtilmeli'}), 400
    ok = can_reader.connect(port, baudrate, can_speed)
    return jsonify({'ok': ok})


@app.route('/api/disconnect', methods=['POST'])
def api_disconnect():
    can_reader.disconnect()
    return jsonify({'ok': True})


@app.route('/api/pause', methods=['POST'])
def api_pause():
    global paused
    paused = can_reader.paused = True
    socketio.emit('status_change', {**conn_status, 'paused': True})
    return jsonify({'ok': True})


@app.route('/api/resume', methods=['POST'])
def api_resume():
    global paused
    paused = can_reader.paused = False
    socketio.emit('status_change', {**conn_status, 'paused': False})
    return jsonify({'ok': True})


@app.route('/api/messages')
def api_messages():
    with _lock:
        msgs = list(all_messages)
    limit = int(request.args.get('limit', 1000))
    return jsonify(msgs[-limit:])

@app.route('/api/send', methods=['POST'])
def api_send():
    global msg_counter
    data = request.json or {}
    
    sender_id   = int(data.get('sender_id', 0x0E))
    receiver_id = int(data.get('receiver_id', 0x0F))
    msg_id      = int(data.get('msg_id', 0x000))
    priority    = int(data.get('priority', 0))
    seq_type    = int(data.get('seq_type', 3))      # UNSEG (0b11)
    seq_count   = int(data.get('seq_count', 0))
    payload     = data.get('payload', [])

    # 29-bit CAN ID hesaplama
    raw_id = (
        ((priority & 0x03) << 27) |
        ((sender_id & 0x0F) << 23) |
        ((receiver_id & 0x0F) << 19) |
        ((msg_id & 0x3FF) << 9) |
        ((seq_type & 0x03) << 7) |
        (seq_count & 0x7F)
    )

    payload_bytes = bytes(payload[:8])
    ok = can_reader.send_message(raw_id, payload_bytes, is_ext=True)
    
    # ─── YAZILIMSAL LOOPBACK (Arayüze Düşürme) ──────────────────────────────
    if ok:
        node_map = _nodes_map()
        def_map  = _defs_map()
        
        src  = node_map.get(sender_id,   {'name': f'Node 0x{sender_id:X}',   'short': f'0x{sender_id:X}',   'color': '#888'})
        dst  = node_map.get(receiver_id, {'name': f'Node 0x{receiver_id:X}', 'short': f'0x{receiver_id:X}', 'color': '#888'})
        mdef = def_map.get(msg_id,       {'name': f'0x{msg_id:03X}',     'description': ''})
        seq  = SEQ_TYPE_INFO.get(seq_type, {'name': '??', 'label': 'Unknown', 'color': '#888', 'bg': '#EEE'})
        
        now_ts = time.time()
        
        with _lock:
            msg_counter += 1
            db_id = msg_counter
            
            entry = {
                'db_id':          db_id,
                'timestamp':      now_ts,
                'ts_str':         datetime.fromtimestamp(now_ts).strftime('%H:%M:%S.%f')[:-3],
                'raw_id':         f'0x{raw_id:08X}',
                'priority':       f'{priority:02b}',
                'sender_id':      sender_id,
                'sender_hex':     f'0x{sender_id:X}',
                'sender_name':    src['name'],
                'sender_short':   src['short'],
                'sender_color':   src['color'],
                'receiver_id':    receiver_id,
                'receiver_hex':   f'0x{receiver_id:X}',
                'receiver_name':  dst['name'],
                'receiver_short': dst['short'],
                'receiver_color': dst['color'],
                'message_id':     msg_id,
                'message_id_hex': f'0x{msg_id:03X}',
                'message_name':   mdef['name'],
                'message_desc':   mdef['description'],
                'seq_type':       seq_type,
                'seq_type_name':  seq['name'],
                'seq_type_label': seq['label'],
                'seq_type_color': seq['color'],
                'seq_type_bg':    seq['bg'],
                'seq_count':      seq_count,
                'data':           list(payload_bytes),
                'data_hex':       ' '.join(f'{b:02X}' for b in payload_bytes),
                'frame_type':     'extended',
                'seg_group':      None,
                'requested_db_id': None,
                'is_sent':        True  # Frontend'in yakalaması için özel flag
            }
            
            all_messages.append(entry)
            _append_csv(entry)
            
        socketio.emit('new_message', entry)
    # ────────────────────────────────────────────────────────────────────────
    
    return jsonify({'ok': ok, 'raw_id': hex(raw_id)})


@app.route('/api/messages/clear', methods=['POST'])
def api_clear():
    global all_messages, msg_counter, seg_groups, seg_group_ctr, session_start, session_csv
    with _lock:
        all_messages  = []
        msg_counter   = 0
        seg_groups    = {}
        seg_group_ctr = 0
    session_start = time.time()
    ts = datetime.now().strftime('%Y%m%d_%H%M%S')
    session_csv = os.path.join(LOGS_DIR, f'session_{ts}.csv')
    socketio.emit('messages_cleared')
    return jsonify({'ok': True})


@app.route('/api/messages/<int:db_id>/request', methods=['POST'])
def api_set_request(db_id):
    data   = request.json or {}
    req_id = data.get('requested_db_id')
    with _lock:
        for m in all_messages:
            if m['db_id'] == db_id:
                m['requested_db_id'] = req_id
                socketio.emit('message_updated', {'db_id': db_id, 'requested_db_id': req_id})
                return jsonify({'ok': True})
    return jsonify({'error': 'Bulunamadı'}), 404


@app.route('/api/segment/<int:group_id>')
def api_segment(group_id):
    with _lock:
        msgs = [m for m in all_messages if m.get('seg_group') == group_id]
    return jsonify(msgs)


@app.route('/api/export')
def api_export():
    with _lock:
        msgs = list(all_messages)
    # Optional filters
    sender_filter   = request.args.getlist('sender')
    receiver_filter = request.args.getlist('receiver')
    msg_id_filter   = request.args.getlist('msg_id')
    if sender_filter:
        s = {int(x, 0) for x in sender_filter}
        msgs = [m for m in msgs if m['sender_id'] in s]
    if receiver_filter:
        r = {int(x, 0) for x in receiver_filter}
        msgs = [m for m in msgs if m['receiver_id'] in r]
    if msg_id_filter:
        mi = {int(x, 0) for x in msg_id_filter}
        msgs = [m for m in msgs if m['message_id'] in mi]

    buf = io.StringIO()
    w   = csv.DictWriter(buf, fieldnames=_CSV_FIELDS, extrasaction='ignore')
    w.writeheader()
    w.writerows(msgs)
    buf.seek(0)
    ts = datetime.now().strftime('%Y%m%d_%H%M%S')
    return send_file(
        io.BytesIO(buf.getvalue().encode('utf-8')),
        mimetype='text/csv',
        as_attachment=True,
        download_name=f'metucube_{ts}.csv',
    )


# ─── Admin API ───────────────────────────────────────────────────────────────
@app.route('/api/nodes', methods=['GET'])
def api_nodes_get():
    return jsonify(load_nodes())


@app.route('/api/nodes', methods=['POST'])
def api_nodes_post():
    print("save note istek")
    save_nodes(request.json)
    return jsonify({'ok': True})


@app.route('/api/message_defs', methods=['GET'])
def api_defs_get():
    return jsonify(load_msg_defs())


@app.route('/api/message_defs', methods=['POST'])
def api_defs_post():
    save_msg_defs(request.json)
    return jsonify({'ok': True})


# ─── SocketIO ────────────────────────────────────────────────────────────────
@socketio.on('connect')
def ws_connect():
    with _lock:
        count = len(all_messages)
    socketio.emit('status_change', {**conn_status, 'paused': paused, 'message_count': count},
                  to=request.sid)

@app.after_request
def add_header(response):
    """API endpoint'lerinde tarayıcının bayat veri tutmasını kesin olarak yasaklar."""
    if request.path.startswith('/api/'):
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    return response

# ─── Giriş noktası ───────────────────────────────────────────────────────────
if __name__ == '__main__':
    print('\n  🛰  METUCube Ground Station')
    print('  ─────────────────────────────────')
    print('  http://localhost:5000\n')
    socketio.run(app, host='0.0.0.0', port=5000, debug=False, allow_unsafe_werkzeug=True)

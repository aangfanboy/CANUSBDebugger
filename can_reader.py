"""
can_reader.py – Arka planda çalışan Waveshare USB-CAN okuyucu.
Flask app.py tarafından import edilir.
"""

import threading
import serial
import time

# ─── CAN hız tablosu ─────────────────────────────────────────────────────────
CANUSB_SPEED_MAP = {
    1_000_000: 0x01, 800_000: 0x02, 500_000: 0x03,
      400_000: 0x04, 250_000: 0x05, 200_000: 0x06,
      125_000: 0x07, 100_000: 0x08,  50_000: 0x09,
       20_000: 0x0A,  10_000: 0x0B,   5_000: 0x0C,
}

CANUSB_FRAME_EXTENDED = 0x02
CANUSB_MODE_NORMAL    = 0x00


class CANMessage:
    """
    Tek bir gelen CAN frame'ini temsil eder.
    29-bit genişletilmiş ID → METUCube alanlarına ayrılır.

    29-bit yapısı:
        [28:27] Priority    – 2 bit
        [26:23] Sender ID   – 4 bit
        [22:19] Receiver ID – 4 bit
        [18:9]  Message ID  – 10 bit
        [8:7]   Seq. Type   – 2 bit
        [6:0]   Seq. Count  – 7 bit
    """
    __slots__ = (
        'timestamp', 'raw_id', 'data', 'frame_type',
        'priority', 'sender_id', 'receiver_id',
        'message_id', 'seq_type', 'seq_count',
    )

    def __init__(self, timestamp: float, raw_id: int, data: bytes, frame_type: str = 'extended'):
        self.timestamp  = timestamp
        self.raw_id     = raw_id
        self.data       = data
        self.frame_type = frame_type

        if frame_type == 'extended':
            self.priority    = (raw_id >> 27) & 0x03
            self.sender_id   = (raw_id >> 23) & 0x0F
            self.receiver_id = (raw_id >> 19) & 0x0F
            self.message_id  = (raw_id >>  9) & 0x3FF
            self.seq_type    = (raw_id >>  7) & 0x03
            self.seq_count   =  raw_id        & 0x7F
        else:
            self.priority    = 0
            self.sender_id   = 0
            self.receiver_id = 0
            self.message_id  = raw_id & 0x7FF
            self.seq_type    = 0b11   # unsegmented
            self.seq_count   = 0


class CANReader:
    """Thread tabanlı Waveshare USB-CAN okuyucu."""

    def __init__(self, on_message=None, on_status=None):
        self.on_message = on_message
        self.on_status  = on_status
        self.ser        = None
        self.running    = False
        self.paused     = False
        self._thread    = None

    # ── Bağlantı ────────────────────────────────────────────────────────────
    def connect(self, port: str, baudrate: int = 2_000_000, can_speed: int = 500_000) -> bool:
        try:
            self.ser = serial.Serial(
                port=port, baudrate=baudrate,
                bytesize=serial.EIGHTBITS,
                parity=serial.PARITY_NONE,
                stopbits=serial.STOPBITS_TWO,
                timeout=0.1,
            )
            speed_byte = CANUSB_SPEED_MAP.get(can_speed, 0x03)
            self._send_settings(speed_byte, CANUSB_MODE_NORMAL, CANUSB_FRAME_EXTENDED)

            self.running = True
            self._thread = threading.Thread(target=self._read_loop, daemon=True)
            self._thread.start()

            if self.on_status:
                self.on_status('connected', port)
            return True

        except Exception as exc:
            if self.on_status:
                self.on_status('error', str(exc))
            return False

    def disconnect(self):
        self.running = False
        if self.ser:
            try:
                self.ser.close()
            except Exception:
                pass
        if self.on_status:
            self.on_status('disconnected', '')

    def send_message(self, can_id: int, data: bytes, is_ext: bool = True) -> bool:
        """CAN bus üzerine mesaj gönderir."""
        if not self.running or not self.ser:
            return False
        
        dlc = len(data)
        if dlc > 8: 
            dlc = 8  # 8-byte payload sınırı
            
        # Waveshare Variable Length Frame Control Byte: 
        # 0xC0 (Data Frame) | 0x20 (Extended Flag) | DLC
        ctrl = 0xC0 | (0x20 if is_ext else 0x00) | dlc
        
        frame = bytearray([0xAA, ctrl])
        
        # ID gönderimi: Waveshare'de ID Little-Endian (LSB first) olarak gönderilir.
        if is_ext:
            frame.extend([
                can_id & 0xFF,
                (can_id >> 8) & 0xFF,
                (can_id >> 16) & 0xFF,
                (can_id >> 24) & 0xFF
            ])
        else:
            frame.extend([
                can_id & 0xFF,
                (can_id >> 8) & 0xFF
            ])
            
        frame.extend(data[:dlc])
        
        # DÜZELTME BURADA: Checksum DEĞİL, Variable Length formatının End Code'u olan 0x55 eklenmeli!
        frame.append(0x55)
        
        try:
            self.ser.write(bytes(frame))
            return True
        except Exception:
            return False

    # ── Waveshare protokolü ──────────────────────────────────────────────────
    @staticmethod
    def _checksum(data: bytes) -> int:
        return sum(data) & 0xFF

    def _send_settings(self, speed: int, mode: int, frame_type: int):
        frame = bytearray([
            0xAA, 0x55, 0x12,
            speed, frame_type,
            0, 0, 0, 0,
            0, 0, 0, 0,
            mode, 0x01,
            0, 0, 0, 0,
        ])
        frame.append(self._checksum(frame[2:]))
        self.ser.write(bytes(frame))

    @staticmethod
    def _is_complete(frame: bytearray) -> bool:
        n = len(frame)
        if n > 0 and frame[0] != 0xAA:
            return True
        if n < 2:
            return False
        if frame[1] == 0x55:
            return n >= 20
        if (frame[1] & 0xD0) == 0xC0:          # data frame (std or ext)
            dlc     = frame[1] & 0x0F
            is_ext  = bool(frame[1] & 0x20)
            overhead = 7 if is_ext else 5
            return n >= dlc + overhead
        return True

    def _read_frame(self):
        frame = bytearray()
        while self.running:
            raw = self.ser.read(1)
            if raw:
                if len(frame) == 32:
                    return None
                frame.append(raw[0])
                if self._is_complete(frame):
                    break
            else:
                time.sleep(1e-5)
        return bytes(frame)

    def _parse(self, frame: bytes):
        if not frame or len(frame) < 4:
            return None
        if frame[0] != 0xAA or (frame[1] & 0xD0) != 0xC0:
            return None

        dlc    = frame[1] & 0x0F
        is_ext = bool(frame[1] & 0x20)
        n      = len(frame)

        if is_ext and n >= dlc + 7:
            can_id = (
                frame[2] | (frame[3] << 8) | (frame[4] << 16) | (frame[5] << 24)
            ) & 0x1FFFFFFF
            data = frame[6:6 + dlc]
            return CANMessage(time.time(), can_id, data, 'extended')

        if not is_ext and n >= dlc + 5:
            can_id = frame[2] | (frame[3] << 8)
            data   = frame[4:4 + dlc]
            return CANMessage(time.time(), can_id, data, 'standard')

        return None

    # ── Okuma döngüsü ────────────────────────────────────────────────────────
    def _read_loop(self):
        while self.running:
            try:
                frame = self._read_frame()
                if not frame:
                    continue
                if self.paused:
                    continue
                msg = self._parse(frame)
                if msg and self.on_message:
                    self.on_message(msg)
            except Exception:
                time.sleep(0.05)

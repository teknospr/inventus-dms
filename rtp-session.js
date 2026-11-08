// RTP media session for the Inventus softphone (M2).
// G.711 μ-law (PCMU/0) and a-law (PCMA/8) over UDP, 20 ms packets @ 8 kHz.
// Node has no audio I/O, so PCM is exchanged with the renderer (Web Audio):
//   renderer mic (Int16 8 kHz) -> writePcm() -> μ-law -> RTP -> dgram
//   dgram -> RTP -> μ-law decode -> jitter buffer -> 'pcm' event -> renderer playback
// Dependency-free so it packages with electron-builder.

const dgram = require('dgram');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const FRAME_SAMPLES = 160; // 20 ms @ 8 kHz
const FRAME_MS = 20;

// ── G.711 μ-law ─────────────────────────────────────────────────────────────────
const BIAS = 0x84, CLIP = 32635;
function linearToMuLaw(sample) {
  let sign = (sample >> 8) & 0x80;
  if (sign) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {}
  const mantissa = (sample >> (exponent + 3)) & 0x0F;
  return (~(sign | (exponent << 4) | mantissa)) & 0xFF;
}
function muLawToLinear(u) {
  u = ~u & 0xFF;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0F;
  let sample = ((mantissa << 3) + BIAS) << exponent;
  sample -= BIAS;
  return sign ? -sample : sample;
}

// ── G.711 a-law ─────────────────────────────────────────────────────────────────
function linearToALaw(sample) {
  let sign = (sample & 0x8000) ? 0x80 : 0x00;
  if (sign) sample = -sample;
  if (sample > 32635) sample = 32635;
  let compressed;
  if (sample >= 256) {
    let exponent = 7;
    for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {}
    const mantissa = (sample >> (exponent + 3)) & 0x0F;
    compressed = (exponent << 4) | mantissa;
  } else {
    compressed = sample >> 4;
  }
  return (compressed ^ sign ^ 0x55) & 0xFF;
}
function aLawToLinear(a) {
  a ^= 0x55;
  const sign = a & 0x80;
  const exponent = (a >> 4) & 0x07;
  let mantissa = a & 0x0F;
  let sample = exponent ? ((mantissa << 4) + 0x108) << (exponent - 1) : (mantissa << 4) + 8;
  return sign ? sample : -sample;
}

class RtpSession extends EventEmitter {
  constructor() {
    super();
    this.socket = null;
    this.localPort = 0;
    this.remoteIp = null;
    this.remotePort = null;
    this.payloadType = 0;          // 0 = PCMU, 8 = PCMA
    this.ssrc = crypto.randomBytes(4).readUInt32BE(0);
    this.seq = crypto.randomBytes(2).readUInt16BE(0);
    this.timestamp = crypto.randomBytes(4).readUInt32BE(0);
    this.sendQueue = Buffer.alloc(0); // pending Int16 PCM (as bytes) awaiting packetization
    this.sendTimer = null;
    this.started = false;
    this.muted = false;
  }

  setMuted(m) { this.muted = !!m; if (this.muted) this.sendQueue = Buffer.alloc(0); }

  bind() {
    return new Promise((resolve, reject) => {
      this.socket = dgram.createSocket('udp4');
      this.socket.on('error', (e) => this.emit('error', e));
      this.socket.on('message', (msg, rinfo) => this._onRtp(msg, rinfo));
      this.socket.bind(0, () => { this.localPort = this.socket.address().port; resolve(this.localPort); });
    });
  }

  setRemote(ip, port, payloadType) {
    this.remoteIp = ip;
    this.remotePort = port;
    if (payloadType === 0 || payloadType === 8) this.payloadType = payloadType;
  }

  start() {
    if (this.started) return;
    this.started = true;
    // Emit one RTP frame every 20 ms from whatever PCM the renderer has supplied
    // (silence if the buffer underruns, so timestamps stay continuous).
    this.sendTimer = setInterval(() => this._tick(), FRAME_MS);
  }

  stop() {
    this.started = false;
    if (this.sendTimer) { clearInterval(this.sendTimer); this.sendTimer = null; }
    if (this.socket) { try { this.socket.close(); } catch {} this.socket = null; }
    this.sendQueue = Buffer.alloc(0);
  }

  // Int16Array (or Buffer of Int16 LE) of 8 kHz PCM from the renderer mic.
  writePcm(int16) {
    const buf = Buffer.isBuffer(int16) ? int16 : Buffer.from(int16.buffer, int16.byteOffset, int16.byteLength);
    this.sendQueue = this.sendQueue.length ? Buffer.concat([this.sendQueue, buf]) : buf;
    // Guard against unbounded growth if the far end never reads.
    const maxBytes = FRAME_SAMPLES * 2 * 25; // ~500 ms
    if (this.sendQueue.length > maxBytes) this.sendQueue = this.sendQueue.slice(this.sendQueue.length - maxBytes);
  }

  _tick() {
    if (!this.remoteIp || !this.socket) return;
    const need = FRAME_SAMPLES * 2; // bytes of Int16 for one 20ms frame
    let frame;
    if (this.muted) {
      frame = Buffer.alloc(need); // send comfort silence while muted
    } else if (this.sendQueue.length >= need) {
      frame = this.sendQueue.slice(0, need);
      this.sendQueue = this.sendQueue.slice(need);
    } else {
      frame = Buffer.alloc(need); // silence on underrun
    }
    const encode = this.payloadType === 8 ? linearToALaw : linearToMuLaw;
    const payload = Buffer.alloc(FRAME_SAMPLES);
    for (let i = 0; i < FRAME_SAMPLES; i++) payload[i] = encode(frame.readInt16LE(i * 2));

    const header = Buffer.alloc(12);
    header[0] = 0x80;
    header[1] = this.payloadType & 0x7F;
    header.writeUInt16BE(this.seq & 0xFFFF, 2);
    header.writeUInt32BE(this.timestamp >>> 0, 4);
    header.writeUInt32BE(this.ssrc >>> 0, 8);
    this.seq = (this.seq + 1) & 0xFFFF;
    this.timestamp = (this.timestamp + FRAME_SAMPLES) >>> 0;

    const packet = Buffer.concat([header, payload]);
    this.socket.send(packet, this.remotePort, this.remoteIp);
  }

  // RFC 2833 / RFC 4733 DTMF over RTP (telephone-event, PT 101 as advertised in SDP).
  sendDtmf(digit) {
    const map = { '0':0,'1':1,'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'*':10,'#':11,'A':12,'B':13,'C':14,'D':15 };
    const ev = map[String(digit).toUpperCase()];
    if (ev === undefined || !this.remoteIp || !this.socket) return;
    const pt = 101, volume = 10, durStep = FRAME_SAMPLES; // 20ms in 8kHz units
    const ts = this.timestamp >>> 0;                       // freeze audio timestamp for the whole event
    const total = 7;                                       // ~140ms tone; last 3 are end packets
    for (let i = 0; i < total; i++) {
      const end = i >= total - 3;
      const duration = Math.min((i + 1) * durStep, total * durStep);
      const header = Buffer.alloc(12);
      header[0] = 0x80;
      header[1] = (i === 0 ? 0x80 : 0) | (pt & 0x7F);       // marker on the first packet
      header.writeUInt16BE(this.seq & 0xFFFF, 2);
      header.writeUInt32BE(ts, 4);
      header.writeUInt32BE(this.ssrc >>> 0, 8);
      this.seq = (this.seq + 1) & 0xFFFF;
      const pl = Buffer.alloc(4);
      pl[0] = ev;
      pl[1] = (end ? 0x80 : 0) | (volume & 0x3F);
      pl.writeUInt16BE(duration, 2);
      const pkt = Buffer.concat([header, pl]);
      setTimeout(() => { if (this.socket && this.remoteIp) this.socket.send(pkt, this.remotePort, this.remoteIp); }, i * FRAME_MS);
    }
    // Skip the audio timestamp past the event so the stream stays monotonic.
    this.timestamp = (ts + total * durStep) >>> 0;
  }

  _onRtp(msg) {
    if (msg.length < 12) return;
    const pt = msg[1] & 0x7F;
    if (pt !== 0 && pt !== 8) return; // ignore telephone-event / comfort-noise / other non-audio PTs
    const payload = msg.slice(12);
    const decode = pt === 8 ? aLawToLinear : muLawToLinear;
    const pcm = Buffer.alloc(payload.length * 2);
    for (let i = 0; i < payload.length; i++) pcm.writeInt16LE(decode(payload[i]), i * 2);
    // Hand decoded 8 kHz Int16 PCM to the renderer for playback.
    this.emit('pcm', pcm);
  }
}

module.exports = { RtpSession, FRAME_SAMPLES };

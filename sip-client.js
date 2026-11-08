// Minimal SIP-over-UDP client for the Inventus softphone.
// Milestone 1 scope: REGISTER with MD5 digest auth + periodic re-REGISTER.
// Structured so INVITE/BYE (call setup) can be layered on top later.
//
// Deliberately dependency-free (Node dgram + crypto) so it packages cleanly
// with electron-builder. Not a full RFC 3261 stack — it implements the subset
// a single-extension softphone needs against an Asterisk/chan_pjsip PBX.

const dgram = require('dgram');
const crypto = require('crypto');
const os = require('os');
const { EventEmitter } = require('events');
const { RtpSession } = require('./rtp-session');

function randHex(n = 8) { return crypto.randomBytes(n).toString('hex'); }
function md5(s) { return crypto.createHash('md5').update(s).digest('hex'); }

// Pick a routable IPv4 for the Via/Contact host.
function localIPv4() {
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const i of ifs[name] || []) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return '127.0.0.1';
}

// Parse a SIP message into { statusCode, reason, method, headers, body }.
function parseMessage(raw) {
  const text = raw.toString('utf8');
  const idx = text.indexOf('\r\n\r\n');
  const head = idx >= 0 ? text.slice(0, idx) : text;
  const body = idx >= 0 ? text.slice(idx + 4) : '';
  const lines = head.split('\r\n');
  const start = lines.shift() || '';
  const headers = {};
  for (const line of lines) {
    const c = line.indexOf(':');
    if (c < 0) continue;
    const key = line.slice(0, c).trim().toLowerCase();
    const val = line.slice(c + 1).trim();
    // WWW-Authenticate / Via can repeat; keep the first meaningful one for our needs.
    if (headers[key] === undefined) headers[key] = val;
    else headers[key] += ',' + val;
  }
  const respMatch = start.match(/^SIP\/2\.0\s+(\d+)\s+(.*)$/);
  if (respMatch) {
    return { isResponse: true, statusCode: parseInt(respMatch[1], 10), reason: respMatch[2], headers, body, raw: text };
  }
  const reqMatch = start.match(/^([A-Z]+)\s+(\S+)\s+SIP\/2\.0$/);
  if (reqMatch) {
    return { isResponse: false, method: reqMatch[1], uri: reqMatch[2], headers, body, raw: text };
  }
  return { unknown: true, headers, body, raw: text };
}

function extractTag(header) {
  const m = /;tag=([^;>\s]+)/.exec(header || '');
  return m ? m[1] : null;
}
function extractUri(header) {
  const m = /<([^>]+)>/.exec(header || '');
  if (m) return m[1];
  const t = (header || '').trim().split(/\s|;/)[0];
  return /^sips?:/.test(t) ? t : null;
}
function uriUser(uri) {
  const m = /sips?:([^@;>]+)@/.exec(uri || '');
  return m ? m[1] : (uri || '');
}

// Parse a digest challenge header value into a key/value map.
function parseAuth(value) {
  const out = {};
  const re = /(\w+)=(?:"([^"]*)"|([^,]*))/g;
  let m;
  while ((m = re.exec(value)) !== null) out[m[1].toLowerCase()] = m[2] !== undefined ? m[2] : m[3];
  return out;
}

class SipClient extends EventEmitter {
  /**
   * @param {object} cfg
   *  extension, secret, server (PBX host), port (5060), domain, displayName
   */
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.socket = null;
    this.localIp = localIPv4();
    this.localPort = 0;
    this.callId = randHex(12) + '@' + this.localIp;
    this.fromTag = randHex(6);
    this.cseq = 1;
    this.registered = false;
    this.expires = 300;
    this.reRegisterTimer = null;
    this._pendingRegister = null; // { resolve, reject } for the in-flight attempt
    this.call = null;             // single active call dialog (see _newCall)
  }

  get aor() { return `sip:${this.cfg.extension}@${this.cfg.domain || this.cfg.server}`; }
  get contact() { return `sip:${this.cfg.extension}@${this.localIp}:${this.localPort}`; }

  start() {
    return new Promise((resolve, reject) => {
      this.socket = dgram.createSocket('udp4');
      this.socket.on('error', (err) => { this.emit('error', err); });
      this.socket.on('message', (msg, rinfo) => this._onMessage(msg, rinfo));
      this.socket.bind(0, () => {
        this.localPort = this.socket.address().port;
        this.register().then(resolve).catch(reject);
      });
    });
  }

  stop() {
    if (this.call) { try { this.hangup(); } catch {} }
    if (this.reRegisterTimer) { clearTimeout(this.reRegisterTimer); this.reRegisterTimer = null; }
    // Best-effort de-register (Expires: 0), then close.
    try { this._sendRegister(0, null); } catch {}
    if (this.socket) { try { this.socket.close(); } catch {} this.socket = null; }
    this.registered = false;
  }

  register() {
    return new Promise((resolve, reject) => {
      this._pendingRegister = { resolve, reject };
      this._authCtx = null;
      this._sendRegister(this.expires, null);
      // Guard against a silent PBX.
      this._registerTimeout = setTimeout(() => {
        if (this._pendingRegister) {
          const p = this._pendingRegister; this._pendingRegister = null;
          p.reject(new Error('REGISTER timed out (no response from PBX)'));
          this.emit('registration-failed', 'timeout');
        }
      }, 10000);
    });
  }

  _sendRegister(expires, authHeader) {
    this.cseq += 1;
    const branch = 'z9hG4bK' + randHex(6);
    const lines = [
      `REGISTER sip:${this.cfg.domain || this.cfg.server} SIP/2.0`,
      `Via: SIP/2.0/UDP ${this.localIp}:${this.localPort};branch=${branch};rport`,
      `Max-Forwards: 70`,
      `From: "${this.cfg.displayName || this.cfg.extension}" <${this.aor}>;tag=${this.fromTag}`,
      `To: <${this.aor}>`,
      `Call-ID: ${this.callId}`,
      `CSeq: ${this.cseq} REGISTER`,
      `Contact: <${this.contact}>`,
      `Expires: ${expires}`,
      `User-Agent: InventusDMS-Softphone/1.0`,
    ];
    if (authHeader) lines.push(authHeader);
    lines.push('Content-Length: 0', '', '');
    this._send(lines.join('\r\n'));
  }

  // Build a digest Authorization header from a challenge.
  _buildAuth(challenge, method, uri, headerName) {
    const c = parseAuth(challenge);
    const realm = c.realm || '';
    const nonce = c.nonce || '';
    const qop = c.qop;
    const ha1 = md5(`${this.cfg.extension}:${realm}:${this.cfg.secret}`);
    const ha2 = md5(`${method}:${uri}`);
    let response, extra = '';
    if (qop && /auth/.test(qop)) {
      const nc = '00000001';
      const cnonce = randHex(8);
      response = md5(`${ha1}:${nonce}:${nc}:${cnonce}:auth:${ha2}`);
      extra = `, qop=auth, nc=${nc}, cnonce="${cnonce}"`;
    } else {
      response = md5(`${ha1}:${nonce}:${ha2}`);
    }
    const parts = [
      `username="${this.cfg.extension}"`,
      `realm="${realm}"`,
      `nonce="${nonce}"`,
      `uri="${uri}"`,
      `response="${response}"`,
    ];
    if (c.opaque) parts.push(`opaque="${c.opaque}"`);
    if (c.algorithm) parts.push(`algorithm=${c.algorithm}`);
    return `${headerName}: Digest ${parts.join(', ')}${extra}`;
  }

  _onMessage(msg, rinfo) {
    const m = parseMessage(msg);
    if (m.isResponse) return this._onResponse(m);
    if (!m.method) return;
    switch (m.method) {
      case 'INVITE': return this._onIncomingInvite(m, rinfo);
      case 'ACK':    return; // far end confirmed our 200 (answered incoming) — nothing to do
      case 'BYE':    return this._onBye(m);
      case 'CANCEL': return this._onCancel(m);
      case 'NOTIFY': return this._sendSimpleResponse(m, 200, 'OK'); // REFER progress notifications
      case 'OPTIONS': return this._sendSimpleResponse(m, 200, 'OK');
      default:       return this._sendSimpleResponse(m, 200, 'OK');
    }
  }

  _onResponse(m) {
    const cseqHeader = (m.headers['cseq'] || '').toUpperCase();
    if (cseqHeader.includes('INVITE')) return this._onInviteResponse(m);
    if (cseqHeader.includes('BYE') || cseqHeader.includes('CANCEL') || cseqHeader.includes('REFER')) return; // best-effort
    if (!cseqHeader.includes('REGISTER')) { this.emit('response', m); return; }

    // Auth challenge → retry once with credentials.
    if ((m.statusCode === 401 || m.statusCode === 407) && !this._authCtx) {
      const isProxy = m.statusCode === 407;
      const challenge = isProxy ? m.headers['proxy-authenticate'] : m.headers['www-authenticate'];
      if (!challenge) return this._failRegister('Auth challenge missing header');
      this._authCtx = true;
      const uri = `sip:${this.cfg.domain || this.cfg.server}`;
      const header = this._buildAuth(challenge, 'REGISTER', uri, isProxy ? 'Proxy-Authorization' : 'Authorization');
      this._sendRegister(this.expires, header);
      return;
    }

    if (m.statusCode >= 200 && m.statusCode < 300) {
      if (this._registerTimeout) { clearTimeout(this._registerTimeout); this._registerTimeout = null; }
      // Honor the PBX-granted Expires when present.
      const exp = parseInt((m.headers['expires'] || '').trim(), 10);
      const contactExp = (m.headers['contact'] || '').match(/expires=(\d+)/i);
      const granted = !isNaN(exp) ? exp : (contactExp ? parseInt(contactExp[1], 10) : this.expires);
      this.registered = true;
      this.emit('registered', { expires: granted });
      if (this._pendingRegister) { this._pendingRegister.resolve({ expires: granted }); this._pendingRegister = null; }
      // Re-register a bit before expiry.
      if (this.reRegisterTimer) clearTimeout(this.reRegisterTimer);
      this.reRegisterTimer = setTimeout(() => { this._authCtx = null; this._sendRegister(this.expires, null); },
        Math.max(30, granted - 15) * 1000);
      return;
    }

    if (m.statusCode >= 400) {
      this._failRegister(`${m.statusCode} ${m.reason}`);
    }
  }

  _failRegister(reason) {
    if (this._registerTimeout) { clearTimeout(this._registerTimeout); this._registerTimeout = null; }
    this.registered = false;
    this.emit('registration-failed', reason);
    if (this._pendingRegister) { this._pendingRegister.reject(new Error(reason)); this._pendingRegister = null; }
  }

  // ── Call helpers ────────────────────────────────────────────────────────────
  _localHeader(tag) {
    return `"${this.cfg.displayName || this.cfg.extension}" <${this.aor}>;tag=${tag}`;
  }
  _remoteHeader(c) {
    return `<${c.remoteUri}>` + (c.remoteTag ? `;tag=${c.remoteTag}` : '');
  }

  _buildSdp(rtpPort, direction = 'sendrecv') {
    const sid = Date.now();
    return [
      'v=0',
      `o=- ${sid} ${sid} IN IP4 ${this.localIp}`,
      's=InventusDMS',
      `c=IN IP4 ${this.localIp}`,
      't=0 0',
      `m=audio ${rtpPort} RTP/AVP 0 8 101`,
      'a=rtpmap:0 PCMU/8000',
      'a=rtpmap:8 PCMA/8000',
      'a=rtpmap:101 telephone-event/8000',
      'a=fmtp:101 0-16',
      `a=${direction}`,
      '',
    ].join('\r\n');
  }
  _parseSdp(body) {
    const ipM = /c=IN IP4 ([0-9.]+)/.exec(body || '');
    const mM = /m=audio (\d+) RTP\/AVP ([0-9 ]+)/.exec(body || '');
    if (!ipM || !mM) return null;
    const pts = mM[2].trim().split(/\s+/).map(Number);
    const pt = pts.includes(0) ? 0 : (pts.includes(8) ? 8 : pts[0]);
    return { ip: ipM[1], port: parseInt(mM[1], 10), pt };
  }
  _startMedia(body) {
    const c = this.call;
    if (!c || !body) return;
    const remote = this._parseSdp(body);
    if (!remote) return;
    c.rtp.setRemote(remote.ip, remote.port, remote.pt);
    c.rtp.start();
    this.emit('media-started');
  }

  // Outgoing call.
  async call(number) {
    if (this.call) throw new Error('A call is already in progress');
    const rtp = new RtpSession();
    const rtpPort = await rtp.bind();
    const remoteUri = `sip:${number}@${this.cfg.domain || this.cfg.server}`;
    const c = {
      dir: 'out', number, callId: randHex(12) + '@' + this.localIp,
      localTag: randHex(6), remoteTag: null,
      remoteUri, reqUri: remoteUri,
      cseq: 1, rtp, rtpPort, authTried: false, state: 'calling',
    };
    this.call = c;
    rtp.on('pcm', (pcm) => this.emit('audio', pcm));
    rtp.on('error', (e) => this.emit('error', e));
    this._sendInvite(null);
    this.emit('call-state', { state: 'calling', number });
  }

  _sendInvite(authHeader) {
    const c = this.call;
    c.cseq += 1;
    c.branch = 'z9hG4bK' + randHex(6);
    const sdp = this._buildSdp(c.rtpPort);
    const lines = [
      `INVITE ${c.reqUri} SIP/2.0`,
      `Via: SIP/2.0/UDP ${this.localIp}:${this.localPort};branch=${c.branch};rport`,
      `Max-Forwards: 70`,
      `From: ${this._localHeader(c.localTag)}`,
      `To: ${this._remoteHeader(c)}`,
      `Call-ID: ${c.callId}`,
      `CSeq: ${c.cseq} INVITE`,
      `Contact: <${this.contact}>`,
      `User-Agent: InventusDMS-Softphone/1.0`,
      `Content-Type: application/sdp`,
    ];
    if (authHeader) lines.push(authHeader);
    lines.push(`Content-Length: ${Buffer.byteLength(sdp)}`, '', sdp);
    this._send(lines.join('\r\n'));
  }

  _onInviteResponse(m) {
    const c = this.call;
    if (!c) return;

    // In-dialog re-INVITE (hold / resume) response.
    if (c.reinvite) {
      const code = m.statusCode;
      if (code === 401 || code === 407) {
        this._ackFailure(m);
        if (c.reinvite.authTried) { c.reinvite = null; return; }
        c.reinvite.authTried = true;
        const isProxy = code === 407;
        const challenge = isProxy ? m.headers['proxy-authenticate'] : m.headers['www-authenticate'];
        const header = challenge && this._buildAuth(challenge, 'INVITE', c.reqUri, isProxy ? 'Proxy-Authorization' : 'Authorization');
        if (header) this._sendReinvite(header);
        return;
      }
      if (code >= 200 && code < 300) {
        this._sendAck();
        const onHold = c.reinvite.direction !== 'sendrecv';
        c.held = onHold;
        if (c.rtp) c.rtp.setMuted(onHold); // stop sending audio while held
        this.emit('call-state', { state: onHold ? 'held' : 'connected', number: c.number });
        c.reinvite = null;
      } else if (code >= 300) {
        c.reinvite = null; // hold/resume rejected — leave the call as-is
      }
      return;
    }

    if (c.dir !== 'out') return;
    const code = m.statusCode;
    const toTag = extractTag(m.headers['to']);
    if (toTag && !c.remoteTag) c.remoteTag = toTag;

    if (code === 401 || code === 407) {
      this._ackFailure(m);
      if (c.authTried) return this._endCall(`auth failed (${code})`);
      c.authTried = true;
      const isProxy = code === 407;
      const challenge = isProxy ? m.headers['proxy-authenticate'] : m.headers['www-authenticate'];
      if (!challenge) return this._endCall('auth challenge missing');
      c.remoteTag = null; // fresh transaction
      const header = this._buildAuth(challenge, 'INVITE', c.reqUri, isProxy ? 'Proxy-Authorization' : 'Authorization');
      this._sendInvite(header);
      return;
    }
    if (code >= 180 && code < 200) {
      c.state = 'ringing';
      if (m.body && /m=audio/.test(m.body)) this._startMedia(m.body); // early media
      this.emit('call-state', { state: 'ringing', number: c.number });
      return;
    }
    if (code >= 200 && code < 300) {
      const contact = extractUri(m.headers['contact']);
      if (contact) c.reqUri = contact;
      this._startMedia(m.body);
      this._sendAck();
      c.state = 'connected';
      this.emit('call-state', { state: 'connected', number: c.number });
      return;
    }
    if (code >= 300) {
      this._ackFailure(m);
      this._endCall(`call failed (${code} ${m.reason})`);
    }
  }

  _sendAck() {
    const c = this.call;
    const lines = [
      `ACK ${c.reqUri} SIP/2.0`,
      `Via: SIP/2.0/UDP ${this.localIp}:${this.localPort};branch=z9hG4bK${randHex(6)};rport`,
      `Max-Forwards: 70`,
      `From: ${this._localHeader(c.localTag)}`,
      `To: ${this._remoteHeader(c)}`,
      `Call-ID: ${c.callId}`,
      `CSeq: ${c.cseq} ACK`,
      `Content-Length: 0`, '', '',
    ];
    this._send(lines.join('\r\n'));
  }

  // ACK for a non-2xx INVITE response — same branch/CSeq as the INVITE.
  _ackFailure(m) {
    const c = this.call;
    const toTag = extractTag(m.headers['to']);
    const to = `<${c.remoteUri}>` + (toTag ? `;tag=${toTag}` : '');
    const lines = [
      `ACK ${c.reqUri} SIP/2.0`,
      `Via: SIP/2.0/UDP ${this.localIp}:${this.localPort};branch=${c.branch}`,
      `Max-Forwards: 70`,
      `From: ${this._localHeader(c.localTag)}`,
      `To: ${to}`,
      `Call-ID: ${c.callId}`,
      `CSeq: ${c.cseq} ACK`,
      `Content-Length: 0`, '', '',
    ];
    this._send(lines.join('\r\n'));
  }

  // Incoming call.
  _onIncomingInvite(m, rinfo) {
    if (this.call) return this._sendResponse(m, 486, 'Busy Here', null);
    const rtp = new RtpSession();
    rtp.bind().then((rtpPort) => {
      const fromUri = extractUri(m.headers['from']);
      const c = {
        dir: 'in', number: uriUser(fromUri), callId: m.headers['call-id'],
        localTag: randHex(6), remoteTag: extractTag(m.headers['from']),
        remoteUri: fromUri, reqUri: extractUri(m.headers['contact']) || fromUri,
        cseqNum: parseInt((m.headers['cseq'] || '').trim(), 10) || 1,
        rtp, rtpPort, offer: m.body, invite: m, state: 'incoming',
      };
      this.call = c;
      rtp.on('pcm', (pcm) => this.emit('audio', pcm));
      rtp.on('error', (e) => this.emit('error', e));
      this._sendResponse(m, 180, 'Ringing', c.localTag);
      this.emit('call-state', { state: 'incoming', number: c.number });
    }).catch((e) => this.emit('error', e));
  }

  answer() {
    const c = this.call;
    if (!c || c.dir !== 'in' || c.state !== 'incoming') return;
    this._startMedia(c.offer);
    const sdp = this._buildSdp(c.rtpPort);
    this._sendResponse(c.invite, 200, 'OK', c.localTag, sdp);
    c.state = 'connected';
    this.emit('call-state', { state: 'connected', number: c.number });
  }

  hangup() {
    const c = this.call;
    if (!c) return;
    if (c.dir === 'in' && c.state === 'incoming') {
      this._sendResponse(c.invite, 486, 'Busy Here', c.localTag);
      return this._endCall('rejected');
    }
    if (c.state === 'connected' || c.dir === 'in') this._sendBye();
    else if (c.dir === 'out') this._sendBye(); // best-effort; a CANCEL would be more correct pre-answer
    this._endCall('hung up');
  }

  _sendBye() {
    const c = this.call;
    if (!c) return;
    const cseq = ((c.dir === 'out' ? c.cseq : c.cseqNum) || 1) + 1;
    const lines = [
      `BYE ${c.reqUri} SIP/2.0`,
      `Via: SIP/2.0/UDP ${this.localIp}:${this.localPort};branch=z9hG4bK${randHex(6)};rport`,
      `Max-Forwards: 70`,
      `From: ${this._localHeader(c.localTag)}`,
      `To: ${this._remoteHeader(c)}`,
      `Call-ID: ${c.callId}`,
      `CSeq: ${cseq} BYE`,
      `Content-Length: 0`, '', '',
    ];
    this._send(lines.join('\r\n'));
  }

  _onBye(m) {
    this._sendResponse(m, 200, 'OK', this.call ? this.call.localTag : null);
    this._endCall('remote hung up');
  }

  _onCancel(m) {
    this._sendResponse(m, 200, 'OK', null);
    const c = this.call;
    if (c && c.dir === 'in' && c.invite) this._sendResponse(c.invite, 487, 'Request Terminated', c.localTag);
    this._endCall('cancelled by caller');
  }

  _endCall(reason) {
    const c = this.call;
    if (!c) return;
    try { c.rtp.stop(); } catch {}
    this.call = null;
    this.emit('call-state', { state: 'ended', reason });
  }

  // Generic response to an inbound request; echoes Via/From/Call-ID/CSeq.
  _sendResponse(req, code, reason, localTag, sdp) {
    let toHeader = req.headers['to'] || '';
    if (localTag && !/;tag=/.test(toHeader)) toHeader += `;tag=${localTag}`;
    const lines = [
      `SIP/2.0 ${code} ${reason}`,
      `Via: ${req.headers['via'] || ''}`,
      `From: ${req.headers['from'] || ''}`,
      `To: ${toHeader}`,
      `Call-ID: ${req.headers['call-id'] || ''}`,
      `CSeq: ${req.headers['cseq'] || ''}`,
      `Contact: <${this.contact}>`,
      `User-Agent: InventusDMS-Softphone/1.0`,
    ];
    if (sdp) lines.push(`Content-Type: application/sdp`, `Content-Length: ${Buffer.byteLength(sdp)}`, '', sdp);
    else lines.push('Content-Length: 0', '', '');
    this._send(lines.join('\r\n'));
  }
  _sendSimpleResponse(req, code, reason) { this._sendResponse(req, code, reason, null); }

  // ── Hold (re-INVITE) ──────────────────────────────────────────────────────────
  hold() { this._reinvite('inactive'); }
  unhold() { this._reinvite('sendrecv'); }

  _reinvite(direction) {
    const c = this.call;
    if (!c || c.state !== 'connected') return;
    c.reinvite = { direction, authTried: false };
    this._sendReinvite(null);
  }

  _sendReinvite(authHeader) {
    const c = this.call;
    c.cseq += 1;
    c.branch = 'z9hG4bK' + randHex(6);
    const sdp = this._buildSdp(c.rtpPort, c.reinvite.direction);
    const lines = [
      `INVITE ${c.reqUri} SIP/2.0`,
      `Via: SIP/2.0/UDP ${this.localIp}:${this.localPort};branch=${c.branch};rport`,
      `Max-Forwards: 70`,
      `From: ${this._localHeader(c.localTag)}`,
      `To: ${this._remoteHeader(c)}`,
      `Call-ID: ${c.callId}`,
      `CSeq: ${c.cseq} INVITE`,
      `Contact: <${this.contact}>`,
      `User-Agent: InventusDMS-Softphone/1.0`,
      `Content-Type: application/sdp`,
    ];
    if (authHeader) lines.push(authHeader);
    lines.push(`Content-Length: ${Buffer.byteLength(sdp)}`, '', sdp);
    this._send(lines.join('\r\n'));
  }

  // ── Blind transfer (REFER) ────────────────────────────────────────────────────
  transfer(target) {
    const c = this.call;
    if (!c || c.state !== 'connected' || !target) return;
    c.cseq = (c.cseq || 1) + 1;
    const referTo = `sip:${String(target).replace(/[^0-9*#+a-zA-Z._-]/g, '')}@${this.cfg.domain || this.cfg.server}`;
    const lines = [
      `REFER ${c.reqUri} SIP/2.0`,
      `Via: SIP/2.0/UDP ${this.localIp}:${this.localPort};branch=z9hG4bK${randHex(6)};rport`,
      `Max-Forwards: 70`,
      `From: ${this._localHeader(c.localTag)}`,
      `To: ${this._remoteHeader(c)}`,
      `Call-ID: ${c.callId}`,
      `CSeq: ${c.cseq} REFER`,
      `Contact: <${this.contact}>`,
      `Refer-To: <${referTo}>`,
      `Referred-By: <${this.aor}>`,
      `User-Agent: InventusDMS-Softphone/1.0`,
      `Content-Length: 0`, '', '',
    ];
    this._send(lines.join('\r\n'));
    this.emit('call-state', { state: 'transferring', number: target });
    // The PBX drives the transfer and sends us a BYE when it completes; _onBye ends the call.
  }

  // Feed mic PCM (Int16 8 kHz) from the renderer into the active call's RTP sender.
  sendAudio(int16) {
    if (this.call && this.call.rtp) this.call.rtp.writePcm(int16);
  }
  setMuted(m) { if (this.call && this.call.rtp) this.call.rtp.setMuted(m); }
  sendDtmf(digit) { if (this.call && this.call.rtp && this.call.state === 'connected') this.call.rtp.sendDtmf(digit); }
  get inCall() { return !!this.call; }

  _send(text) {
    if (!this.socket) return;
    const buf = Buffer.from(text, 'utf8');
    this.socket.send(buf, this.cfg.port || 5060, this.cfg.server, (err) => {
      if (err) this.emit('error', err);
    });
  }
}

module.exports = { SipClient, parseMessage, parseAuth };

'use strict';
// Lõi luật chơi lô tô. Không phụ thuộc thư viện nào, để máy chủ làm trọng tài:
// vé do máy chủ phát và giữ, số do máy chủ bốc, Kinh do máy chủ soát.
const crypto = require('crypto');

const COLORS = ['pink', 'rose', 'red', 'maroon', 'orange', 'peach', 'yellow', 'lemon', 'gold', 'lime', 'green', 'forest',
  'mint', 'teal', 'sky', 'blue', 'navy', 'indigo', 'purple', 'lavender', 'magenta', 'brown', 'gray', 'black'];
const HOST_GRACE_MS = 30 * 1000;      // cái mất kết nối quá lâu thì người khác được xin làm cái
const DOI_COOLDOWN_MS = 15 * 1000;
const CHAT_COOLDOWN_MS = 700;
const CHAT_KEEP = 100;

const rnd = (n) => crypto.randomInt(n);
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = rnd(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function range(a, b) { const r = []; for (let i = a; i <= b; i++) r.push(i); return r; }
function decade(c) { return c === 0 ? range(1, 9) : c === 8 ? range(80, 90) : range(c * 10, c * 10 + 9); }

// Khung 9x9: mỗi hàng 5 ô có số, mỗi cột 5 ô có số.
function mask() {
  const rows = shuffle(range(0, 8)), cols = shuffle(range(0, 8)), t = [];
  for (let r = 0; r < 9; r++) t.push([0, 0, 0, 0, 0, 0, 0, 0, 0]);
  for (let i = 0; i < 9; i++) for (let k = 0; k < 5; k++) t[rows[i]][cols[(i + k) % 9]] = -1;
  return t;
}
function makeTicket() {
  const t = mask();
  for (let c = 0; c < 9; c++) {
    const pick = shuffle(decade(c)).slice(0, 5).sort((a, b) => a - b); let n = 0;
    for (let r = 0; r < 9; r++) if (t[r][c] === -1) t[r][c] = pick[n++];
  }
  return t;
}
// Tờ thứ hai của cặp: đúng 45 số tờ kia không có, nên một cặp phủ đủ 1-90 và không trùng số.
function complement(a) {
  const used = new Set(a.flat().filter((n) => n > 0)), t = mask();
  for (let r = 0; r < 9; r++) if (t[r][0] === -1 && t[r][8] === 0) { t[r][0] = 0; t[r][8] = -1; break; }
  for (let c = 0; c < 9; c++) {
    const pool = decade(c).filter((n) => !used.has(n)); let n = 0;
    for (let r = 0; r < 9; r++) if (t[r][c] === -1) t[r][c] = pool[n++];
  }
  return t;
}
function makePair() { const a = makeTicket(); return [a, complement(a)]; }

function cleanName(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, 20); }
function cleanText(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, 200); }

class Player {
  constructor(token, name, uid) {
    this.token = token;                       // bí mật, chỉ máy người chơi biết
    this.id = crypto.randomBytes(6).toString('hex'); // mã công khai
    this.uid = uid;                           // số dùng cho kênh thoại
    this.name = name;
    this.online = true; this.offlineAt = 0;
    this.pairs = {}; this.take = {};
    const c = COLORS[rnd(COLORS.length)];
    this.take[c] = 2; this.pairOf(c);
    this.waited = new Set(); this.kinhRows = new Set();
    this.doi = false; this.kinh = false;
    this.lastDoi = 0; this.lastChat = 0;
    this.voice = { in: false, muted: false };
  }
  pairOf(c) { if (!this.pairs[c]) this.pairs[c] = makePair(); return this.pairs[c]; }
  color() { return COLORS.find((c) => this.take[c] > 0) || 'pink'; }
  tickets() {
    const o = [];
    for (const c of COLORS) { const k = this.take[c] || 0; for (let i = 0; i < k; i++) o.push({ color: c, n: i + 1, rows: this.pairOf(c)[i] }); }
    return o;
  }
  rows() {
    const o = [];
    for (const t of this.tickets()) t.rows.forEach((r, ri) => o.push({ key: t.color + t.n + ':' + ri, color: t.color, n: t.n, row: ri + 1, nums: r.filter((x) => x > 0) }));
    return o;
  }
  resetRound() { this.waited.clear(); this.kinhRows.clear(); this.doi = false; this.kinh = false; }
}

class Room {
  constructor(pin) {
    this.pin = pin; this.round = 1; this.called = []; this.calledSet = new Set();
    this.players = new Map();   // token -> Player
    this.hostToken = null; this.chat = []; this.nextUid = 1000 + rnd(1000);
    this.auto = false; this.speed = 5; this.emptySince = Date.now();
  }
  get locked() { return this.called.length > 0; }
  host() { return this.hostToken ? this.players.get(this.hostToken) || null : null; }
  isHost(p) { return !!p && p.token === this.hostToken; }
  uniqueName(name, exceptToken) {
    const taken = new Set([...this.players.values()].filter((p) => p.token !== exceptToken).map((p) => p.name.toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    for (let i = 2; i < 99; i++) { const n = name.slice(0, 16) + ' (' + i + ')'; if (!taken.has(n.toLowerCase())) return n; }
    return name;
  }
  say(p, text, sys) {
    const m = { id: p ? p.id : null, name: p ? p.name : '', text, at: Date.now(), sys: !!sys };
    this.chat.push(m); if (this.chat.length > CHAT_KEEP) this.chat.shift();
    return m;
  }

  // Trả về { player, events }. events là danh sách việc máy chủ cần phát cho cả phòng.
  join(token, rawName) {
    const name = cleanName(rawName);
    if (!name) return { error: 'Đặt tên trước để cái và mọi người biết bạn là ai.' };
    if (typeof token !== 'string' || token.length < 16 || token.length > 80) return { error: 'Phiên chơi không hợp lệ. Tải lại trang.' };
    let p = this.players.get(token); const events = [];
    if (p) {
      const back = !p.online; p.online = true; p.offlineAt = 0;
      const nn = this.uniqueName(name, token);
      if (nn !== p.name) p.name = nn;
      if (back) events.push({ chat: this.say(p, 'quay lại phòng', true) });
    } else {
      p = new Player(token, this.uniqueName(name, token), this.nextUid++);
      this.players.set(token, p);
      events.push({ chat: this.say(p, 'vào phòng', true) });
    }
    if (!this.hostToken && this.players.size === 1) { this.hostToken = token; }
    this.emptySince = 0;
    return { player: p, events };
  }
  disconnect(p) {
    p.online = false; p.offlineAt = Date.now(); p.voice = { in: false, muted: false };
    if (![...this.players.values()].some((x) => x.online)) this.emptySince = Date.now();
    return [{ chat: this.say(p, 'mất kết nối', true) }];
  }
  leave(p) {
    const events = [{ chat: this.say(p, 'rời phòng', true) }];
    if (this.isHost(p)) { this.hostToken = null; this.auto = false; }
    this.players.delete(p.token);
    if (![...this.players.values()].some((x) => x.online)) this.emptySince = Date.now();
    return events;
  }

  /* ----- cái ----- */
  claimHost(p) {
    const h = this.host();
    if (h && h !== p) {
      if (h.online) return { error: 'Cái đang có mặt. Chỉ xin làm cái được khi cái nhường hoặc mất kết nối quá 30 giây.' };
      if (Date.now() - h.offlineAt < HOST_GRACE_MS) return { error: 'Cái vừa mất kết nối. Chờ thêm ít giây rồi xin lại.' };
    }
    this.hostToken = p.token; this.auto = false;
    return { events: [{ chat: this.say(p, 'nhận làm cái', true) }] };
  }
  quitHost(p) {
    if (!this.isHost(p)) return { error: 'Bạn không phải cái.' };
    this.hostToken = null; this.auto = false;
    return { events: [{ chat: this.say(p, 'thôi làm cái', true) }] };
  }
  setAuto(p, on, speed) {
    if (!this.isHost(p)) return { error: 'Chỉ cái mới hô số được.' };
    if ([3, 5, 8].includes(+speed)) this.speed = +speed;
    this.auto = !!on && this.called.length < 90;
    return { events: [] };
  }
  draw(p) {
    if (p && !this.isHost(p)) return { error: 'Chỉ cái mới hô số được.' };
    if (this.called.length >= 90) { this.auto = false; return { error: 'Đã hô hết 90 số.' }; }
    const left = range(1, 90).filter((n) => !this.calledSet.has(n));
    const n = left[rnd(left.length)];
    this.called.push(n); this.calledSet.add(n);
    const events = [{ event: { type: 'number', n } }];
    // Tự hô Đợi: hàng nào vừa còn thiếu đúng một số thì báo cả phòng, không lộ số đang chờ.
    for (const pl of this.players.values()) {
      let fresh = false;
      for (const R of pl.rows()) {
        const got = R.nums.filter((x) => this.calledSet.has(x)).length;
        if (got === 4 && !pl.waited.has(R.key)) { pl.waited.add(R.key); fresh = true; }
      }
      if (fresh && !pl.kinh) { pl.doi = true; events.push({ chat: this.say(pl, 'Đợi!', false) }, { event: { type: 'doi', name: pl.name, id: pl.id } }); }
    }
    if (this.called.length >= 90) this.auto = false;
    return { n, events };
  }
  newRound(p) {
    if (!this.isHost(p)) return { error: 'Chỉ cái mới mở ván mới được.' };
    this.round++; this.called = []; this.calledSet.clear(); this.auto = false;
    for (const pl of this.players.values()) pl.resetRound();
    return { events: [{ chat: this.say(p, 'mở ván ' + this.round, true) }, { event: { type: 'round', round: this.round } }] };
  }

  /* ----- người chơi ----- */
  setTake(p, color, k) {
    if (this.locked) return { error: 'Ván đang chơi, chưa đổi vé được. Chờ cái mở ván mới.' };
    if (!COLORS.includes(color) || ![0, 1, 2].includes(k)) return { error: 'Lựa chọn vé không hợp lệ.' };
    const sum = COLORS.reduce((s, c) => s + (c === color ? k : p.take[c] || 0), 0);
    if (!sum) return { error: 'Phải cầm ít nhất 1 tờ vé.' };
    p.take[color] = k; if (k > 0) p.pairOf(color);
    p.resetRound();
    return { events: [] };
  }
  reroll(p) {
    if (this.locked) return { error: 'Ván đang chơi, chưa đổi vé được. Chờ cái mở ván mới.' };
    for (const c of COLORS) if (p.take[c] > 0) p.pairs[c] = makePair();
    p.resetRound();
    return { events: [] };
  }
  isWaiting(p) { return p.rows().some((R) => R.nums.filter((x) => this.calledSet.has(x)).length === 4); }
  doi(p) {
    if (!this.isWaiting(p)) return { error: 'Bạn chưa có hàng nào còn thiếu đúng một số.' };
    if (Date.now() - p.lastDoi < DOI_COOLDOWN_MS) return { error: 'Bạn vừa hô Đợi rồi. Chờ vài giây nữa.' };
    p.lastDoi = Date.now(); p.doi = true;
    return { events: [{ chat: this.say(p, 'Đợi!', false) }, { event: { type: 'doi', name: p.name, id: p.id } }] };
  }
  kinh(p) {
    const R = p.rows().find((x) => !p.kinhRows.has(x.key) && x.nums.every((n) => this.calledSet.has(n)));
    if (!R) {
      return { error: p.kinhRows.size ? 'Hàng đó bạn đã hô Kinh rồi.' : 'Chưa có hàng nào đủ 5 số cái đã hô.' };
    }
    p.kinhRows.add(R.key); p.kinh = true; p.doi = false; this.auto = false;
    return {
      row: R,
      events: [
        { chat: this.say(p, 'KINH! Hàng đủ số: ' + R.nums.join(' · '), true) },
        { event: { type: 'kinh', name: p.name, id: p.id, nums: R.nums, round: this.round } },
      ],
    };
  }
  chatFrom(p, raw) {
    const text = cleanText(raw);
    if (!text) return { error: '' };
    if (Date.now() - p.lastChat < CHAT_COOLDOWN_MS) return { error: 'Bạn nhắn nhanh quá. Chờ một chút.' };
    p.lastChat = Date.now();
    return { events: [{ chat: this.say(p, text, false) }] };
  }
  setVoice(p, v) {
    p.voice = { in: !!(v && v.in), muted: !!(v && v.muted) };
    return { events: [] };
  }

  /* ----- dữ liệu gửi cho máy khách ----- */
  publicState() {
    const h = this.host();
    return {
      pin: this.pin, round: this.round, called: this.called.slice(), locked: this.locked,
      hostId: h ? h.id : null, hostOnline: h ? h.online : false, auto: this.auto, speed: this.speed,
      players: [...this.players.values()].map((p) => ({
        id: p.id, uid: p.uid, name: p.name, color: p.color(), online: p.online,
        doi: p.doi, kinh: p.kinh, voice: p.voice, tickets: p.tickets().length,
      })),
    };
  }
  privateState(p) {
    return { id: p.id, uid: p.uid, name: p.name, take: Object.assign({}, p.take), tickets: p.tickets() };
  }
}

class RoomStore {
  constructor() { this.rooms = new Map(); }
  create() {
    for (let i = 0; i < 50; i++) {
      const pin = String(1000 + rnd(9000));
      if (!this.rooms.has(pin)) { const r = new Room(pin); this.rooms.set(pin, r); return r; }
    }
    return null;
  }
  get(pin) { return this.rooms.get(String(pin || '').replace(/\D/g, '')) || null; }
  // Dọn phòng không còn ai trực tuyến quá maxIdleMs.
  sweep(maxIdleMs) {
    const now = Date.now(), gone = [];
    for (const [pin, r] of this.rooms) if (r.emptySince && now - r.emptySince > maxIdleMs) { this.rooms.delete(pin); gone.push(pin); }
    return gone;
  }
}

module.exports = { COLORS, RoomStore, Room, Player, makeTicket, complement, makePair, cleanName };

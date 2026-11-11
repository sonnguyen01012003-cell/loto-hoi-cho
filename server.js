'use strict';
// Máy chủ lô tô: Express phục vụ trang, socket.io đồng bộ phòng, Agora lo kênh thoại.
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { RoomStore } = require('./game');

const PORT = process.env.PORT || 3000;
const AGORA_APP_ID = process.env.AGORA_APP_ID || '';
const AGORA_APP_CERTIFICATE = process.env.AGORA_APP_CERTIFICATE || '';

// Tuỳ chọn: nếu dự án Agora bật App Certificate thì cần gói "agora-token" để cấp token.
let tokenLib = null;
if (AGORA_APP_CERTIFICATE) {
  try { tokenLib = require('agora-token'); }
  catch (e) { console.warn('Có AGORA_APP_CERTIFICATE nhưng chưa cài gói agora-token: chạy "npm install agora-token".'); }
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 20000 });
const store = new RoomStore();
const timers = new Map(); // pin -> interval tự hô

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/config', (req, res) => res.json({ agoraAppId: AGORA_APP_ID }));

function stopAuto(room) {
  const t = timers.get(room.pin);
  if (t) { clearInterval(t); timers.delete(room.pin); }
  room.auto = false;
}
function syncAuto(room) {
  const t = timers.get(room.pin);
  if (t) { clearInterval(t); timers.delete(room.pin); }
  if (!room.auto) return;
  timers.set(room.pin, setInterval(() => {
    const h = room.host();
    if (!room.auto || !h || !h.online) { stopAuto(room); pushState(room); return; }
    const r = room.draw(null);
    if (r.error) { stopAuto(room); pushState(room); return; }
    emitEvents(room, r.events);
    if (!room.auto) stopAuto(room);
    pushState(room);
  }, room.speed * 1000));
}
function pushState(room) { io.to(room.pin).emit('state', room.publicState()); }
function emitEvents(room, events) {
  for (const e of events || []) {
    if (e.chat) io.to(room.pin).emit('chat', e.chat);
    if (e.event) io.to(room.pin).emit('event', e.event);
  }
}

io.on('connection', (socket) => {
  let room = null, me = null;
  const reply = (ack, data) => { if (typeof ack === 'function') ack(data); };
  const sendMe = () => { if (room && me) socket.emit('me', room.privateState(me)); };

  // Chạy một hành động của người chơi, phát kết quả cho cả phòng.
  function act(ack, fn, opts) {
    if (!room || !me) return reply(ack, { error: 'Bạn chưa vào phòng.' });
    if (socket.data.token !== me.token) return reply(ack, { error: 'Phòng này đang mở ở máy khác của bạn.' });
    const r = fn();
    if (r.error !== undefined) return reply(ack, { error: r.error });
    emitEvents(room, r.events);
    if (opts && opts.auto) syncAuto(room);
    if (!room.auto) stopAuto(room);
    if (opts && opts.me) sendMe();
    pushState(room);
    reply(ack, { ok: true });
  }

  function enter(r, token, name, ack) {
    const j = r.join(token, name);
    if (j.error) return reply(ack, { error: j.error });
    // Một người chỉ ở một máy: máy cũ bị thay bằng máy mới.
    for (const s of io.sockets.sockets.values()) {
      if (s !== socket && s.data.token === token && s.data.pin === r.pin) { s.emit('kicked', 'Bạn vừa mở phòng này ở máy khác.'); s.data.token = null; s.leave(r.pin); }
    }
    room = r; me = j.player;
    socket.data.token = token; socket.data.pin = r.pin;
    socket.join(r.pin);
    reply(ack, { ok: true, pin: r.pin });
    socket.emit('chatLog', r.chat);
    sendMe();
    emitEvents(r, j.events);
    pushState(r);
  }

  socket.on('create', (d, ack) => {
    if (room && me && socket.data.token === me.token) return reply(ack, { error: 'Bạn đang ở trong một phòng.' });
    const r = store.create();
    if (!r) return reply(ack, { error: 'Máy chủ đang hết mã phòng. Thử lại sau.' });
    enter(r, d && d.token, d && d.name, (res) => { if (res.error) store.rooms.delete(r.pin); reply(ack, res); });
  });
  socket.on('join', (d, ack) => {
    if (room && me && socket.data.token === me.token) return reply(ack, { error: 'Bạn đang ở trong một phòng.' });
    const r = store.get(d && d.pin);
    if (!r) return reply(ack, { error: 'Không có phòng này. Kiểm tra lại mã PIN với cái.' });
    enter(r, d && d.token, d && d.name, ack);
  });
  socket.on('leave', (d, ack) => {
    if (!room || !me) return reply(ack, { ok: true });
    if (socket.data.token !== me.token) { room = null; me = null; return reply(ack, { ok: true }); }
    const r = room, ev = r.leave(me);
    socket.leave(r.pin); socket.data.token = null;
    room = null; me = null;
    emitEvents(r, ev); if (!r.auto) stopAuto(r); pushState(r);
    reply(ack, { ok: true });
  });

  socket.on('draw', (d, ack) => act(ack, () => room.draw(me)));
  socket.on('auto', (d, ack) => act(ack, () => room.setAuto(me, d && d.on, d && d.speed), { auto: true }));
  socket.on('newRound', (d, ack) => act(ack, () => room.newRound(me)));
  socket.on('claimHost', (d, ack) => act(ack, () => room.claimHost(me)));
  socket.on('quitHost', (d, ack) => act(ack, () => room.quitHost(me)));
  socket.on('setTake', (d, ack) => act(ack, () => room.setTake(me, d && d.color, d && +d.k), { me: true }));
  socket.on('reroll', (d, ack) => act(ack, () => room.reroll(me), { me: true }));
  socket.on('doi', (d, ack) => act(ack, () => room.doi(me)));
  socket.on('kinh', (d, ack) => act(ack, () => room.kinh(me)));
  socket.on('chat', (d, ack) => act(ack, () => room.chatFrom(me, d)));
  socket.on('rename', (d, ack) => act(ack, () => {
    const j = room.join(me.token, d);
    return j.error ? { error: j.error } : { events: j.events };
  }, { me: true }));
  socket.on('voice', (d, ack) => act(ack, () => room.setVoice(me, d)));

  // Token kênh thoại. Chỉ cần khi dự án Agora bật App Certificate.
  socket.on('voiceToken', (d, ack) => {
    if (!room || !me) return reply(ack, { error: 'Bạn chưa vào phòng.' });
    if (!AGORA_APP_ID) return reply(ack, { error: 'Máy chủ chưa cấu hình AGORA_APP_ID.' });
    const channel = 'loto-' + room.pin;
    if (!AGORA_APP_CERTIFICATE) return reply(ack, { appId: AGORA_APP_ID, channel, uid: me.uid, token: null });
    if (!tokenLib) return reply(ack, { error: 'Máy chủ thiếu gói agora-token để cấp token thoại.' });
    try {
      const { RtcTokenBuilder, RtcRole } = tokenLib;
      const token = RtcTokenBuilder.buildTokenWithUid(AGORA_APP_ID, AGORA_APP_CERTIFICATE, channel, me.uid, RtcRole.PUBLISHER, 3600, 3600);
      reply(ack, { appId: AGORA_APP_ID, channel, uid: me.uid, token });
    } catch (e) { reply(ack, { error: 'Không cấp được token thoại: ' + e.message }); }
  });

  socket.on('disconnect', () => {
    if (!room || !me || socket.data.token !== me.token) return;
    const r = room, ev = r.disconnect(me);
    if (r.isHost(me)) stopAuto(r);
    emitEvents(r, ev); pushState(r);
  });
});

// Dọn phòng không còn ai trực tuyến quá 30 phút.
setInterval(() => { for (const pin of store.sweep(30 * 60 * 1000)) { const t = timers.get(pin); if (t) { clearInterval(t); timers.delete(pin); } } }, 60 * 1000);

server.listen(PORT, () => {
  console.log('Lô tô đang chạy: http://localhost:' + PORT);
  console.log(AGORA_APP_ID ? 'Kênh thoại Agora: đã bật.' : 'Kênh thoại Agora: CHƯA bật (thiếu biến môi trường AGORA_APP_ID).');
});

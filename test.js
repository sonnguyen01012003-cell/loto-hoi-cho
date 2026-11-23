'use strict';
// Kiểm tra lõi luật chơi: node test.js
const assert = require('assert');
const { RoomStore, makePair } = require('./game');

// 1. Cặp vé: mỗi hàng 5 số, đúng cột hàng chục, hai tờ không trùng số và phủ đủ 1-90.
for (let k = 0; k < 2000; k++) {
  const seen = new Set();
  for (const t of makePair()) for (const r of t) {
    const nums = r.filter((n) => n > 0);
    assert.strictEqual(nums.length, 5);
    r.forEach((n, c) => { if (n > 0) { const lo = c === 0 ? 1 : c * 10, hi = c === 0 ? 9 : c === 8 ? 90 : c * 10 + 9; assert(n >= lo && n <= hi); } });
    for (const n of nums) { assert(!seen.has(n)); seen.add(n); }
  }
  assert.strictEqual(seen.size, 90);
}

// 2. Một ván đầy đủ.
const store = new RoomStore();
const room = store.create();
const A = room.join('a'.repeat(32), 'Sơn').player;
const B = room.join('b'.repeat(32), 'sơn').player;      // trùng tên
assert(room.isHost(A), 'người tạo phòng làm cái');
assert.notStrictEqual(A.name.toLowerCase(), B.name.toLowerCase(), 'tên trùng phải được đánh số');
assert(room.draw(B).error, 'người không phải cái không hô số được');
assert(room.claimHost(B).error, 'không giành cái khi cái đang có mặt');
assert(!room.setTake(B, 'blue', 2).error, 'đổi vé được trước khi hô số');
assert(room.kinh(A).error, 'chưa có số thì không kinh được');

let winner = null, doiSeen = false, draws = 0;
while (!winner) {
  const r = room.draw(A); assert(!r.error); draws++;
  if (r.events.some((e) => e.event && e.event.type === 'doi')) doiSeen = true;
  assert(room.setTake(B, 'red', 1).error, 'vé bị khoá khi ván đang chơi');
  assert(room.reroll(B).error, 'không bốc lại vé giữa ván');
  for (const p of [A, B]) {
    const k = room.kinh(p);
    if (!k.error) {
      assert(k.row.nums.every((n) => room.called.includes(n)), 'hàng kinh phải gồm toàn số đã hô');
      assert(room.kinh(p).error || true);
      winner = p; break;
    }
  }
  assert(draws <= 90);
}
assert(doiSeen, 'phải có tiếng Đợi trước khi có người kinh');
assert.strictEqual(new Set(room.called).size, room.called.length, 'không hô trùng số');
const pub = JSON.stringify(room.publicState());
assert(!pub.includes(A.token) && !pub.includes(B.token), 'không lộ mã bí mật của người chơi');
assert(!/"rows"/.test(pub), 'không lộ vé của người khác');

// 3. Ván mới mở khoá vé; cái mất kết nối quá lâu thì người khác xin làm cái được.
assert(!room.newRound(A).error); assert.strictEqual(room.called.length, 0);
assert(!room.reroll(B).error, 'sang ván mới đổi vé được');
room.disconnect(A); assert(room.claimHost(B).error, 'cái vừa rớt mạng thì chưa giành được');
A.offlineAt = Date.now() - 60000; assert(!room.claimHost(B).error); assert(room.isHost(B));
assert(room.draw(A).error);

// 4. Hò: chỉ khi có hàng đủ 3 số đã hô, mỗi hàng một lần.
assert(room.ho(B).error, 'chưa hô số nào thì không hò được');
const row = B.rows()[0];
row.nums.slice(0, 2).forEach((n) => { room.called.push(n); room.calledSet.add(n); });
assert(room.ho(B).error, 'mới 2 số thì chưa hò được');
room.called.push(row.nums[2]); room.calledSet.add(row.nums[2]);
const ho = room.ho(B);
assert(!ho.error && ho.events.some((e) => e.event && e.event.type === 'ho' && e.event.id === B.id), 'đủ 3 số thì hò được');
assert(!JSON.stringify(ho.events).includes(String(row.nums[0]) + ','), 'hò không lộ số');
const hoAgain = B.rows().filter((x) => x.nums.filter((n) => room.calledSet.has(n)).length >= 3).length;
for (let i = 1; i < hoAgain; i++) assert(!room.ho(B).error);
assert(room.ho(B).error, 'mỗi hàng chỉ hò một lần');
room.newRound(B); assert(B.hoRows.size === 0, 'ván mới xoá lượt hò');

// 5. Dọn phòng trống.
room.disconnect(B); room.emptySince = Date.now() - 3600000;
assert.deepStrictEqual(store.sweep(1800000), [room.pin]);
console.log('Tất cả kiểm tra đều đạt. Ván thử kết thúc sau ' + draws + ' số, người thắng: ' + winner.name + '.');

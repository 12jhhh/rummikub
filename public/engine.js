/*
 * 拉密 Rummikub · 规则引擎（浏览器 + Node 共用）
 * 纯函数式状态机，无 DOM 依赖。服务端用它做权威校验，客户端用它做即时反馈。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.RummiEngine = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var COLORS = ["red", "blue", "yellow", "black"];
  var CN = { red: "红", blue: "蓝", yellow: "黄", black: "黑", joker: "百搭" };

  function isJoker(t) { return t.c === "joker"; }
  function points(t) { return isJoker(t) ? 30 : t.n; }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  /* ---------------- 牌堆 ---------------- */
  function buildDeck(salt, counter) {
    var d = [];
    for (var ci = 0; ci < COLORS.length; ci++) {
      var c = COLORS[ci];
      for (var n = 1; n <= 13; n++) {
        d.push({ id: "t" + salt + "_" + (++counter.v), c: c, n: n });
        d.push({ id: "t" + salt + "_" + (++counter.v), c: c, n: n });
      }
    }
    d.push({ id: "t" + salt + "_" + (++counter.v), c: "joker", n: 0 });
    d.push({ id: "t" + salt + "_" + (++counter.v), c: "joker", n: 0 });
    return d;
  }

  function shuffle(a) {
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = a[i]; a[i] = a[j]; a[j] = tmp;
    }
    return a;
  }

  /* ---------------- 牌组判定 ---------------- */
  function tryRun(tiles) {
    var n = tiles.length;
    if (n > 13) return null;
    var reals = [];
    for (var r = 0; r < n; r++) if (!isJoker(tiles[r])) reals.push(tiles[r]);
    if (!reals.length) return null;
    var col = reals[0].c;
    for (var i = 0; i < reals.length; i++) if (reals[i].c !== col) return null;
    for (var s = 1; s + n - 1 <= 13; s++) {
      var ok = true, rep = [];
      for (var k = 0; k < n; k++) {
        if (!isJoker(tiles[k]) && tiles[k].n !== s + k) { ok = false; break; }
        rep.push(s + k);
      }
      if (ok) {
        var sum = 0;
        for (var q = 0; q < rep.length; q++) sum += rep[q];
        return { ok: true, type: "run", start: s, end: s + n - 1, sum: sum, rep: rep, color: col };
      }
    }
    return null;
  }

  function tryGroup(tiles) {
    var n = tiles.length;
    if (n < 3 || n > 4) return null;
    var reals = [];
    for (var i = 0; i < n; i++) if (!isJoker(tiles[i])) reals.push(tiles[i]);
    if (!reals.length) return null;
    var num = reals[0].n, seen = {};
    for (var k = 0; k < reals.length; k++) {
      if (reals[k].n !== num) return null;
      if (seen[reals[k].c]) return null;
      seen[reals[k].c] = true;
    }
    var rep = [];
    for (var j = 0; j < n; j++) rep.push(num);
    return { ok: true, type: "group", num: num, sum: num * n, rep: rep, count: n };
  }

  function explainSet(tiles) {
    var jokers = 0, reals = [];
    for (var i = 0; i < tiles.length; i++) {
      if (isJoker(tiles[i])) jokers++;
      else reals.push(tiles[i]);
    }
    if (reals.length === 0) return "不能全部是百搭牌";
    if (reals.length === 1) return "牌组不成立，请再补充牌";
    var sameColor = true, sameNum = true;
    for (var a = 1; a < reals.length; a++) {
      if (reals[a].c !== reals[0].c) sameColor = false;
      if (reals[a].n !== reals[0].n) sameNum = false;
    }
    if (sameColor && sameNum) return "同色同数字不能组成牌组";
    if (sameColor) {
      var nums = {}, dup = false;
      for (var b = 0; b < reals.length; b++) {
        if (nums[reals[b].n]) dup = true;
        nums[reals[b].n] = true;
      }
      if (dup) return "顺组里数字不能重复";
      if (jokers > 0) return "百搭所在位置无法让顺组连续";
      return "顺组必须同色且数字连续，13 不能接 1";
    }
    if (sameNum) {
      var cs = {};
      for (var c = 0; c < reals.length; c++) {
        if (cs[reals[c].c]) return "群组里颜色不能重复";
        cs[reals[c].c] = true;
      }
      return "群组最多 4 张（四种颜色各一张）";
    }
    return "既不是同色顺组，也不是同数字群组";
  }

  function analyzeSet(tiles) {
    var n = tiles.length;
    if (n === 0) return { ok: false, reason: "空牌组" };
    if (n < 3) return { ok: false, reason: "只有 " + n + " 张，至少需要 3 张" };
    var jokers = 0;
    for (var i = 0; i < n; i++) if (isJoker(tiles[i])) jokers++;
    if (jokers > 2) return { ok: false, reason: "百搭牌最多 2 张" };
    var run = tryRun(tiles);
    if (run) return run;
    var grp = tryGroup(tiles);
    if (grp) return grp;
    return { ok: false, reason: explainSet(tiles) };
  }

  /* ---------------- 状态 ---------------- */
  function emptyState() {
    return {
      deck: [], racks: [[], []], board: [],
      melded: [false, false], cur: 0, locked: {},
      turnStart: null, setSeq: 0, seq: 0,
      gameOver: false, winner: null, reason: "", scores: null
    };
  }

  function createState() {
    var st = emptyState();
    var counter = { v: 0 };
    var salt = Math.random().toString(36).slice(2, 7);
    var deck = shuffle(buildDeck(salt, counter));
    for (var i = 0; i < 14; i++) {
      st.racks[0].push(deck.pop());
      st.racks[1].push(deck.pop());
    }
    st.deck = deck;
    startTurn(st);
    return st;
  }

  function snapshot(st) {
    return {
      board: st.board.map(function (b) { return { id: b.id, tiles: b.tiles.slice() }; }),
      racks: [st.racks[0].slice(), st.racks[1].slice()],
      deck: st.deck.slice(),
      melded: [st.melded[0], st.melded[1]],
      locked: Object.assign({}, st.locked),
      cur: st.cur
    };
  }

  function startTurn(st) {
    var ids = {};
    for (var b = 0; b < st.board.length; b++) {
      for (var i = 0; i < st.board[b].tiles.length; i++) {
        ids[st.board[b].tiles[i].id] = true;
      }
    }
    st.locked = ids;
    st.turnStart = snapshot(st);
    st.seq++;
  }

  function restoreTurnStart(st) {
    var sn = st.turnStart;
    if (!sn) return false;
    st.board = sn.board.map(function (b) { return { id: b.id, tiles: b.tiles.slice() }; });
    st.racks = [sn.racks[0].slice(), sn.racks[1].slice()];
    st.deck = sn.deck.slice();
    st.melded = [sn.melded[0], sn.melded[1]];
    st.locked = Object.assign({}, sn.locked);
    st.cur = sn.cur;
    return true;
  }

  /* ---------------- 查询 ---------------- */
  function findSet(st, setId) {
    for (var i = 0; i < st.board.length; i++) if (st.board[i].id === setId) return st.board[i];
    return null;
  }

  function findLoc(st, seat, tileId) {
    var rack = st.racks[seat] || [];
    for (var i = 0; i < rack.length; i++) {
      if (rack[i].id === tileId) return { zone: "rack", tile: rack[i], idx: i, set: null };
    }
    for (var b = 0; b < st.board.length; b++) {
      var ts = st.board[b].tiles;
      for (var k = 0; k < ts.length; k++) {
        if (ts[k].id === tileId) return { zone: "board", tile: ts[k], idx: k, set: st.board[b] };
      }
    }
    return null;
  }

  function isFrozen(st, seat, set) {
    if (st.melded[seat]) return false;
    for (var i = 0; i < set.tiles.length; i++) if (st.locked[set.tiles[i].id]) return true;
    return false;
  }

  function freshCount(st) {
    var n = 0;
    for (var b = 0; b < st.board.length; b++) {
      for (var i = 0; i < st.board[b].tiles.length; i++) {
        if (!st.locked[st.board[b].tiles[i].id]) n++;
      }
    }
    return n;
  }

  function meldSum(st) {
    var sum = 0;
    for (var b = 0; b < st.board.length; b++) {
      var ts = st.board[b].tiles, hasLocked = false;
      for (var i = 0; i < ts.length; i++) if (st.locked[ts[i].id]) { hasLocked = true; break; }
      if (hasLocked) continue;
      var a = analyzeSet(ts);
      if (a.ok) sum += a.sum;
    }
    return sum;
  }

  function scoreOf(rack) {
    var s = 0;
    for (var i = 0; i < rack.length; i++) s += points(rack[i]);
    return s;
  }

  function pruneEmpty(st) {
    st.board = st.board.filter(function (b) { return b.tiles.length > 0; });
  }

  function tidySet(set) {
    var ts = set.tiles;
    if (!ts.length) return;
    for (var i = 0; i < ts.length; i++) if (isJoker(ts[i])) return;
    var sameColor = true, sameNum = true;
    for (var a = 1; a < ts.length; a++) {
      if (ts[a].c !== ts[0].c) sameColor = false;
      if (ts[a].n !== ts[0].n) sameNum = false;
    }
    if (sameColor) {
      var nums = ts.map(function (t) { return t.n; }).sort(function (x, y) { return x - y; });
      var uniq = true;
      for (var u = 1; u < nums.length; u++) if (nums[u] === nums[u - 1]) uniq = false;
      if (uniq && nums[nums.length - 1] - nums[0] === nums.length - 1) {
        var map = {};
        for (var m = 0; m < ts.length; m++) map[ts[m].n] = ts[m];
        set.tiles = nums.map(function (n) { return map[n]; });
        return;
      }
    }
    if (sameNum) {
      var seen = {}, okColors = true;
      for (var b = 0; b < ts.length; b++) {
        if (seen[ts[b].c]) okColors = false;
        seen[ts[b].c] = true;
      }
      if (okColors) {
        set.tiles = ts.slice().sort(function (x, y) {
          return COLORS.indexOf(x.c) - COLORS.indexOf(y.c);
        });
      }
    }
  }

  /* ---------------- 操作 ---------------- */
  function applyMove(st, seat, tileId, target) {
    if (!st) return { ok: false, error: "对局不存在" };
    if (st.gameOver) return { ok: false, error: "对局已结束" };
    if (st.cur !== seat) return { ok: false, error: "还没轮到你出牌" };
    if (!target) return { ok: false, error: "缺少落点" };

    var loc = findLoc(st, seat, tileId);
    if (!loc) return { ok: false, error: "这张牌不在你的牌架或桌面上" };
    if (loc.zone === "board" && isFrozen(st, seat, loc.set)) {
      return { ok: false, error: "破冰前不能使用或重排桌面已有的牌组" };
    }

    var set = null;
    if (target.type === "set") {
      set = findSet(st, target.setId);
      if (!set) return { ok: false, error: "目标牌组不存在" };
      if (isFrozen(st, seat, set)) return { ok: false, error: "破冰前不能使用桌面已有的牌组" };
    }
    var sameSet = !!(set && loc.zone === "board" && loc.set.id === set.id);
    var srcIdx = loc.idx;
    if (target.type === "rack") {
      if (loc.zone === "rack") return { ok: false, error: "这张牌已经在牌架上了" };
      if (st.locked[tileId]) return { ok: false, error: "已出到桌面的牌不能收回牌架" };
    }
    if (target.type !== "set" && target.type !== "rack" && target.type !== "new") {
      return { ok: false, error: "未知落点" };
    }

    if (loc.zone === "rack") {
      st.racks[seat] = st.racks[seat].filter(function (t) { return t.id !== tileId; });
    } else {
      loc.set.tiles.splice(loc.idx, 1);
    }

    if (target.type === "set") {
      var idx = parseInt(target.index, 10);
      if (isNaN(idx) || idx < 0) idx = 0;
      if (sameSet && idx > srcIdx) idx--;
      if (idx > set.tiles.length) idx = set.tiles.length;
      set.tiles.splice(idx, 0, loc.tile);
      tidySet(set);
    } else if (target.type === "rack") {
      st.racks[seat].push(loc.tile);
    } else {
      st.setSeq++;
      st.board.push({ id: "s" + st.setSeq, tiles: [loc.tile] });
    }
    pruneEmpty(st);
    st.seq++;
    return { ok: true };
  }

  function validateTurn(st, seat) {
    var issues = [];
    if (!st) return { ok: false, issues: ["对局不存在"] };
    if (st.cur !== seat) return { ok: false, issues: ["还没轮到你出牌"] };
    pruneEmpty(st);

    for (var i = 0; i < st.board.length; i++) {
      var a = analyzeSet(st.board[i].tiles);
      if (!a.ok) issues.push("第 " + (i + 1) + " 个牌组不合法：" + a.reason);
    }

    var fresh = freshCount(st);
    if (st.melded[seat]) {
      if (fresh === 0) issues.push("本回合至少要打出 1 张自己牌架上的牌（纯重排不算完成出牌）");
    } else {
      var sum = meldSum(st);
      if (fresh === 0) issues.push("破冰回合：需要用自己的牌组成至少一个牌组");
      else if (sum < 30) issues.push("破冰未达成：当前牌面合计 " + sum + " 分，需要 ≥ 30 分");
    }
    return { ok: issues.length === 0, issues: issues, sum: meldSum(st) };
  }

  function commitTurn(st, seat) {
    var v = validateTurn(st, seat);
    if (!v.ok) return v;
    st.melded[seat] = true;
    st.scores = [scoreOf(st.racks[0]), scoreOf(st.racks[1])];
    if (st.racks[seat].length === 0) {
      st.gameOver = true;
      st.winner = seat;
      st.reason = "rack";
      st.seq++;
      return { ok: true, win: true };
    }
    st.cur = 1 - seat;
    startTurn(st);
    return { ok: true, win: false };
  }

  function undoTurn(st, seat) {
    if (!st) return { ok: false, error: "对局不存在" };
    if (st.gameOver) return { ok: false, error: "对局已结束" };
    if (st.cur !== seat) return { ok: false, error: "还没轮到你出牌" };
    if (!st.turnStart) return { ok: false, error: "没有可撤销的状态" };
    restoreTurnStart(st);
    st.seq++;
    return { ok: true };
  }

  function settle(st) {
    st.scores = [scoreOf(st.racks[0]), scoreOf(st.racks[1])];
    st.gameOver = true;
    st.reason = "deck";
    if (st.scores[0] === st.scores[1]) st.winner = -1;
    else st.winner = st.scores[0] < st.scores[1] ? 0 : 1;
    st.seq++;
    return { ok: true, ended: true };
  }

  function drawTile(st, seat) {
    if (!st) return { ok: false, error: "对局不存在" };
    if (st.gameOver) return { ok: false, error: "对局已结束" };
    if (st.cur !== seat) return { ok: false, error: "还没轮到你出牌" };
    if (freshCount(st) > 0) {
      return { ok: false, error: "桌面上还有本回合打出的牌，请先确认或撤销" };
    }
    if (!st.deck.length) {
      return settle(st);
    }
    var t = st.deck.pop();
    st.racks[seat].push(t);
    st.cur = 1 - seat;
    startTurn(st);
    return { ok: true, tile: t };
  }

  return {
    COLORS: COLORS, CN: CN,
    isJoker: isJoker, points: points, clone: clone,
    buildDeck: buildDeck, shuffle: shuffle,
    analyzeSet: analyzeSet, tryRun: tryRun, tryGroup: tryGroup,
    createState: createState, snapshot: snapshot, startTurn: startTurn,
    restoreTurnStart: restoreTurnStart,
    findSet: findSet, findLoc: findLoc, isFrozen: isFrozen,
    freshCount: freshCount, meldSum: meldSum, scoreOf: scoreOf,
    applyMove: applyMove, validateTurn: validateTurn, commitTurn: commitTurn,
    undoTurn: undoTurn, drawTile: drawTile, settle: settle, tidySet: tidySet
  };
});

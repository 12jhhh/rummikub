#!/usr/bin/env node
/*
 * 拉密 Rummikub · 线上对战服务端
 * 零依赖：只用 Node 内置模块。规则判定全部在服务端执行（权威状态），
 * 客户端只拿到「公共桌面 + 自己的手牌」，对手手牌永不下发。
 *
 * 启动：node server.js            （默认仅本机 http://127.0.0.1:3000）
 *      PORT=8080 node server.js
 *      HOST=0.0.0.0 node server.js （需要局域网访问时才显式开启）
 *
 * 注意：请勿把本地端口通过 cloudflared / ngrok 等隧道暴露到公网。
 *       如需公网访问，请部署到公司 with 平台并接入太湖身份鉴权。
 */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const E = require("./public/engine.js");

const PORT = Number(process.env.PORT || 3000);
/* 安全默认：只监听本机回环地址，不对外暴露端口 */
const HOST = process.env.HOST || "127.0.0.1";
const LAN_OPEN = HOST === "0.0.0.0" || HOST === "::";
const ROOT = path.join(__dirname, "public");
const MAX_ROOM_AGE = 6 * 60 * 60 * 1000; // 6 小时无人活动自动回收

const rooms = new Map();

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */
function token() {
  return crypto.randomBytes(18).toString("hex");
}

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function newCode() {
  let c = "";
  for (let i = 0; i < 4; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return rooms.has(c) ? newCode() : c;
}

function cleanName(name, fallback) {
  let s = String(name == null ? "" : name).replace(/[\u0000-\u001f<>]/g, "").trim();
  if (!s) s = fallback;
  return s.slice(0, 12);
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function readBody(req, cb) {
  let raw = "", size = 0, done = false;
  req.on("data", (chunk) => {
    if (done) return;
    size += chunk.length;
    if (size > 128 * 1024) {
      done = true;
      cb(new Error("请求体过大"));
      req.destroy();
      return;
    }
    raw += chunk;
  });
  req.on("end", () => {
    if (done) return;
    done = true;
    if (!raw) return cb(null, {});
    try { cb(null, JSON.parse(raw)); }
    catch (e) { cb(new Error("请求格式错误")); }
  });
}

/* ------------------------------------------------------------------ */
/* 房间                                                               */
/* ------------------------------------------------------------------ */
function createRoom(name) {
  const code = newCode();
  const t = token();
  const room = {
    code,
    seats: [t, null],
    tokens: Object.create(null),
    names: [cleanName(name, "玩家 1"), "等待加入"],
    started: false,
    state: null,
    clients: new Set(),
    version: 1,
    rematch: [false, false],
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  room.tokens[t] = 0;
  rooms.set(code, room);
  return { room, token: t, seat: 0 };
}

function findSeat(room, token) {
  if (!token) return -1;
  const seat = room.tokens[token];
  return seat === undefined ? -1 : seat;
}

function connectedSeats(room) {
  const out = [false, false];
  for (const c of room.clients) if (c.seat === 0 || c.seat === 1) out[c.seat] = true;
  return out;
}

/* 每个座位只能看到自己的手牌 */
function view(room, seat) {
  const st = room.state;
  const v = {
    room: room.code,
    seat: seat,
    names: room.names,
    seats: [!!room.seats[0], !!room.seats[1]],
    connected: connectedSeats(room),
    started: room.started,
    version: room.version,
    rematch: room.rematch.slice(),
    board: [],
    deckCount: 0,
    melded: [false, false],
    cur: 0,
    locked: {},
    rackCounts: [0, 0],
    myRack: [],
    gameOver: false,
    winner: null,
    reason: "",
    scores: null
  };
  if (st) {
    v.board = st.board;
    v.deckCount = st.deck.length;
    v.melded = st.melded;
    v.cur = st.cur;
    v.locked = st.locked;
    v.rackCounts = [st.racks[0].length, st.racks[1].length];
    v.myRack = seat >= 0 ? st.racks[seat] : [];
    v.gameOver = st.gameOver;
    v.winner = st.winner;
    v.reason = st.reason;
    v.scores = st.scores;
  }
  return v;
}

function writeEvent(res, event, data) {
  res.write("event: " + event + "\n" + "data: " + JSON.stringify(data) + "\n\n");
}

function broadcast(room) {
  room.updatedAt = Date.now();
  room.version++;
  const dead = [];
  for (const c of room.clients) {
    try {
      writeEvent(c.res, "view", view(room, c.seat));
    } catch (err) {
      dead.push(c);
    }
  }
  for (const c of dead) room.clients.delete(c);
}

/* ------------------------------------------------------------------ */
/* 动作                                                               */
/* ------------------------------------------------------------------ */
function handleAction(room, seat, body) {
  if (seat < 0) return { ok: false, error: "你不是这个房间的玩家" };
  const type = body.type;

  if (type === "rematch") {
    if (!room.started) return { ok: false, error: "对局还没开始" };
    if (!room.state || !room.state.gameOver) return { ok: false, error: "对局还没有结束" };
    room.rematch[seat] = true;
    if (room.rematch[0] && room.rematch[1]) {
      room.state = E.createState();
      room.rematch = [false, false];
      room.started = true;
      return { ok: true, restarted: true };
    }
    return { ok: true, waiting: true };
  }

  if (!room.started || !room.state) return { ok: false, error: "对局还没开始" };
  const st = room.state;

  switch (type) {
    case "move":
      return E.applyMove(st, seat, String(body.tileId || ""), body.target || null);
    case "confirm":
      return E.commitTurn(st, seat);
    case "undo":
      return E.undoTurn(st, seat);
    case "draw":
      return E.drawTile(st, seat);
    default:
      return { ok: false, error: "未知操作" };
  }
}

/* ------------------------------------------------------------------ */
/* HTTP                                                               */
/* ------------------------------------------------------------------ */
const STATIC = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/engine.js": { file: "engine.js", type: "application/javascript; charset=utf-8" }
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const pathname = url.pathname;

  if (req.method === "GET" && STATIC[pathname]) {
    const item = STATIC[pathname];
    fs.readFile(path.join(ROOT, item.file), (err, buf) => {
      if (err) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("读取 " + item.file + " 失败");
        return;
      }
      res.writeHead(200, {
        "Content-Type": item.type,
        "Cache-Control": "no-cache",
        "Content-Length": buf.length
      });
      res.end(buf);
    });
    return;
  }

  if (pathname === "/favicon.ico") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (pathname === "/api/health") {
    json(res, 200, { ok: true, rooms: rooms.size, uptime: process.uptime() });
    return;
  }

  /* ---- SSE ---- */
  if (req.method === "GET" && pathname === "/api/events") {
    const code = String(url.searchParams.get("room") || "").toUpperCase();
    const tok = String(url.searchParams.get("token") || "");
    const room = rooms.get(code);
    if (!room) return json(res, 404, { error: "房间不存在" });
    const seat = findSeat(room, tok);
    if (seat < 0) return json(res, 403, { error: "身份校验失败" });

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no"
    });
    if (res.socket) res.socket.setTimeout(0);
    res.setTimeout(0);
    res.write(": connected\n\n");

    const client = { seat, res };
    room.clients.add(client);
    room.updatedAt = Date.now();
    try { writeEvent(res, "view", view(room, seat)); } catch (e) { /* ignore */ }

    /* 通知对手「我上线了」 */
    const others = Array.from(room.clients).filter((c) => c !== client);
    for (const c of others) {
      try { writeEvent(c.res, "view", view(room, c.seat)); } catch (e) { /* ignore */ }
    }

    req.on("close", () => {
      room.clients.delete(client);
      room.updatedAt = Date.now();
      for (const c of room.clients) {
        try { writeEvent(c.res, "view", view(room, c.seat)); } catch (e) { /* ignore */ }
      }
    });
    return;
  }

  /* ---- API ---- */
  if (req.method === "POST" && pathname.startsWith("/api/")) {
    readBody(req, (err, body) => {
      if (err) return json(res, 400, { ok: false, error: err.message });
      body = body || {};
      const name = cleanName(body.name, "玩家");

      if (pathname === "/api/create") {
        const r = createRoom(name);
        return json(res, 200, { ok: true, room: r.room.code, token: r.token, seat: r.seat, name });
      }

      if (pathname === "/api/join") {
        const code = String(body.room || "").toUpperCase().trim();
        const room = rooms.get(code);
        if (!room) return json(res, 404, { ok: false, error: "房间不存在，请核对房号" });

        const existing = findSeat(room, body.token);
        if (existing >= 0) {
          if (name) room.names[existing] = name;
          room.updatedAt = Date.now();
          broadcast(room);
          return json(res, 200, { ok: true, room: code, token: body.token, seat: existing, name: room.names[existing] });
        }

        let seat = -1;
        if (!room.seats[0]) seat = 0;
        else if (!room.seats[1]) seat = 1;
        if (seat < 0) return json(res, 409, { ok: false, error: "房间已满（2 人）" });

        const tok = token();
        room.seats[seat] = tok;
        room.tokens[tok] = seat;
        room.names[seat] = name;
        room.updatedAt = Date.now();
        broadcast(room);
        return json(res, 200, { ok: true, room: code, token: tok, seat, name });
      }

      const code = String(body.room || "").toUpperCase();
      const room = rooms.get(code);
      if (!room) return json(res, 404, { ok: false, error: "房间不存在" });
      const seat = findSeat(room, body.token);
      if (seat < 0) return json(res, 403, { ok: false, error: "身份校验失败，请重新加入房间" });

      if (pathname === "/api/start") {
        if (room.started) {
          return json(res, 409, { ok: false, error: "对局已经开始了" });
        }
        if (!room.seats[0] || !room.seats[1]) {
          return json(res, 409, { ok: false, error: "需要两位玩家都进入房间后才能开始" });
        }
        room.state = E.createState();
        room.started = true;
        room.rematch = [false, false];
        broadcast(room);
        return json(res, 200, { ok: true, view: view(room, seat) });
      }

      if (pathname === "/api/action") {
        let result;
        try {
          result = handleAction(room, seat, body);
        } catch (e) {
          console.error("[action]", e);
          return json(res, 500, { ok: false, error: "服务端处理失败" });
        }
        if (result && result.ok) broadcast(room);
        return json(res, 200, Object.assign({}, result, { view: view(room, seat) }));
      }

      return json(res, 404, { ok: false, error: "接口不存在" });
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not Found");
});

/* 心跳，避免代理断开空闲 SSE */
setInterval(() => {
  for (const room of rooms.values()) {
    for (const c of room.clients) {
      try { c.res.write(": ping\n\n"); }
      catch (e) { room.clients.delete(c); }
    }
  }
}, 20000).unref();

/* 回收长时间无活动的房间 */
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.updatedAt > MAX_ROOM_AGE && room.clients.size === 0) rooms.delete(code);
  }
}, 10 * 60 * 1000).unref();

server.keepAliveTimeout = 76000;
server.headersTimeout = 80000;

server.on("error", (err) => {
  if (err && err.code === "EADDRINUSE") {
    console.error("");
    console.error("  [X] 端口 " + PORT + " 已被占用。");
    console.error("      关掉占用它的程序，或改用别的端口：");
    console.error("      Windows:  set PORT=3001 && node server.js");
    console.error("");
  } else {
    console.error(err);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const nets = os.networkInterfaces();
  const lan = [];
  for (const key of Object.keys(nets)) {
    for (const ni of nets[key] || []) {
      if (ni.family === "IPv4" && !ni.internal) lan.push(ni.address);
    }
  }
  const local = "http://localhost:" + PORT;
  const out = [
    "",
    "  ==============================================",
    "    拉密 · 线上对战  已启动",
    "  ==============================================",
    "",
    "    打开:        " + local
  ];
  if (LAN_OPEN) {
    for (const ip of lan) out.push("    局域网访问:  http://" + ip + ":" + PORT);
  } else {
    out.push("    监听范围:    仅本机（安全默认）");
    out.push("    需要局域网:  HOST=0.0.0.0 node server.js");
  }
  out.push("");
  out.push("    玩法: 创建房间 -> 把 4 位房号发给朋友 -> 对方加入 -> 开始对局");
  out.push("");
  out.push("    关闭这个窗口 = 停止服务");
  out.push("    请勿用 cloudflared / ngrok 等隧道把端口暴露到公网；");
  out.push("    公网访问请部署到公司 with 平台并接入太湖身份鉴权。");
  out.push("");
  console.log(out.join("\n"));

  /* 双击 bat 时自动打开浏览器；被管道调用（测试）时不打开 */
  if (process.stdout.isTTY && !process.env.RUMMI_NO_OPEN && process.argv.indexOf("--no-open") < 0) {
    const cmd = process.platform === "win32"
      ? 'start "" "' + local + '"'
      : (process.platform === "darwin" ? 'open "' + local + '"' : 'xdg-open "' + local + '"');
    require("child_process").exec(cmd, () => {});
  }
});

process.on("SIGINT", () => {
  console.log("\n已停止");
  process.exit(0);
});

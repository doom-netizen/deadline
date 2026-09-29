// DEADLINE multiplayer relay server
// Handles: public matchmaking queue, private room codes, relaying player state,
// host-authoritative shared match state (bots/bomb/timer), lightweight
// server-side anti-cheat (speed cap, fire-rate cap, damage cap), AND a small
// real account system (signup/login/password reset/admin tools) backed by a
// JSON file on disk.
const { WebSocketServer } = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
const MAX_PLAYERS = 10; // per match (adjust as you like)
const ADMIN_KEY = process.env.ADMIN_KEY || ''; // set this in your host's env vars; admin routes refuse to work without it

// Real weapon stats mirrored from the client, used only to sanity-check claims.
const WEAPONS = {
  PISTOL:   { dmg: 25, rate: 0.35 },
  SMG:      { dmg: 12, rate: 0.08 },
  RIFLE:    { dmg: 30, rate: 0.14 },
  BREACHER: { dmg: 9,  rate: 0.18 },
};
const MAX_DMG = Math.max(...Object.values(WEAPONS).map(w => w.dmg)) + 5; // small buffer
const MAX_SPEED = 170; // px/sec a legit client can move (135 normal + buffer); staff "fast" toggle will get rejected here, by design
const MATCH_TICK_MIN_INTERVAL = 0.07; // seconds, throttle host ticks server-side too

// ---------------------------------------------------------------------------
// Accounts: persisted to accounts.json next to this file. NOTE: on hosts with
// an ephemeral filesystem (e.g. a free Render web service with no attached
// persistent disk), this file is wiped on every new deploy - it survives
// ordinary restarts/sleep, but not a redeploy. Attach a persistent disk (or
// swap this for a real database) if you need accounts to survive redeploys.
// ---------------------------------------------------------------------------
const ACCOUNTS_FILE = path.join(__dirname, 'accounts.json');
let accounts = {}; // username -> { pwHash, salt, key, rp, cr, codes, inv, staff, createdAt }

function loadAccounts() {
  try {
    accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
  } catch (e) {
    accounts = {};
  }
}
let saveTimer = null;
function saveAccounts() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(ACCOUNTS_FILE, JSON.stringify(accounts), (err) => {
      if (err) console.error('Failed to save accounts.json:', err.message);
    });
  }, 150); // debounce bursts of writes
}
loadAccounts();

function randKey(n = 12) {
  return Array.from(crypto.randomBytes(n), b => b % 10).join('');
}
function hashPw(pw, salt) {
  return crypto.scryptSync(String(pw), salt, 64).toString('hex');
}
function makeSalt() {
  return crypto.randomBytes(16).toString('hex');
}
function publicAccount(u, a) {
  // never send pwHash/salt back to a client
  return { u, key: a.key, rp: a.rp, cr: a.cr, codes: a.codes, inv: a.inv, staff: !!a.staff };
}
function findByKey(k) {
  for (const u in accounts) if (accounts[u].key === k) return u;
  return null;
}

// -- HTTP server: health check + JSON account API + WS upgrade target --
function readBody(req, cb) {
  let data = '';
  req.on('data', c => { data += c; if (data.length > 1e6) req.destroy(); });
  req.on('end', () => {
    if (!data) return cb({});
    try { cb(JSON.parse(data)); } catch { cb(null); }
  });
}
function json(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(obj));
}

const httpServer = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') return json(res, 204, {});

  if (url.pathname === '/' ) {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('DEADLINE server is running.\n');
  }

  if (req.method === 'POST' && url.pathname === '/signup') {
    return readBody(req, body => {
      if (!body) return json(res, 400, { ok: false, error: 'bad json' });
      const u = String(body.u || '').trim().toLowerCase();
      const p = String(body.p || '');
      if (!/^[a-z0-9_]{3,16}$/.test(u)) return json(res, 400, { ok: false, error: 'Username: 3-16 letters/numbers' });
      if (p.length < 4) return json(res, 400, { ok: false, error: 'Password: 4+ characters' });
      if (accounts[u]) return json(res, 409, { ok: false, error: 'Username taken' });
      const salt = makeSalt();
      accounts[u] = { pwHash: hashPw(p, salt), salt, key: randKey(), rp: 0, cr: 0, codes: [], inv: null, staff: false, createdAt: Date.now() };
      saveAccounts();
      json(res, 200, { ok: true, account: publicAccount(u, accounts[u]) });
    });
  }

  if (req.method === 'POST' && url.pathname === '/login') {
    return readBody(req, body => {
      if (!body) return json(res, 400, { ok: false, error: 'bad json' });
      let u = String(body.u || '').trim().toLowerCase();
      const p = body.p, k = body.k;
      if (!u && k) u = findByKey(k);
      const a = u && accounts[u];
      if (!a) return json(res, 401, { ok: false, error: 'Invalid login' });
      if (k) { if (a.key !== k) return json(res, 401, { ok: false, error: 'Invalid login' }); }
      else { if (hashPw(p, a.salt) !== a.pwHash) return json(res, 401, { ok: false, error: 'Invalid login' }); }
      json(res, 200, { ok: true, account: publicAccount(u, a) });
    });
  }

  if (req.method === 'POST' && url.pathname === '/save') {
    // sync gameplay progress (rank points/credits/codes/inventory) for a logged-in player
    return readBody(req, body => {
      if (!body) return json(res, 400, { ok: false, error: 'bad json' });
      const u = String(body.u || '').trim().toLowerCase();
      const a = accounts[u];
      if (!a || a.key !== body.k) return json(res, 401, { ok: false, error: 'Invalid login' });
      const d = body.data || {};
      if (typeof d.rp === 'number') a.rp = d.rp;
      if (typeof d.cr === 'number') a.cr = d.cr;
      if (Array.isArray(d.codes)) a.codes = d.codes;
      if (d.inv) a.inv = d.inv;
      saveAccounts();
      json(res, 200, { ok: true });
    });
  }

  if (req.method === 'POST' && url.pathname === '/change-password') {
    return readBody(req, body => {
      if (!body) return json(res, 400, { ok: false, error: 'bad json' });
      const u = String(body.u || '').trim().toLowerCase();
      const a = accounts[u];
      if (!a) return json(res, 401, { ok: false, error: 'Invalid login' });
      if (hashPw(body.p, a.salt) !== a.pwHash) return json(res, 401, { ok: false, error: 'Wrong current password' });
      const newP = String(body.newP || '');
      if (newP.length < 4) return json(res, 400, { ok: false, error: 'Password: 4+ characters' });
      a.salt = makeSalt();
      a.pwHash = hashPw(newP, a.salt);
      a.key = randKey(); // rotate the access key too, so a leaked old key stops working
      saveAccounts();
      json(res, 200, { ok: true, key: a.key });
    });
  }

  if (req.method === 'POST' && url.pathname === '/regenerate-key') {
    return readBody(req, body => {
      if (!body) return json(res, 400, { ok: false, error: 'bad json' });
      const u = String(body.u || '').trim().toLowerCase();
      const a = accounts[u];
      if (!a) return json(res, 401, { ok: false, error: 'Invalid login' });
      if (hashPw(body.p, a.salt) !== a.pwHash) return json(res, 401, { ok: false, error: 'Wrong password' });
      a.key = randKey();
      saveAccounts();
      json(res, 200, { ok: true, key: a.key });
    });
  }

  if (req.method === 'POST' && url.pathname === '/admin-reset-password') {
    return readBody(req, body => {
      if (!body) return json(res, 400, { ok: false, error: 'bad json' });
      if (!ADMIN_KEY || body.adminKey !== ADMIN_KEY) return json(res, 403, { ok: false, error: 'Invalid admin key' });
      const u = String(body.u || '').trim().toLowerCase();
      const a = accounts[u];
      if (!a) return json(res, 404, { ok: false, error: 'No such account' });
      const newP = String(body.newP || '');
      if (newP.length < 4) return json(res, 400, { ok: false, error: 'Password: 4+ characters' });
      a.salt = makeSalt();
      a.pwHash = hashPw(newP, a.salt);
      a.key = randKey(); // also locks out anyone using the old (possibly leaked) key
      saveAccounts();
      json(res, 200, { ok: true, key: a.key });
    });
  }

  if (req.method === 'GET' && url.pathname === '/admin-list') {
    const adminKey = url.searchParams.get('adminKey');
    if (!ADMIN_KEY || adminKey !== ADMIN_KEY) return json(res, 403, { ok: false, error: 'Invalid admin key' });
    const list = Object.keys(accounts).sort().map(u => ({
      u, rp: accounts[u].rp, cr: accounts[u].cr, staff: !!accounts[u].staff, createdAt: accounts[u].createdAt,
    }));
    return json(res, 200, { ok: true, accounts: list });
  }

  json(res, 404, { ok: false, error: 'not found' });
});

const wss = new WebSocketServer({ server: httpServer });

const rooms = new Map(); // roomCode -> room
let nextPlayerId = 1;

function makeRoomCode() {
  let code;
  do {
    code = Math.floor(1000 + Math.random() * 9000).toString();
  } while (rooms.has(code));
  return code;
}

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(room, msg, exceptWs) {
  for (const client of room.players) {
    if (client !== exceptWs) send(client, msg);
  }
}

function createRoom(code, isPublic) {
  const room = {
    code,
    isPublic,
    players: new Set(),
    hostId: null,
    createdAt: Date.now(),
    lastMatchTick: 0,
  };
  rooms.set(code, room);
  return room;
}

function promoteHost(room) {
  const next = [...room.players][0];
  room.hostId = next ? next.playerId : null;
  if (next) broadcast(room, { t: 'host_changed', id: next.playerId }, null);
}

function joinRoom(ws, room) {
  room.players.add(ws);
  ws.room = room;
  ws.lastState = null;       // {x,y,t} for speed-cap checks
  ws.lastShot = {};          // weapon -> last accepted shot time (ms)
  if (room.hostId === null) room.hostId = ws.playerId; // first player in the room is host
  send(ws, { t: 'joined', code: room.code, id: ws.playerId, isHost: room.hostId === ws.playerId });
  broadcast(room, { t: 'player_joined', id: ws.playerId, name: ws.name }, ws);
}

function leaveRoom(ws) {
  const room = ws.room;
  if (!room) return;
  room.players.delete(ws);
  broadcast(room, { t: 'player_left', id: ws.playerId }, ws);
  if (room.players.size === 0) {
    rooms.delete(room.code);
  } else if (room.hostId === ws.playerId) {
    promoteHost(room); // the host disconnected — hand it to whoever's left
  }
  ws.room = null;
}

wss.on('connection', (ws) => {
  ws.playerId = nextPlayerId++;
  ws.name = 'Player' + ws.playerId;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.t) {
      case 'set_name':
        ws.name = String(msg.name || ws.name).slice(0, 20);
        break;

      case 'find_public': {
        let room = [...rooms.values()].find(r => r.isPublic && r.players.size < MAX_PLAYERS);
        if (!room) room = createRoom(makeRoomCode(), true);
        joinRoom(ws, room);
        break;
      }

      case 'create_private': {
        const room = createRoom(makeRoomCode(), false);
        joinRoom(ws, room);
        break;
      }

      case 'join_code': {
        const room = rooms.get(String(msg.code || '').trim());
        if (!room) { send(ws, { t: 'error', message: 'No match with that code.' }); return; }
        if (room.players.size >= MAX_PLAYERS) { send(ws, { t: 'error', message: 'That match is full.' }); return; }
        joinRoom(ws, room);
        break;
      }

      case 'state': {
        // Player broadcasting their own position/angle/hp/weapon. Anti-cheat: reject
        // moves that imply an impossible speed, and clamp hp to a legal range.
        if (!ws.room) return;
        const d = msg.data || {};
        const now = Date.now();
        if (typeof d.x === 'number' && typeof d.y === 'number') {
          if (ws.lastState) {
            const dt = Math.max(0.001, (now - ws.lastState.t) / 1000);
            const dist = Math.hypot(d.x - ws.lastState.x, d.y - ws.lastState.y);
            const allowed = MAX_SPEED * dt + 24; // small slack for jitter
            if (dist > allowed) return; // drop silently — too far, too fast
          }
          ws.lastState = { x: d.x, y: d.y, t: now };
        }
        if (typeof d.hp === 'number') d.hp = Math.max(0, Math.min(100, d.hp));
        broadcast(ws.room, { t: 'state', id: ws.playerId, name: ws.name, ...d }, ws);
        break;
      }

      case 'event': {
        if (!ws.room) return;
        const d = msg.data || {};

        // Host-authoritative match state (shared bomb/timer/bots). Only the
        // room's current host is allowed to publish it, and only so often.
        if (d.kind === 'match_tick') {
          if (ws.playerId !== ws.room.hostId) return; // not the host — ignore
          const now = Date.now();
          if (now - ws.room.lastMatchTick < MATCH_TICK_MIN_INTERVAL * 1000) return;
          ws.room.lastMatchTick = now;
          broadcast(ws.room, { t: 'event', id: ws.playerId, name: ws.name, ...d }, ws);
          return;
        }

        // A hit claim against a shared enemy: validate fire rate + damage before relaying.
        if (d.kind === 'shot_hit') {
          const wp = WEAPONS[d.weapon];
          if (!wp) return;
          const now = Date.now();
          const last = ws.lastShot[d.weapon] || 0;
          if (now - last < wp.rate * 1000 - 30) return; // firing faster than the weapon allows — drop
          ws.lastShot[d.weapon] = now;
          d.dmg = Math.max(0, Math.min(MAX_DMG, Number(d.dmg) || 0));
          broadcast(ws.room, { t: 'event', id: ws.playerId, name: ws.name, ...d }, ws);
          return;
        }

        // Anything else (grenade thrown, cosmetic events, etc.) is relayed as-is.
        broadcast(ws.room, { t: 'event', id: ws.playerId, name: ws.name, ...d }, ws);
        break;
      }

      case 'leave':
        leaveRoom(ws);
        break;
    }
  });

  ws.on('close', () => leaveRoom(ws));
});

httpServer.listen(PORT, () => {
  console.log(`DEADLINE server listening on port ${PORT}`);
});

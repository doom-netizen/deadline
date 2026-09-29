// DEADLINE multiplayer relay server
// Handles: public matchmaking queue, private room codes, relaying player state,
// host-authoritative shared match state (bots/bomb/timer), and lightweight
// server-side anti-cheat (speed cap, fire-rate cap, damage cap).
const { WebSocketServer } = require('ws');
const http = require('http');

const PORT = process.env.PORT || 8080;
const MAX_PLAYERS = 10; // per match (adjust as you like)

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

// -- simple HTTP server so hosts have something to "wake" / health-check --
const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('DEADLINE server is running.\n');
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

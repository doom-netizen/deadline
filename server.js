// DEADLINE multiplayer relay server
// Handles: public matchmaking queue, private room codes, relaying player state.
const { WebSocketServer } = require('ws');
const http = require('http');

const PORT = process.env.PORT || 8080;
const MAX_PLAYERS = 10; // per match (adjust as you like)

// -- simple HTTP server so hosts have something to "wake" / health-check --
const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('DEADLINE server is running.\n');
});

const wss = new WebSocketServer({ server: httpServer });

let publicQueue = [];          // sockets waiting for a public match
const rooms = new Map();       // roomCode -> { players: Set<ws>, state: {...} }
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
    createdAt: Date.now(),
  };
  rooms.set(code, room);
  return room;
}

function joinRoom(ws, room) {
  room.players.add(ws);
  ws.room = room;
  send(ws, { t: 'joined', code: room.code, id: ws.playerId });
  broadcast(room, { t: 'player_joined', id: ws.playerId, name: ws.name }, ws);
}

function leaveRoom(ws) {
  const room = ws.room;
  if (!room) return;
  room.players.delete(ws);
  broadcast(room, { t: 'player_left', id: ws.playerId }, ws);
  if (room.players.size === 0) rooms.delete(room.code);
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
        // pull from the waiting queue, or start a fresh public room
        publicQueue = publicQueue.filter(s => s.readyState === s.OPEN && !s.room);
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
        // player is broadcasting their position/angle/action to everyone else in the room
        if (!ws.room) return;
        broadcast(ws.room, { t: 'state', id: ws.playerId, name: ws.name, ...msg.data }, ws);
        break;
      }

      case 'event': {
        // one-off events: shot fired, grenade thrown, bomb planted/defused, kill, etc.
        if (!ws.room) return;
        broadcast(ws.room, { t: 'event', id: ws.playerId, name: ws.name, ...msg.data }, ws);
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

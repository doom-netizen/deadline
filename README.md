# DEADLINE Multiplayer Server

A minimal WebSocket relay server: public matchmaking, private room codes,
and broadcasting player state/events to everyone in a match. It does not
run game logic itself (no server-side hit detection yet) — it just
relays what each client sends to everyone else in the same room. That's
enough to see other real players moving/shooting in real time.

## Run it locally
```
npm install
npm start
```
Server listens on port 8080 (or $PORT).

## Protocol (JSON messages over WebSocket)
Client -> Server:
- {"t":"set_name","name":"Alex"}
- {"t":"find_public"}                  // join/create a public match
- {"t":"create_private"}               // get a room code back
- {"t":"join_code","code":"4821"}      // join a friend's room
- {"t":"state","data":{...}}           // your position/angle/etc, sent ~10x/sec
- {"t":"event","data":{...}}           // shot fired, bomb planted, kill, etc.
- {"t":"leave"}

Server -> Client:
- {"t":"joined","code":"4821","id":7}
- {"t":"player_joined","id":8,"name":"..."}
- {"t":"player_left","id":8}
- {"t":"state","id":8,"name":"...",...}
- {"t":"event","id":8,"name":"...",...}
- {"t":"error","message":"..."}

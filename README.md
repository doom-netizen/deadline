# DEADLINE Server

A minimal WebSocket relay server (public matchmaking, private room codes,
broadcasting player state/events to everyone in a match — no server-side
game logic beyond light anti-cheat checks) plus a small real account API
(signup/login/password reset/admin tools), all in one Node process.

## Run it locally
```
npm install
npm start
```
Server listens on port 8080 (or $PORT).

Set `ADMIN_KEY` in the environment to enable the admin account endpoints
(`/admin-reset-password`, `/admin-list`). Without it, those routes always
refuse. Only the site owner should know this value — it's entered into the
in-game ADMIN screen (visible to staff accounts) when needed, never stored
in the game's code.

## Accounts
Accounts are stored in `accounts.json` next to `server.js`, created
automatically on first signup. **This file is not committed** (see
`.gitignore`) and, on hosts with an ephemeral filesystem (e.g. a free
Render web service with no attached persistent disk), it's wiped on every
new deploy — it survives ordinary restarts/sleep, but not a redeploy. For
accounts that need to survive redeploys, attach a persistent disk (or swap
the storage in `server.js` for a real database) mounted at the repo root.

### Account API (JSON over HTTP, all under the same host/port as the WebSocket)
- `POST /signup {u,p}` → `{ok,account}` or `{ok:false,error}`
- `POST /login {u,p}` or `{u,k}` (key-only login) → `{ok,account}`
- `POST /save {u,k,data:{rp,cr,codes,inv}}` → sync gameplay progress (key-authenticated)
- `POST /change-password {u,p,newP}` → `{ok,key}` (rotates the access key too)
- `POST /regenerate-key {u,p}` → `{ok,key}`
- `POST /admin-reset-password {u,newP,adminKey}` → `{ok,key}` — resets a player's password and rotates their key, for recovering a compromised account
- `GET /admin-list?adminKey=...` → `{ok,accounts:[{u,rp,cr,staff,createdAt}]}`

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

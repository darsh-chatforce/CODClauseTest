import { createServer } from 'node:http';
import * as THREE from 'three';
import { WebSocketServer, type WebSocket } from 'ws';
import { Room, type RoomPlayer } from './room';
import {
  ROOM_ALPHABET,
  SNAPSHOT_HZ,
  isRoomCode,
  type ClientMessage,
  type ServerMessage,
} from '../src/net/protocol';

/**
 * Operation Nightfall — co-op server.
 *
 * Deliberately small and deliberately optional. `npm run dev` starts it
 * alongside Vite; if it is not running, the game is exactly the single-player
 * build it was at M3 and nothing in `src/` blocks on a socket. That is the
 * constraint the whole of M4 is built under: **the offline game must not
 * acquire a dependency on the network to stay working.**
 *
 *   npm run server            # this, on :8787
 *   npm run dev               # vite + this, one command
 */

const PORT = Number(process.env.NF_PORT ?? 8787);
const MAX_PLAYERS = 4;

const rooms = new Map<string, Room>();
let nextId = 1;

function makeCode(): string {
  for (let attempt = 0; attempt < 500; attempt++) {
    let c = '';
    for (let i = 0; i < 4; i++) {
      c += ROOM_ALPHABET[Math.floor(Math.random() * ROOM_ALPHABET.length)];
    }
    if (!rooms.has(c)) return c;
  }
  throw new Error('room code space exhausted');
}

const http = createServer((req, res) => {
  // A health endpoint so the smoke harness can wait for readiness instead of
  // sleeping a hopeful number of milliseconds.
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      rooms: rooms.size,
      players: [...rooms.values()].reduce((n, r) => n + r.players.size, 0),
      snapshotHz: SNAPSHOT_HZ,
    }));
    return;
  }
  res.writeHead(404).end('not found');
});

const wss = new WebSocketServer({ server: http });

wss.on('connection', (ws: WebSocket) => {
  let player: RoomPlayer | null = null;
  let room: Room | null = null;

  const send = (msg: ServerMessage): void => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };

  const leave = (): void => {
    if (room && player) {
      room.remove(player.id);
      if (room.empty) {
        room.dispose();
        rooms.delete(room.code);
      }
    }
    room = null;
    player = null;
  };

  ws.on('message', (raw) => {
    let m: ClientMessage;
    try {
      m = JSON.parse(String(raw)) as ClientMessage;
    } catch {
      send({ t: 'error', message: 'bad json' });
      return;
    }

    if (m.t === 'ping') {
      send({ t: 'pong', ts: m.ts });
      return;
    }

    if (m.t === 'join') {
      if (player) return;
      // A blank/absent code CREATES a room; a code JOINS one. One field, two
      // intents, so the client never has to ask "does this room exist yet".
      const wanted = (m.room ?? '').trim().toUpperCase();
      let code: string;
      if (wanted === '') {
        code = makeCode();
        rooms.set(code, new Room(code));
      } else if (!isRoomCode(wanted)) {
        send({ t: 'error', message: `"${wanted}" is not a room code` });
        return;
      } else if (!rooms.has(wanted)) {
        send({ t: 'error', message: `no room ${wanted}` });
        return;
      } else {
        code = wanted;
      }

      const r = rooms.get(code)!;
      if (r.players.size >= MAX_PLAYERS) {
        send({ t: 'error', message: `room ${code} is full` });
        return;
      }

      const id = `p${nextId++}`;
      const name = (m.name || `SOLDIER ${id.slice(1)}`).slice(0, 16).toUpperCase();
      player = {
        id,
        name,
        send,
        position: new THREE.Vector3(),
        yaw: 0,
        pitch: 0,
        health: 100,
        flags: 0,
        score: 0,
        kills: 0,
        lastSeen: Date.now(),
        alive: true,
      };
      room = r;
      r.add(player);
      send({ t: 'welcome', id, room: code, name, snapshotHz: SNAPSHOT_HZ });
      console.log(`[room ${code}] + ${name} (${r.players.size}/${MAX_PLAYERS})`);
      return;
    }

    if (!player || !room) return;

    switch (m.t) {
      case 'input':
        room.applyInput(player.id, m);
        break;
      case 'fire':
        room.applyFire(
          player.id,
          new THREE.Vector3(m.ox, m.oy, m.oz),
          new THREE.Vector3(m.dx, m.dy, m.dz),
        );
        break;
      case 'restart':
        room.reset();
        break;
      default:
        break;
    }
  });

  ws.on('close', () => {
    if (player && room) console.log(`[room ${room.code}] - ${player.name}`);
    leave();
  });
  ws.on('error', leave);
});

http.listen(PORT, () => {
  console.log(`Operation Nightfall co-op server on ws://localhost:${PORT}  (${SNAPSHOT_HZ} Hz snapshots)`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    for (const r of rooms.values()) r.dispose();
    wss.close();
    http.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500);
  });
}

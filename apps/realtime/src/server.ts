/**
 * Presence server for the grow room.
 *
 * This holds positions and nothing else. It has no key, it never signs anything,
 * and it is not consulted about any value in the game. If it dies, the room still
 * renders every bench and every plant correctly from chain state, and every
 * transaction still works. That separation is deliberate and it is the reason
 * this can be a plain WebSocket server rather than an authoritative game server.
 *
 * What it does NOT do, on purpose:
 *   - decide anything about growth, yield, quality or rewards
 *   - accept a wallet address as proof of identity
 *   - persist anything
 *
 * A client can claim to be any name and any position. That is fine, because the
 * worst a liar achieves is standing in the wrong place in someone else's browser.
 *
 * ---------------------------------------------------------------------------
 * Scale
 *
 * The first version broadcast every player to every player as a list of objects,
 * every tick. That is O(n squared) in message size as well as in work, and it
 * measured at 39 KB/s per player with a thousand connected, which is three
 * gigabits at ten thousand. Not real.
 *
 * Four things bring it down, in order of how much they matter:
 *
 *   1. **Shards.** A room has a capacity. Past it, joiners land in the next
 *      shard of the same room, so "main" becomes main#0, main#1 and so on. Ten
 *      thousand players is two hundred shards of fifty, not one room of ten
 *      thousand, and nobody was ever going to see ten thousand avatars anyway.
 *      Shards are also the unit of horizontal scale: a second process takes a
 *      different set of them and nothing has to be shared between the two.
 *   2. **Names are sent once.** A name is static, so it goes in an "arrived"
 *      message and never again. Positions after that are numbers only.
 *   3. **Flat arrays, not objects.** A moved player is four numbers in one flat
 *      list rather than a JSON object with four keys, which is most of the
 *      remaining bytes.
 *   4. **Only what changed.** Players who did not move are not in the tick, and
 *      a tick with nothing in it is not sent.
 *
 * Interest radius sits under all of that: you are only ever told about people
 * close enough to see.
 */
import { WebSocketServer, WebSocket } from "ws";

// Railway assigns a port at deploy time and routes its public wss:// domain to
// whatever the service actually listens on. Ignoring that and binding a fixed
// port instead means the process starts cleanly but nobody outside the host can
// reach it, which the client already tolerates (the room just goes solo) but is
// exactly the kind of silent misconfiguration worth not shipping. PORT wins when
// the host sets it; REALTIME_PORT is the explicit local override.
const PORT = Number(process.env.PORT ?? process.env.REALTIME_PORT ?? 8787);

/**
 * Ten a second, not sixteen.
 *
 * The client interpolates between updates, so the extra six ticks bought
 * nothing visible and cost forty percent of the bandwidth.
 */
const TICK_MS = Number(process.env.TICK_MS ?? 100);
const STALE_MS = 15_000;

/**
 * How many players share one shard.
 *
 * Sized so the per tick work inside a shard stays trivial. Raising it makes the
 * world feel busier and the tick quadratic in this number, so it is the one dial
 * to be careful with.
 */
const SHARD_CAPACITY = Number(process.env.SHARD_CAPACITY ?? 48);

/**
 * Metres. Beyond this you are not sent someone, because you cannot see them.
 *
 * The room is 16 by 22, so a radius of 14 is about the near half of it. Set it
 * wider than the room's diagonal and interest management stops doing anything.
 */
const INTEREST_RADIUS = Number(process.env.INTEREST_RADIUS ?? 14);

/** A hard ceiling on one payload, whatever the radius says. */
const MAX_NEIGHBOURS = 64;

/** Room bounds, mirrored from the client so a hostile client cannot teleport. */
const BOUND_X = 8;
const BOUND_Z = 11;

type Player = {
  /** Numeric, because it goes into every position frame. */
  id: number;
  name: string;
  x: number;
  z: number;
  ry: number;
  /** The base room the client asked for, without the shard suffix. */
  room: string;
  /** The shard actually assigned, which is what the broadcast groups by. */
  shard: string;
  lastSeen: number;
  /** Bumped whenever position changes, so a still player costs nothing. */
  version: number;
  /** Who this player currently knows about, and at what version. */
  known: Map<number, number>;
  socket: WebSocket;
};

const players = new Map<number, Player>();
const shards = new Map<string, Set<Player>>();

function clamp(v: unknown, limit: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : 0;
  return Math.max(-limit, Math.min(limit, n));
}

/**
 * Names are shown in other people's browsers, so this is an allowlist rather
 * than a denylist.
 *
 * The first version stripped non-printable characters, which let
 * `<script>x</script>` straight through because every byte of it is printable.
 * React escapes text nodes so it would not have executed, but relying on the
 * consumer to be careful is exactly the assumption that breaks the first time
 * a name is put somewhere else.
 */
function cleanName(v: unknown): string {
  const s = typeof v === "string" ? v : "";
  const stripped = s
    .replace(/[^A-Za-z0-9 ._-]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 18);
  return stripped.length > 0 ? stripped : "grower";
}

function cleanRoom(v: unknown): string {
  const s = typeof v === "string" ? v : "main";
  return /^[a-z0-9-]{1,24}$/i.test(s) ? s : "main";
}

/**
 * Puts a player in the first shard of their room with space, creating one if
 * every existing shard is full.
 *
 * Filling the lowest numbered shard first keeps rooms dense rather than
 * scattering ten people across ten shards, which matters because an empty room
 * is the one thing a presence server can actually get wrong.
 */
function assignShard(player: Player, room: string) {
  leaveShard(player);
  player.room = room;

  for (let i = 0; ; i++) {
    const key = `${room}#${i}`;
    const set = shards.get(key);
    if (!set) {
      shards.set(key, new Set([player]));
      player.shard = key;
      return;
    }
    if (set.size < SHARD_CAPACITY) {
      set.add(player);
      player.shard = key;
      return;
    }
  }
}

function leaveShard(player: Player) {
  if (!player.shard) return;
  const set = shards.get(player.shard);
  if (set) {
    set.delete(player);
    if (set.size === 0) shards.delete(player.shard);
  }
  player.shard = "";
  player.known.clear();
}

const wss = new WebSocketServer({ port: PORT });
let nextId = 1;

wss.on("connection", (socket, req) => {
  const id = nextId++;
  const player: Player = {
    id,
    name: "grower",
    x: 0,
    z: 0,
    ry: 0,
    room: "main",
    shard: "",
    lastSeen: Date.now(),
    version: 1,
    known: new Map(),
    socket,
  };
  players.set(id, player);
  assignShard(player, "main");
  socket.send(JSON.stringify({ t: "hello", id, shard: player.shard }));

  // A client that floods gets dropped rather than being allowed to spin the loop.
  let budget = 0;
  const budgetTimer = setInterval(() => {
    budget = 0;
  }, 1000);

  socket.on("message", (raw) => {
    if (++budget > 60) {
      socket.close(1008, "too chatty");
      return;
    }
    let msg: Record<string, unknown>;
    try {
      const text = typeof raw === "string" ? raw : raw.toString("utf8");
      if (text.length > 512) return;
      msg = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }

    if (msg.t === "join") {
      const name = cleanName(msg.name);
      const room = cleanRoom(msg.room);
      const renamed = name !== player.name;
      player.name = name;
      if (room !== player.room) assignShard(player, room);

      /**
       * Only invalidate when the name actually changed.
       *
       * Names are sent once, so a rename has to reach everyone already told the
       * old one. Doing that on every join rather than on a real rename let one
       * client spend its whole message budget forcing every peer in the shard to
       * resend its name entry: cheap to send, expensive for everyone else, and
       * the cost grew with how busy the room was.
       */
      if (renamed) {
        for (const other of shards.get(player.shard) ?? []) other.known.delete(player.id);
      }
      socket.send(JSON.stringify({ t: "hello", id, shard: player.shard }));
    } else if (msg.t === "move") {
      const x = clamp(msg.x, BOUND_X);
      const z = clamp(msg.z, BOUND_Z);
      const rawRy = typeof msg.ry === "number" && Number.isFinite(msg.ry) ? msg.ry : 0;
      const ry = ((rawRy + Math.PI) % (Math.PI * 2)) - Math.PI;
      // Only a real move counts, so a client resending the same position does
      // not force its neighbours' payloads to be rebuilt.
      if (
        Math.abs(x - player.x) > 0.02 ||
        Math.abs(z - player.z) > 0.02 ||
        Math.abs(ry - player.ry) > 0.02
      ) {
        player.x = x;
        player.z = z;
        player.ry = ry;
        player.version++;
      }
    }
    player.lastSeen = Date.now();
  });

  const bye = () => {
    clearInterval(budgetTimer);
    leaveShard(player);
    players.delete(id);
  };
  socket.on("close", bye);
  socket.on("error", bye);

  void req;
});

/** Two decimals is well under a pixel at room scale and roughly halves the payload. */
const r2 = (n: number) => Math.round(n * 100) / 100;

setInterval(() => {
  const now = Date.now();
  for (const [, p] of players) {
    if (now - p.lastSeen > STALE_MS) {
      p.socket.close(1000, "idle");
      leaveShard(p);
      players.delete(p.id);
    }
  }

  const radiusSq = INTEREST_RADIUS * INTEREST_RADIUS;

  for (const [, set] of shards) {
    // One array per shard, so the inner loop is over a small bounded list.
    const list = Array.from(set);

    for (const me of list) {
      if (me.socket.readyState !== WebSocket.OPEN) continue;

      // arrived: id and name, sent once. moved: four numbers, flat.
      let arrived: [number, string][] | null = null;
      let moved: number[] | null = null;
      const stillHere = new Set<number>();

      let neighbours = 0;
      for (const other of list) {
        if (other === me) continue;
        const dx = other.x - me.x;
        const dz = other.z - me.z;
        if (dx * dx + dz * dz > radiusSq) continue;
        if (++neighbours > MAX_NEIGHBOURS) break;

        stillHere.add(other.id);
        const seenVersion = me.known.get(other.id);

        if (seenVersion === undefined) {
          (arrived ??= []).push([other.id, other.name]);
        } else if (seenVersion === other.version) {
          continue;
        }
        me.known.set(other.id, other.version);
        (moved ??= []).push(other.id, r2(other.x), r2(other.z), r2(other.ry));
      }

      let left: number[] | null = null;
      for (const id of me.known.keys()) {
        if (!stillHere.has(id)) (left ??= []).push(id);
      }
      if (left) for (const id of left) me.known.delete(id);

      // A tick where this player's neighbourhood did not change is not sent at
      // all, which is what makes a still room free rather than merely cheap.
      if (!arrived && !moved && !left) continue;

      const frame: Record<string, unknown> = { t: "p" };
      if (arrived) frame.a = arrived;
      if (moved) frame.m = moved;
      if (left) frame.r = left;
      me.socket.send(JSON.stringify(frame));
    }
  }
}, TICK_MS);

console.log(`Presence server on ws://127.0.0.1:${PORT}`);
console.log(
  `Shards of ${SHARD_CAPACITY}, interest radius ${INTEREST_RADIUS}m, ` +
    `at most ${MAX_NEIGHBOURS} neighbours, ${1000 / TICK_MS} ticks a second.`
);
console.log("Holds positions only. No key, no authority over any value in the game.");

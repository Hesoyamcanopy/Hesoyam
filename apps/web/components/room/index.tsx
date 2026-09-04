"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { Peer, RoomBench } from "./scene";
import { useCheats, CHEATS } from "./cheats";

/**
 * The room, and the presence connection that populates it with other people.
 *
 * Three.js is loaded client side only. It is a large dependency and there is
 * nothing meaningful to render on a server, so it is excluded from the server
 * bundle entirely rather than being hydrated away.
 */
const GrowRoom = dynamic(() => import("./scene").then((m) => m.GrowRoom), {
  ssr: false,
  loading: () => <div className="room-loading">Loading the room</div>,
});

/**
 * Where the presence server is, if there is one.
 *
 * The old default was a bare `ws://127.0.0.1:8787`, which is right in
 * development and quietly wrong in production twice over: there is nothing on
 * localhost for a visitor, and an insecure socket from an HTTPS page is blocked
 * as mixed content before it is even attempted. Both failures look identical to
 * "nobody else is online", which is the worst way for a misconfiguration to
 * present itself.
 *
 * So the localhost default only applies when the page itself is not secure.
 * Deployed without NEXT_PUBLIC_REALTIME_URL, the room is honestly single player
 * rather than pretending to reach for a server that cannot exist.
 */
function presenceUrl(): string | null {
  const configured = process.env.NEXT_PUBLIC_REALTIME_URL;
  if (configured) return configured;
  if (typeof window === "undefined") return null;
  return window.location.protocol === "https:" ? null : "ws://127.0.0.1:8787";
}

/**
 * Connects to the presence server, if there is one.
 *
 * Failure here is not an error state. The room is fully playable alone, so a
 * missing or dead presence server degrades to an empty room rather than to a
 * broken page. That is the same separation the server file describes: positions
 * are decoration, chain state is the game.
 */
function usePresence(name: string, enabled: boolean) {
  /**
   * Peers live in a ref, not in state.
   *
   * Ten position frames a second, each rebuilding an array of up to sixty four
   * objects, would be ten React renders a second of a tree containing a WebGL
   * canvas. The scene reads this array inside its own animation frame instead,
   * so movement never touches React at all. Only the count is state, and only
   * because the heads up display shows it.
   */
  const peersRef = useRef<Peer[]>([]);
  const byId = useRef(new Map<number, Peer>());
  const [count, setCount] = useState(0);
  const [status, setStatus] = useState<"off" | "connecting" | "live">("off");
  const sock = useRef<WebSocket | null>(null);
  const last = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    let closed = false;
    let retry: ReturnType<typeof setTimeout>;

    const rebuild = () => {
      peersRef.current = Array.from(byId.current.values());
      setCount((c) => (c === peersRef.current.length ? c : peersRef.current.length));
    };

    const reset = () => {
      byId.current.clear();
      rebuild();
    };

    const connect = () => {
      if (closed) return;
      const url = presenceUrl();
      // Not configured on a secure page. Single player, and it says so.
      if (!url) {
        setStatus("off");
        return;
      }
      setStatus("connecting");
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch {
        setStatus("off");
        return;
      }
      sock.current = ws;

      ws.onopen = () => {
        setStatus("live");
        ws.send(JSON.stringify({ t: "join", name, room: "main" }));
      };

      /**
       * The wire format is deliberately terse, because it is the thing that runs
       * ten times a second for everybody at once:
       *
       *   a: [[id, name], ...]   somebody came into view, name sent once only
       *   m: [id, x, z, ry, ...] flat quads, only for people who actually moved
       *   r: [id, ...]           somebody left view
       */
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(String(e.data));
          if (msg.t !== "p") return;
          let structural = false;

          if (Array.isArray(msg.a)) {
            for (const [id, nm] of msg.a as [number, string][]) {
              if (!byId.current.has(id)) {
                byId.current.set(id, { id: String(id), name: nm, x: 0, z: 0, ry: 0 });
                structural = true;
              }
            }
          }
          if (Array.isArray(msg.m)) {
            const flat = msg.m as number[];
            for (let i = 0; i + 3 < flat.length; i += 4) {
              const peer = byId.current.get(flat[i]);
              if (!peer) continue;
              peer.x = flat[i + 1];
              peer.z = flat[i + 2];
              peer.ry = flat[i + 3];
            }
          }
          if (Array.isArray(msg.r)) {
            for (const id of msg.r as number[]) {
              if (byId.current.delete(id)) structural = true;
            }
          }

          // Only somebody arriving or leaving changes the array itself. A move
          // mutates a peer in place, which the scene already reads every frame.
          if (structural) rebuild();
        } catch {
          // A malformed frame is the server's problem, not a reason to tear down.
        }
      };

      ws.onclose = () => {
        setStatus("off");
        reset();
        if (!closed) retry = setTimeout(connect, 3000);
      };
      ws.onerror = () => ws.close();
    };

    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      sock.current?.close();
    };
  }, [name, enabled]);

  // Throttled, because a render loop would otherwise send sixty frames a second.
  const push = useCallback((x: number, z: number, ry: number) => {
    const now = performance.now();
    if (now - last.current < 70) return;
    last.current = now;
    const ws = sock.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ t: "move", x, z, ry }));
    }
  }, []);

  return { peersRef, count, status, push };
}

export type RoomAction = {
  label: string;
  onRun: () => void;
  disabled?: boolean;
};

export function RoomView({
  benches,
  playerName,
  actionsFor,
}: {
  benches: RoomBench[];
  playerName: string;
  /** The dashboard already owns every transaction. The room only calls back. */
  actionsFor: (b: RoomBench) => RoomAction[];
}) {
  const [near, setNear] = useState<RoomBench | null>(null);
  const [on, setOn] = useState(false);
  const [codesOpen, setCodesOpen] = useState(false);
  // Only listens while you are actually in the room, so typing anywhere else in
  // the app cannot trip a code.
  const { cheats, flash, typing, reset } = useCheats(on);
  const { peersRef, count, status, push } = usePresence(playerName, on);

  const actions = useMemo(() => (near ? actionsFor(near) : []), [near, actionsFor]);

  // The key handler is registered once, so it reads the current action through a
  // ref rather than closing over a stale one.
  const primary = useRef<RoomAction | null>(null);
  primary.current = actions.find((a) => !a.disabled) ?? null;
  const interact = useCallback(() => {
    primary.current?.onRun();
  }, []);

  if (!on) {
    return (
      <div className="room-gate">
        <div className="room-gate-inner">
          <h3>Enter the grow room</h3>
          <p>
            First person. WASD to walk, shift to run, mouse to look. Click the room to
            capture the pointer and press escape to release it.
          </p>
          <p className="room-gate-note">
            Everything in here is drawn from chain state. Walking up to a plant opens the
            same transaction the panels below do, and the presence server holds positions
            only. If you own no benches yet the room is empty, and you can still walk it
            and meet whoever else is in there.
          </p>
          <button className="btn btn-primary" type="button" onClick={() => setOn(true)}>
            Enter the room
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="room-wrap">
      <div className="room-canvas">
        <GrowRoom
          benches={benches}
          peersRef={peersRef}
          cheats={cheats}
          onNear={setNear}
          onMove={push}
          onInteract={interact}
        />
      </div>

      <div className="room-hud">
        <span className={`room-status room-status-${status}`}>
          {status === "live" ? `${count} other ${count === 1 ? "grower" : "growers"}` : "solo"}
        </span>
        <span className="room-keys">WASD move, shift run, E to use, esc to release</span>
        <button
          className="room-exit"
          type="button"
          onClick={() => setCodesOpen((v) => !v)}
          aria-expanded={codesOpen}
        >
          {codesOpen ? "Hide codes" : "Codes"}
        </button>
        <button
          className="room-exit"
          type="button"
          onClick={() => {
            reset();
            setOn(false);
          }}
        >
          Leave
        </button>
      </div>

      {typing ? (
        <div className="cheat-typing mono" aria-hidden="true">
          {typing}
          <span className="cheat-caret" />
        </div>
      ) : null}

      {flash ? (
        <div className="cheat-flash" role="status">
          <span className="sa-banner sa-banner-good">
            {flash.on ? "Cheat activated" : "Cheat off"}
          </span>
          <p className="sa-banner-sub">{flash.label}</p>
        </div>
      ) : null}

      {codesOpen ? (
        <div className="cheat-list">
          <p className="cheat-list-head">
            Type them. No box, no enter key, exactly like the game. Type one again to
            turn it off.
          </p>
          <ul>
            {CHEATS.map((c) => (
              <li key={c.code}>
                <span className="mono cheat-code">{c.code}</span>
                <span className="cheat-label">{c.label}</span>
                <span className="cheat-effect">{c.effect}</span>
              </li>
            ))}
          </ul>
          <p className="cheat-list-foot">
            Every one of these changes how the room looks and nothing else. None of them
            touches a balance, a grow, a yield or a reward, and none of them is sent
            anywhere. A cheat that paid out would make the rest of this project a lie.
          </p>
        </div>
      ) : null}

      {near ? (
        <div className="room-prompt">
          <div className="room-prompt-head">
            <span className="room-prompt-id">Bench {near.id.toString()}</span>
            <span className="room-prompt-strain">
              {near.growId > 0n ? near.strainName : "empty"}
            </span>
          </div>
          {near.growId > 0n ? (
            <div className="room-prompt-meta">
              <span>{Math.round(near.progress * 100)}% grown</span>
              <span>care {near.care}</span>
              {near.ready ? <span className="tone-cash">ready</span> : null}
              {near.feedIndex !== null ? (
                <span className="tone-amber">feed window {near.feedIndex + 1} open</span>
              ) : null}
              {near.treatSlot !== null ? (
                <span className="tone-red">pest {near.treatSlot + 1} untreated</span>
              ) : null}
            </div>
          ) : null}
          <div className="room-prompt-actions">
            {actions.length === 0 ? (
              <span className="room-prompt-idle">
                {near.growId === 0n
                  ? "Connect a wallet and own this bench to plant here."
                  : "Nothing to do on this plant right now."}
              </span>
            ) : (
              actions.map((a) => (
                <button
                  key={a.label}
                  className="btn btn-primary btn-sm"
                  type="button"
                  disabled={a.disabled}
                  onClick={a.onRun}
                >
                  {a.label}
                </button>
              ))
            )}
            {actions.some((a) => !a.disabled) ? (
              <span className="room-prompt-key">or press E</span>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export type { RoomBench, Peer };

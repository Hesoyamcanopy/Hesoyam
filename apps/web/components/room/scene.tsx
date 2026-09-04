"use client";

import { useMemo, useRef, useState, useEffect, type MutableRefObject } from "react";
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import * as THREE from "three";
import { NO_CHEATS, type CheatState } from "./cheats";

/**
 * The grow room, in 3D.
 *
 * Everything here is procedural voxel geometry. There is no downloaded model, no
 * texture file and no commissioned art. That is a performance decision before it
 * is an aesthetic one: a realistic character model is megabytes over the wire and
 * tens of thousands of triangles on screen, and neither of those survives a room
 * with a crowd in it. A blocky character is a handful of boxes that instance into
 * a single draw call, which is what makes a crowd possible at all.
 *
 * Two rules hold the frame budget:
 *
 *   1. Anything that repeats is one InstancedMesh, not N meshes. The floor, the
 *      walls, every plant across every bench, and every other player each cost
 *      one draw call no matter how many of them there are.
 *   2. Other players are sorted by distance and hard capped. Past the cap they
 *      are simply not drawn, because a player forty metres away behind a wall is
 *      not information.
 *
 * The room is a mirror of chain state and never a source of truth. A bench exists
 * here because the chain says the player owns it, and a plant is the size it is
 * because growth is a pure function of elapsed time that the contract also
 * computes. Nothing you do in here moves value; walking up to a plant opens the
 * same transaction the dashboard would.
 */

export type RoomBench = {
  id: bigint;
  tier: number;
  /** 0 when empty, otherwise the active grow. */
  growId: bigint;
  strainName: string;
  /** 0 to 1 through the cycle. */
  progress: number;
  care: number;
  ready: boolean;
  /** The open feed window, or null when none is open right now. */
  feedIndex: number | null;
  /** The untreated event slot that has fired, or null. */
  treatSlot: number | null;
};

export type Peer = {
  id: string;
  name: string;
  x: number;
  z: number;
  ry: number;
};

/**
 * At most this many other players are drawn, nearest first.
 *
 * The room holds a few dozen people before it stops reading as a room, so this
 * is generous rather than tight. The cost of the cap is one sort per frame over
 * however many peers the server sent, which is bounded separately by the
 * server's own interest radius.
 */
const MAX_PEERS_DRAWN = 96;

/** Beyond this, another player is not worth a draw call. */
const PEER_CULL_DISTANCE = 34;

/**
 * Nearer than this and a player is not drawn either.
 *
 * Somebody standing on the camera is a wall of clipped geometry across the whole
 * view, which is worse than not drawing them: you cannot see the room and you
 * cannot see them either. The camera near plane is 0.1, so this leaves the head
 * comfortably outside it.
 */
const PEER_NEAR_CLIP = 0.9;

const PALETTE = {
  floorA: "#3a4633",
  floorB: "#43503b",
  floorLine: "#79854a",
  wallA: "#4c5a44",
  wallB: "#55644c",
  wallTrim: "#2b3325",
  ceiling: "#232a1e",
  pillar: "#6b7a5e",
  benchTop: "#a8814a",
  benchLeg: "#6d5230",
  tray: "#4a3a26",
  soil: "#43331f",
  stem: "#4f8a34",
  leaf: "#63c23f",
  leafLight: "#88de5c",
  bud: "#e2ee66",
  lampBody: "#8d9683",
  lampGlow: "#ffe89a",
  // Wall art. Bright on purpose: these are the only saturated things in the room
  // and they are what stops it reading as a green box.
  art1: "#e0913a",
  art2: "#c9453a",
  art3: "#6ea9d8",
  art4: "#f5c542",
  art5: "#e05ca8",
};

/** Flat shaded, so every block reads as six distinct faces rather than a blob. */
function mat(color: string, opts: THREE.MeshStandardMaterialParameters = {}) {
  return new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.92, ...opts });
}

/**
 * One unit cube, shared by everything.
 *
 * Every block in the room is this geometry with a scale on its instance matrix,
 * which means the whole scene needs exactly one box in GPU memory.
 */
const UNIT = new THREE.BoxGeometry(1, 1, 1);

/**
 * A limb cube whose origin sits at the top face rather than the centre, so an
 * instance matrix can rotate it around the shoulder or hip the way a limb
 * actually swings.
 */
const LIMB = new THREE.BoxGeometry(1, 1, 1).translate(0, -0.5, 0);

const BLOCK_MAT = mat("#ffffff");
const PLANT_MAT = mat("#ffffff");
const BUD_MAT = mat("#ffffff", { emissive: "#c8d84a", emissiveIntensity: 0.35 });
const SKIN_MAT = mat("#ffffff");
const CLOTH_MAT = mat("#ffffff");
// Barely lit rather than fully shaded, so eyes stay readable in a dim room.
const FACE_MAT = mat("#ffffff", { roughness: 1, emissiveIntensity: 0 });

// Reused across every matrix write, so the per frame work allocates nothing.
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _euler = new THREE.Euler(0, 0, 0, "YXZ");
const _mat4 = new THREE.Matrix4();
const _color = new THREE.Color();

function setInstance(
  target: THREE.InstancedMesh,
  i: number,
  x: number,
  y: number,
  z: number,
  sx: number,
  sy: number,
  sz: number,
  ry = 0,
  rx = 0
) {
  _pos.set(x, y, z);
  _euler.set(rx, ry, 0);
  _quat.setFromEuler(_euler);
  _scale.set(sx, sy, sz);
  target.setMatrixAt(i, _mat4.compose(_pos, _quat, _scale));
}

/** Deterministic 0 to 1 from a string, so a player keeps the same look. */
function hash01(s: string, salt: number): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

// ---------------------------------------------------------------- the shell

/**
 * Floor, walls and ceiling, built out of one metre blocks.
 *
 * Three InstancedMeshes for the whole shell. Built once and never touched again,
 * because the room does not change shape. Per block tone variation comes from
 * instance colour, which is what stops a flat plane from reading as a flat plane.
 */
function Shell({ w, d, h }: { w: number; d: number; h: number }) {
  const floorRef = useRef<THREE.InstancedMesh>(null);
  const wallRef = useRef<THREE.InstancedMesh>(null);
  const ceilRef = useRef<THREE.InstancedMesh>(null);

  const counts = useMemo(() => {
    const floor = w * d;
    const walls = (w * h) * 2 + (d * h) * 2;
    return { floor, walls, ceiling: w * d };
  }, [w, d, h]);

  useEffect(() => {
    const floor = floorRef.current;
    const wall = wallRef.current;
    const ceil = ceilRef.current;
    if (!floor || !wall || !ceil) return;

    const a = new THREE.Color(PALETTE.floorA);
    const b = new THREE.Color(PALETTE.floorB);
    const line = new THREE.Color(PALETTE.floorLine);

    let i = 0;
    for (let gx = 0; gx < w; gx++) {
      for (let gz = 0; gz < d; gz++) {
        const x = -w / 2 + gx + 0.5;
        const z = -d / 2 + gz + 0.5;
        setInstance(floor, i, x, -0.5, z, 1, 1, 1);
        // Two painted walkway lines, the way a real bay is marked out.
        const onLine = gx === 3 || gx === w - 4;
        floor.setColorAt(i, onLine ? line : (gx + gz) % 2 === 0 ? a : b);
        i++;
      }
    }
    floor.instanceMatrix.needsUpdate = true;
    if (floor.instanceColor) floor.instanceColor.needsUpdate = true;

    const wa = new THREE.Color(PALETTE.wallA);
    const wb = new THREE.Color(PALETTE.wallB);
    const trim = new THREE.Color(PALETTE.wallTrim);

    let j = 0;
    const place = (x: number, y: number, z: number, seed: number) => {
      setInstance(wall, j, x, y, z, 1, 1, 1);
      // A waist high trim band, then a light speckle so the wall has grain.
      const c = y < 1.5 ? trim : hash01(`${x},${z},${y}`, seed) > 0.72 ? wb : wa;
      wall.setColorAt(j, c);
      j++;
    };

    for (let gy = 0; gy < h; gy++) {
      const y = gy + 0.5;
      for (let gx = 0; gx < w; gx++) {
        const x = -w / 2 + gx + 0.5;
        place(x, y, -d / 2 - 0.5, 1);
        place(x, y, d / 2 + 0.5, 2);
      }
      for (let gz = 0; gz < d; gz++) {
        const z = -d / 2 + gz + 0.5;
        place(-w / 2 - 0.5, y, z, 3);
        place(w / 2 + 0.5, y, z, 4);
      }
    }
    wall.instanceMatrix.needsUpdate = true;
    if (wall.instanceColor) wall.instanceColor.needsUpdate = true;

    const cc = new THREE.Color(PALETTE.ceiling);
    let k = 0;
    for (let gx = 0; gx < w; gx++) {
      for (let gz = 0; gz < d; gz++) {
        setInstance(ceil, k, -w / 2 + gx + 0.5, h + 0.5, -d / 2 + gz + 0.5, 1, 1, 1);
        ceil.setColorAt(k, cc);
        k++;
      }
    }
    ceil.instanceMatrix.needsUpdate = true;
    if (ceil.instanceColor) ceil.instanceColor.needsUpdate = true;
  }, [w, d, h]);

  return (
    <>
      <instancedMesh
        ref={floorRef}
        args={[UNIT, BLOCK_MAT, counts.floor]}

        frustumCulled={false}
      />
      <instancedMesh ref={wallRef} args={[UNIT, BLOCK_MAT, counts.walls]} frustumCulled={false} />
      <instancedMesh ref={ceilRef} args={[UNIT, BLOCK_MAT, counts.ceiling]} frustumCulled={false} />
    </>
  );
}

/** Blocky hanging lights, two rows down the bay. */
function Lamps({ w, d, h }: { w: number; d: number; h: number }) {
  const body = useMemo(() => mat(PALETTE.lampBody), []);
  const glow = useMemo(
    () => mat(PALETTE.lampGlow, { emissive: PALETTE.lampGlow, emissiveIntensity: 1.15 }),
    []
  );

  const spots = useMemo(() => {
    const out: [number, number][] = [];
    for (const x of [-w / 4, w / 4]) {
      for (let i = 0; i < 5; i++) out.push([x, -d / 2 + 3 + i * ((d - 6) / 4)]);
    }
    return out;
  }, [w, d]);

  return (
    <group>
      {spots.map(([x, z], i) => (
        <group key={i} position={[x, h - 0.85, z]}>
          <mesh position={[0, 0.5, 0]} material={body}>
            <boxGeometry args={[0.12, 0.9, 0.12]} />
          </mesh>
          <mesh material={body}>
            <boxGeometry args={[1.5, 0.18, 0.5]} />
          </mesh>
          <mesh position={[0, -0.11, 0]} material={glow}>
            <boxGeometry args={[1.34, 0.06, 0.36]} />
          </mesh>
          <pointLight position={[0, -0.5, 0]} intensity={9} distance={9} decay={2} color="#ffe6ae" />
        </group>
      ))}
    </group>
  );
}

/** Blocky pillars along the long walls, so the room has depth cues. */
function Pillars({ w, d, h }: { w: number; d: number; h: number }) {
  const m = useMemo(() => mat(PALETTE.pillar), []);
  const spots = useMemo(() => {
    const out: [number, number][] = [];
    for (let i = 0; i < 4; i++) {
      const z = -d / 2 + 3 + i * ((d - 6) / 3);
      out.push([-w / 2 + 0.4, z]);
      out.push([w / 2 - 0.4, z]);
    }
    return out;
  }, [w, d]);

  return (
    <group>
      {spots.map(([x, z], i) => (
        <mesh key={i} position={[x, h / 2, z]} material={m}>
          <boxGeometry args={[0.7, h, 0.7]} />
        </mesh>
      ))}
    </group>
  );
}

/**
 * Wall art, as flat blocks of colour.
 *
 * These are the only saturated things in the room and they carry most of the
 * character. Deliberately abstract: original blocks of colour, nothing lifted
 * from anywhere.
 */
function WallArt({ w, d, h }: { w: number; d: number; h: number }) {
  const pieces = useMemo(() => {
    const tones = [PALETTE.art1, PALETTE.art2, PALETTE.art3, PALETTE.art4, PALETTE.art5];
    const out: { pos: [number, number, number]; ry: number; s: number; seed: number }[] = [];
    const y = h * 0.55;
    out.push({ pos: [-w / 2 + 0.08, y, -4], ry: Math.PI / 2, s: 1.6, seed: 11 });
    out.push({ pos: [-w / 2 + 0.08, y, 4], ry: Math.PI / 2, s: 1.25, seed: 27 });
    out.push({ pos: [w / 2 - 0.08, y, -1], ry: -Math.PI / 2, s: 1.7, seed: 43 });
    out.push({ pos: [w / 2 - 0.08, y, 6], ry: -Math.PI / 2, s: 1.3, seed: 59 });
    out.push({ pos: [0, y, -d / 2 + 0.08], ry: 0, s: 1.9, seed: 71 });
    return out.map((p) => ({ ...p, tones }));
  }, [w, d, h]);

  return (
    <group>
      {pieces.map((p, i) => (
        <group key={i} position={p.pos} rotation={[0, p.ry, 0]}>
          <mesh>
            <boxGeometry args={[p.s * 1.15, p.s * 0.85, 0.06]} />
            <meshStandardMaterial color="#20261a" flatShading />
          </mesh>
          {Array.from({ length: 9 }, (_, k) => {
            const cx = (k % 3) - 1;
            const cy = Math.floor(k / 3) - 1;
            const tone = p.tones[Math.floor(hash01(`${i}:${k}`, p.seed) * p.tones.length)];
            return (
              <mesh key={k} position={[cx * p.s * 0.34, cy * p.s * 0.25, 0.05]}>
                <boxGeometry args={[p.s * 0.3, p.s * 0.22, 0.03]} />
                <meshStandardMaterial color={tone} flatShading />
              </mesh>
            );
          })}
        </group>
      ))}
    </group>
  );
}

// ---------------------------------------------------------------- plants

type PlantBlock = {
  x: number;
  y: number;
  z: number;
  sx: number;
  sy: number;
  sz: number;
  ry: number;
  light: boolean;
};

/**
 * Every plant on every bench, as four InstancedMeshes.
 *
 * Built in world space from the bench layout rather than as a child of each
 * bench, because that is what lets one draw call cover the whole room. A plant is
 * blocks: a soil block, a stem column, leaf slabs in tiers, and a bud once it is
 * far enough through the cycle. The block count grows with progress, so a plant
 * visibly gains mass rather than just scaling up.
 */
function usePlantBlocks(benches: RoomBench[], layout: [number, number, number][]) {
  return useMemo(() => {
    const soil: PlantBlock[] = [];
    const stem: PlantBlock[] = [];
    const leaf: PlantBlock[] = [];
    const bud: PlantBlock[] = [];

    benches.forEach((b, i) => {
      const at = layout[i];
      if (!at) return;
      const [bx, , bz] = at;
      const top = 0.74;

      if (b.growId === 0n) {
        // A free bench gets empty trays, so it reads as somewhere to plant.
        for (const ox of [-0.5, 0, 0.5]) {
          soil.push({ x: bx + ox, y: top + 0.07, z: bz, sx: 0.42, sy: 0.14, sz: 0.42, ry: 0, light: false });
        }
        return;
      }

      const p = Math.max(0.04, Math.min(1, b.progress));
      const height = 0.3 + p * 1.15;
      const tiers = Math.max(1, Math.round(p * 5));
      const spread = 0.22 + p * 0.44;

      soil.push({ x: bx, y: top + 0.09, z: bz, sx: 0.56, sy: 0.18, sz: 0.56, ry: 0, light: false });
      stem.push({
        x: bx,
        y: top + 0.18 + height / 2,
        z: bz,
        sx: 0.11,
        sy: height,
        sz: 0.11,
        ry: 0,
        light: false,
      });

      for (let t = 0; t < tiers; t++) {
        const y = top + 0.24 + (height - 0.1) * ((t + 1) / (tiers + 1));
        const reach = spread * (0.55 + 0.45 * (1 - t / tiers));
        for (let k = 0; k < 4; k++) {
          const a = (k / 4) * Math.PI * 2 + t * 0.45;
          leaf.push({
            x: bx + Math.cos(a) * reach * 0.62,
            y,
            z: bz + Math.sin(a) * reach * 0.62,
            sx: reach * 1.25,
            sy: 0.075,
            sz: 0.2,
            ry: -a,
            light: t % 2 === 0,
          });
        }
      }

      if (p > 0.55) {
        const s = 0.16 + (p - 0.55) * 0.4;
        bud.push({
          x: bx,
          y: top + 0.2 + height,
          z: bz,
          sx: s,
          sy: s * 1.3,
          sz: s,
          ry: 0,
          light: b.ready,
        });
      }
    });

    return { soil, stem, leaf, bud };
  }, [benches, layout]);
}

function BlockField({
  blocks,
  material,
  colorA,
  colorB,
}: {
  blocks: PlantBlock[];
  material: THREE.Material;
  colorA: string;
  colorB: string;
}) {
  const ref = useRef<THREE.InstancedMesh>(null);
  // A stable allocation, so a plant growing does not rebuild the buffer.
  const capacity = Math.max(16, Math.ceil(blocks.length / 64) * 64);

  useEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const a = new THREE.Color(colorA);
    const b = new THREE.Color(colorB);
    for (let i = 0; i < blocks.length; i++) {
      const k = blocks[i];
      setInstance(mesh, i, k.x, k.y, k.z, k.sx, k.sy, k.sz, k.ry);
      mesh.setColorAt(i, k.light ? b : a);
    }
    mesh.count = blocks.length;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [blocks, colorA, colorB]);

  return (
    <instancedMesh ref={ref} args={[UNIT, material, capacity]} frustumCulled={false} />
  );
}

function Plants({ benches, layout }: { benches: RoomBench[]; layout: [number, number, number][] }) {
  const { soil, stem, leaf, bud } = usePlantBlocks(benches, layout);
  return (
    <>
      <BlockField blocks={soil} material={PLANT_MAT} colorA={PALETTE.soil} colorB={PALETTE.tray} />
      <BlockField blocks={stem} material={PLANT_MAT} colorA={PALETTE.stem} colorB={PALETTE.stem} />
      <BlockField blocks={leaf} material={PLANT_MAT} colorA={PALETTE.leaf} colorB={PALETTE.leafLight} />
      <BlockField blocks={bud} material={BUD_MAT} colorA={PALETTE.bud} colorB="#ffffff" />
    </>
  );
}

// ---------------------------------------------------------------- benches

function BenchUnit({
  bench,
  position,
  onFocus,
  focused,
}: {
  bench: RoomBench;
  position: [number, number, number];
  onFocus: (b: RoomBench | null) => void;
  focused: boolean;
}) {
  const topMat = useMemo(() => mat(PALETTE.benchTop), []);
  const legMat = useMemo(() => mat(PALETTE.benchLeg), []);

  const tone =
    bench.ready ? "#9ad34a"
    : bench.treatSlot !== null ? "#e2705a"
    : bench.feedIndex !== null ? "#e0a83b"
    : "#7fb8e0";

  return (
    <group
      position={position}
      onPointerOver={(e: ThreeEvent<PointerEvent>) => {
        e.stopPropagation();
        onFocus(bench);
      }}
      onPointerOut={() => onFocus(null)}
    >
      <mesh position={[0, 0.68, 0]} material={topMat} castShadow>
        <boxGeometry args={[1.8, 0.14, 1.2]} />
      </mesh>
      {[
        [-0.78, -0.46],
        [0.78, -0.46],
        [-0.78, 0.46],
        [0.78, 0.46],
      ].map(([x, z], i) => (
        <mesh key={i} position={[x, 0.31, z]} material={legMat}>
          <boxGeometry args={[0.14, 0.62, 0.14]} />
        </mesh>
      ))}

      {/* A block marker above the bench, so the room is readable at a glance. */}
      <mesh position={[0, 2.15, 0]}>
        <boxGeometry args={[focused ? 0.34 : 0.24, focused ? 0.34 : 0.24, focused ? 0.34 : 0.24]} />
        <meshStandardMaterial
          color={tone}
          emissive={tone}
          emissiveIntensity={focused ? 1.5 : 0.8}
          flatShading
        />
      </mesh>
    </group>
  );
}

// ---------------------------------------------------------------- other players

/**
 * Minecraft proportions, in metres.
 *
 * The classic model is 32 units tall where a unit is a sixteenth of a block, so
 * everything below is that grid multiplied by U. Keeping the real proportions is
 * what makes it read as the style rather than as generic boxes.
 */
const U = 1.8 / 32;
const HEAD = { s: 8 * U, y: 28 * U };
const BODY = { w: 8 * U, h: 12 * U, d: 4 * U, y: 18 * U };
const ARM = { w: 4 * U, h: 12 * U, d: 4 * U, pivotY: 24 * U, offX: 6 * U };
const LEG = { w: 4 * U, h: 12 * U, d: 4 * U, pivotY: 12 * U, offX: 2 * U };

const SKIN_TONES = ["#e8b98c", "#c98d5e", "#8d5a36", "#5f3a22", "#f2d3ae"];
const SHIRT_TONES = ["#3f7fbf", "#c9453a", "#5fbf4a", "#e0a83b", "#8a5fd0", "#d8d8d8", "#2f3a4a"];
const PANTS_TONES = ["#33405a", "#2f3a2c", "#4a3a2a", "#5a5a5a", "#26303c"];
const HAIR_TONES = ["#2b1d12", "#6b4423", "#a86a2c", "#d9c07a", "#1a1a1a", "#7a2f1e", "#4a4a52"];
const EYE_TONES = ["#3a2a18", "#2f5fa8", "#3f7a4a", "#5a4030", "#4a4a55"];

/**
 * The face, laid out on the eight by eight pixel grid a Minecraft skin uses for
 * the front of a head.
 *
 * `x` and `y` are pixel centres measured from the middle of the face, `w` and
 * `h` are pixel sizes. Everything is multiplied by U at draw time, so the
 * proportions are the real ones rather than something eyeballed.
 *
 * White on the outside of each eye and the iris toward the nose is how Steve is
 * actually drawn, and it is what stops two dark squares reading as a robot.
 */
const FACE_PARTS = [
  { tone: "white", x: -2.5, y: 0.5, w: 1, h: 1 },
  { tone: "eye", x: -1.5, y: 0.5, w: 1, h: 1 },
  { tone: "eye", x: 1.5, y: 0.5, w: 1, h: 1 },
  { tone: "white", x: 2.5, y: 0.5, w: 1, h: 1 },
  { tone: "mouth", x: 0, y: -1.5, w: 3, h: 1 },
] as const;

/** Face pixels plus the hair layer, which is one block rather than five. */
const FACE_PER_PEER = FACE_PARTS.length + 1;

/** Just proud of the head's front face, so nothing z fights with the skin. */
const FACE_Z = -(4 * U + 0.006);
const FACE_THICK = 0.012;

/** Eyes and a mouth are invisible past this, and shimmer if drawn anyway. */
const FACE_DISTANCE = 16;

const EYE_WHITE = "#f2f2ee";
const MOUTH_TONE = "#4a2f24";

type PeerVis = {
  x: number;
  z: number;
  ry: number;
  tx: number;
  tz: number;
  tRy: number;
  phase: number;
  speed: number;
  skin: string;
  shirt: string;
  pants: string;
  hair: string;
  eye: string;
};

/** Shortest way round the circle, so a peer turning past pi does not spin. */
function angleLerp(a: number, b: number, t: number): number {
  let diff = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * t;
}

/**
 * Every other player in the room, in five draw calls.
 *
 * Head, body, arms, legs and face detail are each one InstancedMesh, so the cost of a crowd
 * is the cost of writing matrices rather than the cost of traversing a scene
 * graph with thousands of nodes in it. Positions arrive from the presence server
 * about sixteen times a second and are interpolated here, so movement is smooth
 * without the server having to send more.
 */
function Peers({
  peersRef,
  cheats,
}: {
  peersRef: MutableRefObject<Peer[]>;
  cheats: CheatState;
}) {
  const headRef = useRef<THREE.InstancedMesh>(null);
  const bodyRef = useRef<THREE.InstancedMesh>(null);
  const armRef = useRef<THREE.InstancedMesh>(null);
  const legRef = useRef<THREE.InstancedMesh>(null);
  const faceRef = useRef<THREE.InstancedMesh>(null);

  const vis = useRef(new Map<string, PeerVis>());
  const cheat = useRef(cheats);
  cheat.current = cheats;

  const { camera } = useThree();

  useFrame((_, rawDt) => {
    const head = headRef.current;
    const body = bodyRef.current;
    const arm = armRef.current;
    const leg = legRef.current;
    const face = faceRef.current;
    if (!head || !body || !arm || !leg || !face) return;

    const dt = Math.min(rawDt, 0.1);
    const seen = new Set<string>();

    for (const p of peersRef.current) {
      seen.add(p.id);
      let v = vis.current.get(p.id);
      if (!v) {
        v = {
          x: p.x,
          z: p.z,
          ry: p.ry,
          tx: p.x,
          tz: p.z,
          tRy: p.ry,
          phase: hash01(p.id, 7) * Math.PI * 2,
          speed: 0,
          skin: SKIN_TONES[Math.floor(hash01(p.id, 1) * SKIN_TONES.length)],
          shirt: SHIRT_TONES[Math.floor(hash01(p.id, 2) * SHIRT_TONES.length)],
          pants: PANTS_TONES[Math.floor(hash01(p.id, 3) * PANTS_TONES.length)],
          hair: HAIR_TONES[Math.floor(hash01(p.id, 4) * HAIR_TONES.length)],
          eye: EYE_TONES[Math.floor(hash01(p.id, 5) * EYE_TONES.length)],
        };
        vis.current.set(p.id, v);
      }
      v.tx = p.x;
      v.tz = p.z;
      v.tRy = p.ry;
    }
    for (const id of vis.current.keys()) if (!seen.has(id)) vis.current.delete(id);

    // Interpolate toward the last position the server sent, and drive the walk
    // cycle from how fast that actually moved rather than from a timer.
    const drawable: PeerVis[] = [];
    for (const v of vis.current.values()) {
      const k = Math.min(1, dt * 11);
      const px = v.x;
      const pz = v.z;
      v.x += (v.tx - v.x) * k;
      v.z += (v.tz - v.z) * k;
      v.ry = angleLerp(v.ry, v.tRy, Math.min(1, dt * 9));

      const moved = Math.hypot(v.x - px, v.z - pz) / dt;
      v.speed += (moved - v.speed) * Math.min(1, dt * 8);
      v.phase += v.speed * 2.1 * dt;

      const dx = v.x - camera.position.x;
      const dz = v.z - camera.position.z;
      const distSq = dx * dx + dz * dz;
      if (distSq < PEER_CULL_DISTANCE * PEER_CULL_DISTANCE && distSq > PEER_NEAR_CLIP * PEER_NEAR_CLIP) {
        drawable.push(v);
      }
    }

    // Nearest first, then cut. A crowd past the cap is not drawn at all, which is
    // the whole reason a crowd is affordable.
    if (drawable.length > MAX_PEERS_DRAWN) {
      drawable.sort((a, b) => {
        const da = (a.x - camera.position.x) ** 2 + (a.z - camera.position.z) ** 2;
        const db = (b.x - camera.position.x) ** 2 + (b.z - camera.position.z) ** 2;
        return da - db;
      });
      drawable.length = MAX_PEERS_DRAWN;
    }

    const headScale = cheat.current.bighead ? 2.4 : 1;

    for (let i = 0; i < drawable.length; i++) {
      const v = drawable[i];
      const cos = Math.cos(v.ry);
      const sin = Math.sin(v.ry);
      // A stride, not a star jump. Real walking swings a limb about thirty
      // degrees, and the amplitude reaches full at roughly a running pace.
      const swing = Math.sin(v.phase) * Math.min(1, v.speed / 4) * 0.55;

      // A bigger head sits higher too, so it rests on the shoulders rather
      // than sinking into the chest.
      const hs = HEAD.s * headScale;
      const hy = HEAD.y + (hs - HEAD.s) / 2;
      setInstance(head, i, v.x, hy, v.z, hs, hs, hs, v.ry);
      head.setColorAt(i, _color.set(v.skin));

      setInstance(body, i, v.x, BODY.y, v.z, BODY.w, BODY.h, BODY.d, v.ry);
      body.setColorAt(i, _color.set(v.shirt));

      for (const side of [0, 1]) {
        const ox = side === 0 ? -ARM.offX : ARM.offX;
        const j = i * 2 + side;
        setInstance(
          arm,
          j,
          v.x + ox * cos,
          ARM.pivotY,
          v.z - ox * sin,
          ARM.w,
          ARM.h,
          ARM.d,
          v.ry,
          side === 0 ? swing : -swing
        );
        arm.setColorAt(j, _color.set(v.shirt));

        const lx = side === 0 ? -LEG.offX : LEG.offX;
        setInstance(
          leg,
          j,
          v.x + lx * cos,
          LEG.pivotY,
          v.z - lx * sin,
          LEG.w,
          LEG.h,
          LEG.d,
          v.ry,
          side === 0 ? -swing : swing
        );
        leg.setColorAt(j, _color.set(v.pants));
      }
    }

    /**
     * Faces, for whoever is close enough to have one.
     *
     * Each pixel of the face is a thin block sitting just proud of the head's
     * front surface, placed in head local coordinates and then rotated by the
     * peer's facing. A peer looks along its local negative Z, which is why the
     * face is on that side: the earlier version of this avatar put its facing
     * marker on positive Z and was quietly wearing it on the back of its head.
     *
     * All of it lands in one InstancedMesh, so a room full of faces is still one
     * draw call. Past FACE_DISTANCE a face is under a pixel across and only
     * shimmers, so it is skipped rather than drawn.
     */
    let faceCount = 0;
    for (let i = 0; i < drawable.length; i++) {
      const v = drawable[i];
      const dx = v.x - camera.position.x;
      const dz = v.z - camera.position.z;
      if (dx * dx + dz * dz > FACE_DISTANCE * FACE_DISTANCE) continue;

      const cos = Math.cos(v.ry);
      const sin = Math.sin(v.ry);
      // Head local offset to world, for a rotation of ry about Y.
      const faceLift = (HEAD.s * headScale - HEAD.s) / 2;
      const put = (lx: number, ly: number, lz: number, sx: number, sy: number, sz: number, tone: string) => {
        setInstance(
          face,
          faceCount,
          v.x + (lx * cos + lz * sin) * headScale,
          HEAD.y + faceLift + ly * headScale,
          v.z + (-lx * sin + lz * cos) * headScale,
          sx * headScale,
          sy * headScale,
          sz * headScale,
          v.ry
        );
        face.setColorAt(faceCount, _color.set(tone));
        faceCount++;
      };

      for (const part of FACE_PARTS) {
        const tone =
          part.tone === "white" ? EYE_WHITE : part.tone === "eye" ? v.eye : MOUTH_TONE;
        put(part.x * U, part.y * U, FACE_Z, part.w * U, part.h * U, FACE_THICK, tone);
      }

      // The hair sits over the head as a slightly larger block, the way a skin's
      // hat layer does, so it covers the top and both sides in one instance.
      put(0, 2.25 * U, 0, 8.5 * U, 3.5 * U, 8.5 * U, v.hair);
    }

    head.count = drawable.length;
    body.count = drawable.length;
    arm.count = drawable.length * 2;
    leg.count = drawable.length * 2;
    face.count = faceCount;

    head.instanceMatrix.needsUpdate = true;
    body.instanceMatrix.needsUpdate = true;
    arm.instanceMatrix.needsUpdate = true;
    leg.instanceMatrix.needsUpdate = true;
    face.instanceMatrix.needsUpdate = true;
    if (head.instanceColor) head.instanceColor.needsUpdate = true;
    if (body.instanceColor) body.instanceColor.needsUpdate = true;
    if (arm.instanceColor) arm.instanceColor.needsUpdate = true;
    if (leg.instanceColor) leg.instanceColor.needsUpdate = true;
    if (face.instanceColor) face.instanceColor.needsUpdate = true;
  });

  return (
    <>
      <instancedMesh ref={headRef} args={[UNIT, SKIN_MAT, MAX_PEERS_DRAWN]} frustumCulled={false} />
      <instancedMesh ref={bodyRef} args={[UNIT, CLOTH_MAT, MAX_PEERS_DRAWN]} frustumCulled={false} />
      <instancedMesh ref={armRef} args={[LIMB, CLOTH_MAT, MAX_PEERS_DRAWN * 2]} frustumCulled={false} />
      <instancedMesh ref={legRef} args={[LIMB, CLOTH_MAT, MAX_PEERS_DRAWN * 2]} frustumCulled={false} />
      <instancedMesh
        ref={faceRef}
        args={[UNIT, FACE_MAT, MAX_PEERS_DRAWN * FACE_PER_PEER]}
        frustumCulled={false}
      />
    </>
  );
}

// ---------------------------------------------------------------- controls

/** Standing eye height, in metres. */
const EYE = 1.65;

/**
 * First person movement. WASD to walk, mouse to look once the canvas is clicked.
 *
 * Deliberately hand rolled rather than pulling in another dependency: it is
 * thirty lines, and the collision is a clamp against the room bounds because a
 * physics engine for a rectangular room would be silly.
 */
function Player({
  bounds,
  cheats,
  onMove,
  onInteract,
}: {
  bounds: { w: number; d: number; h: number };
  cheats: CheatState;
  onMove: (x: number, z: number, ry: number) => void;
  onInteract: () => void;
}) {
  const { camera, gl } = useThree();
  const keys = useRef<Record<string, boolean>>({});
  const yaw = useRef(0);
  const pitch = useRef(0);
  const locked = useRef(false);
  const vy = useRef(0);
  // Read inside the frame loop, so toggling a code takes effect immediately
  // without the movement handler being torn down and rebuilt.
  const cheat = useRef(cheats);
  cheat.current = cheats;

  useEffect(() => {
    camera.position.set(0, EYE, bounds.d / 2 - 2.5);

    const down = (e: KeyboardEvent) => {
      keys.current[e.code] = true;
      // Space is a jetpack and a jump in here, never a page scroll.
      if (e.code === "Space") e.preventDefault();
      // E runs whatever the prompt is offering, so the pointer never has to be
      // released to plant, feed, treat or harvest.
      if (e.code === "KeyE") onInteract();
    };
    const up = (e: KeyboardEvent) => {
      keys.current[e.code] = false;
    };
    const move = (e: MouseEvent) => {
      if (!locked.current) return;
      yaw.current -= e.movementX * 0.0022;
      pitch.current -= e.movementY * 0.0022;
      pitch.current = Math.max(-1.2, Math.min(1.2, pitch.current));
    };
    const lockChange = () => {
      locked.current = document.pointerLockElement === gl.domElement;
    };
    const click = () => {
      if (!locked.current) void gl.domElement.requestPointerLock();
    };

    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    document.addEventListener("mousemove", move);
    document.addEventListener("pointerlockchange", lockChange);
    gl.domElement.addEventListener("click", click);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      document.removeEventListener("mousemove", move);
      document.removeEventListener("pointerlockchange", lockChange);
      gl.domElement.removeEventListener("click", click);
    };
  }, [camera, gl, bounds.d, onInteract]);

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.05);
    const c = cheat.current;
    const base = keys.current["ShiftLeft"] ? 6.5 : 3.4;
    const speed = base * (c.fast ? 2.4 : 1) * dt;
    const f = (keys.current["KeyW"] ? 1 : 0) - (keys.current["KeyS"] ? 1 : 0);
    const s = (keys.current["KeyD"] ? 1 : 0) - (keys.current["KeyA"] ? 1 : 0);

    if (f !== 0 || s !== 0) {
      const len = Math.hypot(f, s);
      const fx = -Math.sin(yaw.current);
      const fz = -Math.cos(yaw.current);
      camera.position.x += ((fx * f + Math.cos(yaw.current) * s) / len) * speed;
      camera.position.z += ((fz * f - Math.sin(yaw.current) * s) / len) * speed;
    }

    // Keep the player inside the shell.
    const m = 1.1;
    camera.position.x = Math.max(-bounds.w / 2 + m, Math.min(bounds.w / 2 - m, camera.position.x));
    camera.position.z = Math.max(-bounds.d / 2 + m, Math.min(bounds.d / 2 - m, camera.position.z));

    /**
     * Height. Eye level unless a code says otherwise.
     *
     * The jetpack hovers rather than falling, so releasing the key parks you in
     * mid air. Moon gravity keeps normal jumping but pulls a fifth as hard, and
     * with neither code on there is no vertical movement at all, which is the
     * behaviour every other part of the room was written against.
     */
    const ceiling = bounds.h - 0.4;
    const jumping = keys.current["Space"];

    if (c.jetpack) {
      const lift = jumping ? 5.2 : keys.current["ControlLeft"] ? -5.2 : 0;
      camera.position.y = Math.max(EYE, Math.min(ceiling, camera.position.y + lift * dt));
      vy.current = 0;
    } else if (c.moon) {
      const grounded = camera.position.y <= EYE + 0.001;
      if (grounded && jumping) vy.current = 6.4;
      vy.current -= 3.4 * dt;
      camera.position.y = Math.min(ceiling, camera.position.y + vy.current * dt);
      if (camera.position.y <= EYE) {
        camera.position.y = EYE;
        vy.current = 0;
      }
    } else if (camera.position.y !== EYE) {
      // A code was switched off in mid air. Come down rather than hang there.
      vy.current -= 18 * dt;
      camera.position.y = Math.max(EYE, camera.position.y + vy.current * dt);
      if (camera.position.y === EYE) vy.current = 0;
    }

    camera.rotation.set(pitch.current, yaw.current, 0, "YXZ");
    onMove(camera.position.x, camera.position.z, yaw.current);
  });

  return null;
}

/** Picks whichever bench the player is closest to and actually facing. */
function Proximity({
  benches,
  layout,
  onNear,
}: {
  benches: RoomBench[];
  layout: [number, number, number][];
  onNear: (b: RoomBench | null) => void;
}) {
  const { camera } = useThree();
  const last = useRef<string>("");

  useFrame(() => {
    let best: RoomBench | null = null;
    let bestD = 3.2;
    for (let i = 0; i < benches.length; i++) {
      const p = layout[i];
      if (!p) continue;
      const dx = camera.position.x - p[0];
      const dz = camera.position.z - p[2];
      const dist = Math.hypot(dx, dz);
      if (dist < bestD) {
        bestD = dist;
        best = benches[i];
      }
    }
    const key = best ? best.id.toString() : "";
    if (key !== last.current) {
      last.current = key;
      onNear(best);
    }
  });

  return null;
}

// ---------------------------------------------------------------- the room

export function GrowRoom({
  benches,
  peersRef,
  cheats = NO_CHEATS,
  onNear,
  onMove,
  onInteract,
}: {
  benches: RoomBench[];
  peersRef: MutableRefObject<Peer[]>;
  cheats?: CheatState;
  onNear: (b: RoomBench | null) => void;
  onMove: (x: number, z: number, ry: number) => void;
  onInteract: () => void;
}) {
  const [focused, setFocused] = useState<RoomBench | null>(null);

  // Whole metres, because the shell is built out of one metre blocks.
  const w = 16;
  const d = 22;
  const h = 5;

  /**
   * Lighting, as one table rather than a conditional per light.
   *
   * Every visual cheat is a change to these numbers and nothing else, which is
   * what keeps them provably cosmetic: there is no path from any of this to a
   * yield, a balance or a contract call.
   */
  const look = useMemo(() => {
    const base = {
      clear: "#141a10",
      fog: "#1b2216",
      fogNear: 20,
      fogFar: 62,
      ambient: 0.85,
      ambientColor: "#cfd8bc",
      sky: "#f0f6e0",
      ground: "#2a3222",
      hemi: 0.7,
      sun: 0.55,
      sunColor: "#ffe6b8",
    };
    if (cheats.night) {
      return {
        ...base,
        clear: "#05070a",
        fog: "#070a10",
        fogNear: 8,
        fogFar: 34,
        ambient: 0.1,
        ambientColor: "#7f93c4",
        sky: "#33406b",
        ground: "#05070a",
        hemi: 0.16,
        sun: 0.04,
        sunColor: "#8fa6df",
      };
    }
    if (cheats.hot) {
      return {
        ...base,
        clear: "#e8e2b4",
        fog: "#ede7bd",
        fogNear: 30,
        fogFar: 95,
        ambient: 2.1,
        ambientColor: "#fffbe4",
        sky: "#ffffff",
        ground: "#cfc98f",
        hemi: 1.5,
        sun: 1.5,
        sunColor: "#fff3c4",
      };
    }
    if (cheats.pink) {
      return {
        ...base,
        clear: "#2a1020",
        fog: "#3d1730",
        fogNear: 16,
        fogFar: 58,
        ambient: 1.15,
        ambientColor: "#ff9ad5",
        sky: "#ffd0ec",
        ground: "#5a1f45",
        hemi: 0.95,
        sun: 0.8,
        sunColor: "#ff7fc4",
      };
    }
    if (cheats.gold) {
      return {
        ...base,
        clear: "#191204",
        fog: "#241a06",
        fogNear: 18,
        fogFar: 60,
        ambient: 1.2,
        ambientColor: "#ffd469",
        sky: "#fff0bd",
        ground: "#3a2a08",
        hemi: 0.9,
        sun: 0.9,
        sunColor: "#ffcf4d",
      };
    }
    return base;
  }, [cheats.night, cheats.hot, cheats.pink, cheats.gold]);

  const layout = useMemo<[number, number, number][]>(() => {
    const out: [number, number, number][] = [];
    const perRow = 4;
    for (let i = 0; i < benches.length; i++) {
      const row = Math.floor(i / perRow);
      const col = i % perRow;
      out.push([-w / 4 + (row % 2) * (w / 2), 0, -d / 2 + 4 + col * 3.4]);
    }
    return out;
  }, [benches.length]);

  return (
    <Canvas
      shadows={false}
      dpr={[1, 1.75]}
      camera={{ fov: 72, near: 0.1, far: 120 }}
      gl={{ antialias: false }}
      style={{ background: look.clear }}
    >
      <fog attach="fog" args={[look.fog, look.fogNear, look.fogFar]} />
      <ambientLight intensity={look.ambient} color={look.ambientColor} />
      <hemisphereLight args={[look.sky, look.ground, look.hemi]} />
      <directionalLight position={[6, 10, 3]} intensity={look.sun} color={look.sunColor} />

      <Shell w={w} d={d} h={h} />
      <Pillars w={w} d={d} h={h} />
      <Lamps w={w} d={d} h={h} />
      <WallArt w={w} d={d} h={h} />

      {benches.map((b, i) => (
        <BenchUnit
          key={b.id.toString()}
          bench={b}
          position={layout[i] ?? [0, 0, 0]}
          onFocus={setFocused}
          focused={focused?.id === b.id}
        />
      ))}
      <Plants benches={benches} layout={layout} />

      <Peers peersRef={peersRef} cheats={cheats} />

      <Player bounds={{ w, d, h }} cheats={cheats} onMove={onMove} onInteract={onInteract} />
      <Proximity benches={benches} layout={layout} onNear={onNear} />
    </Canvas>
  );
}

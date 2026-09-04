"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Cheat codes, typed the way the game they are named after took them: no input
 * box, no submit button, you just start typing while you are walking around.
 *
 * Every one of these is cosmetic and lives entirely in this browser. Nothing
 * here touches a contract, a balance, a grow, a yield or a reward, and none of
 * it is sent to any server. That is deliberate rather than a limitation: this
 * whole protocol is built on the claim that nothing is minted and no deposit
 * funds anybody's payout, and a cheat code that handed out an advantage would
 * be the one thing that made that claim false.
 *
 * So the joke is the inversion. The code this project is named after gave you
 * health, armour and money for nothing. Type it here and it tells you, plainly,
 * that it did not.
 *
 * If a paid code is ever added it belongs on chain, priced above what it is
 * worth, charged straight to the RevenueRouter, and it must be committed before
 * the grow's beacon round reveals. Not here.
 */

export type CheatState = {
  jetpack: boolean;
  moon: boolean;
  fast: boolean;
  night: boolean;
  hot: boolean;
  pink: boolean;
  bighead: boolean;
  gold: boolean;
};

export const NO_CHEATS: CheatState = {
  jetpack: false,
  moon: false,
  fast: false,
  night: false,
  hot: false,
  pink: false,
  bighead: false,
  gold: false,
};

type Cheat = {
  code: string;
  key: keyof CheatState;
  label: string;
  /** Shown in the code list, so nobody expects an advantage from any of these. */
  effect: string;
};

/**
 * The codes.
 *
 * Public on purpose. These are short uppercase strings, so a hash of one is
 * brute forced in milliseconds and treating them as secrets would only be
 * theatre. They are meant to be passed around.
 */
export const CHEATS: Cheat[] = [
  {
    code: "HESOYAM",
    key: "gold",
    label: "Somebody paid for it",
    effect: "Gold wash over the room. Adds nothing to your balance, which is the point.",
  },
  {
    code: "ROCKETMAN",
    key: "jetpack",
    label: "Jetpack",
    effect: "Space to rise, left ctrl to drop. Fly the bay.",
  },
  {
    code: "CJPHONEHOME",
    key: "moon",
    label: "Moon gravity",
    effect: "Space to jump, and you come down slowly.",
  },
  {
    code: "SPEEDITUP",
    key: "fast",
    label: "Speed freak",
    effect: "Everything moves faster on foot.",
  },
  {
    code: "NIGHTPROWLER",
    key: "night",
    label: "Always night",
    effect: "Kills the daylight. The grow lamps become the only light in the room.",
  },
  {
    code: "TOODAMNHOT",
    key: "hot",
    label: "Blown out",
    effect: "Midday glare through the whole bay.",
  },
  {
    code: "PINKISTHENEWCOOL",
    key: "pink",
    label: "Pink",
    effect: "Exactly what it says.",
  },
  {
    code: "BIGHEADMODE",
    key: "bighead",
    label: "Big heads",
    effect: "Everybody else in the room grows a much larger head.",
  },
];

const LONGEST = CHEATS.reduce((n, c) => Math.max(n, c.code.length), 0);

export type CheatFlash = { label: string; on: boolean; at: number };

/**
 * The longest tail of the buffer that could still become a code.
 *
 * This is what makes an on screen echo usable rather than noise. Walking holds
 * W, A, S and D down, and every one of those lands in the buffer, so echoing the
 * raw buffer would just spew "WWWAASSDD" across the screen the whole time you
 * move. Showing only a live prefix means the echo stays blank while you walk and
 * appears the moment you start typing something that could be a real code.
 */
function livePrefix(buffer: string): string {
  for (let start = 0; start < buffer.length; start++) {
    const tail = buffer.slice(start);
    if (CHEATS.some((c) => c.code.startsWith(tail))) return tail;
  }
  return "";
}

/**
 * Watches the keyboard for a code and toggles it.
 *
 * A ring buffer of the last few letters, matched against every code on each
 * keystroke. Typing a code a second time turns it back off, the way a toggle
 * cheat behaves in the original.
 *
 * The buffer deliberately does not swallow the keystroke: typing HESOYAM while
 * standing in the room also walks you around a bit, because A and S are in it.
 * That is what happens in the game too.
 */
export function useCheats(enabled: boolean) {
  const [cheats, setCheats] = useState<CheatState>(NO_CHEATS);
  const [flash, setFlash] = useState<CheatFlash | null>(null);
  /** What to echo on screen. Empty unless a real code is being typed. */
  const [typing, setTyping] = useState("");
  const buffer = useRef("");

  useEffect(() => {
    if (!enabled) return;
    let idle: ReturnType<typeof setTimeout>;

    const onKey = (e: KeyboardEvent) => {
      // Somebody filling in the watch address box is not entering a cheat.
      const el = document.activeElement;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      const ch = e.key.length === 1 ? e.key.toUpperCase() : "";
      if (ch < "A" || ch > "Z") return;

      buffer.current = (buffer.current + ch).slice(-LONGEST);

      const hit = CHEATS.find((c) => buffer.current.endsWith(c.code));
      if (!hit) {
        // Show progress, and give up on it after a pause so a half typed code
        // does not sit on screen forever.
        setTyping(livePrefix(buffer.current));
        clearTimeout(idle);
        idle = setTimeout(() => setTyping(""), 1600);
        return;
      }

      buffer.current = "";
      setTyping("");
      clearTimeout(idle);
      setCheats((prev) => {
        const on = !prev[hit.key];
        setFlash({ label: hit.label, on, at: Date.now() });
        return { ...prev, [hit.key]: on };
      });
    };

    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      clearTimeout(idle);
    };
  }, [enabled]);

  // The banner clears itself rather than sitting there.
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 2600);
    return () => clearTimeout(t);
  }, [flash]);

  const reset = () => {
    setCheats(NO_CHEATS);
    setTyping("");
    buffer.current = "";
  };

  return { cheats, flash, typing, reset };
}

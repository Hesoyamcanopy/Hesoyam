import { keccak256, toHex, type Hex } from "viem";

/**
 * The beacon hash chain.
 *
 * Built backwards from a secret. `chain[0]` is the head that gets published on
 * chain and never changes. Revealing walks forward: round 1 reveals `chain[1]`,
 * round 2 reveals `chain[2]`, and each link hashes to the one before it, which
 * is what the contract verifies.
 *
 * SECURITY, because this is the sensitive part of the whole system.
 *
 * The secret determines every future link. Anyone holding it can compute what
 * the next preimage will be. They still cannot substitute a different one, since
 * the head is fixed on chain and finding a second preimage means breaking
 * keccak, so a leak cannot let anyone steer an outcome.
 *
 * What a leak WOULD threaten is prediction. A player who knew the next preimage
 * could try to grind their own commit against it. The contract mixes the reveal
 * block's hash into the round seed specifically to stop that: at the moment a
 * player plants, the hash of the block that will carry the next reveal does not
 * exist yet, so the seed is unknown even to whoever holds the secret.
 *
 * That leaves one residual trust assumption worth stating plainly: an attacker
 * who both holds the secret AND can influence which block the reveal lands in
 * has more leverage than either alone. Keep the secret off shared machines, and
 * do not run the revealer from the same key that owns the contracts.
 */
export function buildChain(secret: string, length: number): Hex[] {
  if (length < 2) throw new Error("chain length must be at least 2");
  const out = new Array<Hex>(length);
  out[length - 1] = keccak256(toHex(secret));
  for (let i = length - 1; i > 0; i--) {
    out[i - 1] = keccak256(out[i]);
  }
  return out;
}

/**
 * Verifies a chain end to end before it is used for anything.
 *
 * Cheap, and it catches the one mistake that would be unrecoverable: publishing
 * a head that the revealer cannot actually walk. Once `commitChain` is called it
 * cannot be called again, so a wrong head bricks the beacon permanently.
 */
export function verifyChain(chain: Hex[]): boolean {
  for (let i = 0; i < chain.length - 1; i++) {
    if (keccak256(chain[i + 1]) !== chain[i]) return false;
  }
  return true;
}

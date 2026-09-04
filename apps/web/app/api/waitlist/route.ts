import { NextResponse } from "next/server";
import { isAddress } from "viem";

/**
 * Mainnet waitlist signup.
 *
 * Writes through Supabase's REST interface with plain fetch rather than pulling in
 * the JS client, because one insert does not justify a dependency in the browser
 * bundle's workspace. The service role key is read server side only and never
 * prefixed NEXT_PUBLIC_, so it cannot leak into the client.
 *
 * Signing is deliberately not required. This is a mailing list, not a claim, and
 * an address someone else typed in gets them nothing that address does not already
 * get. Whatever the launch grants is decided on chain against these addresses, at
 * which point the wallet has to sign for itself.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TABLE = "waitlist";

export async function POST(request: Request) {
  // Validate the request before checking server config. A malformed address is the
  // caller's problem and deserves its own message whether or not the backing store
  // happens to be configured.
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Send a JSON body." }, { status: 400 });
  }

  const wallet = (body as { wallet?: unknown })?.wallet;
  if (typeof wallet !== "string" || !isAddress(wallet.trim())) {
    return NextResponse.json(
      { error: "That is not a valid wallet address. It should start with 0x and be 42 characters." },
      { status: 400 }
    );
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  // A missing key is an operator problem, not a visitor problem. Say so plainly in
  // the log and give the visitor something true rather than a generic failure.
  if (!url || !key) {
    console.error("waitlist: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set");
    return NextResponse.json(
      { error: "The waitlist is not accepting signups yet. Try again shortly." },
      { status: 503 }
    );
  }

  const source = (body as { source?: unknown })?.source;

  const res = await fetch(`${url}/rest/v1/${TABLE}`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      // Upsert. A repeat signup is the same intent as the first one, so it should
      // be idempotent rather than an error the visitor has to interpret.
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify({
      wallet: wallet.trim().toLowerCase(),
      source: typeof source === "string" ? source.slice(0, 64) : null,
      user_agent: request.headers.get("user-agent")?.slice(0, 256) ?? null,
    }),
    cache: "no-store",
  });

  if (!res.ok) {
    console.error("waitlist: supabase responded", res.status, await res.text().catch(() => ""));
    return NextResponse.json(
      { error: "Could not save that just now. Try again in a moment." },
      { status: 502 }
    );
  }

  return NextResponse.json({ ok: true });
}

/**
 * Sign In With Ethereum, as a Supabase Edge Function.
 *
 * Two routes.
 *   POST /siwe/nonce   { address }            -> { nonce, message }
 *   POST /siwe/verify  { message, signature } -> { token, wallet, expiresAt }
 *
 * The token is a Supabase compatible JWT carrying a `wallet` claim, which is what the
 * row level security policies read through auth_wallet(). The client hands it to
 * supabase.auth.setSession and every later query is scoped to that address.
 *
 * This function holds the JWT secret and the service role key. It signs nothing on
 * chain and holds no wallet key, because it never needs one. Do not add one.
 *
 * Deno runtime. Type errors from the editor's Node typings are expected here.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { verifyMessage } from "https://esm.sh/viem@2.21.0";
import { create, getNumericDate } from "https://deno.land/x/djwt@v3.0.2/mod.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const JWT_SECRET = Deno.env.get("SUPABASE_JWT_SECRET")!;
const DOMAIN = Deno.env.get("SIWE_DOMAIN") ?? "hesoyam.fi";
const CHAIN_ID = Number(Deno.env.get("SIWE_CHAIN_ID") ?? "421614");
const SESSION_SECONDS = 60 * 60 * 12;

const db = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...cors() },
  });

function cors() {
  return {
    "access-control-allow-origin": Deno.env.get("ALLOWED_ORIGIN") ?? "*",
    "access-control-allow-headers": "content-type, authorization",
    "access-control-allow-methods": "POST, OPTIONS",
  };
}

const isAddress = (v: unknown): v is string => typeof v === "string" && /^0x[a-fA-F0-9]{40}$/.test(v);

/** EIP-4361 message. Kept minimal and built server side so the client cannot alter the terms. */
function buildMessage(address: string, nonce: string, issuedAt: string) {
  return [
    `${DOMAIN} wants you to sign in with your Ethereum account:`,
    address,
    "",
    "Sign in to Hesoyam. This does not authorise any transaction and cannot move funds.",
    "",
    `URI: https://${DOMAIN}`,
    "Version: 1",
    `Chain ID: ${CHAIN_ID}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
  ].join("\n");
}

function parseMessage(message: string) {
  const lines = message.split("\n");
  const address = lines[1]?.trim() ?? "";
  const field = (name: string) =>
    lines.find((l) => l.startsWith(`${name}: `))?.slice(name.length + 2)?.trim() ?? "";
  return {
    address,
    nonce: field("Nonce"),
    issuedAt: field("Issued At"),
    chainId: Number(field("Chain ID")),
  };
}

async function signingKey() {
  return await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(JWT_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

async function handleNonce(body: Record<string, unknown>) {
  if (!isAddress(body.address)) return json({ error: "A valid address is required." }, 400);
  const address = body.address.toLowerCase();

  const nonce = crypto.randomUUID().replace(/-/g, "");
  const issuedAt = new Date().toISOString();

  const { error } = await db.from("siwe_nonces").insert({ nonce, address });
  if (error) return json({ error: "Could not issue a nonce." }, 500);

  return json({ nonce, message: buildMessage(address, nonce, issuedAt) });
}

async function handleVerify(body: Record<string, unknown>) {
  const { message, signature } = body as { message?: string; signature?: string };
  if (typeof message !== "string" || typeof signature !== "string") {
    return json({ error: "A message and a signature are required." }, 400);
  }

  const parsed = parseMessage(message);
  if (!isAddress(parsed.address)) return json({ error: "Malformed message." }, 400);
  if (parsed.chainId !== CHAIN_ID) return json({ error: "Wrong chain." }, 400);
  if (!message.startsWith(`${DOMAIN} wants you to sign in`)) {
    return json({ error: "Wrong domain." }, 400);
  }

  // The nonce has to exist, be unused, and belong to this address. Consuming it is a
  // conditional update, so two requests racing the same nonce cannot both win.
  const { data: rows, error: claimError } = await db
    .from("siwe_nonces")
    .update({ consumed: true })
    .eq("nonce", parsed.nonce)
    .eq("consumed", false)
    .eq("address", parsed.address.toLowerCase())
    .gt("expires_at", new Date().toISOString())
    .select();

  if (claimError) return json({ error: "Could not verify." }, 500);
  if (!rows || rows.length === 0) return json({ error: "Nonce is unknown, used or expired." }, 401);

  const valid = await verifyMessage({
    address: parsed.address as `0x${string}`,
    message,
    signature: signature as `0x${string}`,
  });
  if (!valid) return json({ error: "Signature does not match." }, 401);

  const wallet = parsed.address.toLowerCase();
  const expiresAt = getNumericDate(SESSION_SECONDS);

  const token = await create(
    { alg: "HS256", typ: "JWT" },
    {
      // Supabase reads `sub` and `role`. `wallet` is ours, read by auth_wallet().
      sub: wallet,
      role: "authenticated",
      aud: "authenticated",
      wallet,
      exp: expiresAt,
      iat: getNumericDate(0),
    },
    await signingKey()
  );

  await db.from("profiles").upsert({ wallet }, { onConflict: "wallet", ignoreDuplicates: true });

  return json({ token, wallet, expiresAt });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors() });
  if (req.method !== "POST") return json({ error: "POST only." }, 405);

  const url = new URL(req.url);
  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return json({ error: "Body must be JSON." }, 400);
  }

  if (url.pathname.endsWith("/nonce")) return await handleNonce(body);
  if (url.pathname.endsWith("/verify")) return await handleVerify(body);
  return json({ error: "Unknown route." }, 404);
});

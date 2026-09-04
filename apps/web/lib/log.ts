/**
 * Structured logging.
 *
 * One line of JSON per event in production so a log drain can parse it, and a
 * readable line in development. Every log carries a `scope` so a noisy subsystem can
 * be filtered without grepping message text.
 *
 * `captureError` is the single seam an error tracker plugs into. Swap the body for a
 * Sentry, Highlight or Axiom call and nothing else in the app changes.
 */

type Level = "debug" | "info" | "warn" | "error";

type Fields = Record<string, unknown>;

const isProd = process.env.NODE_ENV === "production";
const MIN: Level = (process.env.NEXT_PUBLIC_LOG_LEVEL as Level) || (isProd ? "info" : "debug");

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Keys whose values are replaced before anything is written. */
const REDACT = new Set(["privateKey", "sessionKey", "mnemonic", "seed", "authorization", "jwt", "password"]);

function redact(fields: Fields): Fields {
  const out: Fields = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = REDACT.has(k) ? "[redacted]" : v;
  }
  return out;
}

function emit(level: Level, scope: string, message: string, fields: Fields = {}) {
  if (ORDER[level] < ORDER[MIN]) return;

  const safe = redact(fields);
  const line = { level, scope, message, time: new Date().toISOString(), ...safe };

  const target = level === "error" ? console.error : level === "warn" ? console.warn : console.log;

  if (isProd) {
    target(JSON.stringify(line));
    return;
  }
  const extra = Object.keys(safe).length ? " " + JSON.stringify(safe) : "";
  target(`${level.toUpperCase().padEnd(5)} [${scope}] ${message}${extra}`);
}

export function logger(scope: string) {
  return {
    debug: (message: string, fields?: Fields) => emit("debug", scope, message, fields),
    info: (message: string, fields?: Fields) => emit("info", scope, message, fields),
    warn: (message: string, fields?: Fields) => emit("warn", scope, message, fields),
    error: (message: string, fields?: Fields) => emit("error", scope, message, fields),
  };
}

/**
 * The one place an error reporter is wired in. Called by the app's error boundary and
 * by any catch block that has given up on recovering.
 */
export function captureError(error: unknown, context: Fields = {}) {
  const err =
    error instanceof Error
      ? { name: error.name, message: error.message, stack: error.stack }
      : { name: "NonError", message: String(error) };

  emit("error", context.scope ? String(context.scope) : "app", err.message, {
    ...context,
    errorName: err.name,
    stack: err.stack,
  });

  // Wire a real tracker here. Keep it non throwing: a failed report must never
  // become a second error on top of the first.
}

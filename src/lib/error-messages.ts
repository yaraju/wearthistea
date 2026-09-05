/**
 * Turn a raw internal error message (a Prisma error, a GCS SDK error, a
 * Gemini SDK error blob, a stack fragment, etc.) into on-brand, human copy
 * safe to show a customer. Used both server-side (to sanitize what routes
 * return in the `error` field of a JSON response) and client-side (defense
 * in depth, in case an unmapped raw string ever reaches the UI another way).
 *
 * The raw message should still be logged/persisted wherever it already is —
 * this function is only for what gets shown on screen. A short, human-
 * authored message (e.g. a validation error a route already wrote on
 * purpose, like "Please fill in the required address fields.") is passed
 * through unchanged — only messages that actually look like internals
 * (stack fragments, JSON error blobs, driver/SDK error codes) get replaced.
 */
function looksRaw(msg: string): boolean {
  if (msg.length > 140) return true;
  if (/[{}[\]]/.test(msg)) return true; // JSON error payloads (Gemini, Printrove, etc.)
  if (/\bat \S+\(|node_modules|\.(ts|js|tsx|jsx):\d+/.test(msg)) return true; // stack fragments
  if (/\b(TypeError|SyntaxError|ReferenceError|RangeError|PrismaClientKnownRequestError|ENOENT|EACCES|ECONNREFUSED)\b/.test(msg)) return true;
  if (/\bP\d{4}\b/.test(msg)) return true; // Prisma error codes
  return false;
}

export function friendlyError(msg: string): string {
  if (/RESOURCE_EXHAUSTED|quota|\b429\b|\b503\b|UNAVAILABLE|high demand|swamped/i.test(msg)) {
    return "Our design engine is swamped right now — try again in a moment.";
  }
  if (/bucket|GCS|ENOENT|no such file|storage/i.test(msg)) {
    return "We brewed it but couldn't pour it into storage — try again in a moment.";
  }
  if (/no image data|returned no image|safety|blocked/i.test(msg)) {
    return "That one didn't brew right — try a different phrase or style.";
  }
  if (/^Firebase:|auth\/[a-z-]+/i.test(msg)) {
    return "Couldn't sign you in — try again in a moment.";
  }
  if (looksRaw(msg)) {
    return "Something curdled while we were brewing that — try again in a moment.";
  }
  return msg;
}

// Optional addon auth. Off unless BITCHORD_AUTH=1.
// Enabling it needs the official verifier from the BitChord docs saved,
// unchanged, as src/bitchord-addon-auth.mjs. BitChord desktop/web cannot
// pass this check, so leave it off if you test on desktop.

export async function loadAuth() {
  if (process.env.BITCHORD_AUTH !== "1") return null;
  const hosts = (process.env.ADDON_HOSTS || "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  if (!hosts.length) {
    throw new Error("BITCHORD_AUTH=1 needs ADDON_HOSTS (public hostname, no scheme/port/path)");
  }
  let mod;
  try {
    mod = await import("./bitchord-addon-auth.mjs");
  } catch {
    throw new Error("Save the official verifier as src/bitchord-addon-auth.mjs (see BitChord docs, Addon auth)");
  }
  return mod.createBitChordAuth({ hosts });
}

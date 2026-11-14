import { createHandler } from "./handler.js";
import { loadAuth } from "./auth.js";
import * as jamendo from "./providers/jamendo.js";
import * as custom from "./providers/custom.js";
import * as tidal from "./providers/tidal.js";

const providers = { jamendo, custom, tidal };
let handlerPromise;

function requiredSecret(name, minimum = 32) {
  const value = String(process.env[name] || "").trim();
  if (value.length < minimum) {
    throw new Error(`${name} must be configured with at least ${minimum} characters`);
  }
  if (name === "ADDON_PATH_SECRET" && !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("ADDON_PATH_SECRET may contain only URL-safe letters, numbers, _ and -");
  }
  return value;
}

export function getHandler() {
  handlerPromise ??= (async () => {
    const name = process.env.PROVIDER || "tidal";
    const provider = providers[name];
    if (!provider) throw new Error(`Unknown PROVIDER "${name}"`);

    const pathSecret = requiredSecret("ADDON_PATH_SECRET");
    const mediaSecret = requiredSecret("MEDIA_URL_SECRET");
    const bridgeToken = requiredSecret("INTERNAL_BRIDGE_TOKEN");
    const adminPassword = requiredSecret("ADMIN_PASSWORD", 16);

    return createHandler({
      provider,
      auth: await loadAuth(),
      pathSecret,
      mediaSecret,
      bridgeToken,
      adminPassword,
      adminUsername: process.env.ADMIN_USERNAME || "admin",
      bridgeUrl: process.env.MORNYE_BRIDGE_URL || "http://127.0.0.1:8765",
      mediaTtlSeconds: Number(process.env.MEDIA_URL_TTL_SECONDS || 3600),
      meta: {
        id: process.env.ADDON_ID || "personal.bitchord.tidal.mornye",
        name: process.env.ADDON_NAME || "Personal TIDAL (Mornye)",
        version: "0.3.0",
      },
    });
  })();
  return handlerPromise;
}

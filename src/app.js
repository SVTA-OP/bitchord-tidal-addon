import { createHandler } from "./handler.js";
import { loadAuth } from "./auth.js";
import * as jamendo from "./providers/jamendo.js";
import * as custom from "./providers/custom.js";
import * as tidal from "./providers/tidal.js";

const providers = { jamendo, custom, tidal };

let handlerPromise;

export function getHandler() {
  handlerPromise ??= (async () => {
    const name = process.env.PROVIDER || "jamendo";
    const provider = providers[name];
    if (!provider) throw new Error(`Unknown PROVIDER "${name}"`);
    return createHandler({
      provider,
      auth: await loadAuth(),
      meta: {
        id: process.env.ADDON_ID,
        name: process.env.ADDON_NAME,
      },
    });
  })();
  return handlerPromise;
}

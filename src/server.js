import http from "node:http";
import { nodeHandler } from "./node-adapter.js";

const port = Number(process.env.PORT || 3000);
http.createServer(nodeHandler).listen(port, () => {
  console.log(`BitChord addon listening on http://localhost:${port}/manifest.json`);
});

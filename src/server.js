import http from "node:http";
import { nodeHandler } from "./node-adapter.js";

const port = Number(process.env.PORT || 3000);
const server = http.createServer(nodeHandler);
server.requestTimeout = 15 * 60 * 1000;
server.headersTimeout = 16 * 60 * 1000;
server.keepAliveTimeout = 75_000;
server.listen(port, "0.0.0.0", () => {
  console.log(`Personal BitChord addon listening on port ${port}`);
});

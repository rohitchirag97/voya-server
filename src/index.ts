import { serve } from "./app";
import { config } from "./config";
import { loadLevels, watchLevels } from "./lib/levels";
import { runGreedyLoop } from "./services/greedy";
import { runRocketLoop } from "./services/rocket";

await loadLevels();
watchLevels();

const server = serve(config.port);
console.log(JSON.stringify({ level: "info", msg: "listening", port: server.port }));
void runGreedyLoop();
void runRocketLoop();

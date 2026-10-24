import { serve } from "./app";
import { config } from "./config";
import { loadLevels, watchLevels } from "./lib/levels";
import { runCpExpiryLoop } from "./services/cp";
import { runGreedyLoop } from "./services/greedy";
import { runLudoLoop } from "./services/ludo";
import { runRocketLoop } from "./services/rocket";

await loadLevels();
watchLevels();

const server = serve(config.port);
console.log(JSON.stringify({ level: "info", msg: "listening", port: server.port }));
void runGreedyLoop();
void runRocketLoop();
void runLudoLoop();
runCpExpiryLoop();

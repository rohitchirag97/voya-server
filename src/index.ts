import { serve } from "./app";
import { config } from "./config";
import { loadLevels, watchLevels } from "./lib/levels";
import { runCpLoop } from "./services/cp";
import { runMicLoop } from "./services/hostMonth";
import { purgeUndelivered } from "./services/dmPush";
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
runCpLoop();
runMicLoop();
// Inbox messages no phone picked up within 30 days are deleted (chats live on phones, not here).
setInterval(() => purgeUndelivered().catch(() => {}), 3600_000);

import { claudeCode } from "./backends/claude-code/index.ts";
import { runServer } from "./server/http.ts";

await runServer(claudeCode);

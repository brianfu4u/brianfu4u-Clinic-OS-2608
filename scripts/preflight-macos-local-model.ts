import { runLocalModelPreflight } from "../src/runtime/local-model-preflight.ts";

const result = await runLocalModelPreflight();
process.stdout.write(`${JSON.stringify(result)}\n`);
if (result.status !== "READY") process.exitCode = 1;

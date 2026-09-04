import { runExternalVolumeLocalModelTrial } from "../src/runtime/external-volume-local-model-trial.ts";

const result = await runExternalVolumeLocalModelTrial();
process.stdout.write(`${JSON.stringify(result)}\n`);
if (result.status !== "READY") process.exitCode = 1;

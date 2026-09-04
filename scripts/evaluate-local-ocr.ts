import { runLocalOcrEvaluation } from "../src/runtime/local-ocr-evaluation.ts";

const corpusDir = process.argv[2] ?? "";
const language = process.argv[3] ?? "eng";
const result = await runLocalOcrEvaluation(corpusDir, {
  executablePath: process.env.WO021_TESSERACT_PATH ?? "",
  tessdataDir: process.env.WO021_TESSDATA_DIR ?? "",
}, language);
process.stdout.write(`${JSON.stringify(result)}\n`);
if (result.status !== "READY") process.exitCode = 1;

import { recordLocalOcrLanguageRelease } from "../src/runtime/local-ocr-language-release-record.ts";

const [language, evaluationResultPath, confirmation, recordDirectory] = process.argv.slice(2);
const result = recordLocalOcrLanguageRelease({ language, evaluationResultPath, confirmation, recordDirectory });
process.stdout.write(`${JSON.stringify(result)}\n`);
if (result.status !== "RECORDED") process.exitCode = 1;

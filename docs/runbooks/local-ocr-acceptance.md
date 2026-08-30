# WO-021 local OCR acceptance

Run the separate real gate only on a host with the exact checked-in Tesseract manifest assets:

```bash
npm run accept:ocr-local
```

The default deployment paths are `/usr/bin/tesseract` and
`/usr/share/tesseract-ocr/5/tessdata`. A deployment may set the server-controlled absolute paths
`WO021_TESSERACT_PATH` and `WO021_TESSDATA_DIR`; request data cannot set them. Missing or mismatched
assets fail the command non-zero.

This gate executes two committed, non-PHI synthetic English PNG samples through the immutable local
object store, the real Tesseract process, `InferenceGateway`, and
`StoredEvidenceExtractionService`. It requires normalized CER <= 2% and a recognized report marker
for every sample. It proves only the frozen Tesseract 5.3.4 English smoke baseline.

It does not prove clinical OCR quality or a physically offline deployment. Full acceptance remains
blocked until the same command passes with external networking disabled and approved hashed
Japanese/Chinese assets pass a separately frozen de-identified clinical corpus gate.

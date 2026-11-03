import { openEvidenceLedger } from "../server/evidenceLedger";

// Filesystem-owner command, not a web endpoint. Never prints the receipt key/token.
const [operation, recordId] = process.argv.slice(2);
if (operation !== "list" && (operation !== "inspect" || !recordId)) {
  console.error("Usage: npm run evidence:history -- list | inspect <record-uuid>");
  process.exitCode = 1;
} else {
  let ledger: ReturnType<typeof openEvidenceLedger> | undefined;
  try {
    ledger = openEvidenceLedger({ readOnly: true });
    console.log(JSON.stringify(operation === "list" ? ledger.listLocal() : ledger.inspectLocal(recordId), null, 2));
  } catch {
    console.error("Local ledger unavailable or integrity check failed. No key or raw database content printed.");
    process.exitCode = 1;
  } finally { ledger?.close(); }
}

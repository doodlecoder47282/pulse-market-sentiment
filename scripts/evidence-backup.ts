import {
  createEvidenceBackup, EvidenceBackupError, initializeEvidenceRecoveryKey, restoreEvidenceBackup,
} from "../server/evidenceBackup";

// Explicit local paths only. Never accepts key bytes/tokens or imports server/index.
const usage = [
  "Usage (absolute paths; existing owner-only parent directories):",
  "  tsx scripts/evidence-backup.ts init-key --key-file <file>",
  "  tsx scripts/evidence-backup.ts backup --ledger-dir <dir> --key-file <file> --backup-file <new-file>",
  "  tsx scripts/evidence-backup.ts restore --backup-file <file> --key-file <file> --restore-dir <new-dir>",
].join("\n");
const [command, ...args] = process.argv.slice(2);
const expected = command === "init-key" ? ["--key-file"]
  : command === "backup" ? ["--ledger-dir", "--key-file", "--backup-file"]
  : command === "restore" ? ["--backup-file", "--key-file", "--restore-dir"] : [];
const options = new Map<string, string>();
let valid = expected.length > 0 && args.length === expected.length * 2;
for (let i = 0; i < args.length; i += 2) {
  if (!expected.includes(args[i]) || !args[i + 1] || options.has(args[i])) valid = false;
  options.set(args[i], args[i + 1]);
}
if (!valid || expected.some(key => !options.has(key))) {
  console.error(usage);
  process.exitCode = 1;
} else {
  try {
    const recoveryKeyFile = options.get("--key-file")!;
    const result = command === "init-key" ? initializeEvidenceRecoveryKey({ recoveryKeyFile })
      : command === "backup" ? await createEvidenceBackup({
        directory: options.get("--ledger-dir")!, backupFile: options.get("--backup-file")!, recoveryKeyFile,
      }) : restoreEvidenceBackup({
        directory: options.get("--restore-dir")!, backupFile: options.get("--backup-file")!, recoveryKeyFile,
      });
    console.log(JSON.stringify(result));
  } catch (error) {
    // Do not log arbitrary filesystem/SQLite/JSON/Zod errors, arguments, paths, keys or receipts.
    const code = error instanceof EvidenceBackupError ? error.code : "local_operation_failed";
    console.error(`Evidence recovery failed: ${code}. No key or ledger content printed.`);
    process.exitCode = 1;
  }
}

// Narrow offline review/approval-record/import surface. No executor or transport.
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { reviewBatch, verifyReviewBatch, appendReviewAudit, type VerifiedReviewBatch } from "./review-queue.js";
import { requestOperatorApproval, type ApprovalBinding } from "./approval.js";
import { importResume } from "./resume-import.js";
export interface JobbotContext {
  privateDir: string;
  now: number;
  isSuppressed: (contactId: string, destination: string) => boolean;
  out: (text: string) => void;
  error: (text: string) => void;
}
export function approvalBinding(batch: VerifiedReviewBatch): ApprovalBinding {
  return { batchId: batch.manifest.batchId, revision: batch.manifest.revision, payloadSha256: batch.manifest.payloadSha256,
    destinations: batch.items.map((item) => ({ itemId: item.id, channel: item.channel, destination: item.destination })),
    attachments: batch.items.flatMap((item) => batch.attachments.map((attachment) => ({ itemId: item.id, path: `attachments/${attachment.id}`, sha256: attachment.sha256 }))),
    actionCount: batch.manifest.actionCount };
}
export function runJobbot(args: string[], context: JobbotContext): number {
  const [command, id, ...rest] = args;
  const checks = { now: context.now, isSuppressed: context.isSuppressed };
  try {
    if (command === "review" && id && rest.length === 0) {
      context.out(reviewBatch(context.privateDir, id, checks).preview); return 0;
    }
    if (command === "approve-send" && id && rest.length === 2 && rest[0] === "--sha256") {
      const batch = verifyReviewBatch(context.privateDir, id, checks);
      if (rest[1] !== batch.manifest.payloadSha256) throw new Error("digest mismatch");
      appendReviewAudit(context.privateDir, { type: "approval_denied", batchId: id, payloadSha256: batch.manifest.payloadSha256, timestamp: context.now, revision: batch.manifest.revision });
      // This is an attempted approval audit event, not an approval record.
      requestOperatorApproval(approvalBinding(batch));
    }
    if (command === "revoke-approval" && id && rest.length === 0) {
      const batch = verifyReviewBatch(context.privateDir, id, checks);
      appendReviewAudit(context.privateDir, { type: "revocation", batchId: id, payloadSha256: batch.manifest.payloadSha256, timestamp: context.now, revision: batch.manifest.revision });
      context.out("Revocation recorded; no usable approval exists in this runtime."); return 0;
    }
    if (command === "import-resume" && id === "--source" && rest.length >= 3 && rest[1] === "--id" && (rest.length === 3 || (rest.length === 4 && rest[3] === "--write"))) {
      const result = importResume(context.privateDir, rest[0], rest[2], rest[3] === "--write", context.now);
      context.out(result.imported ? "Resume imported into the private data plane." : "Dry run: no resume read or copied; add --write for explicit import."); return 0;
    }
    context.error("Usage: jobbot review <batch-rN> | approve-send <batch-rN> --sha256 <digest> | revoke-approval <batch-rN> | import-resume --source <path> --id <opaque-id> [--write] | boards list|stale|show|stats|add|event|events|detect [--json]");
    return 2;
  } catch (error) {
    if ((error as { code?: string }).code === "operator_boundary_unavailable") context.error("operator_boundary_unavailable: operator-only identity separation is not established; no approval was created.");
    else context.error("Private review operation denied; no approval or external effect occurred.");
    return 1;
  }
}
export async function main(args = process.argv.slice(2)): Promise<number> {
  const privateDir = resolve(process.env.JOBBOT_PRIVATE_DIR ?? join(process.cwd(), ".private"));
  if (args[0] === "boards") {
    process.env.JOBBOT_PRIVATE_DIR = privateDir;
    process.env.STATE_DIR = join(privateDir, "state");
    try {
      const { runBoardCli } = await import("./board-cli.js");
      return runBoardCli(args.slice(1), {
        out: (text) => process.stdout.write(text + "\n"),
        error: (text) => process.stderr.write(text + "\n"),
      });
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : "board command failed"}\n`);
      return 1;
    }
  }
  let isSuppressed = (_id: string, _destination: string): boolean => { throw new Error("suppression unavailable"); };
  // Only an explicitly selected queue command opens the configured private DB.
  if (["review", "approve-send", "revoke-approval"].includes(args[0])) {
    process.env.JOBBOT_PRIVATE_DIR = privateDir; process.env.STATE_DIR = join(privateDir, "state");
    const DB = await import("./db.js"); isSuppressed = DB.isPrivatePersonSuppressed;
  }
  return runJobbot(args, { privateDir, now: Date.now(), isSuppressed, out: (s) => process.stdout.write(s + "\n"), error: (s) => process.stderr.write(s + "\n") });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch(() => { process.stderr.write("Private command unavailable.\n"); process.exitCode = 1; });
}

// Deletes one discussion thread by id. Run out-of-process (not imported into the
// Playwright test file directly) because Playwright's own TS transform can't load the
// generated Prisma client's ESM output — see the `finally` block in discussion-flow.spec.ts.
import "dotenv/config";
import { prisma } from "@/app/server/db";

const threadId = process.argv[2];
if (!threadId) {
  console.error("usage: tsx e2e/support/cleanup-discussion.ts <threadId>");
  process.exit(1);
}

prisma.discussionThread.delete({ where: { id: threadId } })
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error("cleanup-discussion failed", error instanceof Error ? error.message : error);
    process.exit(0); // best-effort teardown — never fail the test run over cleanup
  });

import "dotenv/config";
import { prisma } from "@/app/server/db";
import { replacedOriginalDraftData } from "@/app/server/course/course-service";

/**
 * One-off (2026-11-13): recordings replaced with Vimeo before the "original as a draft" step
 * existed have their file on the stream server but no Медиатека row pointing at it, so a curator
 * can't delete it. Creates the missing draft for each. Safe to run again: it skips any file that
 * already has a row in any status — including an archived one, which means the curator has
 * already deleted that original.
 */
async function main(): Promise<void> {
  const replaced = await prisma.mediaAsset.findMany({
    where: { replacedFromKey: { not: null }, replacedFromProvider: { not: null } },
    select: { practicumId: true, kind: true, audience: true, title: true, durationSec: true, byteSize: true, replacedFromProvider: true, replacedFromKey: true },
  });
  let created = 0;
  for (const row of replaced) {
    if (!row.replacedFromProvider || !row.replacedFromKey) continue;
    const known = await prisma.mediaAsset.count({ where: { provider: row.replacedFromProvider, providerKey: row.replacedFromKey } });
    if (known > 0) continue;
    const lastUnattached = await prisma.mediaAsset.findFirst({ where: { practicumId: row.practicumId, moduleId: null, scheduleEventId: null }, orderBy: { position: "desc" }, select: { position: true } });
    await prisma.mediaAsset.create({
      data: replacedOriginalDraftData({ practicumId: row.practicumId, provider: row.replacedFromProvider, providerKey: row.replacedFromKey, kind: row.kind, audience: row.audience, title: row.title, mimeType: "video/mp4", durationSec: row.durationSec, byteSize: row.byteSize }, (lastUnattached?.position ?? -1) + 1),
    });
    created += 1;
  }
  console.log(`Replaced recordings: ${replaced.length}, drafts created: ${created}`);
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Backfill failed"); process.exitCode = 1; }).finally(() => prisma.$disconnect());

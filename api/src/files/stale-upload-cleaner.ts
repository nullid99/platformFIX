import { Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { fileService } from "@/app/server/files";

const CLEANUP_INTERVAL_MS = 60 * 60_000;
const STALE_AFTER_MS = 24 * 60 * 60_000;

/** Hourly removal of uploads that never finished (security review STG-5) — see cleanupStaleUploads. */
@Injectable()
export class StaleUploadCleaner implements OnModuleInit, OnModuleDestroy {
  private timer: ReturnType<typeof setInterval> | null = null;

  public onModuleInit(): void {
    this.timer = setInterval(() => { void this.tick(); }, CLEANUP_INTERVAL_MS);
  }

  public onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    try {
      const removed = await fileService.cleanupStaleUploads(STALE_AFTER_MS);
      if (removed > 0) console.log("Stale uploads removed", JSON.stringify({ removed }));
    } catch (error) {
      console.error("Stale upload cleanup failed", error instanceof Error ? error.message : "unknown error");
    }
  }
}

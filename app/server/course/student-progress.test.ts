import "dotenv/config";
import { describe, expect, it } from "vitest";
import { ModuleAccessStatus } from "@/app/generated/prisma/enums";
import { isLessonDone } from "./student-progress-service";

describe("isLessonDone", () => {
  it("counts an open lesson without ДЗ once every earlier lesson is done", () => {
    expect(isLessonDone(ModuleAccessStatus.UNLOCKED, 0, true)).toBe(true);
  });

  it("does not count an open lesson without ДЗ while an earlier lesson isn't done", () => {
    expect(isLessonDone(ModuleAccessStatus.UNLOCKED, 0, false)).toBe(false);
  });

  it("does not count an open lesson whose ДЗ isn't accepted yet", () => {
    expect(isLessonDone(ModuleAccessStatus.UNLOCKED, 2, true)).toBe(false);
  });

  it("does not count a closed lesson, even without ДЗ", () => {
    expect(isLessonDone(ModuleAccessStatus.LOCKED, 0, true)).toBe(false);
  });

  it("counts a completed lesson regardless of the ones before it", () => {
    expect(isLessonDone(ModuleAccessStatus.COMPLETED, 3, false)).toBe(true);
  });
});

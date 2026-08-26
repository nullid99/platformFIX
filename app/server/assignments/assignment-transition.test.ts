import { describe, expect, it } from "vitest";
import { nextSubmissionStatus } from "./assignment-transition";

describe("submission review transitions", () => {
  it("accepts submitted work and requests revision", () => {
    expect(nextSubmissionStatus("SUBMITTED", "accepted")).toBe("ACCEPTED");
    expect(nextSubmissionStatus("IN_REVIEW", "revision")).toBe("NEEDS_REVISION");
  });

  it("rejects repeated decisions", () => {
    expect(() => nextSubmissionStatus("ACCEPTED", "revision")).toThrow();
    expect(() => nextSubmissionStatus("NEEDS_REVISION", "accepted")).toThrow();
  });
});

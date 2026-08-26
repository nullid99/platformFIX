export type ReviewDecision = "accepted" | "revision";

export function nextSubmissionStatus(current: string, decision: ReviewDecision): "ACCEPTED" | "NEEDS_REVISION" {
  if (current !== "SUBMITTED" && current !== "IN_REVIEW") {
    throw new Error("Submission is not awaiting review");
  }
  return decision === "accepted" ? "ACCEPTED" : "NEEDS_REVISION";
}

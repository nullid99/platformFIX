import { describe, expect, it } from "vitest";
import { parseAssignmentMaterials } from "./assignment-input";

describe("parseAssignmentMaterials", () => {
  it("allows a create request without materials", () => {
    expect(parseAssignmentMaterials(undefined, true)).toBeUndefined();
  });

  it("accepts a link and a stored file reference", () => {
    expect(parseAssignmentMaterials([
      { kind: "LINK", title: "Запись разбора", url: "https://vimeo.com/123" },
      { kind: "FILE", title: "График.jpg", fileId: "file_123" },
    ])).toEqual([
      { kind: "LINK", title: "Запись разбора", url: "https://vimeo.com/123" },
      { kind: "FILE", title: "График.jpg", fileId: "file_123" },
    ]);
  });

  it("rejects a non-array value", () => {
    expect(() => parseAssignmentMaterials("not-an-array", true)).toThrow("materials must be an array");
  });
});

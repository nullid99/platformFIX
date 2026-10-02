import { describe, expect, test } from "vitest";
import { assignmentMaterialEmbed } from "./page";

// Regression test (2026-10-01): a Vimeo video hidden on vimeo.com only plays embedded, so any
// share-link format this parser doesn't recognize turns a homework video into a dead link.
describe("assignmentMaterialEmbed", () => {
  test.each([
    ["https://vimeo.com/1232097692?share=copy&fl=sv&fe=ci", "https://player.vimeo.com/video/1232097692"],
    ["https://vimeo.com/1232097692/abc123def0", "https://player.vimeo.com/video/1232097692?h=abc123def0"],
    ["https://vimeo.com/1232097692/abc123def0?share=copy", "https://player.vimeo.com/video/1232097692?h=abc123def0"],
    ["https://player.vimeo.com/video/1232097692?h=abc123", "https://player.vimeo.com/video/1232097692?h=abc123"],
    ["https://vimeo.com/channels/staffpicks/1232097692", "https://player.vimeo.com/video/1232097692"],
    ["  https://vimeo.com/1232097692  ", "https://player.vimeo.com/video/1232097692"],
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "https://www.youtube.com/embed/dQw4w9WgXcQ"],
    ["https://youtube.com/watch?v=dQw4w9WgXcQ&t=30s", "https://www.youtube.com/embed/dQw4w9WgXcQ"],
    ["https://m.youtube.com/watch?v=dQw4w9WgXcQ", "https://www.youtube.com/embed/dQw4w9WgXcQ"],
    ["https://youtu.be/dQw4w9WgXcQ?si=abc", "https://www.youtube.com/embed/dQw4w9WgXcQ"],
    ["https://www.youtube.com/shorts/dQw4w9WgXcQ", "https://www.youtube.com/embed/dQw4w9WgXcQ"],
    ["https://www.youtube.com/live/dQw4w9WgXcQ", "https://www.youtube.com/embed/dQw4w9WgXcQ"],
  ])("%s → player", (input, expected) => {
    expect(assignmentMaterialEmbed(input)).toBe(expected);
  });

  test.each([
    "https://traderscare.io/register",
    "https://vimeo.com/channels/staffpicks",
    "https://www.youtube.com/@somechannel",
    "not a url",
  ])("%s → plain link", (input) => {
    expect(assignmentMaterialEmbed(input)).toBeNull();
  });
});

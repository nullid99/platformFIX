import { describe, expect, it } from "vitest";
import { MediaAssetKind } from "../../../app/generated/prisma/enums";
import { parseCreateModuleBody, parseCreateVimeoMediaBody } from "./course-input";

describe("parseCreateModuleBody", () => {
  it("accepts a module with a local cover", () => {
    expect(parseCreateModuleBody({ title: "Новый блок", section: "Practice", coverPath: "/event-covers/PRE.png" })).toEqual({
      title: "Новый блок",
      description: undefined,
      section: "Practice",
      coverPath: "/event-covers/PRE.png",
    });
  });

  it("rejects a remote cover path", () => {
    expect(() => parseCreateModuleBody({ title: "Новый блок", coverPath: "https://example.com/cover.png" })).toThrow("coverPath must be a local public path");
  });
});

describe("parseCreateVimeoMediaBody", () => {
  it("accepts a Vimeo media draft attached to a module", () => {
    expect(parseCreateVimeoMediaBody({
      moduleId: "module_1",
      title: "Q&A по Market Logic",
      kind: MediaAssetKind.QA,
      vimeoUrl: "https://vimeo.com/123456789?h=privatehash",
    })).toEqual({
      moduleId: "module_1",
      title: "Q&A по Market Logic",
      kind: MediaAssetKind.QA,
      vimeoUrl: "https://vimeo.com/123456789?h=privatehash",
      description: undefined,
    });
  });

  it("rejects an unknown media kind", () => {
    expect(() => parseCreateVimeoMediaBody({ moduleId: "module_1", title: "Запись", kind: "FILE", vimeoUrl: "https://vimeo.com/123" })).toThrow("kind is invalid");
  });

  it("allows a Talks record without a module", () => {
    expect(parseCreateVimeoMediaBody({ title: "Talks: знакомство", kind: MediaAssetKind.TALKS, vimeoUrl: "https://vimeo.com/123" })).toEqual({
      moduleId: undefined,
      title: "Talks: знакомство",
      kind: MediaAssetKind.TALKS,
      vimeoUrl: "https://vimeo.com/123",
      description: undefined,
    });
  });

  it("requires a module for module-bound media", () => {
    expect(() => parseCreateVimeoMediaBody({ title: "Стрим", kind: MediaAssetKind.STREAM, vimeoUrl: "https://vimeo.com/123" })).toThrow("moduleId is required");
  });
});

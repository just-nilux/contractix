import { describe, expect, it } from "vitest";

import { type CaseStage, deriveCaseStage, isSettled, type StageInput } from "./derive-stage.js";

const doc = (status: string, analysisStatus: string): StageInput => ({ status, analysisStatus });

const uploaded = doc("uploaded", "pending");
const parsing = doc("processing", "pending");
const parsed = doc("ready", "pending");
const analyzing = doc("ready", "analyzing");
const analyzed = doc("ready", "analyzed");
const analysisFailed = doc("ready", "failed");
const parseFailed = doc("failed", "pending");

describe("deriveCaseStage", () => {
  it.each<[string, StageInput[], CaseStage]>([
    ["no documents", [], "empty"],
    ["queued for parsing", [uploaded], "ingesting"],
    ["mid-parse", [parsing, parsed], "ingesting"],
    ["all parsed, none analyzed", [parsed, parsed], "ingested"],
    ["analysis running", [analyzed, analyzing], "analyzing"],
    ["all analyzed", [analyzed, analyzed], "analyzed"],
    ["analysis failed but ingest succeeded", [analysisFailed], "analyzed"],
    ["every document failed to parse", [parseFailed, parseFailed], "failed"],
    ["one parsed, one unparseable", [parseFailed, parsed], "ingested"],
    ["mixed analyzed and never-started", [analyzed, parsed], "analyzed"],
  ])("%s", (_name, documents, expected) => {
    expect(deriveCaseStage(documents)).toBe(expected);
  });

  it("reports `ingested` for a freshly adopted demo case", () => {
    // The case the demo path actually produces: cloned documents are already
    // parsed but have never been analyzed. This is the state for which the
    // progress stream never emits `done`, so getting it right is what stops the
    // page waiting five minutes for a terminal event that is not coming.
    expect(deriveCaseStage([parsed, parsed, parsed, parsed, parsed])).toBe("ingested");
  });

  it("ignores a failed document when deciding whether analysis is running", () => {
    expect(deriveCaseStage([parseFailed, analyzing])).toBe("analyzing");
  });
});

describe("isSettled", () => {
  it.each<[CaseStage, boolean]>([
    ["empty", true],
    ["analyzed", true],
    ["failed", true],
    ["ingesting", false],
    // Not settled: nobody has asked for analysis yet, so the page still has
    // work to trigger.
    ["ingested", false],
    ["analyzing", false],
  ])("%s -> %s", (stage, expected) => {
    expect(isSettled(stage)).toBe(expected);
  });
});

import { describe, it, expect } from "vitest";
import { intersectScope, resolveScope } from "../src/policy/index";

const allowedNs = ["personal", "work/client-a"];
const allowedSe = ["public", "private"];

describe("intersectScope", () => {
  it("defaults to the full allowlist when nothing is requested", () => {
    const s = intersectScope({}, allowedNs, allowedSe);
    expect(s.namespaces).toEqual(["personal", "work/client-a"]);
    expect(s.sensitivities).toEqual(["public", "private"]);
  });

  it("drops requested namespaces outside the allowlist", () => {
    const s = intersectScope({ namespaces: ["work/client-a", "work/client-b"] }, allowedNs, allowedSe);
    expect(s.namespaces).toEqual(["work/client-a"]);
  });

  it("returns empty namespaces when only disallowed ones are requested", () => {
    const s = intersectScope({ namespaces: ["work/client-b"] }, allowedNs, allowedSe);
    expect(s.namespaces).toEqual([]);
  });

  it("drops requested sensitivities outside the allowlist", () => {
    const s = intersectScope({ sensitivityAllowed: ["private", "secret-adjacent"] }, allowedNs, allowedSe);
    expect(s.sensitivities).toEqual(["private"]);
  });
});

describe("resolveScope with explicit allow override", () => {
  it("uses the provided allowlist instead of config when allow is given", () => {
    const s = resolveScope(
      { namespaces: ["a", "b"] },
      { namespaces: ["a"], sensitivities: ["public"] },
    );
    expect(s.namespaces).toEqual(["a"]);
    expect(s.sensitivities).toEqual(["public"]);
  });
});

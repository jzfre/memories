import { describe, it, expect, beforeEach } from "vitest";
import { prisma, resetDb } from "./helpers/db";

describe("db harness", () => {
  beforeEach(resetDb);

  it("connects to the test database and starts empty", async () => {
    expect(await prisma.document.count()).toBe(0);
  });
});

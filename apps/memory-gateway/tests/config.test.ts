import { describe, it, expect, beforeEach } from "vitest";
import { resolve } from "node:path";
import { loadConfig, __resetConfigCache } from "../src/config/index";

const FIXTURE = resolve(__dirname, "fixtures/config.test.yaml");

describe("loadConfig", () => {
  beforeEach(() => __resetConfigCache());

  it("loads a config file from MEMORIES_CONFIG", () => {
    process.env.MEMORIES_CONFIG = FIXTURE;
    delete process.env.VAULT_ROOT;
    const cfg = loadConfig();
    expect(cfg.policy.allowed_namespaces).toContain("work/client-a");
    expect(cfg.policy.allowed_namespaces).not.toContain("work/client-b");
  });

  it("applies VAULT_ROOT override", () => {
    process.env.MEMORIES_CONFIG = FIXTURE;
    process.env.VAULT_ROOT = "/tmp/my-vault";
    __resetConfigCache();
    const cfg = loadConfig();
    expect(cfg.vault.root).toBe("/tmp/my-vault");
  });
});

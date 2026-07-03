import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { resetDb } from "./helpers/db";

const FIXTURE_CONFIG = resolve(__dirname, "fixtures/config.test.yaml");

async function setup(vaultRoot: string) {
  process.env.MEMORIES_CONFIG = FIXTURE_CONFIG;
  process.env.VAULT_ROOT = vaultRoot;
  const { __resetConfigCache } = await import("../src/config/index");
  __resetConfigCache();
  const { writeNote, updateNote } = await import("../src/notes/write");
  const { prisma } = await import("../src/db/client");
  return { writeNote, updateNote, prisma };
}

describe("writeNote", () => {
  let dir: string;
  beforeEach(async () => {
    await resetDb();
    dir = mkdtempSync(join(tmpdir(), "memwrite-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates 00-inbox/<Title>.md with exactly the expected frontmatter, intact body, and an indexed document", async () => {
    const { writeNote, prisma } = await setup(dir);
    const res = await writeNote({ title: "My First Note", content: "Hello world body." }, { client: "test" });

    expect(res.path).toBe("00-inbox/My First Note.md");
    const filePath = join(dir, res.path);
    expect(existsSync(filePath)).toBe(true);

    const raw = readFileSync(filePath, "utf8");
    expect(raw).toContain("kind: note");
    expect(raw).toContain("sensitivity: internal");
    expect(raw).toContain("tags: []");
    expect(raw).toMatch(/created: \d{4}-\d{2}-\d{2}/);
    expect(raw).not.toContain("namespace:");
    expect(raw).not.toContain("status:");
    expect(raw).not.toContain("confidence:");
    expect(raw).toContain("# My First Note");
    expect(raw).toContain("Hello world body.");

    const doc = await prisma.document.findUnique({ where: { id: res.document_id } });
    expect(doc).not.toBeNull();
    expect(doc?.path).toBe("00-inbox/My First Note.md");
  });

  it("collision: a second write with the same title yields a ' 2' filename and a distinct id", async () => {
    const { writeNote } = await setup(dir);
    const first = await writeNote({ title: "Dup Title", content: "First body text." }, { client: "test" });
    const second = await writeNote({ title: "Dup Title", content: "Second body text." }, { client: "test" });
    expect(first.path).toBe("00-inbox/Dup Title.md");
    expect(second.path).toBe("00-inbox/Dup Title 2.md");
    expect(first.document_id).not.toBe(second.document_id);
  });

  it("routes to an explicit, existing folder", async () => {
    mkdirSync(join(dir, "20-decisions"), { recursive: true });
    const { writeNote } = await setup(dir);
    const res = await writeNote(
      { title: "Decide Something", content: "Body text here.", folder: "20-decisions" },
      { client: "test" },
    );
    expect(res.path).toBe("20-decisions/Decide Something.md");
    expect(existsSync(join(dir, res.path))).toBe(true);
  });

  it("rejects a path-traversal folder and writes nothing", async () => {
    const { writeNote } = await setup(dir);
    await expect(
      writeNote({ title: "Evil", content: "Body text.", folder: "../evil" }, { client: "test" }),
    ).rejects.toThrow();
    expect(existsSync(resolve(dir, "..", "evil"))).toBe(false);
  });

  it("rejects a nonexistent folder and writes nothing", async () => {
    const { writeNote } = await setup(dir);
    await expect(
      writeNote({ title: "Nope", content: "Body text.", folder: "nope" }, { client: "test" }),
    ).rejects.toThrow();
    expect(existsSync(join(dir, "nope"))).toBe(false);
  });

  it("throws on secret-looking content", async () => {
    const { writeNote } = await setup(dir);
    await expect(
      writeNote({ title: "Creds", content: "password=hunter2" }, { client: "test" }),
    ).rejects.toThrow();
  });

  it("does not throw on a secret_ref: op://... reference", async () => {
    const { writeNote } = await setup(dir);
    const res = await writeNote(
      { title: "Ref Note", content: "secret_ref: op://vault/item" },
      { client: "test" },
    );
    expect(res.document_id).toBeTruthy();
  });

  it("throws when the body starts with a frontmatter block", async () => {
    const { writeNote } = await setup(dir);
    await expect(
      writeNote({ title: "Bad", content: "---\nkind: note\n---\nbody" }, { client: "test" }),
    ).rejects.toThrow();
  });

  it("dedupes a leading H1 in content — the note has exactly one H1, the title", async () => {
    const { writeNote } = await setup(dir);
    const res = await writeNote(
      { title: "Dallas Housing", content: "# Dallas Housing\n\n## Office anchor\n\n- Whitacre Tower" },
      { client: "test" },
    );
    const raw = readFileSync(join(dir, res.path), "utf8");
    const h1s = raw.split("\n").filter((l) => /^# /.test(l));
    expect(h1s).toEqual(["# Dallas Housing"]);
    expect(raw).toContain("## Office anchor");
  });

  it("sanitizes filesystem/link-breaking characters out of the filename but keeps the human title in the H1", async () => {
    const { writeNote } = await setup(dir);
    const res = await writeNote(
      { title: "Budget: 2026/07 [draft] #1", content: "Body text." },
      { client: "test" },
    );
    expect(res.path).toBe("00-inbox/Budget 2026 07 draft 1.md");
    const raw = readFileSync(join(dir, res.path), "utf8");
    expect(raw).toContain("# Budget: 2026/07 [draft] #1");
  });

  it("throws on an invalid sensitivity value", async () => {
    const { writeNote } = await setup(dir);
    await expect(
      writeNote({ title: "Priv", content: "Body text.", sensitivity: "private" }, { client: "test" }),
    ).rejects.toThrow();
  });
});

describe("updateNote", () => {
  let dir: string;
  beforeEach(async () => {
    await resetDb();
    dir = mkdtempSync(join(tmpdir(), "memupdate-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("replaces the body, preserves the original frontmatter byte-for-byte, and reindexes", async () => {
    const { writeNote, updateNote, prisma } = await setup(dir);
    const created = await writeNote({ title: "Update Me", content: "Original body." }, { client: "test" });
    const filePath = join(dir, created.path);
    const before = readFileSync(filePath, "utf8");
    const beforeFrontmatter = before.split("\n\n")[0]; // "---\n...\n---" (no trailing blank line)

    const updated = await updateNote(created.document_id, "New body content.", { client: "test" });
    expect(updated.document_id).toBe(created.document_id);

    const after = readFileSync(filePath, "utf8");
    expect(after.startsWith(beforeFrontmatter)).toBe(true);
    expect(after).toContain("New body content.");
    expect(after).not.toContain("Original body.");

    const doc = await prisma.document.findUnique({ where: { id: updated.document_id } });
    expect(doc?.bodyText).toContain("New body content.");
  });

  it("throws for an unknown document id", async () => {
    const { updateNote } = await setup(dir);
    await expect(updateNote("no.such.document", "content", { client: "test" })).rejects.toThrow();
  });
});

describe("memory_write_note (MCP, in-memory transport, default profile)", () => {
  let dir: string;
  beforeEach(async () => {
    await resetDb();
    dir = mkdtempSync(join(tmpdir(), "memmcpwrite-"));
    process.env.MEMORIES_CONFIG = FIXTURE_CONFIG;
    process.env.VAULT_ROOT = dir;
    const { __resetConfigCache } = await import("../src/config/index");
    __resetConfigCache();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("is registered and writes a real file when called over the protocol", async () => {
    const { buildMcpServer } = await import("../src/mcp/build");
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = buildMcpServer();
    await server.connect(serverTransport);
    const client = new Client({ name: "write-itest", version: "0.0.0" });
    await client.connect(clientTransport);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("memory_write_note");

    const res: any = await client.callTool({
      name: "memory_write_note",
      arguments: { title: "MCP Written Note", content: "Body via MCP." },
    });
    expect(res.isError).toBeFalsy();
    const payload = JSON.parse(res.content[0].text);
    expect(payload.path).toBe("00-inbox/MCP Written Note.md");
    expect(existsSync(join(dir, payload.path))).toBe(true);

    await client.close();
  });
});

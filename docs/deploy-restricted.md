# Deploying on a restricted / locked-down machine

For a work notebook with no USB, no direct transfer, a small upload cap, and blocked
public registries — but where `git clone` works and an internal **Artifactory** (or
similar) proxies Docker images and npm packages.

The codebase is tiny and travels via git. The only things that "download" are: npm
dependencies, the Postgres+pgvector image, and (optional) the embedding model. Point the
first two at Artifactory; the third you can skip entirely.

## What must reach the machine

| Thing | Size | How |
|---|---|---|
| Code | small | `git clone` (already works for you) |
| node deps | tens of MB | `pnpm install` against the Artifactory **npm** mirror (`.npmrc`) |
| Postgres + **pgvector** | ~hundreds of MB | `docker pull` from the Artifactory **Docker** registry (`POSTGRES_IMAGE`) |
| Embedding model | 0–280 MB | **optional** — skip it (FTS-only), or use a small quant / internal endpoint |

> **pgvector is required even without embeddings.** Migration
> `20260609020000_embeddings` runs `CREATE EXTENSION vector`, so the DB image must be a
> **pgvector** image, not vanilla `postgres`. If Artifactory only has vanilla Postgres,
> tell the maintainer — making the vector extension optional is a small code change.

## Steps

```bash
git clone <repo> memories && cd memories

# 1. npm registry → Artifactory (the .npmrc is gitignored; it holds a token)
cp .npmrc.example .npmrc
#   edit .npmrc: set your Artifactory npm virtual-repo URL; export NPM_TOKEN

# 2. Postgres image → Artifactory (repo-root .env, gitignored, auto-loaded by compose)
cp .env.example .env
#   edit .env: POSTGRES_IMAGE=<artifactory>/docker-remote/pgvector/pgvector:pg16

# 3. App env: copy the template and choose FTS-only (no model needed)
cp apps/memory-gateway/.env.example apps/memory-gateway/.env
#   ensure EMBEDDINGS_ENABLED is unset or =0  → search runs full-text + metadata only

# 4. Install, start DB, migrate
pnpm install --frozen-lockfile
pnpm db:up            # pulls the pgvector image from Artifactory
pnpm generate
pnpm migrate

# 5. Point config.yaml at this machine's vault, then index
#   edit config.yaml: vault.root + allowed namespaces/sensitivities
pnpm scan
pnpm status           # confirm documents/chunks indexed
```

Search, fetch, note writes, and the MCP server all work in FTS-only mode. You lose
*semantic* matching (e.g. "brain gym project" → a note that says "externalizing memory")
but keep strong keyword + title/namespace/tag search.

## Embeddings on the restricted machine (optional)

Three choices, in order of least friction:

1. **None (recommended to start).** `EMBEDDINGS_ENABLED=0`. No model, no LM Studio.
2. **Small local model.** `nomic-embed-text-v1.5` at **Q4_K_M GGUF is ~84 MB — under a
   100 MB cap**, so it uploads/clones directly (no splitting). Run it in LM Studio (or
   any OpenAI-compatible server) and set `EMBEDDINGS_ENABLED=1`, `EMBEDDINGS_URL`,
   `EMBEDDINGS_MODEL`. Re-embed with `pnpm reembed`.
3. **Internal endpoint.** If an approved internal embeddings API exists, point
   `EMBEDDINGS_URL` at it (must be OpenAI-`/embeddings`-compatible, 768-dim) — no local
   model at all.

## Moving the embedding model with Git LFS

If you want the model on the restricted machine and have `git lfs` there, store it in a
**separate throwaway repo** (never the code repo — a binary bloats every clone) and let
LFS carry it past the 100 MB file cap (LFS allows up to 2 GB/file on GitHub).

```bash
# --- on the machine that HAS the model (locate the LM Studio .gguf) ---
find ~/.lmstudio/models -iname '*nomic*embed*.gguf'      # note the path
mkdir memories-model && cd memories-model
git init && git lfs install
git lfs track "*.gguf"            # writes .gitattributes
cp "<that .gguf path>" .
git add .gitattributes *.gguf
git commit -m "embedding model (LFS)"
git remote add origin <empty-private-github-repo>
git push -u origin main           # pointer → git, blob → GitHub LFS storage

# --- on the restricted machine ---
git lfs install
git clone <repo-url> memories-model     # LFS materializes the .gguf on clone
cd memories-model && git lfs pull       # force, in case smudge was skipped
ls -lh *.gguf                            # ~200 MB file present
```

Then import the `.gguf` into LM Studio (or serve it with `llama-server`) and point the
gateway at it via `EMBEDDINGS_URL`.

> **Caveat:** LFS blob transfer uses GitHub's LFS storage backend (a different host than
> `git clone`). If your egress allows github.com but blocks the LFS backend, `git lfs
> pull` fails — fall back to the split-file method below, which rides the same git
> transport your clone already uses. Also: a 200 MB file is one-quarter of GitHub free
> LFS's monthly bandwidth, so don't re-clone repeatedly. (A **Q4_K_M quant is ~84 MB**,
> under the cap — committable as a normal file, no LFS at all.)

## If a registry pull is blocked entirely (air-gapped fallback)

Move the image as split files through git instead of pulling:

```bash
# on a machine that HAS the image
docker save pgvector/pgvector:pg16 | gzip > pgvector.tgz
split -b 95m pgvector.tgz pgvector.tgz.part-     # parts < 100 MB → commit to a throwaway repo

# on the restricted machine
cat pgvector.tgz.part-* | gunzip | docker load
```

Same idea for deps if the npm mirror is unavailable: `pnpm fetch` into a portable store
on a connected machine, commit/split it, and `pnpm install --offline` on the target.

## Limits to remember

- **GitHub rejects any single file > 100 MB** (so does most of your tooling). Split big
  blobs into < 100 MB parts and reassemble with `cat`.
- Keep tokens out of git — `.npmrc` and `.env` are gitignored; only the `*.example`
  templates are tracked.

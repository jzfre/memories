---
kind: note
namespace: testing
sensitivity: public
status: active
confidence: high
tags: [pgvector, embeddings]
---

# Pgvector indexing pipeline

The future embeddings pipeline will store vectors in pgvector alongside the
full-text index, enabling hybrid retrieval. For now retrieval is pure Postgres
full-text search over a weighted tsvector.

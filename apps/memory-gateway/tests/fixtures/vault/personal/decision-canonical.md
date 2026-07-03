---
namespace: personal
sensitivity: private
kind: decision
---

# Use Obsidian as canonical store

## Claim
Obsidian is the canonical store.

## Context
We index notes into postgres for retrieval. The shared keyword is pgvector.

## Evidence
Local-first markdown is durable.

## Assumptions
Vault stays on disk.

## Tradeoffs
Manual sync vs. control.

## Decision
Keep Obsidian canonical; postgres is derived.

## Consequences
Rebuildable index.

## What would change this
A hosted store with better guarantees.

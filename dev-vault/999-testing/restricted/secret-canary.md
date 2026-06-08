---
kind: note
namespace: testing
sensitivity: secret-adjacent
status: active
confidence: medium
tags: [scoping, canary]
---

# Restricted roadmap (must never be retrieved)

This note's sensitivity (`secret-adjacent`) is NOT in the allowed list, so it must
never appear in search or fetch results. Its canary token is **zebrafishsecret** —
if that token ever shows up in a client response, sensitivity scoping is broken.

---
namespace: work/client-b
sensitivity: private
kind: finding
---

# Client B finding

## Finding
This must never leak to a client-a query. The shared keyword is pgvector.

## Evidence
Observed in the client-b environment.

## Source references
chat:client-b

## Confidence
medium

## Validation needed
Re-check with client-b.

## Risk if wrong
Cross-client exposure.

## Related notes
none

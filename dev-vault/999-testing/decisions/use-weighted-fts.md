---
kind: decision
namespace: testing
sensitivity: internal
status: active
confidence: confirmed
tags: [search, ranking]
---

# Decision: Weighted full-text ranking for memory search

## Decision
Search indexes a weighted tsvector so a query word is matched even when it only
appears in a note's title or heading, not its body. Title lexemes weigh highest,
then headings, then body prose.

## Consequences
A question like "what was the weighted ranking decision" surfaces this note even
though the body never repeats the word "weighted ranking decision" verbatim.

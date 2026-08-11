---
name: Bug report
about: Report a reproducible defect (crash, wrong behaviour, protocol violation)
title: '[Bug] '
labels: bug
assignees: ''
---

## Summary
<!-- One or two sentences: what breaks, under what conditions. -->

## Affected layer
<!-- NApp / NACP / NACT / NACEB / NACAB / EventBus. More than one is fine. -->

## Reproduction
<!-- Smallest repro you can manage. A runnable script is ideal. -->
1.
2.
3.

## Expected behaviour
<!-- What the contract / docs say should happen. -->

## Actual behaviour
<!-- What actually happens. Put stacks / logs in the code block. -->

```
<!-- stack, error, observed events -->
```

## Root cause (if known)
<!-- Point at file:line. Leave blank if not yet located. -->

## Impact
<!-- Process crash / one connection lost / one event lost / observation-only.
     Does it need malformed input, or does normal usage hit it? -->

## Environment
- NASDK version / commit:
- Node version:
- Carrier (tcp / unix / ws):

## Notes
<!-- Related issues, workarounds, anything else. -->

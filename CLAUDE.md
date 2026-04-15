@AGENTS.md

# Pre-push verification

Before every single push, trace all data end-to-end:

- Every value sent must match what the receiver expects (types, shapes, units, names, ordering).
- No patches over symptoms — find and fix the root cause.
- No dead code — remove anything unused.
- No fallback routes — a single, intentional path. No "just in case" branches, silent defaults, or try/catch that swallows errors.

When confidence in the change is 95% or higher after this trace, push automatically without asking.
If confidence is below 95%, stop and report what's uncertain before pushing.

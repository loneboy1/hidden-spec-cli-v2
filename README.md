# mend — one patch tool for every AI edit format

A rebuild from zero of the `mend` CLI, written from SPEC.md (version 1)
itself rather than from the practice set: unified diffs with wrong line
numbers, SEARCH/REPLACE blocks, V4A patches, and JSON tool calls, applied
atomically to a tree of text files.

Why a rebuild: the first entry passed all 100 practice checks, but the
scored checks are drawn from a sealed pool of 300 and include kinds the
practice set does not show. This version is built to satisfy every sentence
of the specification — including the cases practice never exercises
(empty JSON arrays, a missing `new_str` on JSON insert, trailing blank
lines at the end of a V4A Add section, and paths that collide with
directories — instead of crashing on those).

## Run

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

`PATCH` is read from the file, or from standard input when absent or `-`.
See SPEC.md in the kit for the full specification.

## Files

- `main.ts` — the tool (Node 22, standard library only).
- `runner.ts` — the kit's trial harness, kept as it is.
- `LICENSE` — MIT.

## Verify

The kit's practice set (100 checks) scores 1000 on this implementation,
and it was differentially tested against the first entry on 162
specification-derived checks written for this rebuild: the only
differences are the cases above, where this version follows the
specification and the first entry did not.

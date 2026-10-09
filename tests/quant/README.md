# Quant tests

Numeric checks for the Batcave math: each test feeds a module a synthetic or
textbook case with a known answer and asserts the module reproduces it.

Run (Node 22, no npm install needed for pure-math modules):

```bash
node --experimental-transform-types --no-warnings \
  --import ./tests/quant/loader/register.mjs --test 'tests/quant/*.test.ts'
```

Rules:

- One file per workstream area: `tests/quant/<area>.test.ts`, using `node:test`
  and `node:assert/strict`.
- Each test names its reference (paper, textbook, exchange document) in a
  comment next to the expected value.
- Tests must be deterministic: seeded random numbers only.
- Modules that import database or network packages can't be loaded without
  `npm ci`; test their pure helpers, or move the math into a pure helper.

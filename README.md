# site-generator-speed-01

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/arbitojeep/site-generator-speed-01/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/arbitojeep/site-generator-speed-01/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A faster drop-in for make.fun's makefun-site 1.0.0: it builds the same static sites byte for byte, about 1.5x faster on the practice set. Written from the published spec (front matter, template dialect, Markdown subset, slug rule, report): strict front matter with its own value grammars and refusal reasons, templates compiled once per case into flat op lists, Markdown lexed in a single pass with a first-character dispatch, inline rendering with a fast path for plain text, ASCII fast paths for slugify and escaping, and words counted while the body is scanned. Verified against the kit: all 3 practice cases match the reference byte for byte, and 16 further generated case sets (48 cases) from the kit generator match too.

## Run it

```sh
node main.ts
```

`main.ts` reads every case from `/input/cases.json` (or `MAKEFUN_INPUT_DIR`), answers each with `run` from `solve.js`, and writes `/output/answers.json` (or `MAKEFUN_OUTPUT_DIR`).

---

<sub>Entered on [make.fun](https://make.fun/?ref=scyzh5ae&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>

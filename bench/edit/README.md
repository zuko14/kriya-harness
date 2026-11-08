# KriyaEditBench

The method is in Kriya's `docs/kriya-harness/kriya_video_editing/EVALUATION_PLAN.md`.

| Suite | Runs where | Costs | Status |
| --- | --- | --- | --- |
| KriyaEditBench-M | `npm run bench:m` (`tests/edit/bench-m/`) | Nothing: a scripted model | Runs today |
| KriyaEditBench-R | Here | Real models and raters, with the owner's go-ahead per run (EDD-35) | **Not run. No comparative claim exists** |

| File | What |
| --- | --- |
| `grade/index.js` | The independent grader: plain ffprobe and ffmpeg, no code from `src/edit` |
| `analyze.js` | Win rates, Bradley-Terry, bootstrap, sign test, cost per accepted, pass^k |
| `corpus.js` | Refuses footage with no release, pass lists that can't fail, and a run with no written go-ahead |
| `blind.js` | Packages for raters: renamed, stripped of metadata; the key apart |

Not here yet, because they need what the owner holds: the footage and audited lists (EB-05),
the arms' accounts, a real recogniser for speech checks (EB-11), an OCR choice, and the
go-ahead (EB-07). Until the grader has an independent recogniser, speech lines come out
`notMeasured`, and a task can't pass on them.

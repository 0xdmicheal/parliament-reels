# parliament-reels

Records Poster Studio videos (the TenGer Parliament TV designs as MP4) on GitHub Actions, so no studio PC is needed.

- `parliament-widget` → `/api/reel-cloud` starts the `reel` workflow with `{ id, spec }`.
- Up to 20 machines each record a slice of the video from the live `/tv` page (`reels.mjs work`), frame by frame on Chrome's virtual clock.
- One job joins the pieces without re-encoding (`reels.mjs join`) and publishes `reel.mp4` as the release `reel-<id>`. Releases are deleted after three days.

Local check: `node reels.mjs plan spec.json`.

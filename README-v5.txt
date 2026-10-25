Studio v5 (cumulative: sentence matching + leader boxes + final rejection) — backend, repo: nativoya
1) Supabase -> SQL Editor: run db/migration_studio_v5.sql   (one new column; safe to run twice; run it BEFORE deploying)
2) Copy these files over the same paths in the repo, commit, let Vercel deploy:
   db/migration_studio_v5.sql            (new)
   config/studioFeedbackMatch.js         (new)
   config/studioFeedback.js
   config/studioLeader.js
   routes/studio/feedback.js
   tests/feedback-match.test.js, tests/leader-boxes.test.js   (new, optional)
3) Then upload the frontend zip to the gigverse-studio repo.

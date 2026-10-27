Studio v8 (batch 1) — backend, repo: nativoya
1) Supabase -> SQL Editor: run db/migration_studio_v8.sql   (safe to run twice; run it BEFORE deploying)
2) Copy these files over the same paths in the repo, commit, let Vercel deploy:
   db/migration_studio_v8.sql      (new)
   config/studioProfile.js         (new)
   config/studioScripts.js
   routes/studio/auth.js, routes/studio/talent.js, routes/studio/headleader.js
   tests/real-data.test.js (new), tests/expiry.test.js   (optional)
3) Then upload the frontend zip to the gigverse-studio repo.
To delete the old talent accounts: the last block of migration_studio_v8.sql (commented) — read it, uncomment, run.

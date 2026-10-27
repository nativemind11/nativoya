Studio v10 (task password) — backend, repo: nativoya
1) Supabase -> SQL Editor: run db/migration_studio_v10.sql   (one new column; safe to run twice; run it BEFORE deploying)
2) Copy these files over the same paths in the repo, commit, let Vercel deploy:
   db/migration_studio_v10.sql           (new)
   config/studioTaskLock.js              (new)
   config/studioScripts.js
   routes/studio/talent.js, routes/studio/headleader.js
   tests/task-password.test.js           (new, optional)
3) Then upload the frontend zip to the gigverse-studio repo.
Nothing existing changes: every task that exists today stays open (no password) until the head leader sets one.

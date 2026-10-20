Studio v3 — backend (repo: nativoya)
1) Supabase -> SQL Editor: run db/migration_studio_v3.sql  (safe to run twice; run it BEFORE deploying)
2) Copy these files over the same paths in the repo, commit, let Vercel deploy:
   db/migration_studio_v3.sql        (new)
   config/studioScripts.js           (new)
   config/studioLeaders.js, config/studioLeader.js, config/studioFeedback.js
   routes/studio/headleader.js, routes/studio/talent.js
3) Then upload the frontend zip (Studio-Frontend-Update-2.zip) to the gigverse-studio repo.

// One-time helper: run `node db/hash-password.js "your-password-here"` from
// the backend project folder (needs bcryptjs installed, which it already
// is) to get a bcrypt hash you can paste into the studio_head_leaders
// INSERT template at the bottom of migration_studio.sql.
const bcrypt = require("bcryptjs");

const password = process.argv[2];
if (!password) {
  console.error("Usage: node db/hash-password.js \"your-password\"");
  process.exit(1);
}

bcrypt.hash(password, 10).then((hash) => {
  console.log(hash);
});

/**
 * True once migration_studio_v7.sql has been run (cached once true). Everything that depends on the feedback
 * files / the rework batches asks this first, so deploying the code before the migration can never break a page.
 */
let ready = false;
async function v7Ready(db) {
  if (ready) return true;
  const r = await db.query(
    `SELECT (SELECT COUNT(*)::int FROM information_schema.columns
             WHERE (table_name = 'studio_feedback_items' AND column_name IN ('sheet_label', 'rework_batch_id'))
                OR (table_name = 'studio_delivery_batches' AND column_name = 'feedback_file_id')) AS cols,
            to_regclass('studio_feedback_files') IS NOT NULL AS tbl`);
  if (r.rows[0].cols === 3 && r.rows[0].tbl) ready = true;
  return ready;
}
module.exports = { v7Ready };

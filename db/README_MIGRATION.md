# ترقية قاعدة البيانات — من منصة سياحة/ترجمة إلى منصة AI training

هذا التحديث غيّر شكل الداتا بشكل جوهري (الأدوار، الجروبات المتعددة، المهارات،
تفاصيل المهمة). أسهل وأضمن طريقة هي إعادة إنشاء القاعدة من الصفر:

```sql
-- في Supabase SQL Editor:
DROP SCHEMA public CASCADE;
CREATE SCHEMA public;
-- بعدين الصق محتوى schema.sql بالكامل وشغّله
```

⚠️ ده هيمسح أي بيانات قديمة (حسابات مرشدين/سائحين قديمة). لو عندك مستخدمين
حقيقيين على النسخة القديمة ومحتاج تحتفظ بيهم، قولّي وهجهزلك سكريبت ترحيل بدل
المسح الكامل.

## تحديث لاحق: دعم أكتر من رابط فيديو/صوت لكل مهمة (بدون مسح البيانات)

لو عندك بيانات حقيقية بالفعل (مهام، ليدرز، أعضاء) ومش عايز تمسح حاجة، شغّل السكريبت ده
بدل إعادة بناء القاعدة من الصفر بالكامل:

```sql
ALTER TABLE tasks RENAME COLUMN video_url TO video_url_old;
ALTER TABLE tasks RENAME COLUMN audio_sample_url TO audio_sample_url_old;
ALTER TABLE tasks ADD COLUMN video_urls TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE tasks ADD COLUMN audio_sample_urls TEXT[] NOT NULL DEFAULT '{}';
UPDATE tasks SET video_urls = CASE WHEN video_url_old IS NOT NULL AND video_url_old <> '' THEN ARRAY[video_url_old] ELSE '{}' END;
UPDATE tasks SET audio_sample_urls = CASE WHEN audio_sample_url_old IS NOT NULL AND audio_sample_url_old <> '' THEN ARRAY[audio_sample_url_old] ELSE '{}' END;
ALTER TABLE tasks DROP COLUMN video_url_old;
ALTER TABLE tasks DROP COLUMN audio_sample_url_old;
```

## تحديث لاحق: منع تكرار "الاستلام التلقائي" للمهام (auto-claim) + تنظيف التكرار الموجود

باگ قديم كان بيخلي المهمة الواحدة تتـ"استلم تلقائيًا" أكتر من مرة لنفس الجروب (اللي مالوش
ليدر)، فتظهر نفس المهمة أكتر من مرة في صفحة العضو. السكريبت ده بيعمل حاجتين: (1) يمنع
تكرار الاستلام التلقائي مستقبليًا بقيد صارم على مستوى القاعدة، و(2) يدمج أي تكرار موجود
بالفعل في مهمة واحدة بس، من غير ما يفقد أي تسليم اترفع بالفعل.

```sql
BEGIN;

-- 1) أضف عمود وقيد يمنعوا تكرار الاستلام التلقائي مستقبليًا
ALTER TABLE task_claims ADD COLUMN IF NOT EXISTS auto_claimed BOOLEAN NOT NULL DEFAULT false;
-- علّم أي استلام حالي لجروب بدون ليدر كـ "تلقائي" (ده اللي كان بيتكرر)
UPDATE task_claims tc SET auto_claimed = true
FROM groups g WHERE g.id = tc.group_id AND g.leader_id IS NULL;

-- 2) لكل (مهمة + جروب) فيهم أكتر من استلام تلقائي، انقل أي تسليمات
--    من النسخ الزيادة للنسخة الأقدم، وخلي كميتها = إجمالي المهمة
WITH ranked AS (
  SELECT id, task_id, group_id,
         ROW_NUMBER() OVER (PARTITION BY task_id, group_id ORDER BY claimed_at ASC) AS rn
  FROM task_claims WHERE auto_claimed
),
survivors AS (SELECT task_id, group_id, id AS keep_id FROM ranked WHERE rn = 1),
dupes AS (
  SELECT r.id AS dup_id, s.keep_id
  FROM ranked r JOIN survivors s ON s.task_id = r.task_id AND s.group_id = r.group_id
  WHERE r.rn > 1
)
UPDATE submissions SET task_claim_id = dupes.keep_id
FROM dupes WHERE submissions.task_claim_id = dupes.dup_id;

UPDATE task_claims tc SET quantity = t.total_quantity
FROM tasks t, (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY task_id, group_id ORDER BY claimed_at ASC) AS rn
  FROM task_claims WHERE auto_claimed
) ranked
WHERE tc.id = ranked.id AND ranked.rn = 1 AND t.id = tc.task_id;

DELETE FROM task_claims WHERE id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY task_id, group_id ORDER BY claimed_at ASC) AS rn
    FROM task_claims WHERE auto_claimed
  ) x WHERE rn > 1
);

-- 3) القيد النهائي اللي بيمنع تكرار الاستلام التلقائي للأبد
CREATE UNIQUE INDEX IF NOT EXISTS task_claims_auto_unique ON task_claims (task_id, group_id) WHERE auto_claimed;

COMMIT;
```

## تحديث تالت: نفس مشكلة التكرار، بس السبب الحقيقي كان مختلف

اتضح إن السبب الحقيقي مش تكرار نفس الجروب — السبب إن أي عضو بقى منضم لأكتر من لغة/جروب
(ميزة "اضف لغة جديدة")، والكود كان بيدي **كل جروب من جروباته الكمية الكاملة للمهمة نفسها
في نفس اللحظة**، بدل ما يوزّعها بينهم صح. اتصلح الكود خالص (بقى بيستلم جروب واحد بعد التاني
مش كلهم مرة واحدة). السكريبت ده بينظف أي تكرار حصل قبل كده:

```sql
BEGIN;

WITH ranked AS (
  SELECT tc.id, tc.task_id,
         ROW_NUMBER() OVER (
           PARTITION BY tc.task_id
           ORDER BY (SELECT COUNT(*) FROM submissions WHERE task_claim_id = tc.id) DESC, tc.claimed_at ASC
         ) AS rn
  FROM task_claims tc WHERE tc.auto_claimed
),
survivors AS (SELECT task_id, id AS keep_id FROM ranked WHERE rn = 1)
UPDATE submissions SET task_claim_id = survivors.keep_id
FROM ranked r JOIN survivors ON survivors.task_id = r.task_id
WHERE submissions.task_claim_id = r.id AND r.rn > 1;

UPDATE task_claims tc SET quantity = t.total_quantity
FROM tasks t, (
  SELECT id, ROW_NUMBER() OVER (
    PARTITION BY task_id
    ORDER BY (SELECT COUNT(*) FROM submissions WHERE task_claim_id = task_claims.id) DESC, claimed_at ASC
  ) AS rn
  FROM task_claims WHERE auto_claimed
) ranked
WHERE tc.id = ranked.id AND ranked.rn = 1 AND t.id = tc.task_id;

DELETE FROM task_claims WHERE id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY task_id
      ORDER BY (SELECT COUNT(*) FROM submissions WHERE task_claim_id = task_claims.id) DESC, claimed_at ASC
    ) AS rn
    FROM task_claims WHERE auto_claimed
  ) x WHERE rn > 1
);

COMMIT;
```

⚠️ بعد السكريبت ده، هيفضل **جروب واحد بس** (الأول اللي عليه تسليمات حقيقية، أو الأقدم لو
مفيش) هو اللي شايل المهمة دي فعليًا — باقي جروبات نفس العضو مش هيشوفوها تاني، وده صح لأن
الكمية الأصلية اتحسبت مرة واحدة بس.

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

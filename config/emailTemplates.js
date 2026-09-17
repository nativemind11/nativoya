// Branded HTML email templates. Kept table-based with inline styles (no
// external stylesheet) because that's the only way to get consistent
// rendering across Gmail/Outlook/Apple Mail — matches the site's colors
// from css/style.css (--color-primary-blue, --color-accent-purple, etc).

function passwordResetEmail({ firstName, resetUrl }) {
  const safeName = String(firstName || "صديقنا").replace(/</g, "&lt;");
  return `
<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0; padding:0; background-color:#EEF1FC; font-family:'Tajawal','Cairo',Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#EEF1FC; padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px; background:#FFFFFF; border-radius:18px; overflow:hidden; box-shadow:0 10px 30px rgba(76,111,240,0.10);">
          <tr>
            <td style="background:linear-gradient(90deg,#4C6FF0,#8B5CF6); padding:28px 32px;" align="center">
              <span style="font-family:'Baloo 2','Cairo',Arial,sans-serif; font-size:22px; font-weight:800; color:#ffffff; letter-spacing:0.5px;">Nativoya</span>
            </td>
          </tr>
          <tr>
            <td style="padding:32px; text-align:right; direction:rtl;">
              <h1 style="margin:0 0 16px; font-size:20px; color:#12142B; font-family:'Cairo','Baloo 2',Arial,sans-serif;">استرجاع كلمة المرور</h1>
              <p style="margin:0 0 16px; font-size:15px; line-height:1.7; color:#3a3d55;">
                أهلاً ${safeName} 👋<br>
                وصلنا طلب لاسترجاع كلمة المرور بتاعة حسابك على Nativoya. دوس على الزرار اللي تحت عشان تختار كلمة مرور جديدة:
              </p>
              <table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px auto;">
                <tr>
                  <td align="center" style="border-radius:999px; background:linear-gradient(90deg,#4C6FF0,#8B5CF6);">
                    <a href="${resetUrl}" style="display:inline-block; padding:14px 36px; font-size:15px; font-weight:700; color:#ffffff; text-decoration:none; border-radius:999px; font-family:'Cairo','Baloo 2',Arial,sans-serif;">
                      إعادة تعيين كلمة المرور
                    </a>
                  </td>
                </tr>
              </table>
              <p style="margin:0 0 8px; font-size:13px; line-height:1.7; color:#6B7280;">
                الرابط ده هيشتغل لمدة ساعة واحدة بس من دلوقتي. لو مطلبتش الاسترجاع ده، ممكن تتجاهل الإيميل ده بكل أمان — حسابك هيفضل زي ما هو.
              </p>
              <p style="margin:16px 0 0; font-size:12px; line-height:1.6; color:#9AA0B4; word-break:break-all;">
                لو الزرار مش شغال، انسخ الرابط ده وحطه في المتصفح:<br>
                <a href="${resetUrl}" style="color:#4C6FF0;">${resetUrl}</a>
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:18px 32px; background:#F7F8FD; border-top:1px solid #E1E4F5; text-align:center;">
              <p style="margin:0; font-size:12px; color:#9AA0B4;">© Nativoya — منصة عمل أونلاين لتدريب نماذج الذكاء الاصطناعي</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

module.exports = { passwordResetEmail };

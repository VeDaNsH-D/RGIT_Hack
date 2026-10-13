import nodemailer from 'nodemailer';
export function invitationEmailError(error) {
  if (error.code === 'EDNS') return 'SMTP hostname could not be resolved. For Gmail, set SMTP_HOST=smtp.gmail.com.';
  if (error.code === 'EAUTH') return 'SMTP authentication failed. Check SMTP_USER and SMTP_PASS; Gmail requires an App Password.';
  if (['ETIMEDOUT', 'ESOCKET', 'ECONNECTION'].includes(error.code)) return 'Could not connect to the SMTP server. Check the host, port, TLS settings and network connection.';
  return 'Could not send the invitation email. Check your SMTP settings and try again.';
}
export function invitationEmailConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS && process.env.INVITE_FROM_EMAIL);
}
export function invitationTransport() {
  const port = Number(process.env.SMTP_PORT || 465);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Object.assign(new Error('SMTP_PORT must be a valid port number.'), { status: 503 });
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST?.trim(), port, secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : port === 465,
    requireTLS: port !== 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000,
    logger: false, debug: false,
  });
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function invitationEmailHtml({ projectName, inviterName, email, url }) {
  const safeProject = escapeHtml(projectName);
  const safeInviter = escapeHtml(inviterName);
  const safeEmail = escapeHtml(email);
  const safeUrl = escapeHtml(url);
  return `<!doctype html>
<html>
<body style="margin:0;padding:0;background:#faf9f6;font-family:Arial,Helvetica,sans-serif;color:#221e1b;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#faf9f6;padding:40px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" style="max-width:480px;background:#ffffff;border:1px solid #ede8e2;border-radius:12px;overflow:hidden;">
        <tr><td style="padding:28px 32px 0;">
          <span style="display:inline-block;font-size:20px;font-weight:700;color:#ff3c0a;letter-spacing:-0.02em;">Over2u</span>
        </td></tr>
        <tr><td style="padding:24px 32px 0;">
          <h1 style="margin:0 0 8px;font-size:20px;line-height:1.3;color:#221e1b;">You're invited to ${safeProject}</h1>
          <p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:#737373;">${safeInviter} invited you to join <strong style="color:#221e1b;">${safeProject}</strong> on Over2u — a shared source of truth for your team's tasks, handoffs, and context.</p>
        </td></tr>
        <tr><td style="padding:0 32px 28px;">
          <a href="${safeUrl}" style="display:inline-block;background:#ff3c0a;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:12px 24px;border-radius:8px;">Accept invitation</a>
        </td></tr>
        <tr><td style="padding:0 32px 28px;border-top:1px solid #ede8e2;padding-top:20px;">
          <p style="margin:0 0 6px;font-size:12px;line-height:1.6;color:#737373;">Sign in or create an account using <strong style="color:#221e1b;">${safeEmail}</strong>.</p>
          <p style="margin:0 0 6px;font-size:12px;line-height:1.6;color:#737373;">This invitation expires in 7 days. If you weren't expecting it, you can ignore this email.</p>
          <p style="margin:12px 0 0;font-size:11px;line-height:1.6;color:#999087;word-break:break-all;">Or paste this link into your browser: <a href="${safeUrl}" style="color:#ff3c0a;">${safeUrl}</a></p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

export async function sendInvitationEmail({ id, email, projectName, inviterName, url }) {
  if (!invitationEmailConfigured()) throw Object.assign(new Error('Invitation email is not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASS and INVITE_FROM_EMAIL on the backend.'), { status: 503 });
  try {
    const result = await invitationTransport().sendMail({
      from: process.env.INVITE_FROM_EMAIL, to: email,
      messageId: `<invitation-${id}@over2u.local>`,
      subject: `You’re invited to ${projectName.replace(/[\r\n]/g, ' ')} on Over2u`,
      text: `${inviterName} invited you to join ${projectName} on Over2u.\n\nReview and accept your invitation:\n${url}\n\nSign in or create an account using ${email}. This invitation expires in 7 days. If you weren’t expecting it, you can ignore this email.`,
      html: invitationEmailHtml({ projectName, inviterName, email, url }),
      disableFileAccess: true, disableUrlAccess: true,
    });
    if (!result.accepted?.length || result.rejected?.length) throw new Error('Recipient rejected');
  } catch (error) {
    const message = invitationEmailError(error);
    throw Object.assign(new Error(message), { status: 502 });
  }
}

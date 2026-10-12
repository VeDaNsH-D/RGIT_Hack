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
export async function sendInvitationEmail({ id, email, projectName, inviterName, url }) {
  if (!invitationEmailConfigured()) throw Object.assign(new Error('Invitation email is not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASS and INVITE_FROM_EMAIL on the backend.'), { status: 503 });
  try {
    const result = await invitationTransport().sendMail({
      from: process.env.INVITE_FROM_EMAIL, to: email,
      messageId: `<invitation-${id}@over2u.local>`,
      subject: `You’re invited to ${projectName.replace(/[\r\n]/g, ' ')} on Over2u`,
      text: `${inviterName} invited you to join ${projectName} on Over2u.\n\nReview and accept your invitation:\n${url}\n\nSign in or create an account using ${email}. This invitation expires in 7 days. If you weren’t expecting it, you can ignore this email.`,
      disableFileAccess: true, disableUrlAccess: true,
    });
    if (!result.accepted?.length || result.rejected?.length) throw new Error('Recipient rejected');
  } catch (error) {
    const message = invitationEmailError(error);
    throw Object.assign(new Error(message), { status: 502 });
  }
}

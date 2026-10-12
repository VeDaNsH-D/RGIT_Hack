import 'dotenv/config';
import { invitationEmailConfigured, invitationTransport, invitationEmailError } from '../src/services/invitationEmail.js';
if (!invitationEmailConfigured()) {
  console.error('Set SMTP_HOST, SMTP_USER, SMTP_PASS and INVITE_FROM_EMAIL in Backend/.env first.');
  process.exitCode = 1;
} else {
  const transport = invitationTransport();
  try { await transport.verify(); console.log('SMTP connection and authentication succeeded. No email was sent.'); }
  catch (error) { console.error(invitationEmailError(error)); process.exitCode = 1; }
  finally { transport.close(); }
}

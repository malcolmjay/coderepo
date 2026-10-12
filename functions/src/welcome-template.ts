import {email} from "./domain.js";

export const WELCOME_PORTAL_URL = "https://camera-hacks.web.app/";
export const WELCOME_SUBJECT = "Welcome to Camera Hacks — your portal is ready";
const escape = (value: string) => value.replace(/[&<>"']/g, character => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[character]!));

/** A stable portal link, never an expiring sign-in credential or download URL. */
export function welcomeMessage(address: string) {
  const recipient = email(address);
  const text = `Welcome to Camera Hacks.

Your customer portal is ready.

Thanks for being part of Camera Hacks. I've added your email to the portal, where you'll find the latest firmware, camera software, 3D files, and guides for your build.

Open your customer portal: ${WELCOME_PORTAL_URL}

Getting started
1. Open the portal and enter ${recipient}.
2. Request a sign-in link and check your inbox. No password needed.
3. Sign in, agree to the Software & Design Usage License, and choose your downloads.

Make it your own
Visit Community Builds to explore customer-made designs and share your own. Have an idea for the camera? Submit it in Enhancement Requests, like other ideas, and follow their progress.

Happy building,
Malcolm
Camera Hacks by Malcolm-Jay

You're receiving this account welcome because Camera Hacks added this email to the customer portal. If you weren't expecting access, you can ignore this email. For help, use the contact options at https://camerahacksbymalcolmjay.com/.
`;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Welcome to Camera Hacks</title></head>
<body style="margin:0;padding:0;background:#eeeeea;color:#252523;font-family:Arial,Helvetica,sans-serif;-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">Your access to firmware, 3D files, and the Camera Hacks community starts here.</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#eeeeea"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellspacing="0" cellpadding="0" style="width:100%;max-width:600px;background:#ffffff">
<tr><td style="padding:28px;background:#252523;border-top:5px solid #f04b2d;color:#ffffff"><p style="margin:0;font-size:28px;font-weight:800;line-height:0.95;letter-spacing:-1px">CAMERA<br>HACKS<span style="color:#ff694c">.</span></p><p style="margin:12px 0 0;font-size:11px;letter-spacing:2px;color:#dadad3">BY MALCOLM-JAY</p></td></tr>
<tr><td style="padding:32px 28px 20px"><p style="margin:0 0 16px;color:#a52d17;font-family:'Courier New',monospace;font-size:12px;font-weight:bold;letter-spacing:2px">WELCOME TO THE WORKSHOP</p><h1 style="margin:0 0 20px;font-size:34px;line-height:1.12;letter-spacing:-1px">Your customer<br>portal is ready.</h1><p style="margin:0 0 16px;font-size:16px;line-height:1.6">Thanks for being part of Camera Hacks. I’ve added your email to the portal, where you’ll find the latest firmware, camera software, 3D files, and guides for your build.</p>
<table role="presentation" cellspacing="0" cellpadding="0" style="margin:24px 0"><tr><td bgcolor="#f04b2d" style="background:#f04b2d"><a href="${WELCOME_PORTAL_URL}" style="display:inline-block;padding:16px 22px;border:1px solid #f04b2d;color:#171716;font-size:15px;font-weight:bold;text-decoration:none">Open customer portal &#8594;</a></td></tr></table>
<h2 style="margin:28px 0 14px;font-size:20px;line-height:1.3">Getting started</h2><ol style="margin:0;padding-left:22px;font-size:15px;line-height:1.7"><li style="padding:0 0 10px">Open the portal and enter <strong style="overflow-wrap:anywhere;word-break:break-all">${escape(recipient)}</strong>.</li><li style="padding:0 0 10px">Request a sign-in link and check your inbox. No password needed.</li><li>Sign in, agree to the Software &amp; Design Usage License, and choose your downloads.</li></ol>
</td></tr>
<tr><td style="padding:10px 28px 28px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td style="padding:22px;background:#f3f3ef;border-left:3px solid #f04b2d"><h2 style="margin:0 0 10px;font-size:20px">Make it your own.</h2><p style="margin:0;font-size:15px;line-height:1.6">Visit <strong>Community Builds</strong> to explore customer-made designs and share your own. Have an idea for the camera? Submit it in <strong>Enhancement Requests</strong>, like other ideas, and follow their progress.</p></td></tr></table><p style="margin:26px 0 0;font-size:16px;line-height:1.6">Happy building,<br><strong>Malcolm</strong></p></td></tr>
<tr><td style="padding:22px 28px;border-top:1px solid #e3e3dc"><p style="margin:0 0 12px;font-size:12px;line-height:1.6;color:#66665f">Button not working? Open <a href="${WELCOME_PORTAL_URL}" style="color:#842612;text-decoration:underline;word-break:break-all">camera-hacks.web.app</a>.</p><p style="margin:0;font-size:12px;line-height:1.6;color:#66665f">You’re receiving this account welcome because Camera Hacks added this email to the customer portal. If you weren’t expecting access, you can ignore this email. For help, use the contact options on <a href="https://camerahacksbymalcolmjay.com/" style="color:#842612;text-decoration:underline">our website</a>.</p></td></tr>
</table></td></tr></table></body></html>`;
  return {subject: WELCOME_SUBJECT, text, html};
}

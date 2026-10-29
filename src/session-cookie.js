/** Build the shared session cookie for password, email, and first-run login. */
export function sessionCookie(req, value, maxAgeSec, name = 'gp_session') {
  const proto = String(req.headers['x-forwarded-proto'] ?? '').toLowerCase();
  const https = proto === 'https' || Boolean(req.socket?.encrypted);
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${https ? '; Secure' : ''}`;
}

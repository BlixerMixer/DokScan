// Supabase client and account helpers.
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

export const cloudEnabled = !!(SUPABASE_URL && SUPABASE_KEY && window.supabase?.createClient);

export const sb = cloudEnabled
  ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: 'dokscan-auth' },
  })
  : null;

// Where links in sign-up / password emails should lead back to.
export const siteUrl = () => location.origin + location.pathname;

const FRIENDLY = [
  [/invalid login credentials/i, 'Wrong email or password.'],
  [/email not confirmed/i, 'Please confirm your email first. Check your inbox (and spam folder) for the link.'],
  [/already registered|already exists/i, 'There is already an account with this email. Sign in instead.'],
  [/password should be at least|weak password/i, 'Choose a longer password (at least 6 characters).'],
  [/rate limit|too many/i, 'Too many attempts. Wait a minute and try again.'],
  [/unable to validate email|invalid.*email/i, 'That email address doesn’t look right.'],
  [/failed to fetch|network/i, 'Can’t reach the server. Check your internet connection.'],
];
export function friendlyError(e) {
  const msg = e?.message || String(e);
  return FRIENDLY.find(([re]) => re.test(msg))?.[1] || msg;
}

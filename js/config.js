// Accounts & cloud sync (Supabase).
//
// Leave both empty to run DokScan without accounts (documents stay in the
// browser on each device). To turn accounts on, create a free Supabase
// project, run supabase/setup.sql in its SQL editor and paste the values from
// Project Settings → API here. The publishable/anon key is meant to be public;
// the database rules in setup.sql make sure people only see their own documents.
export const SUPABASE_URL = '';
export const SUPABASE_KEY = '';

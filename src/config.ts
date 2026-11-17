// Public connection details. The publishable key is meant to be in the browser:
// what protects shop data is row-level security in the database, not this key.
export const SUPABASE_URL = 'https://ssewcrbyowphbrdjzucf.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_L-q4iT8q8MmOfBn-mqgWYw_tyxsZb4u';
export const PHOTO_BUCKET = 'product-photos';
// Turn on after Google sign-in is set up in Supabase (Authentication > Providers).
export const GOOGLE_SIGN_IN = false;
// Contact shown on the privacy page (email or Telegram). Required by the personal data
// law before real shoppers use the site. Leave empty to hide the line.
export const CONTACT = '';

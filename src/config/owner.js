// The workspace owner: the only account that becomes admin by itself (after confirming
// its email). Keep in step with owner_emails() in supabase/migrations.
export const OWNER_EMAILS = ['digitalhubars@gmail.com'];

export const isOwnerEmail = (email) => OWNER_EMAILS.includes(String(email || '').trim().toLowerCase());

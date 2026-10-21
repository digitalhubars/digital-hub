import { HttpError, adminDb, must, requireAdmin, route } from '../../../../server/supabase';

export const dynamic = 'force-dynamic';

// Creating and deleting sign-in accounts needs the secret key, so it happens here.
export const POST = route(async (request, body) => {
  const who = await requireAdmin(request);
  const db = adminDb();

  if (body.action === 'create') {
    const { email, password, fullName, role, groupId, clientId } = body;
    if (!['admin', 'manager', 'client'].includes(role)) throw new HttpError(400, 'Pick a role.');
    const { data, error } = await db.auth.admin.createUser({
      email,
      password,
      email_confirm: true, // the admin vouches for the address
      user_metadata: { full_name: fullName },
    });
    if (error) throw new HttpError(400, /already/i.test(error.message) ? 'An account with this email already exists.' : error.message);
    // The sign-up trigger created the profile as a client; set the chosen access.
    const profile = must(
      await db
        .from('profiles')
        .update({
          full_name: fullName,
          role,
          group_id: role === 'manager' ? groupId || null : null,
          client_id: role === 'client' ? clientId || null : null,
          status: 'active',
        })
        .eq('id', data.user.id)
        .select()
        .single(),
    );
    return { uid: data.user.id, profile };
  }

  if (body.action === 'delete') {
    if (body.uid === who.uid) throw new HttpError(400, 'You can’t delete your own account.');
    const { error } = await db.auth.admin.deleteUser(body.uid);
    if (error) throw new HttpError(400, error.message);
    return { ok: true };
  }

  throw new HttpError(400, 'Unknown action.');
});

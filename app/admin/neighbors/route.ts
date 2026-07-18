import { homeLabelToEmail } from "@/lib/auth-identifiers";
import { createClient as createServerClient } from "@/lib/supabase-server";
import { createClient as createSupabaseAdminClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

function generatePassword() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (byte) => (byte % 10).toString()).join("");
}

async function requireAdmin() {
  const supabase = await createServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) {
    return { error: NextResponse.json({ error: "Debes iniciar sesión como admin." }, { status: 401 }) };
  }

  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();

  if (profile?.role !== "admin") {
    return { error: NextResponse.json({ error: "Solo un admin puede gestionar vecinos." }, { status: 403 }) };
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    return {
      error: NextResponse.json(
        { error: "Falta configurar SUPABASE_SERVICE_ROLE_KEY en el servidor." },
        { status: 500 }
      )
    };
  }

  const admin = createSupabaseAdminClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  return { admin };
}

export async function GET() {
  const context = await requireAdmin();

  if ("error" in context) {
    return context.error;
  }

  const { data, error } = await context.admin
    .from("profiles")
    .select("id, full_name, role, homes(label)")
    .order("role", { ascending: true })
    .order("full_name", { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({ neighbors: data ?? [] });
}

export async function POST(request: Request) {
  const context = await requireAdmin();

  if ("error" in context) {
    return context.error;
  }

  const body = (await request.json().catch(() => null)) as { homeLabel?: string; fullName?: string } | null;
  const homeLabel = body?.homeLabel?.trim();
  const fullName = body?.fullName?.trim() || homeLabel;

  if (!homeLabel) {
    return NextResponse.json({ error: "Indica el piso del vecino." }, { status: 400 });
  }

  let email: string;
  try {
    email = homeLabelToEmail(homeLabel);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Piso no válido." }, { status: 400 });
  }

  const password = generatePassword();

  const { data: existingHome } = await context.admin.from("homes").select("id").eq("label", homeLabel).maybeSingle();
  const homeId =
    existingHome?.id ??
    (
      await context.admin
        .from("homes")
        .insert({ label: homeLabel })
        .select("id")
        .single()
    ).data?.id;

  if (!homeId) {
    return NextResponse.json({ error: "No se ha podido crear el piso." }, { status: 500 });
  }

  const { data: createdUser, error: createUserError } = await context.admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true
  });

  if (createUserError || !createdUser.user) {
    return NextResponse.json(
      { error: createUserError?.message ?? "No se ha podido crear el usuario." },
      { status: 400 }
    );
  }

  const { error: profileError } = await context.admin.from("profiles").insert({
    id: createdUser.user.id,
    home_id: homeId,
    full_name: fullName,
    role: "neighbor"
  });

  if (profileError) {
    await context.admin.auth.admin.deleteUser(createdUser.user.id);
    return NextResponse.json({ error: profileError.message }, { status: 400 });
  }

  return NextResponse.json({
    login: homeLabel,
    password,
    fullName,
    homeLabel
  });
}

export async function PATCH(request: Request) {
  const context = await requireAdmin();

  if ("error" in context) {
    return context.error;
  }

  const body = (await request.json().catch(() => null)) as { profileId?: string } | null;
  const profileId = body?.profileId;

  if (!profileId) {
    return NextResponse.json({ error: "Indica el vecino al que quieres resetear la contraseña." }, { status: 400 });
  }

  const { data: profile, error: profileError } = await context.admin
    .from("profiles")
    .select("id, role, homes(label)")
    .eq("id", profileId)
    .single();

  if (profileError || !profile) {
    return NextResponse.json({ error: profileError?.message ?? "Vecino no encontrado." }, { status: 404 });
  }

  if (profile.role === "admin") {
    return NextResponse.json({ error: "No se puede resetear la contraseña de un admin desde este panel." }, { status: 400 });
  }

  const password = generatePassword();
  const { error: updateError } = await context.admin.auth.admin.updateUserById(profileId, { password });

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 400 });
  }

  const home = (Array.isArray(profile.homes) ? profile.homes[0] : profile.homes) as { label?: string } | null | undefined;
  const homeLabel = home?.label;

  return NextResponse.json({
    login: homeLabel ?? "Vecino",
    password
  });
}

export async function DELETE(request: Request) {
  const context = await requireAdmin();

  if ("error" in context) {
    return context.error;
  }

  const body = (await request.json().catch(() => null)) as { profileId?: string } | null;
  const profileId = body?.profileId;

  if (!profileId) {
    return NextResponse.json({ error: "Indica el vecino que quieres eliminar." }, { status: 400 });
  }

  const { data: profile, error: profileError } = await context.admin
    .from("profiles")
    .select("role")
    .eq("id", profileId)
    .single();

  if (profileError || !profile) {
    return NextResponse.json({ error: profileError?.message ?? "Vecino no encontrado." }, { status: 404 });
  }

  // Delete bookings created by this user to avoid the ON DELETE RESTRICT foreign key constraint.
  // This also applies when the account being removed is an admin.
  const { error: bookingsError } = await context.admin
    .from("bookings")
    .delete()
    .eq("creator_user_id", profileId);

  if (bookingsError) {
    return NextResponse.json({ error: "No se pudieron eliminar las reservas del vecino." }, { status: 400 });
  }

  const { error: deleteError } = await context.admin.auth.admin.deleteUser(profileId);

  if (deleteError) {
    return NextResponse.json({ error: deleteError.message }, { status: 400 });
  }

  return NextResponse.json({ success: true });
}

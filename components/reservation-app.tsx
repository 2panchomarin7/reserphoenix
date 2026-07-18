"use client";

import { homeLabelToEmail } from "@/lib/auth-identifiers";
import { createClient, hasSupabaseConfig } from "@/lib/supabase-browser";
import { Booking, Profile, SPORT_CAPACITY, SPORT_LABELS, Sport } from "@/lib/types";
import {
  CalendarCheck,
  CalendarDays,
  CheckCircle2,
  Clock,
  Copy,
  Loader2,
  LogIn,
  LogOut,
  Plus,
  QrCode,
  RotateCcw,
  Shield,
  UserPlus,
  Users,
  XCircle,
  Trash2
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useCallback, useEffect, useMemo, useState } from "react";

type Counts = Record<string, { participants: number; waitlist: number }>;
type BookingParticipant = { full_name: string; homes?: { label: string } | null };
type AdminNeighbor = {
  id: string;
  full_name: string;
  role: "neighbor" | "admin";
  homes?: { label: string } | null;
};
type CredentialSet = { login: string; password: string } | null;

const STATUS_LABELS: Record<string, string> = {
  open: "Abierta",
  full: "Completa",
  checked_in: "Check-in",
  no_show: "No asistido",
  cancelled: "Cancelada"
};

const SLOT_HOURS = Array.from({ length: 13 }, (_, index) => index + 9);

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("es-ES", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Madrid"
  }).format(new Date(value));
}

function formatDayLabel(value: string) {
  return new Intl.DateTimeFormat("es-ES", {
    weekday: "long",
    day: "2-digit",
    month: "long",
    timeZone: "Europe/Madrid"
  })
    .format(new Date(value))
    .replace(/^./, (char) => char.toUpperCase());
}

function formatDaySelectLabel(value: string) {
  return new Intl.DateTimeFormat("es-ES", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    timeZone: "Europe/Madrid"
  })
    .format(new Date(value))
    .replace(/^./, (char) => char.toUpperCase());
}

function formatSlotHour(value: string) {
  return new Intl.DateTimeFormat("es-ES", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Madrid"
  }).format(new Date(value));
}

function madridDayKey(value: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Madrid",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(value));

  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return `${year}-${month}-${day}`;
}

function isWithinCheckInWindow(slotStart: string) {
  const now = Date.now();
  const slot = new Date(slotStart).getTime();
  return now >= slot - 15 * 60 * 1000 && now <= slot + 15 * 60 * 1000;
}

function madridOffsetFor(date: Date) {
  const offsetName = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Madrid",
    timeZoneName: "shortOffset"
  })
    .formatToParts(date)
    .find((part) => part.type === "timeZoneName")?.value;

  const match = offsetName?.match(/GMT([+-]\d{1,2})(?::(\d{2}))?/);
  const hours = Number(match?.[1] ?? 1);
  const minutes = Number(match?.[2] ?? 0);
  return `${hours >= 0 ? "+" : "-"}${String(Math.abs(hours)).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function madridSlotIso(dayOffset: number, hour: number) {
  const now = new Date();
  const madridParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Madrid",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);
  const year = madridParts.find((part) => part.type === "year")?.value;
  const month = madridParts.find((part) => part.type === "month")?.value;
  const day = madridParts.find((part) => part.type === "day")?.value;
  const base = new Date(`${year}-${month}-${day}T12:00:00Z`);
  base.setUTCDate(base.getUTCDate() + dayOffset);
  const nextParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Madrid",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(base);
  const nextYear = nextParts.find((part) => part.type === "year")?.value;
  const nextMonth = nextParts.find((part) => part.type === "month")?.value;
  const nextDay = nextParts.find((part) => part.type === "day")?.value;

  const probe = new Date(`${nextYear}-${nextMonth}-${nextDay}T12:00:00Z`);
  return `${nextYear}-${nextMonth}-${nextDay}T${String(hour).padStart(2, "0")}:00:00${madridOffsetFor(probe)}`;
}

function readableError(error: unknown) {
  if (error instanceof TypeError && error.message === "Load failed") {
    return "No se ha podido conectar con Supabase. Revisa NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY y reinicia el servidor.";
  }

  return error instanceof Error ? error.message : "Ha ocurrido un error inesperado.";
}

async function copyTextToClipboard(text: string) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Clipboard can be present but unavailable outside a secure context.
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);

  try {
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}

export function ReservationApp() {
  const supabase = useMemo(() => createClient(), []);
  const hasConfig = hasSupabaseConfig();
  const [homeLogin, setHomeLogin] = useState("");
  const [password, setPassword] = useState("");
  const [newHomeLabel, setNewHomeLabel] = useState("");
  const [newFullName, setNewFullName] = useState("");
  const [createdCredentials, setCreatedCredentials] = useState<CredentialSet>(null);
  const [resetCredentials, setResetCredentials] = useState<CredentialSet>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [neighbors, setNeighbors] = useState<AdminNeighbor[]>([]);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [historyBookings, setHistoryBookings] = useState<Booking[]>([]);
  const [counts, setCounts] = useState<Counts>({});
  const [participantsByBooking, setParticipantsByBooking] = useState<Record<string, BookingParticipant[]>>({});
  const [participantBookingIds, setParticipantBookingIds] = useState<string[]>([]);
  const [checkInBookingIds, setCheckInBookingIds] = useState<string[]>([]);
  const [cooldownUntil, setCooldownUntil] = useState<string | null>(null);
  const [selectedSport, setSelectedSport] = useState<Sport>("tennis");
  const [selectedSlot, setSelectedSlot] = useState("");
  const [origin, setOrigin] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isBusy, setIsBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [isCheckInQrVisible, setIsCheckInQrVisible] = useState(false);

  const loadData = useCallback(async () => {
    const { data: sessionData } = await supabase.auth.getSession();
    if (!sessionData.session) {
      setProfile(null);
      setBookings([]);
      setHistoryBookings([]);
      setParticipantsByBooking({});
      setParticipantBookingIds([]);
      setCheckInBookingIds([]);
      setCooldownUntil(null);
      setIsLoading(false);
      return;
    }

    const { data: profileData } = await supabase
      .from("profiles")
      .select("id, home_id, full_name, role, homes(label)")
      .eq("id", sessionData.session.user.id)
      .single();

    setProfile(profileData as Profile | null);

    if (profileData?.role === "admin") {
      const { data: neighborData } = await supabase
        .from("profiles")
        .select("id, full_name, role, homes(label)")
        .order("full_name", { ascending: true });

      setNeighbors((neighborData ?? []) as unknown as AdminNeighbor[]);
    } else {
      setNeighbors([]);
    }

    const { data: bookingData } = await supabase
      .from("bookings")
      .select("id, booking_number, sport, status, slot_start, local_date, creator_user_id, creator_home_id, profiles!bookings_creator_user_id_fkey(full_name, homes(label))")
      .gte("slot_start", new Date(Date.now() - 60 * 60 * 1000).toISOString())
      .order("slot_start", { ascending: true });

    // Cargar historial de reservas del usuario (donde participa)
    const { data: historyData } = await supabase
      .from("bookings")
      .select(`
        id,
        booking_number,
        sport,
        status,
        slot_start,
        local_date,
        creator_user_id,
        creator_home_id,
        profiles!bookings_creator_user_id_fkey(full_name, homes(label)),
        booking_participants!inner(user_id)
      `)
      .eq("booking_participants.user_id", sessionData.session.user.id)
      .order("slot_start", { ascending: false });

    setHistoryBookings((historyData ?? []) as unknown as Booking[]);

    const ids = (bookingData ?? []).map((booking: any) => booking.id);
    const nextCounts: Counts = {};
    const nextParticipants: Record<string, BookingParticipant[]> = {};

    if (ids.length) {
      const [
        { data: participants },
        { data: participantProfiles },
        { data: waitlist },
        { data: mine },
        { data: myCheckins },
        { data: cooldown }
      ] = await Promise.all([
        supabase.from("booking_participants").select("booking_id").in("booking_id", ids),
        supabase.from("booking_participants").select("booking_id, profiles(full_name, homes(label))").in("booking_id", ids),
        supabase.from("booking_waitlist").select("booking_id").in("booking_id", ids),
        supabase.from("booking_participants").select("booking_id").eq("user_id", sessionData.session.user.id).in("booking_id", ids),
        supabase.from("checkins").select("booking_id").eq("user_id", sessionData.session.user.id).in("booking_id", ids),
        supabase.from("booking_cooldowns").select("blocked_until").eq("user_id", sessionData.session.user.id).maybeSingle()
      ]);

      ids.forEach((id: string) => {
        nextCounts[id] = {
          participants: participants?.filter((row: any) => row.booking_id === id).length ?? 0,
          waitlist: waitlist?.filter((row: any) => row.booking_id === id).length ?? 0
        };
        nextParticipants[id] = (participantProfiles ?? [])
          .filter((row: any) => row.booking_id === id)
          .map((row: any) => row.profiles)
          .filter(Boolean) as BookingParticipant[];
      });

      setParticipantBookingIds(mine?.map((row: any) => row.booking_id) ?? []);
      setCheckInBookingIds(myCheckins?.map((row: any) => row.booking_id) ?? []);
      setCooldownUntil((cooldown as { blocked_until?: string } | null)?.blocked_until ?? null);
    } else {
      setParticipantBookingIds([]);
      setCheckInBookingIds([]);
      setCooldownUntil(null);
      setParticipantsByBooking({});
    }

    setCounts(nextCounts);
    setParticipantsByBooking(nextParticipants);
    setBookings((bookingData ?? []) as unknown as Booking[]);
    setIsLoading(false);
  }, [supabase]);

  const availableSlotGroups = useMemo(() => {
    const now = Date.now();

    return [0, 1, 2]
      .map((dayOffset) => ({
        dayOffset,
        slots: SLOT_HOURS.map((hour) => madridSlotIso(dayOffset, hour)).filter((slot) => {
          const time = new Date(slot).getTime();
          return time > now;
        })
      }))
      .filter((group) => group.slots.length > 0);
  }, []);

  const allAvailableSlots = useMemo(
    () => availableSlotGroups.flatMap((group) => group.slots),
    [availableSlotGroups]
  );

  const mobileDayOptions = useMemo(
    () =>
      availableSlotGroups.map((group) => {
        const firstSlot = group.slots[0];
        return {
          key: firstSlot ? madridDayKey(firstSlot) : `day-${group.dayOffset}`,
          label: firstSlot ? formatDaySelectLabel(firstSlot) : ""
        };
      }),
    [availableSlotGroups]
  );

  const selectedMobileDay = selectedSlot
    ? madridDayKey(selectedSlot)
    : mobileDayOptions[0]?.key ?? "";

  const selectedMobileSlots = useMemo(
    () => availableSlotGroups.find((group) => madridDayKey(group.slots[0] ?? "") === selectedMobileDay)?.slots ?? [],
    [availableSlotGroups, selectedMobileDay]
  );

  const activeCooldownUntil = cooldownUntil && new Date(cooldownUntil).getTime() > Date.now() ? cooldownUntil : null;
  const isJoinBlocked = Boolean(activeCooldownUntil);
  const participantBookingSet = useMemo(() => new Set(participantBookingIds), [participantBookingIds]);
  const checkInBookingSet = useMemo(() => new Set(checkInBookingIds), [checkInBookingIds]);

  useEffect(() => {
    setOrigin(window.location.origin);
    loadData();

    const { data } = supabase.auth.onAuthStateChange(() => {
      void loadData();
    });

    return () => data.subscription.unsubscribe();
  }, [loadData, supabase]);

  useEffect(() => {
    if (!allAvailableSlots.length) {
      if (selectedSlot) {
        setSelectedSlot("");
      }
      return;
    }

    if (!allAvailableSlots.includes(selectedSlot)) {
      setSelectedSlot(allAvailableSlots[0]);
    }
  }, [allAvailableSlots, selectedSlot]);

  async function signIn() {
    setIsBusy(true);
    let error: { message: string } | null = null;

    try {
      const email = homeLabelToEmail(homeLogin);
      ({ error } = await supabase.auth.signInWithPassword({ email, password }));
    } catch (caughtError) {
      error = { message: readableError(caughtError) };
    }

    setMessage(error ? error.message : "");
    setIsBusy(false);
  }

  async function signOut() {
    await supabase.auth.signOut();
    setProfile(null);
  }

  async function copyWithFeedback(text: string, successMessage: string) {
    const copied = await copyTextToClipboard(text);
    setMessage(copied ? successMessage : "No se ha podido copiar al portapapeles.");
  }

  async function shareBooking(booking: Booking) {
    const shareUrl = origin ? `${origin}/?booking=${booking.id}` : `${window.location.origin}/?booking=${booking.id}`;
    try {
      if (navigator.share) {
        await navigator.share({
          title: `Reserva de ${SPORT_LABELS[booking.sport]}`,
          text: `Únete a la reserva del ${formatDateTime(booking.slot_start)}.`,
          url: shareUrl
        });
        setMessage("Reserva compartida.");
        return;
      }
      const copied = await copyTextToClipboard(shareUrl);
      if (!copied) throw new Error("Clipboard unavailable");
      setMessage("Enlace de la reserva copiado.");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setMessage("No se ha podido compartir la reserva.");
    }
  }

  async function runAction(action: () => PromiseLike<{ error: { message: string } | null }>, success: string) {
    setIsBusy(true);
    const { error } = await action();
    setMessage(error ? error.message : success);
    await loadData();
    setIsBusy(false);
  }

  async function createNeighbor() {
    setIsBusy(true);
    setCreatedCredentials(null);
    setResetCredentials(null);

    let response: Response;
    try {
      response = await fetch("/admin/neighbors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ homeLabel: newHomeLabel, fullName: newFullName })
      });
    } catch (caughtError) {
      setMessage(readableError(caughtError));
      setIsBusy(false);
      return;
    }

    const result = (await response.json().catch(() => null)) as { error?: string; login?: string; password?: string } | null;

    if (!response.ok || !result?.login || !result?.password) {
      setMessage(result?.error ?? "No se ha podido dar de alta al vecino.");
    } else {
      setCreatedCredentials({ login: result.login, password: result.password });
      setNewHomeLabel("");
      setNewFullName("");
      setMessage("Vecino dado de alta. Guarda la contraseña antes de cerrar esta pantalla.");
      await loadData();
    }

    setIsBusy(false);
  }

  async function resetNeighborPassword(profileId: string) {
    setIsBusy(true);
    setResetCredentials(null);

    let response: Response;
    try {
      response = await fetch("/admin/neighbors", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profileId })
      });
    } catch (caughtError) {
      setMessage(readableError(caughtError));
      setIsBusy(false);
      return;
    }

    const result = (await response.json().catch(() => null)) as { error?: string; login?: string; password?: string } | null;

    if (!response.ok || !result?.login || !result?.password) {
      setMessage(result?.error ?? "No se ha podido resetear la contraseña.");
    } else {
      setResetCredentials({ login: result.login, password: result.password });
      setMessage("Contraseña reseteada. Comparte las nuevas credenciales con el vecino.");
    }

    await loadData();
    setIsBusy(false);
  }

  async function deleteNeighbor(profileId: string) {
    const target = neighbors.find((neighbor) => neighbor.id === profileId);
    const isDeletingAdmin = target?.role === "admin";
    const isDeletingSelf = profileId === profile?.id;
    const label = target?.full_name ?? (isDeletingAdmin ? "este admin" : "este vecino");
    const warning = isDeletingSelf
      ? "Se cerrará tu sesión y se borrará tu acceso y todas tus reservas."
      : `Se borrará el acceso de ${label} y todas sus reservas.`;

    if (!window.confirm(`¿Seguro que quieres eliminar ${isDeletingAdmin ? "este admin" : "este vecino"}? ${warning}`)) {
      return;
    }
    
    setIsBusy(true);

    let response: Response;
    try {
      response = await fetch("/admin/neighbors", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profileId })
      });
    } catch (caughtError) {
      setMessage(readableError(caughtError));
      setIsBusy(false);
      return;
    }

    const result = (await response.json().catch(() => null)) as { error?: string; success?: boolean } | null;

    if (!response.ok || !result?.success) {
      setMessage(result?.error ?? `No se ha podido eliminar ${isDeletingAdmin ? "al admin" : "al vecino"}.`);
    } else {
      setMessage(isDeletingAdmin ? "Admin eliminado correctamente." : "Vecino eliminado correctamente.");
    }

    if (response.ok && result?.success && isDeletingSelf) {
      await supabase.auth.signOut();
      setProfile(null);
      setNeighbors([]);
      setIsBusy(false);
      return;
    }

    await loadData();
    setIsBusy(false);
  }

  async function leaveBooking(bookingId: string) {
    setIsBusy(true);
    const { data, error } = await supabase.rpc("leave_booking", { p_booking_id: bookingId });

    if (error) {
      setMessage(error.message);
    } else if (data === "left_with_cooldown") {
      setMessage("Has salido de la reserva. Espera 5 minutos antes de unirte a otro deporte.");
    } else if (data === "left_waitlist") {
      setMessage("Has salido de la lista de espera.");
    } else {
      setMessage("Has salido de la reserva.");
    }

    await loadData();
    setIsBusy(false);
  }

  async function checkInBooking(bookingId: string) {
    setIsBusy(true);
    const { error } = await supabase.rpc("check_in_booking", { p_booking_id: bookingId });
    setMessage(error ? error.message : "Check-in registrado. La reserva queda validada.");
    await loadData();
    setIsBusy(false);
  }

  function selectMobileDay(dayKey: string) {
    const nextSlots = availableSlotGroups.find((group) => madridDayKey(group.slots[0] ?? "") === dayKey)?.slots ?? [];
    setSelectedSlot(nextSlots[0] ?? allAvailableSlots[0] ?? "");
  }

  const activeBookings = bookings.filter((booking) => booking.status !== "cancelled" && booking.status !== "no_show");
  const checkInUrl = origin ? `${origin}/check-in` : "";

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Comunidad de vecinos</p>
          <h1>Reserphoenix</h1>
        </div>
        {profile ? (
          <button className="icon-button logout-button" title="Cerrar sesión" aria-label="Cerrar sesión" onClick={signOut}>
            <LogOut size={19} />
            <span className="logout-label">Salir</span>
          </button>
        ) : null}
      </header>

      {!profile ? (
        <section className="auth-card">
          {!hasConfig ? (
            <p className="notice">
              Falta configurar Supabase. Crea `.env.local` con `NEXT_PUBLIC_SUPABASE_URL` y `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
            </p>
          ) : null}
          <div className="section-heading">
            <LogIn size={22} />
            <div>
              <h2>Acceso de vecinos</h2>
              <p>Entra con tu piso y la contraseña facilitada por la administración.</p>
            </div>
          </div>
          <label htmlFor="home-login">Piso</label>
          <input id="home-login" value={homeLogin} onChange={(event) => setHomeLogin(event.target.value)} placeholder="3º A" />
          <label htmlFor="password">Contraseña</label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Contraseña"
          />
          <button className="primary-action" disabled={isBusy || !homeLogin || !password} onClick={signIn}>
            {isBusy ? <Loader2 className="spin" size={18} /> : <LogIn size={18} />}
            Entrar
          </button>
          {message ? <p className="notice">{message}</p> : null}
        </section>
      ) : (
        <>
          <section className="profile-strip">
            <div>
              <span>Vecino</span>
              <strong>{profile.full_name}</strong>
            </div>
            <div>
              <span>Piso</span>
              <strong>{profile.homes?.label ?? "Sin piso"}</strong>
            </div>
            <div>
              <span>Rol</span>
              <strong>{profile.role === "admin" ? "Admin" : "Vecino"}</strong>
            </div>
          </section>

          {profile.role === "admin" ? (
            <section className="panel admin-panel">
              <div className="section-heading">
                <UserPlus size={22} />
                <div>
                  <h2>Alta de vecinos</h2>
                  <p>El usuario es el piso. La contraseña se genera automáticamente.</p>
                </div>
              </div>
              <div className="admin-form">
                <label htmlFor="new-home">Piso</label>
                <input id="new-home" value={newHomeLabel} onChange={(event) => setNewHomeLabel(event.target.value)} placeholder="3º A" />
                <label htmlFor="new-name">Nombre visible</label>
                <input
                  id="new-name"
                  value={newFullName}
                  onChange={(event) => setNewFullName(event.target.value)}
                  placeholder="Vecino 3º A"
                />
                  <button className="primary-action" disabled={isBusy || !newHomeLabel} onClick={createNeighbor}>
                    {isBusy ? <Loader2 className="spin" size={18} /> : <UserPlus size={18} />}
                    Dar de alta
                  </button>
                </div>
              {createdCredentials ? (
                <div className="credentials-box">
                  <span>Usuario</span>
                  <strong>{createdCredentials.login}</strong>
                  <span>Contraseña</span>
                  <code>{createdCredentials.password}</code>
                  <button
                    className="secondary-action"
                    type="button"
                    onClick={() =>
                      copyWithFeedback(
                        `Usuario: ${createdCredentials.login}\nContraseña: ${createdCredentials.password}`,
                        "Credenciales copiadas."
                      )
                    }
                  >
                    <Copy size={17} />
                    Copiar credenciales
                  </button>
                </div>
              ) : null}

              {profile.role === "admin" ? (
                <div className="neighbor-list">
                  <div className="neighbor-list-head">
                    <h3>Usuarios</h3>
                    <span>{neighbors.filter((neighbor) => neighbor.role !== "admin").length} vecinos</span>
                  </div>
                  <div className="neighbor-items">
                    {neighbors.map((neighbor) => (
                      <article className="neighbor-item" key={neighbor.id}>
                        <div className="neighbor-copy">
                          <strong>{neighbor.full_name}</strong>
                          <span>{neighbor.homes?.label ?? "Sin piso"}</span>
                        </div>
                        <div className="neighbor-actions">
                          <span className={`status status-${neighbor.role === "admin" ? "full" : "open"}`}>
                            {neighbor.role === "admin" ? "Admin" : "Vecino"}
                          </span>
                          <div style={{ display: "flex", gap: "0.5rem" }}>
                            {neighbor.role !== "admin" ? (
                              <button
                                className="secondary-action"
                                disabled={isBusy}
                                onClick={() => resetNeighborPassword(neighbor.id)}
                              >
                                <RotateCcw size={17} />
                                Reset
                              </button>
                            ) : null}
                            <button
                              className="danger-action"
                              disabled={isBusy}
                              onClick={() => deleteNeighbor(neighbor.id)}
                              aria-label={`Eliminar ${neighbor.role === "admin" ? "admin" : "vecino"}`}
                            >
                              <Trash2 size={17} />
                            </button>
                          </div>
                        </div>
                      </article>
                    ))}
                  </div>
                  {resetCredentials ? (
                    <div className="credentials-box">
                      <span>Usuario</span>
                      <strong>{resetCredentials.login}</strong>
                      <span>Nueva contraseña</span>
                      <code>{resetCredentials.password}</code>
                      <button
                        className="secondary-action"
                        type="button"
                        onClick={() =>
                          copyWithFeedback(
                            `Usuario: ${resetCredentials.login}\nContraseña: ${resetCredentials.password}`,
                            "Credenciales copiadas."
                          )
                        }
                      >
                        <Copy size={17} />
                        Copiar credenciales
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </section>
          ) : null}

          <section className="control-grid">
            <div className="panel">
              <div className="section-heading">
                <Plus size={22} />
                <div>
                  <h2>Nueva reserva</h2>
                  <p>Slots fijos de 60 minutos, hasta 2 días de antelación.</p>
                </div>
              </div>

              <div className="segmented">
                {(["tennis", "football"] as Sport[]).map((sport) => (
                  <button key={sport} className={selectedSport === sport ? "selected" : ""} onClick={() => setSelectedSport(sport)}>
                    {SPORT_LABELS[sport]}
                  </button>
                ))}
              </div>

              <div className="mobile-slot-pickers">
                <div className="mobile-slot-picker">
                  <label htmlFor="mobile-day">Fecha</label>
                  <select id="mobile-day" value={selectedMobileDay} onChange={(event) => selectMobileDay(event.target.value)}>
                    {mobileDayOptions.map((option) => (
                      <option key={option.key} value={option.key}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="mobile-slot-picker">
                  <label htmlFor="mobile-hour">Hora</label>
                  <select id="mobile-hour" value={selectedSlot} onChange={(event) => setSelectedSlot(event.target.value)}>
                    {selectedMobileSlots.map((slot) => (
                      <option key={slot} value={slot}>
                        {formatSlotHour(slot)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="slot-picker">
                {availableSlotGroups.map((group) => (
                  <div key={group.dayOffset}>
                    <h3>{formatDayLabel(group.slots[0] ?? "")}</h3>
                    <div className="slot-buttons">
                      {group.slots.map((slot) => {
                        const hour = new Date(slot).toLocaleTimeString("es-ES", {
                          hour: "2-digit",
                          minute: "2-digit",
                          timeZone: "Europe/Madrid"
                        });
                        return (
                          <button
                            key={slot}
                            type="button"
                            className={selectedSlot === slot ? "selected" : ""}
                            aria-pressed={selectedSlot === slot}
                            onClick={() => setSelectedSlot(slot)}
                          >
                            <span>{hour}</span>
                            <small>{formatDayLabel(slot)}</small>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>

              <button
                className="primary-action"
                disabled={isBusy || !selectedSlot}
                onClick={() =>
                  runAction(
                    () => supabase.rpc("create_booking", { p_sport: selectedSport, p_slot_start: selectedSlot }),
                    "Reserva creada."
                  )
                }
              >
                {isBusy ? <Loader2 className="spin" size={18} /> : <CalendarDays size={18} />}
                Reservar {SPORT_LABELS[selectedSport]}
              </button>
            </div>

            {profile.role === "admin" ? (
              <div className="panel qr-panel">
                <div className="section-heading">
                  <QrCode size={22} />
                  <div>
                    <h2>QR fijo de puerta</h2>
                    <p>Imprime este QR y pégalo en la pista.</p>
                  </div>
                </div>
                <button
                  className="secondary-action"
                  type="button"
                  aria-expanded={isCheckInQrVisible}
                  onClick={() => setIsCheckInQrVisible((visible) => !visible)}
                >
                  <QrCode size={17} />
                  {isCheckInQrVisible ? "Ocultar QR" : "Ver QR"}
                </button>
                {isCheckInQrVisible ? (
                  <>
                    {checkInUrl ? <QRCodeSVG value={checkInUrl} size={168} includeMargin /> : null}
                    <button
                      className="secondary-action"
                      type="button"
                      onClick={() => copyWithFeedback(checkInUrl, "Enlace QR copiado.")}
                    >
                      <Copy size={17} />
                      Copiar enlace QR
                    </button>
                  </>
                ) : null}
              </div>
            ) : null}
          </section>

          <section className="panel reservations-panel">
            <div className="section-heading">
              <Users size={22} />
              <div>
                <h2>Reservas abiertas</h2>
                <p>Únete, comparte o cancela según las reglas de la comunidad.</p>
              </div>
            </div>

            {activeCooldownUntil ? (
              <p className="notice">
                Has salido de una reserva. No puedes apuntarte a otro deporte hasta que pasen 5 minutos.
              </p>
            ) : null}
            {message ? <p className="notice">{message}</p> : null}
            {isLoading ? (
              <div className="inline-status">
                <Loader2 className="spin" size={18} />
                Cargando reservas
              </div>
            ) : activeBookings.length ? (
              <div className="booking-list">
                {activeBookings.map((booking) => {
                  const capacity = SPORT_CAPACITY[booking.sport];
                  const bookingCounts = counts[booking.id] ?? { participants: 0, waitlist: 0 };
                  return (
                    <article className="booking-card" key={booking.id}>
                      <div className="booking-main">
                        <div className="sport-icon">{booking.sport === "tennis" ? "T" : "F"}</div>
                        <div>
                          <h3>
                            {SPORT_LABELS[booking.sport]} <span className="booking-number">#{booking.booking_number}</span>
                          </h3>
                          <p>
                            <Clock size={15} />
                            {formatDateTime(booking.slot_start)}
                          </p>
                          <p>
                            <Shield size={15} />
                            {booking.profiles?.full_name ?? "Vecino"} · {booking.profiles?.homes?.label ?? "Piso"}
                          </p>
                        </div>
                      </div>
                      <div className="booking-meta">
                        <span className={`status status-${booking.status}`}>
                          {STATUS_LABELS[booking.status] || booking.status}
                        </span>
                        <strong>
                          {bookingCounts.participants}/{capacity}
                        </strong>
                        <span>{bookingCounts.waitlist} en espera</span>
                      </div>
                      <div className="booking-participants" aria-label="Personas inscritas">
                        <span className="booking-participants-label">Inscritos</span>
                        {participantsByBooking[booking.id]?.length ? (
                          <span className="booking-participants-list">
                            {participantsByBooking[booking.id]
                              .map((participant) => `${participant.full_name} · ${participant.homes?.label ?? "Sin piso"}`)
                              .join(", ")}
                          </span>
                        ) : (
                          <span className="booking-participants-list">Todavía no hay jugadores inscritos.</span>
                        )}
                      </div>
                      <div className="booking-actions">
                        <button
                          className="secondary-action"
                          disabled={isBusy || isJoinBlocked}
                          onClick={() => runAction(() => supabase.rpc("join_booking", { p_booking_id: booking.id }), "Te has apuntado.")}
                        >
                          <CheckCircle2 size={17} />
                          Apuntarme
                        </button>
                        <button
                          className="secondary-action"
                          disabled={isBusy}
                          onClick={() => leaveBooking(booking.id)}
                        >
                          <XCircle size={17} />
                          Salir
                        </button>
                        {participantBookingSet.has(booking.id) ? (
                          <button
                            className="secondary-action"
                            disabled={isBusy || checkInBookingSet.has(booking.id) || !isWithinCheckInWindow(booking.slot_start)}
                            onClick={() => checkInBooking(booking.id)}
                          >
                            <CalendarCheck size={17} />
                            {checkInBookingSet.has(booking.id) ? "Check-in hecho" : "Check-in"}
                          </button>
                        ) : null}
                        <button className="secondary-action" onClick={() => shareBooking(booking)}>
                          <Copy size={17} />
                          Compartir
                        </button>
                        {booking.creator_user_id === profile.id || profile.role === "admin" ? (
                          <button
                            className="danger-action"
                            disabled={isBusy}
                            onClick={() => runAction(() => supabase.rpc("cancel_booking", { p_booking_id: booking.id }), "Reserva cancelada.")}
                          >
                            Cancelar
                          </button>
                        ) : null}
                      </div>
                    </article>
                  );
                })}
              </div>
            ) : (
              <p className="empty-state">No hay reservas activas en este momento.</p>
            )}
          </section>

          <section className="panel history-panel">
            <div className="section-heading">
              <CalendarCheck size={22} />
              <div>
                <h2>Historial de reservas</h2>
                <p>Tu registro histórico de reservas (creadas o como participante).</p>
              </div>
            </div>

            {historyBookings.length ? (
              <div className="history-list">
                {historyBookings.map((booking) => {
                  const isCreator = booking.creator_user_id === profile.id;
                  return (
                    <article className="history-card" key={booking.id}>
                      <div className="history-card-main">
                        <div className="sport-icon">{booking.sport === "tennis" ? "T" : "F"}</div>
                        <div>
                          <h3>
                            {SPORT_LABELS[booking.sport]} <span className="booking-number">#{booking.booking_number}</span>
                          </h3>
                          <p>
                            <Clock size={14} />
                            {formatDateTime(booking.slot_start)}
                          </p>
                          <p>
                            <Shield size={14} />
                            {isCreator ? "Creada por ti" : `Creada por: ${booking.profiles?.full_name ?? "Vecino"} (${booking.profiles?.homes?.label ?? "Piso"})`}
                          </p>
                        </div>
                      </div>
                      <div className="history-card-meta">
                        <span className={`status status-${booking.status}`}>
                          {STATUS_LABELS[booking.status] || booking.status}
                        </span>
                      </div>
                    </article>
                  );
                })}
              </div>
            ) : (
              <p className="empty-state">No tienes reservas en tu historial.</p>
            )}
          </section>
        </>
      )}
    </main>
  );
}

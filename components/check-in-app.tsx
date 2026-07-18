"use client";

import { createClient, hasSupabaseConfig } from "@/lib/supabase-browser";
import { CalendarCheck, Loader2, LogIn, QrCode } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

export function CheckInApp() {
  const [email, setEmail] = useState("");
  const [sessionReady, setSessionReady] = useState(false);
  const [isSignedIn, setIsSignedIn] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [message, setMessage] = useState("Escanea el QR desde la puerta y confirma tu asistencia.");
  const supabase = useMemo(() => createClient(), []);
  const hasConfig = hasSupabaseConfig();

  useEffect(() => {
    supabase.auth.getSession().then((result: any) => {
      const { data } = result;
      setIsSignedIn(Boolean(data.session));
      setSessionReady(true);
    });

    const { data } = supabase.auth.onAuthStateChange((_event: any, session: any) => {
      setIsSignedIn(Boolean(session));
      setSessionReady(true);
    });

    return () => data.subscription.unsubscribe();
  }, [supabase]);

  async function signIn() {
    setIsLoading(true);
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}/auth/callback?next=/check-in` }
    });
    setMessage(error ? error.message : "Te hemos enviado un enlace de acceso al email.");
    setIsLoading(false);
  }

  async function checkIn() {
    setIsLoading(true);
    const { error } = await supabase.rpc("check_in_booking");
    setMessage(error ? error.message : "Check-in registrado. La reserva queda validada.");
    setIsLoading(false);
  }

  return (
    <main className="checkin-shell">
      <section className="checkin-panel">
        <div className="brand-mark">
          <QrCode size={28} />
        </div>
        <h1>Check-in de pista</h1>
        <p>{message}</p>
        {!hasConfig ? <p className="notice">Falta configurar Supabase en `.env.local`.</p> : null}

        {!sessionReady ? (
          <div className="inline-status">
            <Loader2 className="spin" size={18} />
            Preparando acceso
          </div>
        ) : isSignedIn ? (
          <button className="primary-action" disabled={isLoading} onClick={checkIn}>
            {isLoading ? <Loader2 className="spin" size={18} /> : <CalendarCheck size={18} />}
            Confirmar asistencia
          </button>
        ) : (
          <div className="auth-card compact">
            <label htmlFor="checkin-email">Email de vecino</label>
            <input
              id="checkin-email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="tu@email.com"
            />
            <button className="primary-action" disabled={isLoading || !email} onClick={signIn}>
              {isLoading ? <Loader2 className="spin" size={18} /> : <LogIn size={18} />}
              Enviar enlace
            </button>
          </div>
        )}
      </section>
    </main>
  );
}

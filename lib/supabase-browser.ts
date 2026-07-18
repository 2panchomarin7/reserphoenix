"use client";

import { createBrowserClient } from "@supabase/ssr";

type SupabaseLike = {
  auth: {
    getSession: () => Promise<{ data: { session: null } }>;
    onAuthStateChange: (callback: (event: string, session: null) => void) => {
      data: { subscription: { unsubscribe: () => void } };
    };
    signInWithOtp: (_options: unknown) => Promise<{ error: { message: string } | null }>;
    signInWithPassword: (_options: unknown) => Promise<{ error: { message: string } | null }>;
    signOut: () => Promise<void>;
  };
  from: () => {
    select: () => SupabaseQueryLike;
  };
  rpc: () => Promise<{ error: { message: string } | null }>;
};

type SupabaseQueryLike = {
  select: () => SupabaseQueryLike;
  eq: () => SupabaseQueryLike;
  gte: () => SupabaseQueryLike;
  in: () => SupabaseQueryLike;
  order: () => SupabaseQueryLike;
  single: () => Promise<{ data: null; error: { message: string } | null }>;
};

function createNoopClient(): SupabaseLike {
  const query: SupabaseQueryLike = {
    select: () => query,
    eq: () => query,
    gte: () => query,
    in: () => query,
    order: () => query,
    single: async () => ({ data: null, error: null })
  };

  return {
    auth: {
      getSession: async () => ({ data: { session: null } }),
      onAuthStateChange: () => ({
        data: { subscription: { unsubscribe: () => undefined } }
      }),
      signInWithOtp: async () => ({
        error: { message: "Configura NEXT_PUBLIC_SUPABASE_URL y NEXT_PUBLIC_SUPABASE_ANON_KEY en .env.local." }
      }),
      signInWithPassword: async () => ({
        error: { message: "Configura NEXT_PUBLIC_SUPABASE_URL y NEXT_PUBLIC_SUPABASE_ANON_KEY en .env.local." }
      }),
      signOut: async () => undefined
    },
    from: () => query,
    rpc: async () => ({
      error: { message: "Configura Supabase antes de usar acciones reales." }
    })
  };
}

export function hasSupabaseConfig() {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}

export function createClient(): any {
  if (!hasSupabaseConfig()) {
    return createNoopClient();
  }

  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL as string,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string
  );
}

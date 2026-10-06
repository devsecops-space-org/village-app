import { createClient } from "@supabase/supabase-js";

// Only the project URL and the public anon key belong here. The anon key grants
// nothing by itself: every table is closed and each RPC checks the session.
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
export const configured = !!url && !!anonKey;
export const supabase = createClient(
  url || "http://localhost",
  anonKey || "missing",
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
  },
);
const loginDomain =
  (import.meta.env.VITE_LOGIN_DOMAIN as string | undefined) ||
  "pit-control.local";
export const loginEmail = (username: string) =>
  username.includes("@") ? username : `${username}@${loginDomain}`;

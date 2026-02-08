/**
 * Auth Service — Supabase email/password auth with token management
 *
 * Same Supabase project as the macOS app. Users login with their
 * SwagManager credentials; the CLI stores JWT tokens locally.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { loadConfig, saveConfig, clearConfig, updateConfig, type SwagManagerConfig } from "./config-store.js";

// Public credentials (same as SupabaseConfig.swift)
const SUPABASE_URL = "https://uaednwpxursknmwdeejn.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVhZWRud3B4dXJza25td2RlZWpuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjA5OTcyMzMsImV4cCI6MjA3NjU3MzIzM30.N8jPwlyCBB5KJB5I-XaK6m-mq88rSR445AWFJJmwRCg";

export { SUPABASE_URL, SUPABASE_ANON_KEY };

// Create a bare Supabase client (no stored session)
function createAnonClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// Create a Supabase client authenticated with a user's JWT
export function createAuthenticatedClient(accessToken: string): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

export interface AuthResult {
  success: boolean;
  error?: string;
  config?: SwagManagerConfig;
}

export interface StoreInfo {
  id: string;
  name: string;
  slug?: string;
}

// Sign in with email/password
export async function signIn(email: string, password: string): Promise<AuthResult> {
  const client = createAnonClient();
  const { data, error } = await client.auth.signInWithPassword({ email, password });

  if (error) return { success: false, error: error.message };
  if (!data.session) return { success: false, error: "No session returned" };

  const config: SwagManagerConfig = {
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
    user_id: data.user.id,
    email: data.user.email || email,
    expires_at: data.session.expires_at,
  };

  // Try to extract store from JWT user_metadata first (most reliable)
  const meta = data.user.user_metadata;
  if (meta?.vendor_id) {
    config.store_id = meta.vendor_id;
    config.store_name = meta.store_name || undefined;
  }

  // If no store from metadata, try querying
  if (!config.store_id) {
    const stores = await getStoresForUser(config.access_token!, data.user.id);
    if (stores.length === 1) {
      config.store_id = stores[0].id;
      config.store_name = stores[0].name;
    }
  }

  saveConfig(config);
  return { success: true, config };
}

// Sign up with email/password
export async function signUp(email: string, password: string): Promise<AuthResult> {
  const client = createAnonClient();
  const { data, error } = await client.auth.signUp({ email, password });

  if (error) return { success: false, error: error.message };
  if (!data.session) {
    return { success: true, error: "Check your email to confirm your account" };
  }

  const config: SwagManagerConfig = {
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
    user_id: data.user!.id,
    email: data.user!.email || email,
    expires_at: data.session.expires_at,
  };

  saveConfig(config);
  return { success: true, config };
}

// Refresh an expired session
export async function refreshSession(): Promise<AuthResult> {
  const config = loadConfig();
  if (!config.refresh_token) return { success: false, error: "Not logged in" };

  const client = createAnonClient();
  const { data, error } = await client.auth.refreshSession({
    refresh_token: config.refresh_token,
  });

  if (error) {
    clearConfig();
    return { success: false, error: `Session expired: ${error.message}` };
  }
  if (!data.session) {
    clearConfig();
    return { success: false, error: "Could not refresh session" };
  }

  const updated: SwagManagerConfig = {
    ...config,
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
    expires_at: data.session.expires_at,
  };
  saveConfig(updated);
  return { success: true, config: updated };
}

// Get a valid access token, auto-refreshing if needed
export async function getValidToken(): Promise<string | null> {
  const config = loadConfig();
  if (!config.access_token) return null;

  // Check if token is expired (with 60s buffer)
  const now = Math.floor(Date.now() / 1000);
  if (config.expires_at && config.expires_at - 60 < now) {
    const result = await refreshSession();
    if (!result.success) return null;
    return result.config!.access_token!;
  }

  return config.access_token;
}

// Sign out — clear stored tokens
export function signOut(): void {
  clearConfig();
}

// Get stores for the authenticated user
// RLS on the stores table filters to only stores the user has access to,
// same as the Swift app does: client.from("stores").select()
export async function getStoresForUser(
  accessToken: string,
  _userId: string
): Promise<StoreInfo[]> {
  const client = createAuthenticatedClient(accessToken);

  // Let RLS filter — same pattern as the macOS app (SupabaseService.fetchStores)
  const { data: stores, error } = await client
    .from("stores")
    .select("id, store_name, slug")
    .limit(20);

  if (error) {
    // Fallback: try via the users table (auth_user_id column, not id)
    const { data: userData } = await client
      .from("users")
      .select("store_id")
      .eq("auth_user_id", _userId)
      .single();

    if (userData?.store_id) {
      const { data: store } = await client
        .from("stores")
        .select("id, store_name, slug")
        .eq("id", userData.store_id)
        .single();
      return store ? [{ id: store.id, name: store.store_name, slug: store.slug }] : [];
    }

    return [];
  }

  return (stores || []).map((s: any) => ({ id: s.id, name: s.store_name, slug: s.slug }));
}

// Select a store and save to config
export function selectStore(storeId: string, storeName: string): void {
  updateConfig({ store_id: storeId, store_name: storeName });
}

// Check if logged in (has auth tokens)
export function isLoggedIn(): boolean {
  const config = loadConfig();
  return !!(config.access_token && config.refresh_token);
}

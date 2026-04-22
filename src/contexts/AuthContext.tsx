/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import { backend, type User, type Session } from "@/integrations/backend/client";
import { initializeLocalCoreCache, subscribeLocalDbChanges } from "@/integrations/backend/local-core";

interface AuthState {
  user: User | null;
  session: Session | null;
  isLoading: boolean;
  isLocalCoreReady: boolean;
  isAdmin: boolean;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | undefined>(undefined);
const ADMIN_RECHECK_INTERVAL_MS = 30_000;
const LOCAL_DB_SYNC_DEBOUNCE_MS = 120;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isLocalCoreReady, setIsLocalCoreReady] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const initializedRef = useRef(false);
  const hydratedUserIdRef = useRef<string | null>(null);
  const lastAdminCheckRef = useRef<{ userId: string | null; at: number }>({ userId: null, at: 0 });
  const localCoreHydrationTokenRef = useRef(0);

  const checkAdmin = useCallback(async (userId: string) => {
    try {
      const { data } = await backend
        .from("user_roles")
        .select("role")
        .eq("user_id", userId)
        .eq("role", "admin")
        .maybeSingle();
      return !!data;
    } catch {
      return false;
    }
  }, []);

  const refreshAdmin = useCallback((userId: string) => {
    const now = Date.now();
    const last = lastAdminCheckRef.current;
    if (last.userId === userId && now - last.at < ADMIN_RECHECK_INTERVAL_MS) return;
    lastAdminCheckRef.current = { userId, at: now };
    checkAdmin(userId).then(setIsAdmin);
  }, [checkAdmin]);

  useEffect(() => {
    const loadingFallback = setTimeout(() => {
      if (!initializedRef.current) {
        console.warn("[Auth] timeout fallback: forcing loading=false");
        setIsLoading(false);
      }
    }, 4000);

    // 1. Set up the auth state listener FIRST
    const { data: { subscription } } = backend.auth.onAuthStateChange(
      (_event, newSession) => {
        const newUser = newSession?.user ?? null;
        setUser(newUser);
        setSession(newSession);
        setIsLoading(false);
        initializedRef.current = true;

        if (newUser) {
          setIsLocalCoreReady(false);
          // Use setTimeout to avoid potential backend client deadlock.
          setTimeout(() => {
            refreshAdmin(newUser.id);
            // Cache hydration should run once per authenticated user, not on every auth callback.
            if (hydratedUserIdRef.current !== newUser.id) {
              hydratedUserIdRef.current = newUser.id;
              const hydrationToken = ++localCoreHydrationTokenRef.current;
              initializeLocalCoreCache()
                .catch(console.error)
                .finally(() => {
                  if (localCoreHydrationTokenRef.current === hydrationToken) {
                    setIsLocalCoreReady(true);
                  }
                });
              return;
            }
            setIsLocalCoreReady(true);
          }, 0);
          return;
        }

        hydratedUserIdRef.current = null;
        localCoreHydrationTokenRef.current += 1;
        setIsLocalCoreReady(false);
        lastAdminCheckRef.current = { userId: null, at: 0 };
        setIsAdmin(false);
      }
    );

    // 2. Then get the initial session as a fallback
    backend.auth.getSession().then(({ data: { session: initialSession } }) => {
      // Only use this if onAuthStateChange hasn't fired yet
      if (!initializedRef.current) {
        const initialUser = initialSession?.user ?? null;
        setUser(initialUser);
        setSession(initialSession);
        setIsLoading(false);

        if (initialUser) {
          setIsLocalCoreReady(false);
          refreshAdmin(initialUser.id);
          if (hydratedUserIdRef.current !== initialUser.id) {
            hydratedUserIdRef.current = initialUser.id;
            const hydrationToken = ++localCoreHydrationTokenRef.current;
            initializeLocalCoreCache()
              .catch(console.error)
              .finally(() => {
                if (localCoreHydrationTokenRef.current === hydrationToken) {
                  setIsLocalCoreReady(true);
                }
              });
            return;
          }
          setIsLocalCoreReady(true);
          return;
        }

        hydratedUserIdRef.current = null;
        localCoreHydrationTokenRef.current += 1;
        setIsLocalCoreReady(false);
        lastAdminCheckRef.current = { userId: null, at: 0 };
      }
    }).catch((error) => {
      console.error("[Auth] getSession failed:", error);
      if (!initializedRef.current) {
        setUser(null);
        setSession(null);
        setIsAdmin(false);
        setIsLoading(false);
        initializedRef.current = true;
        hydratedUserIdRef.current = null;
        localCoreHydrationTokenRef.current += 1;
        setIsLocalCoreReady(false);
        lastAdminCheckRef.current = { userId: null, at: 0 };
      }
    });

    return () => {
      clearTimeout(loadingFallback);
      subscription.unsubscribe();
    };
  }, [refreshAdmin]);

  useEffect(() => {
    let syncTimer: number | null = null;
    const syncSession = () => {
      backend.auth.getSession().then(({ data: { session: latestSession } }) => {
        const latestUser = latestSession?.user ?? null;
        setSession(latestSession);
        setUser(latestUser);
        setIsLoading(false);

        if (!latestUser) {
          hydratedUserIdRef.current = null;
          localCoreHydrationTokenRef.current += 1;
          setIsLocalCoreReady(false);
          lastAdminCheckRef.current = { userId: null, at: 0 };
          setIsAdmin(false);
          return;
        }

        setIsLocalCoreReady(true);
        refreshAdmin(latestUser.id);
      }).catch((error) => {
        console.error("[Auth] local db sync getSession failed:", error);
        hydratedUserIdRef.current = null;
        localCoreHydrationTokenRef.current += 1;
        setIsLocalCoreReady(false);
        lastAdminCheckRef.current = { userId: null, at: 0 };
        setSession(null);
        setUser(null);
        setIsAdmin(false);
        setIsLoading(false);
      });
    };

    const unsubscribe = subscribeLocalDbChanges(() => {
      if (syncTimer !== null) {
        window.clearTimeout(syncTimer);
      }
      syncTimer = window.setTimeout(syncSession, LOCAL_DB_SYNC_DEBOUNCE_MS);
    });

    return () => {
      if (syncTimer !== null) {
        window.clearTimeout(syncTimer);
      }
      unsubscribe();
    };
  }, [refreshAdmin]);

  const signOut = useCallback(async () => {
    await backend.auth.signOut();
  }, []);

  return (
    <AuthContext.Provider value={{ user, session, isLoading, isLocalCoreReady, isAdmin, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (ctx === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return ctx;
}

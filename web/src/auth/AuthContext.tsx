import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { api, configureApiAuth } from '../api/client';
import type { AuthResponse, SecurityAnswerInput } from '../api/types';

interface Session {
  readonly userId: string;
  readonly phone: string;
  readonly displayName: string;
  readonly accessToken: string;
  /** Epoch ms. Used only to drop an expired token locally — never to authorise. */
  readonly expiresAt: number;
}

interface AuthContextValue {
  session: Session | null;
  isAuthenticated: boolean;
  login: (phone: string, password: string) => Promise<void>;
  register: (input: {
    phone: string;
    displayName: string;
    password: string;
    email?: string;
    securityAnswers: SecurityAnswerInput[];
  }) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const STORAGE_KEY = 'goti.session';

/**
 * ============================================================================
 *  SESSION STATE
 * ============================================================================
 *
 * WHAT THIS DOES NOT DO — and the distinction matters
 *
 * It performs NO security logic. It does not verify the token, does not decode
 * its claims to decide what the user may do, and does not check ownership of
 * anything. The backend's `JwtAuthGuard` verifies every request, and every
 * use case re-checks authorisation against the database at the moment of use.
 *
 * What lives here is UI ROUTING STATE: "do we have a token to send, and should
 * the app show the signed-in shell or the login screen?" Hiding a button is a
 * convenience, never a control — the backend rejects the call regardless.
 *
 * The expiry timestamp is used only to drop a token we already know is stale,
 * sparing a pointless round trip. It is never treated as proof of anything: a
 * tampered `expiresAt` in localStorage buys an attacker exactly one 401.
 *
 * STORAGE: sessionStorage, not localStorage. The token dies with the tab, which
 * bounds the window in which a token left on a shared machine is usable. It is
 * a demo-appropriate trade; production would use a short-lived access token
 * held in memory plus an httpOnly refresh cookie, which survives neither XSS
 * exfiltration nor a closed tab.
 */
export function AuthProvider({ children }: { children: ReactNode }): JSX.Element {
  const [session, setSession] = useState<Session | null>(() => restoreSession());

  // A ref keeps the API client reading the CURRENT token without re-registering
  // the callback on every render.
  const sessionRef = useRef<Session | null>(session);
  sessionRef.current = session;

  const logout = useCallback(() => {
    setSession(null);
    sessionStorage.removeItem(STORAGE_KEY);
  }, []);

  useEffect(() => {
    configureApiAuth(
      () => sessionRef.current?.accessToken ?? null,
      // Any 401 clears the session once, centrally, rather than every screen
      // handling expiry itself.
      () => {
        setSession(null);
        sessionStorage.removeItem(STORAGE_KEY);
      },
    );
  }, []);

  const persist = useCallback((response: AuthResponse) => {
    const next: Session = {
      userId: response.userId,
      phone: response.phone,
      displayName: response.displayName,
      accessToken: response.accessToken,
      expiresAt: Date.now() + response.expiresInSeconds * 1000,
    };
    setSession(next);
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  }, []);

  const login = useCallback(
    async (phone: string, password: string) => {
      persist(await api.auth.login({ phone, password }));
    },
    [persist],
  );

  const register = useCallback(
    async (input: {
      phone: string;
      displayName: string;
      password: string;
      email?: string;
      securityAnswers: SecurityAnswerInput[];
    }) => {
      persist(await api.auth.register(input));
    },
    [persist],
  );

  const value = useMemo<AuthContextValue>(
    () => ({ session, isAuthenticated: session !== null, login, register, logout }),
    [session, login, register, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

function restoreSession(): Session | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as Session;
    // Drop a token we already know is expired. Saves a round trip; proves nothing.
    if (!parsed.accessToken || parsed.expiresAt <= Date.now()) {
      sessionStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return parsed;
  } catch {
    // Corrupt or unreadable storage is treated as signed out.
    return null;
  }
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside <AuthProvider>.');
  return context;
}

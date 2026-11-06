import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { api, clearToken, getToken, setToken } from './api/client';
import type { Business, MeResponse, User } from './api/types';

type AuthState = {
  ready: boolean;
  user: User | null;
  business: Business | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [business, setBusiness] = useState<Business | null>(null);

  const logout = useCallback(() => {
    clearToken();
    setUser(null);
    setBusiness(null);
  }, []);

  useEffect(() => {
    let alive = true;

    if (!getToken()) {
      setReady(true);
      return;
    }

    api
      .me()
      .then((me: MeResponse) => {
        if (!alive) return;
        setUser(me.user);
        setBusiness(me.business);
      })
      .catch(() => {
        if (!alive) return;
        clearToken();
      })
      .finally(() => {
        if (alive) setReady(true);
      });

    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const onUnauthorized = () => logout();
    window.addEventListener('keyko:unauthorized', onUnauthorized);
    return () => window.removeEventListener('keyko:unauthorized', onUnauthorized);
  }, [logout]);

  const login = useCallback(async (email: string, password: string) => {
    const result = await api.login(email, password);
    setToken(result.token);
    setUser(result.user);
    setBusiness(result.business);
  }, []);

  const value = useMemo(
    () => ({ ready, user, business, login, logout }),
    [ready, user, business, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth fuera de AuthProvider');
  return context;
}

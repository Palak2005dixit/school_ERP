import { useQueryClient } from '@tanstack/react-query';
import type { MeResponse, MembershipSummary, Permission } from '@erp/shared';
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
import { api, onUnauthorized } from '../lib/api';

type AuthStatus = 'loading' | 'authenticated' | 'anonymous';

interface AuthContextValue {
  status: AuthStatus;
  user: MeResponse['user'] | null;
  memberships: MembershipSummary[];
  membership: MembershipSummary | null;
  can: (permission: Permission) => boolean;
  login: (email: string, password: string, totpCode?: string) => Promise<void>;
  logout: () => Promise<void>;
  setActiveSchool: (schoolId: string) => void;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const ACTIVE_SCHOOL_KEY = 'erp.activeSchoolId';

export function AuthProvider({ children }: { children: ReactNode }): ReactNode {
  const queryClient = useQueryClient();
  const signedInUserId = useRef<string | null>(null);
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<MeResponse['user'] | null>(null);
  const [memberships, setMemberships] = useState<MembershipSummary[]>([]);
  const [activeSchoolId, setActiveSchoolId] = useState<string | null>(() =>
    window.localStorage.getItem(ACTIVE_SCHOOL_KEY),
  );

  const applySession = useCallback(
    (session: MeResponse) => {
      // A different person is signing in on this tab. Drop every cached query
      // so the previous user's records can never flash in the new session.
      if (signedInUserId.current && signedInUserId.current !== session.user.id) {
        queryClient.clear();
      }
      signedInUserId.current = session.user.id;
      setUser(session.user);
      setMemberships(session.memberships);
      setStatus('authenticated');
      setActiveSchoolId((current) => {
        if (current && session.memberships.some((entry) => entry.schoolId === current)) {
          return current;
        }
        return session.memberships[0]?.schoolId ?? null;
      });
    },
    [queryClient],
  );

  const clearSession = useCallback(() => {
    signedInUserId.current = null;
    queryClient.clear();
    setUser(null);
    setMemberships([]);
    setStatus('anonymous');
  }, [queryClient]);

  const refresh = useCallback(async () => {
    try {
      const session = await api<MeResponse>('/api/auth/me');
      applySession(session);
    } catch {
      clearSession();
    }
  }, [applySession, clearSession]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => onUnauthorized(clearSession), [clearSession]);

  useEffect(() => {
    if (activeSchoolId) window.localStorage.setItem(ACTIVE_SCHOOL_KEY, activeSchoolId);
    else window.localStorage.removeItem(ACTIVE_SCHOOL_KEY);
  }, [activeSchoolId]);

  const login = useCallback(
    async (email: string, password: string, totpCode?: string) => {
      const session = await api<MeResponse>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password, ...(totpCode ? { totpCode } : {}) }),
      });
      applySession(session);
    },
    [applySession],
  );

  const logout = useCallback(async () => {
    try {
      await api<void>('/api/auth/logout', { method: 'POST' });
    } finally {
      clearSession();
    }
  }, [clearSession]);

  const membership = useMemo(
    () => memberships.find((entry) => entry.schoolId === activeSchoolId) ?? memberships[0] ?? null,
    [memberships, activeSchoolId],
  );

  const permissionSet = useMemo(() => new Set(membership?.permissions ?? []), [membership]);

  const can = useCallback(
    (permission: Permission) => permissionSet.has(permission),
    [permissionSet],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      memberships,
      membership,
      can,
      login,
      logout,
      setActiveSchool: setActiveSchoolId,
      refresh,
    }),
    [status, user, memberships, membership, can, login, logout, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}

/**
 * Returns the active school id for routes that need one. Renders nothing while
 * the session is still loading; callers live inside the authenticated shell.
 */
export function useSchoolId(): string {
  const { membership } = useAuth();
  if (!membership) throw new Error('No active school membership');
  return membership.schoolId;
}

/** School timezone for rendering instants (undefined until the session loads). */
export function useSchoolTimezone(): string | undefined {
  return useAuth().membership?.timezone;
}

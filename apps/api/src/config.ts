import 'dotenv/config';

function int(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value === 'true' || value === '1';
}

export const config = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: int(process.env.PORT, 4000),
  appOrigin: process.env.APP_ORIGIN ?? 'http://localhost:5173',
  sessionTtlDays: int(process.env.SESSION_TTL_DAYS, 7),
  cookieSecure: bool(process.env.COOKIE_SECURE, false),
  isProduction: (process.env.NODE_ENV ?? 'development') === 'production',
  isTest: (process.env.NODE_ENV ?? 'development') === 'test',
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:5433/school_erp',
  /**
   * Optional external notification delivery. There is no built-in provider and
   * no credential is shipped; when these are unset the outbox marks messages
   * blocked instead of pretending they were delivered.
   */
  notificationProviderUrl: process.env.NOTIFICATION_PROVIDER_URL ?? '',
  notificationProviderToken: process.env.NOTIFICATION_PROVIDER_TOKEN ?? '',
  notificationProviderName: process.env.NOTIFICATION_PROVIDER_NAME ?? 'webhook',
} as const;

export const SESSION_COOKIE = 'erp_session';

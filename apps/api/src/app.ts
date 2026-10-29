import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { SESSION_COOKIE, config } from './config';
import { getPool } from './db';
import { loadSessionUser } from './auth/session';
import { AppError, forbidden, mapDatabaseError } from './lib/errors';
import { registerAuthRoutes } from './routes/auth';
import { registerAcademicRoutes } from './routes/academic';
import { registerStudentRoutes } from './routes/students';
import { registerAttendanceRoutes } from './routes/attendance';
import { registerTimetableRoutes } from './routes/timetable';
import { registerFeeRoutes } from './routes/fees';
import { registerFeeExtrasRoutes } from './routes/feeExtras';
import { registerExamRoutes } from './routes/exams';
import { registerStaffRoutes } from './routes/staff';
import { registerNoticeRoutes } from './routes/notices';
import { registerReportRoutes } from './routes/reports';
import { registerAccessRoutes } from './routes/access';
import { registerSafeguardingRoutes } from './routes/safeguarding';
import { registerLeaveConfigRoutes } from './routes/leaveConfig';
import { registerPayrollRoutes } from './routes/payroll';
import { registerSchoolRoutes } from './routes/school';
import { registerStaffAttendanceRoutes } from './routes/staffAttendance';
import { registerRecruitmentRoutes } from './routes/recruitment';
import { registerProcurementRoutes } from './routes/procurement';
import { registerTransportRoutes } from './routes/transport';
import { registerLibraryRoutes } from './routes/library';
import { registerLearningRoutes } from './routes/learning';
import { registerConcernRoutes } from './routes/concerns';
import { registerNotificationRoutes } from './routes/notifications';
import { registerReconciliationRoutes } from './routes/reconciliation';
import { registerSavedReportRoutes } from './routes/savedReports';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface BuildAppOptions {
  logger?: boolean;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
    trustProxy: true,
    bodyLimit: 1024 * 1024,
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cookie);
  await app.register(rateLimit, {
    max: 300,
    timeWindow: '1 minute',
    allowList: [],
  });

  app.decorateRequest('user', null);
  app.decorateRequest('actor', null);
  app.decorateRequest('sessionToken', null);

  /**
   * CSRF defence for cookie-authenticated mutations: browsers always send
   * Origin for cross-site writes, so a mismatched origin is rejected. Requests
   * without an Origin header (server-to-server, tests) are still authenticated
   * by the session cookie and SameSite=Lax.
   */
  app.addHook('onRequest', async (request) => {
    if (!MUTATING_METHODS.has(request.method)) return;
    const origin = request.headers.origin;
    if (!origin) return;
    if (!isAllowedOrigin(origin)) {
      throw forbidden('Cross-origin request blocked');
    }
  });

  app.addHook('onRequest', async (request) => {
    const token = request.cookies[SESSION_COOKIE];
    if (!token) return;
    const user = await loadSessionUser(token);
    if (user) {
      request.user = user;
      request.sessionToken = token;
    }
  });

  app.get('/api/health', async (_request, reply) => {
    try {
      await getPool().query('SELECT 1');
      return { status: 'ok', database: 'ok', version: '0.1.0' };
    } catch {
      return reply.status(503).send({ status: 'degraded', database: 'unavailable' });
    }
  });

  await registerAuthRoutes(app);
  await registerAcademicRoutes(app);
  await registerStudentRoutes(app);
  await registerAttendanceRoutes(app);
  await registerTimetableRoutes(app);
  await registerFeeRoutes(app);
  await registerFeeExtrasRoutes(app);
  await registerExamRoutes(app);
  await registerStaffRoutes(app);
  await registerLeaveConfigRoutes(app);
  await registerPayrollRoutes(app);
  await registerSafeguardingRoutes(app);
  await registerNoticeRoutes(app);
  await registerReportRoutes(app);
  await registerAccessRoutes(app);
  await registerSchoolRoutes(app);
  await registerStaffAttendanceRoutes(app);
  await registerRecruitmentRoutes(app);
  await registerProcurementRoutes(app);
  await registerTransportRoutes(app);
  await registerLibraryRoutes(app);
  await registerLearningRoutes(app);
  await registerConcernRoutes(app);
  await registerNotificationRoutes(app);
  await registerReconciliationRoutes(app);
  await registerSavedReportRoutes(app);

  app.setNotFoundHandler((request, reply) => {
    return reply.status(404).send({
      error: {
        code: 'not_found',
        message: `No route for ${request.method} ${request.url}`,
        requestId: request.id,
      },
    });
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.status).send({
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
          requestId: request.id,
        },
      });
    }

    const dbError = mapDatabaseError(error);
    if (dbError) {
      return reply.status(dbError.status).send({
        error: {
          code: dbError.code,
          message: dbError.message,
          details: dbError.details,
          requestId: request.id,
        },
      });
    }

    const status = (error as { statusCode?: number }).statusCode ?? 500;

    if (status >= 500) {
      request.log.error({ err: error }, 'Unhandled request error');
      return reply.status(500).send({
        error: {
          code: 'internal_error',
          message: 'Something went wrong on our side. Please try again.',
          requestId: request.id,
        },
      });
    }

    return reply.status(status).send({
      error: {
        code: (error as { code?: string }).code ?? 'request_failed',
        message:
          (error as { message?: string }).message === 'Invalid JSON'
            ? 'The request body is not valid JSON'
            : 'The request could not be processed',
        requestId: request.id,
      },
    });
  });

  return app;
}

function isAllowedOrigin(origin: string): boolean {
  try {
    const candidate = new URL(origin);
    const configured = new URL(config.appOrigin);
    if (candidate.origin === configured.origin) return true;
    // Treat loopback aliases as equivalent during local development.
    const loopback = new Set(['localhost', '127.0.0.1', '::1']);
    return (
      !config.isProduction &&
      loopback.has(candidate.hostname) &&
      loopback.has(configured.hostname) &&
      candidate.port === configured.port
    );
  } catch {
    return false;
  }
}

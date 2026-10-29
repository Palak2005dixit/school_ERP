import type { SessionUser } from '@erp/shared';
import type { ActorContext } from '../auth/session';

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null;
    actor: ActorContext | null;
    sessionToken: string | null;
  }
}

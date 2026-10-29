import { config } from '../../config';

export interface NotificationMessage {
  channel: 'email' | 'sms' | 'whatsapp';
  to: string;
  subject: string | null;
  body: string;
}

export interface NotificationDelivery {
  messageId: string;
  provider: string;
}

/**
 * Typed boundary for an external messaging gateway.
 *
 * The ERP ships without provider credentials. When `NOTIFICATION_PROVIDER_URL`
 * is unset `getNotificationProvider()` returns null, so the outbox can record a
 * `blocked` attempt instead of claiming delivery. Tests inject a fake through
 * `setNotificationProviderForTests`.
 */
export interface NotificationProvider {
  readonly name: string;
  send(message: NotificationMessage): Promise<NotificationDelivery>;
}

let override: NotificationProvider | null | undefined;

export function setNotificationProviderForTests(
  provider: NotificationProvider | null | undefined,
): void {
  override = provider;
}

export function getNotificationProvider(): NotificationProvider | null {
  if (override !== undefined) return override;
  if (!config.notificationProviderUrl) return null;
  return new WebhookNotificationProvider(
    config.notificationProviderUrl,
    config.notificationProviderToken,
    config.notificationProviderName,
  );
}

export class WebhookNotificationProvider implements NotificationProvider {
  readonly name: string;

  constructor(
    private readonly url: string,
    private readonly token: string,
    name: string,
  ) {
    this.name = name || 'webhook';
  }

  async send(message: NotificationMessage): Promise<NotificationDelivery> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(this.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        body: JSON.stringify(message),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Provider responded with HTTP ${response.status}`);
      }
      const payload = (await response.json().catch(() => ({}))) as { id?: unknown };
      return {
        provider: this.name,
        messageId: typeof payload.id === 'string' && payload.id ? payload.id : '',
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

export interface PopupMessageRouterOptions {
  notificationTypes?: Iterable<string>;
  ignoredRequestTypes?: Iterable<string>;
  silentTypes?: Iterable<string>;
  sampleWindowMs?: number;
  now?: () => number;
}

export type PopupMessageDecisionKind =
  | 'notification'
  | 'ignored-request'
  | 'ignored-silent'
  | 'handled'
  | 'unknown';

export interface PopupMessageDecision {
  kind: PopupMessageDecisionKind;
  shouldLogUnknown: boolean;
}

export const DEFAULT_NOTIFICATION_TYPES = new Set<string>([
  'settingsUpdated',
  'simulcast:update',
  'simulcast:popupUpdate',
]);

export const DEFAULT_IGNORED_REQUEST_TYPES = new Set<string>([
  'connectDB',
  'getStorageUsage',
  'getAllConversations',
  'getSettings',
  'getLocalStoreStatus',
  'getLocalStoreMigrationState',
  'findConversationByUrl',
  'getTabRuntimeStatus',
  'content:healthPing',
  'content:healthPong',
]);

const DEFAULT_SAMPLE_WINDOW_MS = 60_000;

function normalizeType(type: unknown): string {
  if (typeof type !== 'string' || type.trim().length === 0) {
    return '__unknown__';
  }
  return type;
}

export class PopupMessageRouter {
  private readonly notificationTypes: Set<string>;

  private readonly ignoredRequestTypes: Set<string>;

  private readonly silentTypes: Set<string>;

  private readonly sampleWindowMs: number;

  private readonly now: () => number;

  private readonly unknownLastLoggedAt = new Map<string, number>();

  constructor(options: PopupMessageRouterOptions = {}) {
    this.notificationTypes = new Set(options.notificationTypes || DEFAULT_NOTIFICATION_TYPES);
    this.ignoredRequestTypes = new Set(options.ignoredRequestTypes || DEFAULT_IGNORED_REQUEST_TYPES);
    this.silentTypes = new Set(options.silentTypes || []);
    this.sampleWindowMs = options.sampleWindowMs ?? DEFAULT_SAMPLE_WINDOW_MS;
    this.now = options.now ?? (() => Date.now());
  }

  classify(messageType: unknown, hasHandler: boolean): PopupMessageDecision {
    const normalizedType = normalizeType(messageType);

    if (this.notificationTypes.has(normalizedType)) {
      return { kind: 'notification', shouldLogUnknown: false };
    }

    if (this.ignoredRequestTypes.has(normalizedType)) {
      return { kind: 'ignored-request', shouldLogUnknown: false };
    }

    if (this.silentTypes.has(normalizedType)) {
      return { kind: 'ignored-silent', shouldLogUnknown: false };
    }

    if (hasHandler) {
      return { kind: 'handled', shouldLogUnknown: false };
    }

    return {
      kind: 'unknown',
      shouldLogUnknown: this.shouldLogUnknown(normalizedType),
    };
  }

  private shouldLogUnknown(type: string): boolean {
    const currentTime = this.now();
    const lastLoggedAt = this.unknownLastLoggedAt.get(type);

    if (lastLoggedAt === undefined || currentTime - lastLoggedAt >= this.sampleWindowMs) {
      this.unknownLastLoggedAt.set(type, currentTime);
      return true;
    }

    return false;
  }
}

export function createPopupMessageRouter(options: PopupMessageRouterOptions = {}): PopupMessageRouter {
  return new PopupMessageRouter(options);
}

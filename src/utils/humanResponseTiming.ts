import { configService, type HumanResponseTiming } from '@config/env.config';

export function getHumanResponseTimingConfig(): HumanResponseTiming {
  return configService.get<HumanResponseTiming>('HUMAN_RESPONSE_TIMING');
}

export function isHumanResponseTimingEnabled(): boolean {
  return getHumanResponseTimingConfig().ENABLED;
}

export function shouldApplyHumanTiming(options?: { delay?: number; skipHumanTiming?: boolean }): boolean {
  if (!isHumanResponseTimingEnabled()) return false;
  if (options?.skipHumanTiming) return false;
  if (options?.delay != null && options.delay > 0) return false;
  return true;
}

export function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function randomMs(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min + 1));
}

/** Texto aproximado del mensaje saliente para calcular tiempo de escritura. */
export function extractTextForTiming(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const m = message as Record<string, unknown>;
  if (typeof m.conversation === 'string') return m.conversation;
  const ext = m.extendedTextMessage as { text?: string } | undefined;
  if (ext?.text) return ext.text;
  const caption =
    (m.imageMessage as { caption?: string } | undefined)?.caption ??
    (m.videoMessage as { caption?: string } | undefined)?.caption ??
    (m.documentMessage as { caption?: string } | undefined)?.caption ??
    (m.documentWithCaptionMessage as { message?: { documentMessage?: { caption?: string } } } | undefined)?.message
      ?.documentMessage?.caption;
  if (caption) return caption;
  const buttons = m.buttonsMessage as { contentText?: string; footerText?: string } | undefined;
  if (buttons?.contentText) return buttons.contentText;
  const list = m.listMessage as { description?: string; title?: string } | undefined;
  if (list?.description) return list.description;
  if (list?.title) return list.title;
  return '';
}

export function calcTypingDelayMs(text: string, cfg: HumanResponseTiming): number {
  const n = text.trim().length;
  if (!n) return cfg.TYPING_MIN_MS;
  return Math.min(cfg.TYPING_MAX_MS, Math.max(cfg.TYPING_MIN_MS, n * cfg.TYPING_MS_PER_CHAR));
}

export interface HumanTimingHooks {
  setAvailable: () => Promise<void>;
  applyComposing: (recipientJid: string, delayMs: number) => Promise<void>;
}

interface QueueJob<T> {
  recipientKey: string;
  text: string;
  task: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

class InstanceOutboundQueue {
  private readonly queue: QueueJob<unknown>[] = [];
  private processing = false;
  private ultimoRecipientKey: string | null = null;
  private primeraDesdeColaVacia = true;
  private keepaliveTimer?: ReturnType<typeof setInterval>;
  private expireTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly cfg: HumanResponseTiming,
    private readonly hooks: HumanTimingHooks,
  ) {}

  enqueue<T>(recipientKey: string, text: string, task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.cancelEsperaCliente();
      this.queue.push({
        recipientKey,
        text,
        task: task as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      if (!this.processing) {
        void this.drain();
      }
    });
  }

  private cancelEsperaCliente(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = undefined;
    }
    if (this.expireTimer) {
      clearTimeout(this.expireTimer);
      this.expireTimer = undefined;
    }
  }

  private iniciarEsperaClienteColaVacia(): void {
    this.cancelEsperaCliente();
    void this.hooks.setAvailable();

    this.keepaliveTimer = setInterval(() => {
      void this.hooks.setAvailable();
    }, this.cfg.ONLINE_KEEPALIVE_MS);

    this.expireTimer = setTimeout(() => {
      this.cancelEsperaCliente();
      this.primeraDesdeColaVacia = true;
      this.ultimoRecipientKey = null;
    }, this.cfg.CLIENT_TYPING_WAIT_MS + 500);
  }

  private async drain(): Promise<void> {
    if (this.processing) return;
    this.cancelEsperaCliente();
    this.processing = true;

    try {
      while (this.queue.length > 0) {
        const job = this.queue.shift()!;
        const esPrimeraDesdeVacia = this.primeraDesdeColaVacia;
        const cambioDeChat =
          !esPrimeraDesdeVacia && this.ultimoRecipientKey !== null && this.ultimoRecipientKey !== job.recipientKey;

        if (esPrimeraDesdeVacia) {
          void sleep(randomMs(this.cfg.ONLINE_DELAY_MIN_MS, this.cfg.ONLINE_DELAY_MAX_MS)).then(() =>
            this.hooks.setAvailable(),
          );
        }

        if (cambioDeChat) {
          await sleep(this.cfg.CAMBIO_CHAT_DELAY_MS);
        }

        if (esPrimeraDesdeVacia) {
          await sleep(randomMs(this.cfg.PRE_COMPOSE_DELAY_MIN_MS, this.cfg.PRE_COMPOSE_DELAY_MAX_MS));
        }

        const composeMs = calcTypingDelayMs(job.text, this.cfg);
        await this.hooks.applyComposing(job.recipientKey, composeMs);
        await this.hooks.setAvailable();

        try {
          const result = await job.task();
          job.resolve(result);
        } catch (err) {
          job.reject(err);
        }

        this.ultimoRecipientKey = job.recipientKey;
        this.primeraDesdeColaVacia = false;
      }
    } finally {
      this.processing = false;
      if (this.queue.length === 0 && this.ultimoRecipientKey != null) {
        this.iniciarEsperaClienteColaVacia();
      }
    }
  }
}

const outboundQueues = new Map<string, InstanceOutboundQueue>();

export function runHumanTimedSend<T>(
  instanceName: string,
  recipientKey: string,
  message: unknown,
  hooks: HumanTimingHooks,
  task: () => Promise<T>,
): Promise<T> {
  const cfg = getHumanResponseTimingConfig();
  let queue = outboundQueues.get(instanceName);
  if (!queue) {
    queue = new InstanceOutboundQueue(cfg, hooks);
    outboundQueues.set(instanceName, queue);
  }
  const text = extractTextForTiming(message);
  return queue.enqueue(recipientKey, text, task);
}

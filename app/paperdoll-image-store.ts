export const PAPERDOLL_IMAGE_MAX_ATTEMPTS = 3;
export const PAPERDOLL_IMAGE_RETRY_BASE_DELAY_MS = 750;
export const PAPERDOLL_IMAGE_RETRY_MAX_DELAY_MS = 6_000;
export const PAPERDOLL_IMAGE_RETRY_COOLDOWN_MS = 30_000;

export type PaperdollImageLike = Readonly<{
  complete: boolean;
  naturalWidth: number;
  naturalHeight: number;
}>;

export type PaperdollImageRecord<TImage extends PaperdollImageLike> = {
  image: TImage;
  attempts: number;
};

export type PaperdollImageFactory<TImage extends PaperdollImageLike> = (
  path: string,
  onLoad: () => void,
  onError: () => void,
) => TImage;
export type PaperdollRetryScheduler = (callback: () => void, delayMs: number) => void;
export type PaperdollImageValidator<TImage extends PaperdollImageLike> = (
  path: string,
  image: TImage,
) => boolean;

export function paperdollImageRetryDelay(attempts: number): number {
  const safeAttempts = Number.isFinite(attempts)
    ? Math.max(1, Math.floor(attempts))
    : 1;
  return Math.min(
    PAPERDOLL_IMAGE_RETRY_MAX_DELAY_MS,
    PAPERDOLL_IMAGE_RETRY_BASE_DELAY_MS * 2 ** (safeAttempts - 1),
  );
}

/**
 * Owns only the image paths required by the current scene. Failed paths are
 * removed so a later reconciliation can retry; attempts are bounded per
 * controller lifetime to avoid a missing deployment asset creating a loop.
 */
export class PaperdollImageStore<TImage extends PaperdollImageLike> {
  private readonly records = new Map<string, PaperdollImageRecord<TImage>>();
  private readonly images = new Map<string, TImage>();
  private readonly failedAttempts = new Map<string, number>();
  private readonly retryAfter = new Map<string, number>();
  private requiredPaths = new Set<string>();

  constructor(
    private readonly createImage: PaperdollImageFactory<TImage>,
    private readonly maximumAttempts = PAPERDOLL_IMAGE_MAX_ATTEMPTS,
    private readonly scheduleRetry: PaperdollRetryScheduler = (callback, delayMs) => {
      globalThis.setTimeout(callback, delayMs);
    },
    private readonly validateImage: PaperdollImageValidator<TImage> = () => true,
  ) {}

  get size(): number {
    return this.records.size;
  }

  get(path: string): TImage | undefined {
    return this.records.get(path)?.image;
  }

  /** Mutable consumers can expose this stable map directly as a source map. */
  imageMap(): ReadonlyMap<string, TImage> {
    return this.images;
  }

  has(path: string): boolean {
    return this.records.has(path);
  }

  keys(): readonly string[] {
    return [...this.records.keys()];
  }

  attemptsFor(path: string): number {
    return this.failedAttempts.get(path) ?? this.records.get(path)?.attempts ?? 0;
  }

  reconcile(paths: Iterable<string>): void {
    const required = new Set(
      [...paths].filter((path): path is string => typeof path === "string" && path.length > 0),
    );
    this.requiredPaths = required;

    for (const path of this.records.keys()) {
      if (!required.has(path)) {
        this.records.delete(path);
        this.images.delete(path);
      }
    }
    for (const path of this.failedAttempts.keys()) {
      if (!required.has(path)) {
        this.failedAttempts.delete(path);
        this.retryAfter.delete(path);
      }
    }

    for (const path of required) this.ensure(path);
  }

  clear(): void {
    this.records.clear();
    this.images.clear();
    this.failedAttempts.clear();
    this.retryAfter.clear();
    this.requiredPaths.clear();
  }

  private ensure(path: string): void {
    if (this.records.has(path)) return;
    let attempts = this.failedAttempts.get(path) ?? 0;
    const retryAt = this.retryAfter.get(path) ?? 0;
    if (attempts >= this.maximumAttempts && Date.now() >= retryAt) {
      attempts = 0;
      this.failedAttempts.delete(path);
      this.retryAfter.delete(path);
    }
    if (attempts >= this.maximumAttempts) return;

    const nextAttempts = attempts + 1;
    const holder: { image?: TImage } = {};
    const onLoad = () => {
      const current = this.records.get(path);
      if (!current || current.image !== holder.image) return;
      if (!this.validateImage(path, current.image)) {
        onError();
        return;
      }
      this.failedAttempts.delete(path);
      this.retryAfter.delete(path);
    };
    const onError = () => {
      const current = this.records.get(path);
      if (!current || current.image !== holder.image) return;
      this.records.delete(path);
      this.images.delete(path);
      this.failedAttempts.set(path, nextAttempts);
      if (!this.requiredPaths.has(path)) return;
      if (nextAttempts >= this.maximumAttempts) {
        this.retryAfter.set(path, Date.now() + PAPERDOLL_IMAGE_RETRY_COOLDOWN_MS);
        this.scheduleRetry(() => {
          if (!this.requiredPaths.has(path) || this.records.has(path)) return;
          this.failedAttempts.delete(path);
          this.retryAfter.delete(path);
          this.ensure(path);
        }, PAPERDOLL_IMAGE_RETRY_COOLDOWN_MS);
        return;
      }
      this.scheduleRetry(() => {
        if (!this.requiredPaths.has(path) || this.records.has(path)) return;
        this.ensure(path);
      }, paperdollImageRetryDelay(nextAttempts));
    };
    const image = this.createImage(path, onLoad, onError);
    holder.image = image;
    this.records.set(path, { image, attempts: nextAttempts });
    this.images.set(path, image);
  }
}

export function createBrowserPaperdollImageStore(): PaperdollImageStore<HTMLImageElement> {
  return new PaperdollImageStore(
    (path, onLoad, onError) => {
      const image = new Image();
      image.decoding = "async";
      image.addEventListener("load", onLoad, { once: true });
      image.addEventListener("error", onError, { once: true });
      image.src = path;
      return image;
    },
    PAPERDOLL_IMAGE_MAX_ATTEMPTS,
    (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    (_path, image) => image.naturalWidth === 1_024 && image.naturalHeight === 1_536,
  );
}

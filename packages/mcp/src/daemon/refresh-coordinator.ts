/** Serialize refreshes and share exactly one queued full scan after an incremental refresh. */
export class RefreshCoordinator<T> {
  private flight: { full: boolean; promise: Promise<T> } | null = null;
  private queuedFull: Promise<T> | null = null;

  constructor(private readonly refresh: (full: boolean) => Promise<T>) {}

  get busy(): boolean {
    return this.flight !== null || this.queuedFull !== null;
  }

  run(full: boolean): Promise<T> {
    if (this.queuedFull) return this.queuedFull;
    if (this.flight) {
      if (!full || this.flight.full) return this.flight.promise;
      const queued = this.flight.promise.catch(() => undefined).then(() => this.start(true));
      const result = queued.finally(() => {
        if (this.queuedFull === result) this.queuedFull = null;
      });
      this.queuedFull = result;
      return result;
    }
    return this.start(full);
  }

  private start(full: boolean): Promise<T> {
    const promise = Promise.resolve()
      .then(() => this.refresh(full))
      .finally(() => {
        if (this.flight?.promise === promise) this.flight = null;
      });
    this.flight = { full, promise };
    return promise;
  }
}

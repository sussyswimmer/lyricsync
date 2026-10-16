/** Brief gaps between songs report nothing playing; the settings window rides out a gap this long. */
export const GAP_GRACE_MS = 900;

/**
 * The last song, held through a brief "nothing playing" between songs. Without it the per-song sync
 * controls flash "Nothing playing" on every track change, and a keyboard user's focus on one of them
 * is lost. A song replaces the held one at once; only a gap longer than `graceMs` lets go of it.
 */
export class TrackHold<T> {
  private held: T | null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly onChange: (value: T | null) => void;
  private readonly graceMs: number;

  constructor(initial: T | null, onChange: (value: T | null) => void, graceMs = GAP_GRACE_MS) {
    this.held = initial;
    this.onChange = onChange;
    this.graceMs = graceMs;
  }

  /** The song to show: the latest one, or the last one during a short gap. */
  get value(): T | null {
    return this.held;
  }

  /** Every now-playing report, including the once-a-second resyncs. */
  set(next: T | null): void {
    if (next !== null) {
      this.cancel();
      this.held = next;
      this.onChange(next);
      return;
    }
    // Already let go, or already counting down (the resyncs keep reporting nothing).
    if (this.held === null || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.held = null;
      this.onChange(null);
    }, this.graceMs);
  }

  dispose(): void {
    this.cancel();
  }

  private cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

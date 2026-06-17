/**
 * TapMonitor — JS-level auto-clicker / macro detection.
 *
 * Auto-clickers produce hits at mathematically uniform intervals
 * (coefficient of variation typically < 0.15). Human taps are
 * erratic by nature (CV 0.25–0.60+).
 *
 * Usage: call record() on every HIT_ACK received from the server
 * WebSocket. Call isAutoClicking() to evaluate the current window.
 *
 * The server already enforces a 300 ms minimum between hits.
 * This monitor watches for statistical *uniformity* across a
 * sliding window — the key signal that distinguishes bots from
 * fast human players who occasionally land rapid hits.
 *
 * Native accessibility-service enumeration (checking which
 * accessibility packages are enabled) requires a custom EAS build.
 * This JS analysis provides a complementary, build-agnostic layer
 * that works in Expo Go, custom builds, and the APK alike.
 */

const WINDOW      = 15;   // Sliding window of timestamps to keep
const MIN_HITS    = 12;   // Minimum hits before the check activates
const CV_THRESH   = 0.15; // Coefficient of Variation threshold
                          //   < 0.15 → suspiciously uniform → likely bot
                          //   ≥ 0.15 → human-like variance → allow

export class TapMonitor {
  private timestamps: number[] = [];

  /** Record a new validated hit (call on every HIT_ACK from the server). */
  record(tsMs: number = Date.now()): void {
    this.timestamps.push(tsMs);
    // Keep only the most recent WINDOW + 1 timestamps (to yield WINDOW intervals)
    if (this.timestamps.length > WINDOW + 1) {
      this.timestamps.shift();
    }
  }

  /** Reset the monitor (call when a new game session starts). */
  reset(): void {
    this.timestamps = [];
  }

  /**
   * Returns true when the recent hit pattern is statistically
   * indistinguishable from an automated scripted input.
   *
   * Algorithm:
   *   1. Compute N-1 inter-hit intervals.
   *   2. Compute the Coefficient of Variation (CV = σ / μ).
   *   3. A CV below the threshold means the bot is producing
   *      near-constant-interval taps — impossible for a human.
   */
  isAutoClicking(): boolean {
    if (this.timestamps.length < MIN_HITS + 1) return false;

    const intervals: number[] = [];
    for (let i = 1; i < this.timestamps.length; i++) {
      intervals.push(this.timestamps[i] - this.timestamps[i - 1]);
    }

    const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    if (mean <= 0) return false;

    const variance =
      intervals.reduce((acc, v) => acc + (v - mean) ** 2, 0) / intervals.length;
    const stdDev = Math.sqrt(variance);
    const cv     = stdDev / mean;

    return cv < CV_THRESH;
  }
}

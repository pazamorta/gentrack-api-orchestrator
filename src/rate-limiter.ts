/**
 * In-memory sliding window rate limiter.
 * Supports per-IP, per-route, and global rate limiting.
 */

export interface RateLimitConfig {
  /** Max requests allowed in the window */
  maxRequests: number;
  /** Time window in milliseconds */
  windowMs: number;
  /** Message returned when rate limited */
  message?: string;
}

interface WindowEntry {
  timestamps: number[];
}

export class RateLimiter {
  private windows = new Map<string, WindowEntry>();
  private config: RateLimitConfig;
  private cleanupInterval: ReturnType<typeof setInterval>;

  constructor(config: RateLimitConfig) {
    this.config = config;

    // Periodically clean up expired entries
    this.cleanupInterval = setInterval(() => this.cleanup(), config.windowMs * 2);
  }

  /**
   * Check if a request is allowed for the given key.
   * Returns { allowed, remaining, resetMs }.
   */
  check(key: string): { allowed: boolean; remaining: number; resetMs: number } {
    const now = Date.now();
    const windowStart = now - this.config.windowMs;

    let entry = this.windows.get(key);
    if (!entry) {
      entry = { timestamps: [] };
      this.windows.set(key, entry);
    }

    // Remove timestamps outside the current window
    entry.timestamps = entry.timestamps.filter((t) => t > windowStart);

    const remaining = Math.max(0, this.config.maxRequests - entry.timestamps.length);
    const resetMs = entry.timestamps.length > 0
      ? entry.timestamps[0] + this.config.windowMs - now
      : this.config.windowMs;

    if (entry.timestamps.length >= this.config.maxRequests) {
      return { allowed: false, remaining: 0, resetMs };
    }

    // Record this request
    entry.timestamps.push(now);
    return { allowed: true, remaining: remaining - 1, resetMs };
  }

  /** Clean up expired window entries */
  private cleanup(): void {
    const now = Date.now();
    const windowStart = now - this.config.windowMs;

    for (const [key, entry] of this.windows.entries()) {
      entry.timestamps = entry.timestamps.filter((t) => t > windowStart);
      if (entry.timestamps.length === 0) {
        this.windows.delete(key);
      }
    }
  }

  /** Stop the cleanup interval */
  destroy(): void {
    clearInterval(this.cleanupInterval);
  }
}

// ---- Express Middleware ----

import { Request, Response, NextFunction } from 'express';

export interface RateLimitMiddlewareOptions extends RateLimitConfig {
  /** Function to derive the rate limit key from a request (default: IP address) */
  keyFn?: (req: Request) => string;
  /** Whether to add rate limit headers to the response */
  headers?: boolean;
}

/**
 * Express middleware for rate limiting.
 */
export function rateLimitMiddleware(options: RateLimitMiddlewareOptions) {
  const limiter = new RateLimiter({
    maxRequests: options.maxRequests,
    windowMs: options.windowMs,
    message: options.message,
  });

  const keyFn = options.keyFn || ((req: Request) => req.ip || req.socket.remoteAddress || 'unknown');
  const addHeaders = options.headers !== false;

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = keyFn(req);
    const { allowed, remaining, resetMs } = limiter.check(key);

    if (addHeaders) {
      res.setHeader('X-RateLimit-Limit', options.maxRequests);
      res.setHeader('X-RateLimit-Remaining', remaining);
      res.setHeader('X-RateLimit-Reset', Math.ceil((Date.now() + resetMs) / 1000));
    }

    if (!allowed) {
      res.status(429).json({
        error: options.message || 'Too many requests, please try again later',
        retryAfterMs: resetMs,
      });
      return;
    }

    next();
  };
}

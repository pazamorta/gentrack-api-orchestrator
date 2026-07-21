import { Router, Request, Response } from 'express';
import * as db from '../db';

const router = Router();

/**
 * Mock API handler — matches inbound requests against active mocks
 * and returns the configured mock response.
 * 
 * Frontend apps call /mock/* instead of /api/* to get mocked responses.
 */
router.all('*', (req: Request, res: Response) => {
  const mock = db.getActiveMockForRoute(req.method, req.path);

  if (!mock) {
    res.status(404).json({
      error: 'No active mock configured for this endpoint',
      method: req.method,
      path: req.path,
    });
    return;
  }

  // Set response headers from mock
  if (mock.response.headers) {
    for (const [key, value] of Object.entries(mock.response.headers)) {
      res.setHeader(key, value);
    }
  }

  res.status(mock.response.statusCode).json(mock.response.body);
});

export default router;

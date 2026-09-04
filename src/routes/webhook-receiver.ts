import { Router, Request, Response } from 'express';
import { getReceivedWebhookStore } from '../webhooks/received-store';

const router = Router();

/**
 * Catch-all inbound webhook receiver. Public (no auth). Records every received call to the
 * received-webhook store and returns 200. Currently log-only; route/orchestration triggering
 * can be layered on here later without changing the storage or receiver contract.
 *
 * Mounted at /webhooks, so the matched path (req.path here) is everything after that prefix.
 */
router.all('*', (req: Request, res: Response) => {
  try {
    const name = req.path.replace(/^\//, '') || '(root)';
    getReceivedWebhookStore().add({
      name,
      method: req.method,
      path: req.path,
      headers: req.headers as Record<string, string>,
      query: req.query as Record<string, string>,
      body: req.body,
    });
    console.log(`[webhooks] received ${req.method} /webhooks/${name}`);
  } catch (err) {
    console.error('[webhooks] failed to record inbound webhook:', err);
  }
  res.status(200).json({ received: true });
});

export default router;

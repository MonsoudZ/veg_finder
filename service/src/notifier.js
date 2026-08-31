// Delivers menu-review alerts to a human. Without this the checker's findings only
// reach stdout and the token-protected review queue, so a demoted restaurant can
// sit unreconciled indefinitely.

const DEFAULT_TIMEOUT_MS = 10_000;

export function createNotifier({
  webhookURL = process.env.ALERT_WEBHOOK_URL,
  fetchImpl = fetch,
  logger = console
} = {}) {
  const target = parseWebhookURL(webhookURL, logger);

  return {
    enabled: Boolean(target),

    async send(message) {
      if (!target) return false;
      try {
        // `text` is what Slack renders, `content` is what Discord renders, and the
        // structured fields are there for anything else consuming the hook.
        const response = await fetchImpl(target, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: message.text, content: message.text, ...message.detail }),
          signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
        });
        if (!response.ok) {
          logger.error(`Review alert rejected by webhook: HTTP ${response.status}`);
          return false;
        }
        return true;
      } catch (error) {
        // An unreachable webhook must never fail the check cycle that produced it.
        logger.error(`Review alert could not be delivered: ${error.message ?? error}`);
        return false;
      }
    }
  };
}

function parseWebhookURL(value, logger) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
      logger.error("ALERT_WEBHOOK_URL must use https; review alerts are disabled.");
      return null;
    }
    return url.toString();
  } catch {
    logger.error("ALERT_WEBHOOK_URL is not a valid URL; review alerts are disabled.");
    return null;
  }
}

// Decides whether a completed check cycle is worth waking someone for, and says
// what to do about it. Silent when every source was reachable, unchanged, and no
// earlier demotion is still waiting to be reconciled.
export function summarizeCheck(results, reviewQueue) {
  const changed = results.filter((result) => result.status === "changed");
  const failed = results.filter((result) => result.status === "failed");
  // Human-verified records have no fingerprint; they come due on an age clock.
  const reviewDue = results.filter((result) => result.status === "review_due");
  const queueSize = reviewQueue.length;

  if (changed.length === 0 && failed.length === 0 && reviewDue.length === 0 && queueSize === 0) {
    return { shouldNotify: false };
  }

  const lines = [];
  if (changed.length === 0 && failed.length === 0 && reviewDue.length === 0) {
    lines.push(
      `VegFinder catalog — ${count(queueSize, "restaurant")} still awaiting review`,
      "",
      "Every official source was reachable and unchanged this cycle, but earlier",
      "demotions have not been reconciled yet."
    );
  } else {
    lines.push(
      `VegFinder catalog — ${count(queueSize, "restaurant")} ${queueSize === 1 ? "needs" : "need"} review`,
      ""
    );
    if (changed.length > 0) {
      lines.push(`Official menu changed (${changed.length}):`);
      lines.push(...changed.map((result) => `• ${result.name ?? result.id}`), "");
    }
    if (failed.length > 0) {
      lines.push(`Source unreachable (${failed.length}):`);
      lines.push(...failed.map((result) => `• ${result.name ?? result.id} — ${result.error}`), "");
    }
    if (reviewDue.length > 0) {
      lines.push(`Re-verification due (${reviewDue.length}):`);
      lines.push(...reviewDue.map((result) => `• ${result.name ?? result.id} — ${result.error}`), "");
    }
  }
  lines.push(
    queueSize === 1
      ? "This restaurant is already demoted to 'Needs review' in the app."
      : "These restaurants are already demoted to 'Needs review' in the app.",
    "Reconcile against the official menu, then re-seed with an advanced auditedAt."
  );

  return {
    shouldNotify: true,
    text: lines.join("\n").trim(),
    detail: {
      service: "vegfinder-catalog",
      event: "menu_check",
      changed: changed.map(nameOrID),
      failed: failed.map((result) => ({ restaurant: nameOrID(result), error: result.error })),
      reviewDue: reviewDue.map(nameOrID),
      reviewQueueSize: queueSize
    }
  };
}

// Called after every check cycle, from both the scheduled run and `npm run check`.
export async function announceCheckResults(store, results, { notifier, logger = console } = {}) {
  const reviewQueue = await store.getReviewQueue();
  const summary = summarizeCheck(results, reviewQueue);
  if (!summary.shouldNotify) {
    logger.log("Nothing needs review; no alert sent.");
    return false;
  }
  if (!notifier?.enabled) {
    logger.warn(
      `${reviewQueue.length} restaurant(s) need review and no ALERT_WEBHOOK_URL is configured. ` +
      "Nobody will be told. See GET /internal/review-queue."
    );
    return false;
  }
  return notifier.send(summary);
}

function nameOrID(result) {
  return result.name ?? result.id;
}

function count(value, noun) {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

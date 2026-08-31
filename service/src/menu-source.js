// The two judgements about a fetched source that both the drafting pipeline and
// the change-proposal pipeline have to make, kept in one place so they cannot
// drift apart: whether the document can be read as text at all, and where the
// restaurant's whole-menu claim lives if it is not on the menu.

// A PDF announces itself; anything else is judged by how much of the first few
// kilobytes is unprintable, which is what separates a document from markup.
export function looksBinary(source) {
  const text = String(source ?? "");
  if (text.startsWith("%PDF-")) return true;
  const sample = text.slice(0, 4_000);
  if (!sample) return false;
  const unprintable = sample.replace(/[\t\n\r\x20-\x7e\u00a0-\uffff]/g, "").length;
  return unprintable / sample.length > 0.05;
}

const CLAIM_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36 VegFinderBot/1.0";

// The page an operator nominated as carrying the restaurant's whole-menu claim.
// A failure here is never fatal: without the claim the restaurant simply falls
// back to whatever its menu says on its own, which errs towards less publishing
// rather than more. It is still reported, because a claim page that quietly
// stopped resolving would otherwise look identical to a restaurant that never
// made a claim.
export async function loadClaimPage(restaurant, fetchImpl = fetch) {
  if (!restaurant.claim_url) return { html: null, error: null };
  try {
    const response = await fetchImpl(restaurant.claim_url, {
      headers: { "user-agent": CLAIM_USER_AGENT }, redirect: "follow"
    });
    if (!response.ok) {
      return { html: null, error: `Claim page ${restaurant.claim_url} returned HTTP ${response.status}` };
    }
    return { html: await response.text(), error: null };
  } catch (error) {
    return { html: null, error: `Claim page ${restaurant.claim_url} was unreachable: ${error.message}` };
  }
}

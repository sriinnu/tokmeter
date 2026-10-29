import { TOKEN_BUCKETS, TOKEN_CONFIG, type TokenBucket } from "../charts/token-buckets.js";
import { formatCompact, formatInteger, formatPercent } from "../lib/format.js";

/**
 * Where a total's tokens went, as one 100% bar plus the exact counts. The
 * segments are the five buckets core sums into `totalTokens`, so they add up
 * to it exactly; nothing here re-derives the total.
 */
export function TokenComposition({
  totals,
}: {
  totals: Record<TokenBucket, number> & { totalTokens: number };
}) {
  const total = totals.totalTokens;
  return (
    <div className="grid gap-3">
      <div className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full bg-muted" aria-hidden>
        {total > 0 &&
          TOKEN_BUCKETS.map((bucket) =>
            totals[bucket] > 0 ? (
              <div
                key={bucket}
                style={{
                  width: `${(totals[bucket] / total) * 100}%`,
                  background: TOKEN_CONFIG[bucket].color,
                }}
              />
            ) : null
          )}
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-3 lg:grid-cols-5">
        {TOKEN_BUCKETS.map((bucket) => (
          <div key={bucket} className="min-w-0">
            <dt className="flex items-center gap-1.5 text-muted-foreground">
              <span
                aria-hidden
                className="size-2 rounded-[2px]"
                style={{ background: TOKEN_CONFIG[bucket].color }}
              />
              {TOKEN_CONFIG[bucket].label}
            </dt>
            <dd className="num font-medium" title={formatInteger(totals[bucket])}>
              {formatCompact(totals[bucket])}{" "}
              <span className="font-normal text-muted-foreground">
                {total > 0 ? formatPercent(totals[bucket] / total) : "—"}
              </span>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

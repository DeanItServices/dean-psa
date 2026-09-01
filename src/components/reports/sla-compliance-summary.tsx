import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { SlaComplianceResult } from "@/lib/reporting";

/**
 * Renders the SLA compliance report's two summary blocks -- Response and
 * Resolution -- each showing met count, breached count, and compliance %.
 *
 * When a leg's `*CompliancePct` is `null` (no tickets with an unambiguous
 * final outcome for that leg in the selected range -- see
 * `getSlaCompliance`'s denominator-exclusion rules in `src/lib/reporting.ts`),
 * this renders an explicit "No data in this range" message. It NEVER
 * coerces a null percentage to "0%" or leaves it blank, since 0% would
 * falsely imply every ticket breached when in fact there were no
 * comparable tickets at all.
 *
 * Terminology ("Met" / "Breached") matches `src/components/tickets/sla-badge.tsx`'s
 * existing status labels for consistency with the ticket detail page.
 */
export function SlaComplianceSummary({ result }: { result: SlaComplianceResult }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <SlaLegCard
        title="Response"
        met={result.responseMet}
        breached={result.responseBreached}
        compliancePct={result.responseCompliancePct}
      />
      <SlaLegCard
        title="Resolution"
        met={result.resolutionMet}
        breached={result.resolutionBreached}
        compliancePct={result.resolutionCompliancePct}
      />
    </div>
  );
}

function SlaLegCard({
  title,
  met,
  breached,
  compliancePct,
}: {
  title: string;
  met: number;
  breached: number;
  compliancePct: number | null;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between">
          <span className="text-sm text-muted-foreground">Met</span>
          <span className="text-sm font-medium">{met}</span>
        </div>
        <div className="flex items-baseline justify-between">
          <span className="text-sm text-muted-foreground">Breached</span>
          <span className="text-sm font-medium">{breached}</span>
        </div>
        <div className="flex items-baseline justify-between border-t pt-2">
          <span className="text-sm text-muted-foreground">Compliance</span>
          {compliancePct === null ? (
            <span className="text-sm italic text-muted-foreground">
              No data in this range
            </span>
          ) : (
            <span className="text-lg font-semibold">{compliancePct.toFixed(1)}%</span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

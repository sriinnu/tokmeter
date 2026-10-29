import { Link } from "react-router-dom";
import { Sparkline } from "../../components/Sparkline.js";
import { EmptyState } from "../../components/states.js";
import { Button } from "../../components/ui/button.js";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card.js";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table.js";
import { formatCompact, formatCurrency, formatTimestamp } from "../../lib/format.js";
import { projectHref } from "../projects/project-href.js";
import type { DashboardInsights } from "./buildDashboardInsights.js";

export function TopProjectsCard({ insights }: { insights: DashboardInsights }) {
  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <div>
          <CardTitle>Top projects</CardTitle>
          <CardDescription>
            By estimated cost, all time · trend is the last 14 active days
          </CardDescription>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link to="/projects">All projects</Link>
        </Button>
      </CardHeader>
      <CardContent className="px-0 sm:px-0">
        {insights.topProjects.length === 0 ? (
          <div className="px-4">
            <EmptyState title="Project rankings appear after the first summary" />
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Project</TableHead>
                <TableHead className="text-right">Est. cost</TableHead>
                <TableHead className="hidden text-right sm:table-cell">
                  Last 14 active days
                </TableHead>
                <TableHead className="text-right">Tokens</TableHead>
                <TableHead className="hidden md:table-cell">Last used</TableHead>
                <TableHead className="hidden sm:table-cell">Trend</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {insights.topProjects.map((p) => (
                <TableRow key={p.project}>
                  <TableCell className="max-w-48 truncate sm:max-w-72">
                    <Link
                      to={projectHref(p.project)}
                      className="font-medium underline-offset-2 hover:underline"
                      title={p.project}
                    >
                      {p.project}
                    </Link>
                    <div className="text-xs text-muted-foreground">
                      {p.modelCount} model{p.modelCount === 1 ? "" : "s"} · {p.activeDays} active
                      day
                      {p.activeDays === 1 ? "" : "s"}
                    </div>
                  </TableCell>
                  <TableCell className="num text-right font-medium">
                    {formatCurrency(p.totalCost)}
                  </TableCell>
                  <TableCell className="num hidden text-right text-muted-foreground sm:table-cell">
                    {formatCurrency(p.recentCost)}
                  </TableCell>
                  <TableCell className="num text-right">{formatCompact(p.totalTokens)}</TableCell>
                  <TableCell className="hidden text-muted-foreground md:table-cell">
                    {formatTimestamp(p.lastUsed)}
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    <Sparkline values={p.sparkline} width={80} height={22} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

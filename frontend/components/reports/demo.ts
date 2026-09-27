/** Demo step helper: show one of the scenario's canned reports with its card open. */

import type { AppValue } from "@/components/app/AppContext";
import { reportsApi, selectReport, setReports, type ReportKind } from "@/lib/reports";

export async function showDemoReport(a: AppValue, kind: ReportKind): Promise<void> {
  const { items } = await reportsApi.list();
  setReports(items);
  const r = items.find((x) => x.demo && x.kind === kind) ?? items.find((x) => x.kind === kind);
  a.go({ name: "map" });
  if (!r) return;
  a.focus({ lat: r.lat, lng: r.lng, zoom: 14 });
  setTimeout(() => selectReport(r.id), 400);
}

"use client";

/** The Report button (map and Trip screen): opens the Report sheet. */

import { Icon } from "@/components/ui";
import { REPORT_ICON, openReport, useReports } from "@/lib/reports";
import { C } from "@/lib/theme";

export default function ReportButton() {
  const { draft } = useReports();
  return (
    <button
      type="button"
      onClick={() => openReport()}
      aria-label="Report something on the road"
      aria-haspopup="dialog"
      aria-expanded={!!draft}
      className="flex h-12 cursor-pointer items-center gap-2 rounded-3xl bg-float pr-4 pl-3 text-[14px] font-semibold text-ink shadow-e1 hover:bg-card"
    >
      <Icon d={REPORT_ICON} color={C.moderateText} />
      Report
    </button>
  );
}

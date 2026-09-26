"use client";

// Placeholder: replaced by the screen build (see docs in components/app/AppContext.tsx).

import { useApp } from "@/components/app/AppContext";
import { BackHeader, Title } from "@/components/ui";

export default function Causes() {
  const { back } = useApp();
  return (
    <div className="flex flex-col gap-4 px-5 pt-14 pb-28 md:pt-6">
      <BackHeader onBack={back} />
      <Title>Causes</Title>
    </div>
  );
}

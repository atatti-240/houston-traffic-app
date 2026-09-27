import type { Metadata } from "next";

import SharedTrip from "@/components/share/SharedTrip";

export const metadata: Metadata = {
  title: "Live ETA · BlindSpot",
  description: "Where they're headed and when they should get there, re-checked against live traffic.",
  // The link is the only key to the trip: keep it out of search engines and other sites' logs.
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

/** A Share ETA link: /share/<id>. Everything is loaded in the browser (the API may only be reachable from there). */
export default async function SharePage({ params }: PageProps<"/share/[id]">) {
  const { id } = await params;
  return <SharedTrip id={id} />;
}

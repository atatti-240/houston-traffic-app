/** Louisiana DOTD's public 511LA Baton Rouge traffic cameras (the same list the landing page
 * uses). Until Houston live video is available, each Houston camera without the camera AI's video
 * shows one of these, always the same one for the same Houston camera, labeled as a stand-in. */

export interface LaCam {
  /** 511LA camera number, as in the stream URL ("007") */
  id: string;
  /** Where it looks, e.g. "I-10 at College Dr" */
  name: string;
}

export const LA_CAMS: readonly LaCam[] = [
  { id: "001", name: "I-12 at Drusilla Ln" },
  { id: "003", name: "I-12 east of the I-10/I-12 split" },
  { id: "005", name: "I-10/I-12 split" },
  { id: "007", name: "I-10 at College Dr" },
  { id: "009", name: "I-10 at Perkins Rd" },
  { id: "011", name: "I-10 at I-110" },
  { id: "013", name: "I-10 at Florida St" },
  { id: "015", name: "I-10 at LA 1" },
  { id: "017", name: "I-110 at the Governor's Mansion" },
  { id: "019", name: "I-10 at Essen Ln" },
  { id: "021", name: "I-10 at Picardy Ave" },
  { id: "023", name: "I-12 at Airline Hwy" },
  { id: "025", name: "US 61 at Goodwood Blvd" },
  { id: "027", name: "US 61 at Coursey Blvd" },
  { id: "033", name: "Florida Blvd at Stevendale Rd" },
  { id: "039", name: "I-12 at Sherwood Forest Blvd" },
];

/** Where the public HLS stream lives (it allows any origin). */
export const LA_HOST = "ITSStreamingBR.dotd.la.gov";
export const LA_SITE = "https://www.511la.org";

export function laStreamUrl(cam: LaCam): string {
  return `https://${LA_HOST}/public/br-cam-${cam.id}.streams/playlist.m3u8`;
}

/** FNV-1a: ids that differ only in their last letter land on different cameras. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** The Baton Rouge camera standing in for a Houston camera: the same one every time. `attempt`
 * moves on to the next one in the list when that one won't play. */
export function laCamFor(houstonId: string, attempt = 0): LaCam {
  return LA_CAMS[(hash(houstonId) + attempt) % LA_CAMS.length];
}

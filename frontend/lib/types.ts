export type LatLngTuple = [number, number];

/** How sure we are about a piece of data: live + fresh = high, predictions = medium,
 * sensor down / stale / feed down = low. */
export type Confidence = "high" | "medium" | "low";

export interface Place {
  id: string;
  name: string;
  lat: number;
  lng: number;
}

export interface Segment {
  id: string;
  name: string;
  highway: string;
  road_class: "freeway" | "arterial";
  direction: string;
  from_node: string;
  to_node: string;
  miles: number;
  free_flow_mph: number;
  geometry: LatLngTuple[];
}

export interface ScoreMap {
  at: string;
  scores: Record<string, number>;
  /** Congestion only: segments whose score used live data. */
  sources?: Record<string, { source: string; live_weight: number; predicted: number; updated_at: string | null }>;
  /** Congestion only: segments slowed or closed by an incident. */
  incidents?: Record<string, SegmentIncident>;
}

export interface SegmentIncident {
  closed: boolean;
  slowdown: number;
  title: string;
}

export interface Crossing {
  id: string;
  name: string;
  lat: number;
  lng: number;
  rail_line: string;
  segment_ids: string[];
  block_probability: number;
  expected_delay_min: number;
  live_blocked_until: string | null;
  live?: boolean;
  sensor?: "UP" | "DOWN" | null;
  confidence?: Confidence;
  source?: string;
  updated_at?: string | null;
}

export interface Camera {
  id: string;
  kind: "highway" | "train";
  name: string;
  lat: number;
  lng: number;
  url: string;
  segment_id: string | null;
  crossing_id: string | null;
  mock: boolean;
}

export interface RouteSegment {
  id: string;
  name: string;
  road_class: string;
  enter_at: string;
  travel_min: number;
  train_delay_min: number;
  congestion: number;
  predicted_congestion: number;
  /** "history" or "live:<source>[+<source>]" */
  congestion_source: string;
  live_weight: number;
  live_updated_at: string | null;
  incident: Incident | null;
  incident_slowdown: number;
  confidence: Confidence;
  crash_risk: number;
  miles: number;
  geometry: LatLngTuple[];
}

export interface Incident {
  id: string;
  title: string;
  kind: "crash" | "stall" | "roadwork" | "closure" | "hazard" | "other";
  segment_id: string | null;
  started_at: string;
  clears_at: string | null;
  lanes_blocked: number;
  source: string;
  updated_at: string;
  detail: string;
}

export interface Hazard {
  type: "crossing_blocked" | "crossing_risk" | "incident" | "live_traffic" | "high_crash_risk" | string;
  name: string;
  confidence: Confidence;
  source: string;
  [key: string]: unknown;
}

export interface RouteCrossing {
  id: string;
  name: string;
  lat: number;
  lng: number;
  arrive_at: string;
  block_probability: number;
  expected_delay_min: number;
  live: boolean;
  sensor: "UP" | "DOWN" | null;
  confidence: Confidence;
  source: string;
  updated_at: string | null;
}

export interface Route {
  origin: string;
  destination: string;
  depart_at: string;
  arrive_at: string;
  total_min: number;
  safe_path: boolean;
  /** 0 = fastest, 1 = safest */
  safety_weight: number;
  confidence: Confidence;
  feeds_down: string[];
  summary: string;
  breakdown: {
    free_flow_min: number;
    base_travel_min: number;
    train_delay_min: number;
    crash_exposure: number;
    max_crash_risk: number;
    max_block_probability: number;
  };
  reasons: string[];
  hazards: Hazard[];
  geometry: LatLngTuple[];
  segments: RouteSegment[];
  crossings: RouteCrossing[];
}

export interface Recommendation {
  depart_at: string;
  arrive_by: string;
  eta: string;
  on_time: boolean;
  lead_min: number;
  buffer_min: number;
  /** Leave this much earlier if you can't afford to be late (more margin on shakier data). */
  leave_at_safe: string;
  confidence: number;
  confidence_label: Confidence;
  data_confidence: Confidence;
  route: Route;
  alternative: Route | null;
}

export interface Trip {
  id: number;
  name: string;
  origin: string;
  destination: string;
  arrive_by: string;
  days: number[];
  safe_path: boolean;
  safety_weight?: number | null;
}

export interface AppNotification {
  id: number;
  trip_id: number | null;
  plan_id?: string | null;
  created_at: string;
  kind: "plan" | "leave_now" | "leave_earlier" | "leave_later" | "reroute" | "order_changed" | "info";
  title: string;
  body: string;
}

export interface ClockState {
  now: string;
  weekday: string;
  speed: number;
  notifications?: AppNotification[];
}

export type Location = string | { lat: number; lng: number };

// ---- GET /live (docs/contracts/live_conditions.json) ----------------------------------

export interface LiveCrossing {
  id: string;
  street: string;
  lat: number;
  lng: number;
  status: "blocked" | "clear" | "unknown";
  time_to_clear_min: number | null;
  sensor: "UP" | "DOWN" | null;
  confidence: Confidence;
  p_block_now: number | null;
  source: string;
  updated_at: string | null;
  nearest_camera_id: string | null;
}

export interface LiveIncident extends Incident {
  road: string | null;
  lat: number | null;
  lng: number | null;
  affects_routing: boolean;
}

export interface LiveConditions {
  generated_at: string;
  crossings: LiveCrossing[];
  cameras: (Camera & { snapshot_url: string | null; congestion: number | null; detail: string; updated_at: string | null })[];
  incidents: LiveIncident[];
  travel_times: {
    segment_id: string;
    segment: string;
    minutes: number;
    historical_minutes: number;
    congestion: number;
    usual_congestion: number;
    source: string;
    confidence: Confidence;
    detail: string;
    updated_at: string | null;
  }[];
  feeds: Record<string, { ok: boolean; records: number; error: string | null }>;
  data_freshness: Record<string, unknown>;
}

// ---- POST /plan (docs/contracts/trip_request.json -> plan_result.json) -----------------

export type PlaceIn = { name?: string; place: string } | { name?: string; lat: number; lng: number };

export type StopIn = PlaceIn & {
  window_start?: string | null;
  window_end?: string | null;
  dwell_min?: number;
  fixed_order?: boolean;
};

export interface TripPlanRequest {
  name?: string;
  device_id?: string;
  start: PlaceIn;
  depart_after?: string;
  stops: StopIn[];
  safe_path?: boolean;
  safety_weight?: number;
  buffer_min?: number;
  watch?: boolean;
}

export interface PlanLeg {
  from: string;
  to: string;
  leave_at: string;
  leave_at_safe: string;
  arrive_at: string;
  drive_min: number;
  freeflow_min: number;
  miles: number;
  breakdown: { base_travel_min: number; train_delay_min: number; crash_exposure: number };
  geometry: LatLngTuple[];
  hazards: Hazard[];
  why: string[];
  summary: string;
  window: { start: string | null; end: string | null };
  dwell_min: number;
  wait_min: number;
  late_min: number;
  tight: boolean;
  confidence: Confidence;
  safety_weight: number;
}

export interface PlanResult {
  plan_id: string;
  created_at: string;
  planned_at: string;
  status: "ok" | "late";
  order: string[];
  legs: PlanLeg[];
  late_stops: { name: string; late_min: number }[];
  baseline: { description: string; total_min: number; wait_min: number; late_stops: number };
  saved_min_vs_baseline: number;
  navigate_links: { waze: string; google: string };
  data_freshness: Record<string, unknown>;
  watch: boolean;
  done?: boolean;
  safety_weight: number;
  buffer_min: number;
  drive_min: number;
  warnings: string[];
  notifications?: AppNotification[];
}

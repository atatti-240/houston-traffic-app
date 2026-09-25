export type LatLngTuple = [number, number];

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
  crash_risk: number;
  miles: number;
  geometry: LatLngTuple[];
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
}

export interface Route {
  origin: string;
  destination: string;
  depart_at: string;
  arrive_at: string;
  total_min: number;
  safe_path: boolean;
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
  confidence: number;
  confidence_label: "high" | "medium" | "low";
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
}

export interface AppNotification {
  id: number;
  trip_id: number | null;
  created_at: string;
  kind: "plan" | "leave_now" | "leave_earlier" | "leave_later" | "reroute" | "info";
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

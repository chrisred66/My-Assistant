// Client for the My Assistant PHP API (see server/src/routes.php).
// Requests go through the Tauri HTTP plugin (Rust side), so the server needs no CORS headers.
import { fetch } from "@tauri-apps/plugin-http";

export type Provider = "anthropic" | "openai" | "deepseek";
export const PROVIDERS: Provider[] = ["anthropic", "openai", "deepseek"];
export const PROVIDER_LABELS: Record<Provider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  deepseek: "DeepSeek",
};

/** What the Usage page and ball show: the providers plus Claude Code (read from this computer's logs, tokens only). */
export type UsageSource = Provider | "claude_code";
export const USAGE_SOURCES: UsageSource[] = [...PROVIDERS, "claude_code"];
export const SOURCE_LABELS: Record<UsageSource, string> = { ...PROVIDER_LABELS, claude_code: "Claude Code" };

// User groups (server: Auth.php). role + General plan + PT role/module; `access` is what the account can do.
export type Role = "super_admin" | "admin" | "user";
export type GeneralPlan = "none" | "free" | "paid";
export type PtRole = "none" | "big_man" | "manager" | "staff"; // staff = "Low Man"
export type PtModule = "operations" | "maintenance" | "planning"; // planning = Fleet, Trials, Charging
export type PtLevel = "none" | "view" | "add" | "manage"; // manage = edit, close, delete, settings

/** A role the account can act in, e.g. { id: "pt:manager:maintenance", label: "PT · Maintenance Manager" }. */
export interface UserRole {
  id: string;
  label: string;
}

export interface User {
  id: number;
  roles: UserRole[]; // the Super Admin has every role
  active_role: string | null; // null: several roles and none chosen yet (the app asks)
  account_role: Role; // the account's own role, whatever role it is acting in
  viewed_by: { id: number; name: string } | null; // the Super Admin viewing the app as this account
  email: string | null;
  username: string | null;
  display_name: string;
  has_name?: boolean; // false: display_name is the login (username or email) because no name is set
  role: Role;
  general_plan: GeneralPlan;
  pt_role: PtRole;
  pt_module: PtModule | null;
  access: {
    general: boolean; // General Tool (Recordings, Translate, Transcripts)
    general_plan: GeneralPlan; // in effect: PT users without a plan of their own are "free"
    transcribe: boolean; // speech-to-text; not on the free plan (recordings are saved as audio)
    usage: boolean; // Usage page, AI routing, desktop ball (Super Admin)
    manage_users: boolean;
    /** Today's allowances (null limit: unlimited): translation words (Free 300, Paid 3,000) and transcription minutes (Paid 60). */
    allowance: { words: Allowance; transcribe_minutes: Allowance } | null;
    pt: Record<PtModule, PtLevel>;
  };
}

export interface Allowance {
  limit: number | null;
  used: number;
}

/** Audio storage: 125 MB per person, recordings and meetings together. */
export interface StorageInfo {
  used_bytes: number;
  limit_bytes: number;
}

/** A recording whose audio was removed to stay within the storage allowance (its transcript stays). */
export interface RemovedAudio {
  id: number;
  title: string;
  created_at: string;
}

/** One device sign-in (Settings → Your devices). */
export interface Device {
  id: number;
  device: string;
  signed_in_at: string;
  last_used_at: string | null;
  expires_at: string;
  current: boolean;
}

/** One entry of the activity log (Settings → Activity). */
export interface ActivityEntry {
  id: number;
  created_at: string;
  action: string;
  target: string | null;
  status: number | null;
  role: string | null;
  ip: string | null;
  device: string | null;
  user_id: number | null;
  user_name: string | null;
  viewed_by_name: string | null;
}

export interface ManagedUser extends User {
  disabled: boolean;
  created_at: string;
  editable: boolean; // whether the signed-in administrator may change this account
}

export interface PtStatus {
  connected: boolean;
  database: string;
  tables?: Record<string, number>;
  error?: string;
}

const PT_RANK: Record<PtLevel, number> = { none: 0, view: 1, add: 2, manage: 3 };

/** Whether the user may use a PT module at the given level (view < add < manage). */
export function canPt(user: User, module: PtModule, level: Exclude<PtLevel, "none"> = "view"): boolean {
  return PT_RANK[user.access.pt[module]] >= PT_RANK[level];
}

/** Whether the user has any PT module at all. */
export function hasPt(user: User): boolean {
  return Object.values(user.access.pt).some((l) => l !== "none");
}

/** The fields an administrator sets for an account's groups. */
export interface UserGroups {
  role?: "admin" | "user";
  general_plan?: GeneralPlan;
  pt_role?: PtRole;
  pt_module?: PtModule | "";
}

export const PT_ENERGY_SOURCES = ["Electric", "Hydrogen", "Hybrid", "Diesel"] as const;
export type PtEnergySource = (typeof PT_ENERGY_SOURCES)[number];

export interface PtModelSummary {
  model_id: string;
  manufacturer: string;
  model: string;
  model_year: number;
  bus_type: string;
  bus_length: number; // m
  energy_source: string;
  energy_capacity: number; // kWh (battery) or kg (hydrogen)
  bus_count: number;
}

export interface PtManufacturer {
  manufacturer: string; // key, e.g. "Wisdom_Motor"
  display_name: string;
  category: string;
  created_at: string;
  models: PtModelSummary[];
  bus_count: number;
}

export interface PtModel extends PtModelSummary {
  bus_width: number;
  bus_height: number;
  curb_weight: number;
  gvw: number | null;
  axle_count: number;
  charging_port_count: number;
  one_port_intake: number;
  two_port_intake: number;
}

export interface PtBus {
  bus_id: number; // fleet number, used in trip logs
  plate: string;
  model_id: string;
  model: string;
  model_year: number;
  created_at: string;
  trip_count: number;
  last_trip: string | null;
}

export interface PtManufacturerDetail extends Omit<PtManufacturer, "models" | "bus_count"> {
  models: PtModel[];
  buses: PtBus[];
}

export interface PtNewModel {
  manufacturer: string;
  model: string;
  model_year: number;
  bus_type: string;
  energy_source: PtEnergySource;
  bus_length: number;
  bus_width?: number;
  bus_height?: number;
  curb_weight?: number;
  gvw?: number | null;
  axle_count?: number;
  energy_capacity?: number;
  charging_port_count?: number;
  one_port_intake?: number;
  two_port_intake?: number;
}

// --- PT Operations ---
export type PtSeverity = "critical" | "serious" | "warning" | "info";

export interface PtTripOptions {
  min_date: string | null;
  max_date: string | null;
  trips: number;
  buses: { bus_id: number; label: string; energy: string; model: string | null }[];
  routes: string[];
  issues: { code: string; label: string; severity: PtSeverity }[];
  thresholds: { max_trip_km: number; high_kwh_per_100km: number; high_kg_per_100km: number; low_end_soc: number; low_start_soc: number };
}

/** Which trips: the fleet's (triplog_db) or trial buses' (trial_triplog_db). */
export type PtDataset = "fleet" | "trial";

export interface PtTripFilter {
  from: string;
  to: string;
  bus?: string;
  route?: string;
  energy?: string;
  dataset?: "trial"; // omitted = fleet
  trial?: string; // with dataset "trial": one trial
}

/** energy_used is kWh for battery buses and kg of hydrogen for fuel-cell buses; never add the two. */
export interface PtEnergyTotals {
  energy: string;
  unit: "kWh" | "kg";
  trips: number;
  buses: number;
  distance: number | null;
  energy_used: number | null;
  consumption: number | null; // per 100 km
  /** Hot season (June–September) and the rest of the year. */
  consumption_hot: number | null;
  consumption_mild: number | null;
  distance_hot: number | null;
  distance_mild: number | null;
}

export interface PtOperations {
  totals: {
    trips: number;
    buses: number;
    drivers: number;
    days: number;
    distance: number;
    excluded_trips: number; // impossible distances, left out of distance and energy totals
    avg_soc_drop: number | null;
    min_end_soc: number | null;
    longest_trip: number | null;
  };
  by_energy: PtEnergyTotals[];
  daily: {
    date: string;
    trips: number;
    buses: number;
    distance: number;
    electric_kwh: number | null;
    hydrogen_kg: number | null;
    electric_per_100km: number | null;
    hydrogen_per_100km: number | null;
  }[];
  by_bus: {
    bus_id: number;
    label: string; // fleet number, or a trial bus's own label
    model: string | null;
    manufacturer: string | null;
    energy: string;
    unit: "kWh" | "kg";
    trips: number;
    days: number;
    distance: number;
    energy_used: number | null;
    consumption: number | null;
    consumption_hot: number | null;
    consumption_mild: number | null;
    avg_soc_drop: number | null;
    min_end_soc: number | null;
    exceptions: number;
  }[];
  by_route: {
    route: string;
    trips: number;
    buses: number;
    distance: number;
    avg_trip_km: number | null;
    electric_per_100km: number | null;
    hydrogen_per_100km: number | null;
    electric_hot: number | null;
    electric_mild: number | null;
    hydrogen_hot: number | null;
    hydrogen_mild: number | null;
    avg_soc_drop: number | null;
  }[];
  exceptions: Record<string, number>;
  /** Per exception type: the buses it comes from, most affected first. */
  exception_buses: Record<string, { bus_id: number; label: string; trips: number }[]>;
  /** Months counted as the hot season. */
  hot_months: number[];
  soc_drop_bands: { band: number; trips: number }[];
}

export interface PtTrip {
  trip_id: number;
  date: string;
  driver_id: number | null;
  bus_id: number | null;
  bus_label?: string;
  route: string | null;
  start_time: string | null;
  end_time: string | null;
  start_km: number | null;
  end_km: number | null;
  start_soc: number | null;
  end_soc: number | null;
  distance: number | null;
  soc_drop: number | null;
  energy_used: number | null;
  energy_consumption: number | null;
  energy: string;
  issues: string[];
}

export interface PtUploadSummary {
  file: string;
  rows: number;
  skipped: number;
  skipped_examples: { line: number; reason: string }[];
  date_order: "dmy" | "mdy";
  date_order_detected: "dmy" | "mdy";
  first_date: string | null;
  last_date: string | null;
  days: number;
  unknown_buses: number[];
  extra_columns: string[];
}

export interface PtUploadPreview extends PtUploadSummary {
  would: { new: number; identical: number; conflict: number };
  preview: (Omit<PtTrip, "trip_id" | "energy" | "issues"> & { status: "new" | "identical" | "conflict" })[];
}

export interface PtSaveResult {
  inserted: number;
  identical: number;
  conflicts: number;
}

export interface PtManualTrip {
  start_time: string;
  end_time: string;
  start_km: number;
  end_km: number;
  start_soc: number;
  end_soc: number;
}

// --- PT Trials ---
export type PtTrialStatus = "planned" | "in_progress" | "completed";

export interface PtTrial {
  trial_id: number;
  trial_name: string;
  trial_bus_id: number | null;
  bus_label: string | null;
  model: string | null;
  manufacturer: string | null;
  route: string | null;
  start_date: string | null;
  end_date: string | null;
  load_condition: string | null;
  status: PtTrialStatus;
  notes: string | null;
  created_at: string;
  trips: number;
  distance: number;
  first_trip: string | null;
  last_trip: string | null;
}

export interface PtTrialBus {
  trial_bus_id: number;
  bus_id: string; // the bus's own label
  model_id: string | null;
  model: string | null;
  model_year: number | null;
  manufacturer: string | null;
  energy_source: string | null;
  bus_length: number | null;
  bus_type: string | null;
  status: "active" | "completed" | "promoted";
  notes: string | null;
  promoted_to_bus_id: number | null;
  trials: number;
  trips: number;
  created_at: string;
}

// --- PT Charging ---
export interface PtCharger {
  charger_id: string;
  output_type: string;
  location: string;
  charger_output: number; // kW, whole charger
  one_gun_output: number; // kW when one gun is in use
  two_gun_output: number; // kW per gun when two are in use (0 = not stated)
  guns: number[];
}

export interface PtStation {
  station_id: number;
  station_name: string;
  chargers: PtCharger[];
}

export interface PtDemandBus {
  bus_id: number;
  model: string | null;
  manufacturer: string | null;
  energy: string;
  battery_kwh: number | null;
  max_intake_kw: number | null; // null = not stated
  trips: number;
  distance: number;
  energy_kwh: number | null; // energy used that day
  first_start: string | null;
  last_end: string | null; // when it can start charging
}

export type PtHistoryStat = "avg" | "p85" | "max";
export type PtHistoryWeekdays = "all" | "mon-fri" | "sat-sun";
export type PtAiGoal = "all_charged" | "lowest_peak" | "night_tariff" | "fewest_guns";

export interface PtAiSchedule {
  sessions: { bus_id: number; lane: string; start: number; duration: number }[];
  unplaced: number[];
  notes: string; // DeepSeek's summary of its strategy
  repairs: string[]; // what the server corrected in its plan
  model: string;
  tokens: number;
}

export interface PtChargingDemand {
  date: string; // the operating day, or "typical (from to to)" for a history-based day
  basis?: { from: string; to: string; days: number; weekdays: PtHistoryWeekdays; stat: PtHistoryStat };
  buses: PtDemandBus[];
  not_charged: PtDemandBus[]; // hydrogen and other non-battery buses that ran that day
  days: { date: string; buses: number }[];
}

// --- PT Repair & Maintenance ---
export type PtMaintType = "preventive" | "corrective" | "breakdown" | "inspection" | "accident" | "warranty";
export type PtMaintStatus = "open" | "in_progress" | "waiting_parts" | "completed" | "cancelled";
export type PtMaintPriority = "low" | "normal" | "high" | "critical";

export interface PtMaintOptions {
  currency: string;
  buses: { bus_id: number; model: string; model_id: string; manufacturer: string | null; odometer_km: number | null; last_trip: string | null }[];
  models: { model_id: string; label: string }[];
  types: PtMaintType[];
  statuses: PtMaintStatus[];
  priorities: PtMaintPriority[];
  categories: { code: string; label: string }[];
  workshops: string[]; // manufacturers' names: work orders are done by the manufacturer's workshop
  plans: { plan_id: number; name: string; model_id: string | null }[];
  min_date: string | null;
  max_date: string | null;
  records: number;
}

export interface PtMaintRecord {
  record_id: number;
  bus_id: number;
  model: string | null;
  plan_id: number | null;
  plan_name: string | null;
  type: PtMaintType;
  category: string;
  title: string;
  description: string | null;
  closing_note: string | null;
  priority: PtMaintPriority;
  status: PtMaintStatus;
  reported_date: string;
  completed_date: string | null; // closing date
  odometer_km: number | null;
  downtime_hours: number | null;
  labour_hours: number | null;
  parts_cost: number | null;
  labour_cost: number | null;
  total_cost: number | null;
  workshop: string | null;
  source: string | null; // "access" when imported
  external_ref: string | null; // work-order number in the export ("auto:…" when it had none)
}

export interface PtMaintGroup {
  key: string | number;
  records: number;
  cost: number;
  parts: number;
  labour: number;
  downtime_hours: number;
  failures: number;
  km?: number;
  availability?: number;
}

export interface PtMaintenance {
  records: PtMaintRecord[]; // reported in the range, plus every open one
  totals: {
    open: number;
    reported: number;
    completed: number;
    failures: number; // corrective + breakdown
    cost: number;
    parts: number;
    labour: number;
    downtime_hours: number;
    availability: number | null; // % of bus-hours not lost to downtime
    km: number;
    cost_per_km: number | null;
    failures_per_10k_km: number | null;
    fleet_size: number;
  };
  by_month: PtMaintGroup[];
  by_category: PtMaintGroup[];
  by_type: PtMaintGroup[];
  by_bus: PtMaintGroup[];
  repeat_failures: { bus_id: number; category: string; count: number }[];
}

export interface PtMaintPlan {
  plan_id: number;
  name: string;
  model_id: string | null;
  model: string | null;
  category: string;
  interval_km: number | null;
  interval_days: number | null;
  notes: string | null;
  active: boolean;
}

export interface PtPlanDue {
  plan_id: number;
  plan: string;
  category: string;
  bus_id: number;
  model: string;
  last_done: string | null;
  last_km: number | null;
  odometer_km: number | null;
  due_km: number | null;
  km_left: number | null;
  due_date: string | null;
  days_left: number | null;
  state: "overdue" | "due_soon" | "never_done" | "ok";
}

export type PtMaintInput = Partial<Omit<PtMaintRecord, "record_id" | "model" | "plan_name" | "total_cost" | "source" | "external_ref">>;

export interface PtMaintImport {
  file: string;
  headers: string[];
  total_rows: number;
  sample: unknown[][];
  remembered: boolean; // this file layout was imported before; its mapping was reused
  columns: Record<string, string>; // field → column header
  value_maps: Record<string, { value: string; rows: number; maps_to: string | null }[]>;
  date_order: "dmy" | "mdy";
  date_order_detected: "dmy" | "mdy";
  fields: { field: string; label: string; required: boolean }[];
  ready: boolean;
  missing: string[];
  rows?: number;
  skipped?: number;
  skipped_examples?: { line: number; reason: string }[];
  would?: { new: number; update: number; unchanged: number };
  preview?: (PtMaintInput & { external_ref: string; import_status: "new" | "update" | "unchanged" })[];
  inserted?: number;
  updated?: number;
  unchanged?: number;
}

export interface PtDuplicate {
  id: number;
  entry_key: string;
  source_file: string | null;
  detected_at: string;
  incoming: Record<string, unknown> | null;
  existing: Record<string, unknown> | null;
}

export interface TranslateResult {
  id: number;
  translation: string;
  model: string;
  usage: { input_tokens: number; output_tokens: number };
}

// Transcripts can be in any language: `language` is an ISO 639-1 code where known ("ar", "en", ...),
// and `english` is null when the speech was already English.

export interface UploadResult {
  id: number;
  transcript_id?: number;
  text?: string;
  language?: string | null;
  english?: string | null;
  transcribe_error?: string; // the file was saved; transcription can be retried
  translate_error?: string; // the transcript was saved; translation can be retried
  audio_removed?: RemovedAudio[]; // older audio removed to stay within the storage allowance
  storage?: StorageInfo;
}

export interface TranscribeResult {
  transcript_id: number;
  text: string;
  language: string | null;
}

export interface TranslateTranscriptResult {
  transcript_id: number;
  language: string | null;
  english: string | null;
}

export interface LiveSession {
  recording_id: number;
  transcript_id: number;
}

export interface LiveChunkResult {
  seq: number;
  text: string; // empty when the chunk held no speech
  language: string | null;
  english: string | null;
  translate_error?: string;
}

export interface LiveFinishResult {
  id: number;
  transcript_id: number;
  text: string;
  english: string | null;
  language: string | null;
  audio_removed?: RemovedAudio[];
  storage?: StorageInfo;
}

/** Meeting mode: one speaker turn of a live chunk. */
export interface MeetingTurn {
  part: number;
  speaker: string; // "Speaker 1"...
  name: string | null; // the name given to that speaker
  text: string;
  start_ms: number;
}
export interface MeetingSpeaker {
  label: string;
  name: string | null;
  has_sample: boolean; // a voice sample is kept, so later chunks recognise them
}
export interface MeetingChunkResult {
  seq: number;
  turns: MeetingTurn[];
  speakers: MeetingSpeaker[];
}
export interface MeetingTranslation {
  language: string | null;
  english: { seq: number; part: number; english: string | null }[];
}

/** Daily Feed (see server/src/Feed.php). */
export interface FeedTopic {
  id: number;
  topic: string;
  include_zh: number | boolean; // Chinese-language news too
  effective_from: string; // first feed date that includes it
}
export interface FeedItem {
  rank: number;
  topic: string;
  lang: string; // "en", or "zh" for a Chinese report (title is then the English translation)
  title: string;
  title_original: string | null; // the headline as published, when not English
  summary: string | null; // a short paragraph, in the article's language
  key_points: string[];
  url: string;
  publisher: string;
  published_at: string | null;
  sources: number; // outlets that reported it (2+ = verified)
  source_list: string[];
}
export interface Feed {
  id: number;
  feed_key: string;
  title: string;
  topics: string[];
  status: "ready" | "failed";
  error: string | null;
  created_at: string;
  items: FeedItem[];
}
export interface FeedResponse {
  date: string;
  today: string;
  plan: "combined" | "per_topic";
  can_go_back: boolean; // earlier days' feeds (paid plan)
  feeds: Feed[];
  dates: string[];
  topics: FeedTopic[];
}
export interface FeedStatus {
  date: string;
  ready: number;
  topics_due: number;
  after_8: boolean;
}

export interface Recording {
  id: number;
  kind: "recording" | "meeting";
  title: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  duration_sec: number | null;
  recorded_at: string | null;
  created_at: string;
  has_audio: boolean;
  audio_removed_at: string | null; // audio removed to stay within the storage allowance
  transcript_id: number | null;
  language: string | null;
  source_text: string | null;
  translated_text: string | null;
}

export interface Transcript {
  id: number;
  recording_id: number | null;
  language: string;
  source_text: string;
  translated_text: string | null; // null until translated
  translate_provider: string | null;
  translate_model: string | null;
  created_at: string;
}

export type UsageGroup = "day" | "month" | "model";

/** "providers": what Anthropic/OpenAI report (synced), DeepSeek from this app, plus manual entries. "app": this app only. */
export type UsageView = "providers" | "app";

export interface ProviderSyncStatus {
  can_sync: boolean; // an admin key is configured
  key_setting: string;
  synced_at: string | null;
  range_from: string | null;
  range_to: string | null;
  rows_imported: number;
  last_error: string | null;
}

export interface DeepSeekStatus {
  can_sync: false;
  note: string;
  available?: boolean;
  balance?: { currency: string; total: string; granted: string; topped_up: string }[];
  balance_error?: string;
}

export interface UsageProviders {
  anthropic: ProviderSyncStatus;
  openai: ProviderSyncStatus;
  deepseek: DeepSeekStatus;
}

export interface UsageSyncResult {
  from: string;
  to: string;
  results: Partial<Record<Provider, { ok: boolean; rows?: number; error?: string; skipped?: string }>>;
}

export interface UsageRow {
  bucket: string;
  provider: UsageSource;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  audio_seconds: number;
  cost_usd: number | null; // null when no price is configured for the model
}

export interface UsageSummary {
  from: string;
  to: string;
  rows: UsageRow[];
}

export interface ManualUsage {
  provider: Provider;
  model: string;
  input_tokens: number;
  output_tokens: number;
  note?: string;
  occurred_at?: string;
}

export interface AiRoute {
  provider: Provider;
  model: string | null;
}

export interface AiRouting {
  translate: AiRoute;
  transcribe: AiRoute;
  light: AiRoute;
  charging: AiRoute; // PT charging AI schedule
  habits_zh: AiRoute; // learning from transcript edits, Chinese
  habits_other: AiRoute; // ... every other language
}

/** What's been learned from the user's transcript edits: rules per language group, and edits not learned yet. */
export type HabitGroup = "zh" | "other";
export interface TranscriptHabits {
  rules: Record<HabitGroup, string[]>;
  pending: number;
}
export interface LearnResult extends TranscriptHabits {
  learned: number;
  errors: string[];
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface Config {
  baseUrl: string;
  token: string | null;
  onUnauthorized: () => void;
  /** The Super Admin viewing the app as another account (sent as X-View-As / X-View-As-Role); in memory only. */
  viewAs: { userId: number; role: string | null } | null;
}

const config: Config = { baseUrl: "", token: null, onUnauthorized: () => {}, viewAs: null };

export function configureApi(next: Partial<Config>) {
  Object.assign(config, next);
}

export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/** `asSelf`: as the Super Admin's own account even while viewing as someone else. */
async function request<T>(method: string, path: string, body?: unknown, baseUrl = config.baseUrl, asSelf = false): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (config.token) headers.Authorization = `Bearer ${config.token}`;
  if (config.viewAs && !asSelf) {
    headers["X-View-As"] = String(config.viewAs.userId);
    if (config.viewAs.role) headers["X-View-As-Role"] = config.viewAs.role;
  }

  let payload: BodyInit | undefined;
  if (body instanceof FormData) {
    payload = body; // fetch sets the multipart boundary
  } else if (body !== undefined) {
    headers["Content-Type"] = "application/json; charset=utf-8";
    payload = JSON.stringify(body);
  }

  let res: Response;
  try {
    res = await fetch(`${baseUrl}${path}`, { method, headers, body: payload });
  } catch (e) {
    throw new ApiError(0, `Can't reach the server at ${baseUrl}. Is it running, and is the address right? (${e})`);
  }

  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // Apache error pages and PHP fatals arrive as HTML
  }

  if (!res.ok) {
    const message =
      data && typeof data === "object" && "error" in data
        ? String((data as { error: unknown }).error)
        : `HTTP ${res.status} from ${path}`;
    if (res.status === 401 && config.token) config.onUnauthorized();
    throw new ApiError(res.status, message);
  }
  if (data === null) {
    throw new ApiError(res.status, `Unexpected non-JSON response from ${path}. Check the server address.`);
  }
  return data as T;
}

/** A file download (e.g. a recording's audio): its bytes and the server's file name. */
async function download(path: string): Promise<{ bytes: Uint8Array; name: string }> {
  const headers: Record<string, string> = {};
  if (config.token) headers.Authorization = `Bearer ${config.token}`;
  if (config.viewAs) {
    headers["X-View-As"] = String(config.viewAs.userId);
    if (config.viewAs.role) headers["X-View-As-Role"] = config.viewAs.role;
  }
  const res = await fetch(`${config.baseUrl}${path}`, { method: "GET", headers });
  if (!res.ok) {
    let message = `HTTP ${res.status} from ${path}`;
    try {
      message = String((JSON.parse(await res.text()) as { error?: string }).error ?? message);
    } catch {
      // not JSON
    }
    throw new ApiError(res.status, message);
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "recording";
  return { bytes: new Uint8Array(await res.arrayBuffer()), name };
}

function tripQuery(f: object): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  return q.toString();
}

/** One driver on one bus. km / energy_used count only trips with a usable distance and energy reading (valid_trips). */
export interface PtDriverBus {
  driver_id: string;
  bus_id: string;
  model_id: string | null;
  model: string;
  energy: string;
  unit: "kWh" | "kg";
  trips: number;
  days: number;
  a_trips: number;
  b_trips: number;
  km: number | null;
  energy_used: number | null;
  valid_trips: number;
  /** Valid trips in the hot season (June–September) and in the rest of the year. */
  hot: PtSeasonEnergy;
  mild: PtSeasonEnergy;
  first_date: string;
  last_date: string;
}

export interface PtSeasonEnergy {
  km: number;
  energy_used: number;
  valid_trips: number;
}

/** One driver across all buses. Each bus-day is split at the driver handover (else in half; a lone trip by start time). */
export interface PtDriverShift {
  driver_id: string;
  trips: number;
  days: number;
  a_trips: number;
  b_trips: number;
  a_days: number;
  b_days: number;
  first_date: string;
  last_date: string;
}

export interface PtDrivers {
  from: string;
  to: string;
  min_date: string;
  max_date: string;
  /** How the bus-days in range were split into shifts. */
  shift_basis: { driver_change: number; halves: number; single: number };
  hot_months: number[];
  rows: PtDriverBus[];
  drivers: PtDriverShift[];
}

/** Where uploaded or entered trips go: the fleet, or one trial. */
export type PtTripTarget = { dataset?: undefined } | { dataset: "trial"; trial: number };

function uploadForm(file: File, action: string, dateOrder?: string, target?: PtTripTarget): FormData {
  const form = new FormData();
  form.append("file", file);
  form.append("action", action);
  if (target?.dataset === "trial") {
    form.append("dataset", "trial");
    form.append("trial", String(target.trial));
  }
  if (dateOrder) form.append("date_order", dateOrder);
  return form;
}

const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

export const api = {
  health: (baseUrl: string) => request<{ ok: boolean; time: string }>("GET", "/health", undefined, baseUrl),

  /** `login` is an email address or a username. */
  login: (baseUrl: string, login: string, password: string, device: string) =>
    request<{ token: string; user: User }>("POST", "/auth/login", { login, password, device }, baseUrl),

  logout: () => request<{ ok: boolean }>("POST", "/auth/logout"),

  me: () => request<User>("GET", "/auth/me"),

  /** Your own display name; empty clears it. Returns the updated user. */
  updateProfile: (displayName: string) => request<User>("POST", "/auth/profile", { display_name: displayName }),

  /** Act in another of your roles on this sign-in; returns the user as that role. */
  setRole: async (role: string) => {
    const user = await request<User>("POST", "/auth/role", { role });
    if (config.viewAs) config.viewAs.role = role; // viewing as someone: the role is kept here, not on the server
    return user;
  },

  /** Super Admin: view the app as another account (null: back to your own). Returns who you now are. */
  viewAs: async (userId: number | null): Promise<User> => {
    const previous = config.viewAs;
    config.viewAs = userId === null ? null : { userId, role: null };
    try {
      return await request<User>("GET", "/auth/me");
    } catch (e) {
      config.viewAs = previous;
      throw e;
    }
  },
  /** Accounts the Super Admin can view as (asked as the Super Admin, even while viewing as someone). */
  viewableUsers: async (): Promise<ManagedUser[]> =>
    (await request<ManagedUser[]>("GET", "/users", undefined, config.baseUrl, true)).filter((u) => u.account_role !== "super_admin" && !u.disabled),

  /** Changes your password; the server then signs out every device, this one too. */
  changePassword: (current: string, next: string) =>
    request<{ ok: boolean; signed_out?: boolean }>("POST", "/auth/password", { current, new: next }),
  devices: () => request<Device[]>("GET", "/auth/devices"),
  signOutDevice: (id: number) => request<Device[]>("DELETE", `/auth/devices/${id}`),
  signOutOtherDevices: () => request<Device[]>("POST", "/auth/devices/sign-out-others"),
  /** The activity log (Super Admin: everyone; Admins: accounts below Admin). */
  activity: (f: { user?: number; from?: string; to?: string; limit?: number; offset?: number }) =>
    request<{ total: number; rows: ActivityEntry[] }>("GET", `/activity?${tripQuery(f)}`),

  // Owner only.
  users: () => request<ManagedUser[]>("GET", "/users"),

  createUser: (u: { username?: string; email?: string; display_name?: string; password: string } & UserGroups) =>
    request<{ id: number }>("POST", "/users", u),

  updateUser: (id: number, patch: { display_name?: string; disabled?: boolean; password?: string } & UserGroups) =>
    request<{ ok: boolean }>("POST", `/users/${id}`, patch),

  ptStatus: () => request<PtStatus>("GET", "/pt/status"),

  // PT Fleet. Adding needs edit access, removing needs admin; removed rows go to the removed_* archive tables.
  ptManufacturers: () => request<PtManufacturer[]>("GET", "/pt/manufacturers"),
  ptManufacturer: (key: string) => request<PtManufacturerDetail>("GET", `/pt/manufacturers/${encodeURIComponent(key)}`),
  ptAddManufacturer: (m: { manufacturer: string; display_name?: string; category: string }) =>
    request<{ manufacturer: string }>("POST", "/pt/manufacturers", m),
  ptAddModel: (m: PtNewModel) => request<{ model_id: string }>("POST", "/pt/models", m),
  ptAddBus: (b: { model_id: string; bus_id?: number; plate?: string }) => request<{ bus_id: number }>("POST", "/pt/buses", b),
  ptSetPlate: (busId: number, plate: string) => request<{ ok: boolean }>("POST", `/pt/buses/${busId}`, { plate }),
  ptRemoveBus: (busId: number) => request<{ ok: boolean }>("DELETE", `/pt/buses/${busId}`),
  ptRemoveModel: (modelId: string) => request<{ ok: boolean }>("DELETE", `/pt/models/${encodeURIComponent(modelId)}`),
  ptRemoveManufacturer: (key: string) =>
    request<{ ok: boolean; models: number; buses: number }>("DELETE", `/pt/manufacturers/${encodeURIComponent(key)}`),

  // PT Operations. Uploading and entering trips need edit access; resolving duplicates needs admin.
  ptTripOptions: (dataset: PtDataset = "fleet") =>
    request<PtTripOptions>("GET", `/pt/trips/options${dataset === "trial" ? "?dataset=trial" : ""}`),
  ptOperations: (f: PtTripFilter) => request<PtOperations>("GET", `/pt/operations?${tripQuery(f)}`),
  ptTrips: (f: PtTripFilter & { issue?: string; limit?: number; offset?: number }) =>
    request<{ total: number; rows: PtTrip[] }>("GET", `/pt/trips?${tripQuery(f)}`),
  ptUploadPreview: (file: File, dateOrder?: "dmy" | "mdy", target?: PtTripTarget) =>
    request<PtUploadPreview>("POST", "/pt/trips/upload", uploadForm(file, "preview", dateOrder, target)),
  ptUploadImport: (file: File, dateOrder?: "dmy" | "mdy", target?: PtTripTarget) =>
    request<PtUploadSummary & PtSaveResult>("POST", "/pt/trips/upload", uploadForm(file, "import", dateOrder, target)),
  ptAddTrips: (t: { date: string; driver_id: number; bus_id?: number; route: string; trips: PtManualTrip[] } & PtTripTarget) =>
    request<PtSaveResult>("POST", "/pt/trips", t),

  // PT Drivers: who drove which bus / model / shift, and consumption per driver per bus.
  ptDrivers: (f: { from?: string; to?: string }) => request<PtDrivers>("GET", `/pt/drivers?${tripQuery(f)}`),

  // PT Trials (edit access to add / change).
  ptTrials: () => request<PtTrial[]>("GET", "/pt/trials"),
  ptAddTrial: (t: { trial_name: string; trial_bus_id: number; route?: string; start_date: string; end_date?: string; load_condition?: string; notes?: string }) =>
    request<{ trial_id: number }>("POST", "/pt/trials", t),
  ptUpdateTrial: (id: number, patch: { status?: PtTrialStatus; end_date?: string; route?: string; load_condition?: string; notes?: string }) =>
    request<{ ok: boolean }>("POST", `/pt/trials/${id}`, patch),
  ptTrialBuses: () => request<PtTrialBus[]>("GET", "/pt/trial-buses"),
  ptAddTrialBus: (b: { bus_id: string; model_id: string; notes?: string }) => request<{ trial_bus_id: number }>("POST", "/pt/trial-buses", b),
  ptPromoteTrialBus: (id: number, fleetBusId: number, plate?: string) =>
    request<{ bus_id: number }>("POST", `/pt/trial-buses/${id}/promote`, { fleet_bus_id: fleetBusId, plate }),

  // PT Repair & Maintenance (edit access adds and changes, admin deletes).
  ptMaintOptions: () => request<PtMaintOptions>("GET", "/pt/maintenance/options"),
  ptMaintenance: (f: { from: string; to: string; bus?: string; type?: string; category?: string; status?: string }) =>
    request<PtMaintenance>("GET", `/pt/maintenance?${tripQuery(f)}`),
  ptAddMaint: (m: PtMaintInput) => request<{ record_id: number }>("POST", "/pt/maintenance", m),
  ptUpdateMaint: (id: number, m: PtMaintInput) => request<{ ok: boolean }>("POST", `/pt/maintenance/${id}`, m),
  /** Closes a work order when the workshop reports back. */
  ptCloseMaint: (
    id: number,
    c: { closed_date: string; outcome: "completed" | "cancelled"; downtime_hours?: number | ""; labour_hours?: number | ""; parts_cost?: number | ""; labour_cost?: number | ""; closing_note?: string },
  ) => request<{ ok: boolean }>("POST", `/pt/maintenance/${id}/close`, c),
  /** Access export: preview (default) or import, with optional column and value mappings. */
  ptImportMaint: (file: File, action: "preview" | "import", opts: { columns?: Record<string, string>; values?: Record<string, Record<string, string | null>>; dateOrder?: "dmy" | "mdy" } = {}) => {
    const form = new FormData();
    form.append("file", file);
    form.append("action", action);
    if (opts.columns) form.append("columns", JSON.stringify(opts.columns));
    if (opts.values) form.append("values", JSON.stringify(opts.values));
    if (opts.dateOrder) form.append("date_order", opts.dateOrder);
    return request<PtMaintImport>("POST", "/pt/maintenance/import", form);
  },
  ptReopenMaint: (id: number) => request<{ ok: boolean }>("POST", `/pt/maintenance/${id}/reopen`),
  ptDeleteMaint: (id: number) => request<{ ok: boolean }>("DELETE", `/pt/maintenance/${id}`),
  ptMaintPlans: () => request<{ plans: PtMaintPlan[]; due: PtPlanDue[] }>("GET", "/pt/maintenance/plans"),
  ptAddMaintPlan: (p: { name: string; category: string; model_id?: string; interval_km?: number; interval_days?: number; notes?: string }) =>
    request<{ plan_id: number }>("POST", "/pt/maintenance/plans", p),
  ptSetMaintPlanActive: (id: number, active: boolean) => request<{ ok: boolean }>("POST", `/pt/maintenance/plans/${id}`, { active }),
  ptDeleteMaintPlan: (id: number) => request<{ ok: boolean }>("DELETE", `/pt/maintenance/plans/${id}`),

  // PT Charging (edit access adds, admin removes).
  ptChargingAssets: () => request<PtStation[]>("GET", "/pt/charging/assets"),
  ptAddStation: (name: string) => request<{ station_id: number }>("POST", "/pt/charging/stations", { station_name: name }),
  ptRemoveStation: (id: number) => request<{ ok: boolean }>("DELETE", `/pt/charging/stations/${id}`),
  ptAddCharger: (c: {
    station_id: number;
    charger_id: string;
    location?: string;
    output_type: "DC" | "AC";
    gun_count: number;
    charger_output: number;
    one_gun_output: number;
    two_gun_output?: number;
  }) => request<{ ok: boolean }>("POST", "/pt/charging/chargers", c),
  ptRemoveCharger: (stationId: number, chargerId: string) =>
    request<{ ok: boolean }>("DELETE", `/pt/charging/stations/${stationId}/chargers/${encodeURIComponent(chargerId)}`),
  /** A typical day from each electric bus's last `days` days of trips. */
  ptChargingHistory: (q: { days: number; weekdays: PtHistoryWeekdays; stat: PtHistoryStat; end?: string }) =>
    request<PtChargingDemand>("GET", `/pt/charging/history?${tripQuery(q)}`),
  /** DeepSeek proposes sessions for the simulation as it stands (times: minutes on the 19:00 window). Edit access. */
  ptAiSchedule: (body: {
    lanes: { key: string; label: string; charger: string; one_gun: number; two_gun: number }[];
    buses: { bus_id: number; required_kwh: number; available: number; deadline: number | null; max_intake_kw: number | null }[];
    buffer: number;
    goal: PtAiGoal;
    instructions: string;
  }) => request<PtAiSchedule>("POST", "/pt/charging/ai-schedule", body),
  ptChargingDemand: (date?: string) => request<PtChargingDemand>("GET", `/pt/charging/demand${date ? `?date=${date}` : ""}`),
  ptDuplicates: () => request<PtDuplicate[]>("GET", "/pt/trips/duplicates"),
  ptResolveDuplicate: (id: number, action: "keep" | "replace") => request<{ ok: boolean }>("POST", `/pt/trips/duplicates/${id}`, { action }),

  // Providers are routed on the server (translation: Claude, transcription: OpenAI, light tasks: DeepSeek).
  routing: () => request<AiRouting>("GET", "/ai/routing"),

  translate: (text: string, model?: string) =>
    request<TranslateResult>("POST", "/ai/translate", { text, ...(model ? { model } : {}) }),

  uploadRecording: (
    audio: Blob,
    fileName: string,
    opts: { title?: string; recordedAt?: string; transcribe?: boolean },
  ) => {
    const form = new FormData();
    form.append("audio", audio, fileName);
    if (opts.title) form.append("title", opts.title);
    if (opts.recordedAt) form.append("recorded_at", opts.recordedAt);
    if (opts.transcribe) form.append("transcribe", "1"); // also translates non-English speech
    return request<UploadResult>("POST", "/recordings", form);
  },

  liveStart: (title?: string, recordedAt?: string) =>
    request<LiveSession>("POST", "/live", {
      ...(title ? { title } : {}),
      ...(recordedAt ? { recorded_at: recordedAt } : {}),
    }),

  liveChunk: (recordingId: number, chunk: { seq: number; startMs: number; wav: Blob }, prompt?: string) => {
    const form = new FormData();
    form.append("audio", chunk.wav, `chunk-${chunk.seq}.wav`);
    form.append("seq", String(chunk.seq));
    form.append("start_ms", String(chunk.startMs));
    if (prompt) form.append("prompt", prompt);
    return request<LiveChunkResult>("POST", `/live/${recordingId}/chunk`, form);
  },

  feed: (date?: string) => request<FeedResponse>("GET", `/feed${date ? `?date=${date}` : ""}`),
  addFeedTopic: (topic: string) => request<FeedTopic[]>("POST", "/feed/topics", { topic }),
  removeFeedTopic: (id: number) => request<FeedTopic[]>("DELETE", `/feed/topics/${id}`),
  setFeedTopicChinese: (id: number, on: boolean) => request<FeedTopic[]>("POST", `/feed/topics/${id}`, { include_zh: on }),
  feedStatus: () => request<FeedStatus>("GET", "/feed/status"),
  generateFeed: (force = false) => request<{ built: number }>("POST", "/feed/generate", { force }),

  /** Meeting mode (paid): like live recording, with speaker labels; the whole audio is saved with liveFinish. */
  meetingStart: (title?: string, recordedAt?: string) =>
    request<LiveSession>("POST", "/meetings", { ...(title ? { title } : {}), ...(recordedAt ? { recorded_at: recordedAt } : {}) }),
  meetingChunk: (recordingId: number, chunk: { seq: number; startMs: number; wav: Blob }) => {
    const form = new FormData();
    form.append("audio", chunk.wav, `chunk-${chunk.seq}.wav`);
    form.append("seq", String(chunk.seq));
    form.append("start_ms", String(chunk.startMs));
    return request<MeetingChunkResult>("POST", `/meetings/${recordingId}/chunk`, form);
  },
  meetingTranslate: (recordingId: number, seq?: number) =>
    request<MeetingTranslation>("POST", `/meetings/${recordingId}/translate`, seq === undefined ? {} : { seq }),
  meetingSpeakers: (recordingId: number) => request<MeetingSpeaker[]>("GET", `/meetings/${recordingId}/speakers`),
  renameSpeaker: (recordingId: number, label: string, name: string) =>
    request<MeetingSpeaker[]>("POST", `/meetings/${recordingId}/speakers`, { label, name }),

  liveFinish: (recordingId: number, audio: Blob, fileName: string, durationSec: number) => {
    const form = new FormData();
    form.append("audio", audio, fileName);
    form.append("duration_sec", durationSec.toFixed(2));
    return request<LiveFinishResult>("POST", `/live/${recordingId}/finish`, form);
  },

  transcribeRecording: (recordingId: number) => request<TranscribeResult>("POST", `/recordings/${recordingId}/transcribe`),

  translateTranscript: (transcriptId: number, model?: string) =>
    request<TranslateTranscriptResult>("POST", `/transcripts/${transcriptId}/translate`, model ? { model } : {}),

  recordingStorage: () => request<StorageInfo>("GET", "/recordings/storage"),
  /** A recording's audio, to save on this device. */
  recordingAudio: (id: number) => download(`/recordings/${id}/audio`),
  /** Rename one of your recordings. */
  renameRecording: (id: number, title: string) => request<{ ok: boolean }>("POST", `/recordings/${id}`, { title }),
  /** Delete one of your recordings, with its audio and transcripts. */
  deleteRecording: (id: number) => request<{ ok: boolean }>("DELETE", `/recordings/${id}`),
  /** Edit a transcript or translation; `learn`: a changed original was kept to learn from (call learnHabits). */
  updateTranscript: (id: number, patch: { source_text?: string; translated_text?: string }) =>
    request<{ ok: boolean; learn: boolean }>("POST", `/transcripts/${id}`, patch),
  deleteTranscript: (id: number) => request<{ ok: boolean }>("DELETE", `/transcripts/${id}`),
  habits: () => request<TranscriptHabits>("GET", "/transcripts/habits"),
  setHabits: (group: HabitGroup, rules: string[]) => request<TranscriptHabits>("POST", "/transcripts/habits", { group, rules }),
  learnHabits: () => request<LearnResult>("POST", "/transcripts/learn"),

  recordings: async (): Promise<Recording[]> =>
    (await request<Recording[]>("GET", "/recordings")).map((r) => ({
      ...r,
      id: num(r.id),
      size_bytes: num(r.size_bytes),
      has_audio: Boolean(Number(r.has_audio)),
      duration_sec: r.duration_sec === null ? null : num(r.duration_sec),
      transcript_id: r.transcript_id === null ? null : num(r.transcript_id),
    })),

  transcripts: async (): Promise<Transcript[]> =>
    (await request<Transcript[]>("GET", "/transcripts")).map((t) => ({
      ...t,
      id: num(t.id),
      recording_id: t.recording_id === null ? null : num(t.recording_id),
    })),

  usageSummary: async (from: string, to: string, group: UsageGroup, view: UsageView = "providers"): Promise<UsageSummary> => {
    const q = new URLSearchParams({ from, to, group, view });
    const s = await request<UsageSummary>("GET", `/usage/summary?${q}`);
    return {
      ...s,
      rows: s.rows.map((r) => ({
        ...r,
        requests: num(r.requests),
        input_tokens: num(r.input_tokens),
        output_tokens: num(r.output_tokens),
        cache_read_tokens: num(r.cache_read_tokens),
        audio_seconds: num(r.audio_seconds),
        cost_usd: r.cost_usd === null ? null : num(r.cost_usd),
      })),
    };
  },

  addUsage: (entry: ManualUsage) => request<{ ok: boolean }>("POST", "/usage", entry),

  usageProviders: () => request<UsageProviders>("GET", "/usage/providers"),

  syncUsage: (from?: string, to?: string) =>
    request<UsageSyncResult>("POST", "/usage/sync", { ...(from ? { from } : {}), ...(to ? { to } : {}) }),
};

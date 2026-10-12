// Charging simulation model (no UI): lanes, sessions, automatic scheduling and delivered energy.
// Ported from ptManagement's electricBusChargingSimulation.js, with these changes:
//   - only battery-electric buses (the original also scheduled hydrogen buses, reading kg of H2 as kWh);
//   - a bus's maximum intake (model one_port_intake, when stated) caps the gun's output;
//   - buses are scheduled in the order they come off service, each in the lane where it can start earliest;
//   - each session knows when the bus is next needed (its usual first departure) so late finishes are flagged.
//
// Time is minutes on a 24 h window starting 19:00 (0 = 19:00 today, 1440 = 19:00 tomorrow).
import type { PtDemandBus, PtStation } from "../../lib/api";

export const WINDOW_START = 19 * 60;
export const DAY = 1440;
export const SNAP = 10;
export const TURNAROUND = 30; // minutes from the last trip ending to plugging in
export const BUFFER = 15; // minutes between sessions on the same gun
/** Window minute of 12:00. Last trips ending after this (and before 19:00) finished their day before the window. */
const DAY_SHIFT_END = DAY - 7 * 60;

export interface Lane {
  key: string; // stationId/chargerId/gunId
  stationId: number;
  stationName: string;
  chargerId: string;
  gunId: number;
  oneGun: number; // kW, gun alone on its charger
  twoGun: number; // kW per gun when both are in use
}

export interface Session {
  busId: number;
  lane: string;
  start: number;
  duration: number;
}

export interface BusNeed {
  bus: PtDemandBus;
  requiredKwh: number; // from the grid: (energy used + reserve) / efficiency
  available: number; // earliest plug-in time on the window
  deadline: number | null; // usual first departure next morning, on the window
}

export interface SessionResult {
  deliveredKwh: number;
  segments: { start: number; end: number; shared: boolean }[];
  late: boolean; // still charging after the bus is next needed
}

export const snap = (m: number) => Math.round(m / SNAP) * SNAP;

/**
 * What-if values for one simulation, never saved: per-charger outputs, per-bus maximum intake and the timing rules.
 * Anything left out uses the stored asset data and the defaults above.
 */
export interface Adjustments {
  chargers: Record<string, { oneGun?: number; twoGun?: number }>; // key: stationId/chargerId
  intake: Record<number, number | null>; // bus → kW (null: no limit)
  turnaround?: number;
  buffer?: number;
}

export const NO_ADJUSTMENTS: Adjustments = { chargers: {}, intake: {} };

export const chargerKey = (l: { stationId: number; chargerId: string }) => `${l.stationId}/${l.chargerId}`;

export function isAdjusted(a: Adjustments): boolean {
  return Object.keys(a.chargers).length > 0 || Object.keys(a.intake).length > 0 || a.turnaround !== undefined || a.buffer !== undefined;
}

export function adjustLanes(lanes: Lane[], a: Adjustments): Lane[] {
  return lanes.map((l) => {
    const c = a.chargers[chargerKey(l)];
    return c ? { ...l, oneGun: c.oneGun ?? l.oneGun, twoGun: c.twoGun ?? l.twoGun } : l;
  });
}

export function adjustBuses(buses: PtDemandBus[], a: Adjustments): PtDemandBus[] {
  return buses.map((b) => (b.bus_id in a.intake ? { ...b, max_intake_kw: a.intake[b.bus_id] } : b));
}

/** "HH:MM[:SS]" → minutes on the window. */
export function toWindow(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return (h * 60 + m - WINDOW_START + DAY) % DAY;
}

/** Minutes on the window → "HH:MM". */
export function clock(t: number): string {
  const c = (((WINDOW_START + Math.round(t)) % DAY) + DAY) % DAY;
  return `${String(Math.floor(c / 60)).padStart(2, "0")}:${String(c % 60).padStart(2, "0")}`;
}

export function lanesFrom(stations: PtStation[]): Lane[] {
  return stations.flatMap((s) =>
    s.chargers.flatMap((c) =>
      c.guns.map((g) => ({
        key: `${s.station_id}/${c.charger_id}/${g}`,
        stationId: s.station_id,
        stationName: s.station_name,
        chargerId: c.charger_id,
        gunId: g,
        oneGun: c.one_gun_output,
        twoGun: c.two_gun_output || c.one_gun_output,
      })),
    ),
  );
}

export function needsFor(buses: PtDemandBus[], reserveKwh: number, efficiency: number, turnaround = TURNAROUND): BusNeed[] {
  return buses
    .filter((b) => b.energy_kwh !== null)
    .map((b) => {
      const lastEnd = b.last_end ? toWindow(b.last_end) : 0;
      return {
        bus: b,
        requiredKwh: ((b.energy_kwh ?? 0) + reserveKwh) / Math.max(0.01, efficiency),
        // A last trip ending 12:00–19:00 means the bus is back before the night window opens: it can plug in at 19:00.
        available: lastEnd >= DAY_SHIFT_END ? 0 : Math.min(DAY, snap(lastEnd + turnaround)),
        // A departure before the plug-in time on the window means the next morning's run.
        deadline: b.first_start ? toWindow(b.first_start) : null,
      };
    });
}

const chargerOf = (laneKey: string) => laneKey.slice(0, laneKey.lastIndexOf("/"));

/** Greedy first schedule. Returns sessions and the buses that didn't fit before 19:00 the next day. */
export function autoSchedule(needs: BusNeed[], lanes: Lane[], buffer = BUFFER): { sessions: Session[]; unplaced: number[] } {
  const booked = new Map<string, { start: number; end: number }[]>();
  const sessions: Session[] = [];
  const unplaced: number[] = [];
  for (const n of [...needs].sort((a, b) => a.available - b.available || a.bus.bus_id - b.bus.bus_id)) {
    let best: Session | null = null;
    for (const lane of lanes) {
      // Plan at the shared rate: other buses will usually be on the same charger overnight.
      const kw = Math.min(lane.twoGun || lane.oneGun, n.bus.max_intake_kw ?? Infinity);
      if (kw <= 0) continue;
      const duration = Math.max(30, snap((n.requiredKwh / kw) * 60));
      const taken = booked.get(lane.key) ?? [];
      for (let t = n.available; t + duration <= DAY; t += SNAP) {
        if (taken.some((s) => t < s.end && t + duration > s.start)) continue;
        if (!best || t < best.start) best = { busId: n.bus.bus_id, lane: lane.key, start: t, duration };
        break;
      }
    }
    if (!best) {
      unplaced.push(n.bus.bus_id);
      continue;
    }
    sessions.push(best);
    const list = booked.get(best.lane) ?? [];
    list.push({ start: best.start, end: best.start + best.duration + buffer });
    booked.set(best.lane, list);
  }
  return { sessions, unplaced };
}

/** kW each session draws at minute t (sessions on the same charger share its power). */
function drawAt(t: number, sessions: Session[], lanes: Map<string, Lane>, intake: Map<number, number | null>): Map<Session, { kw: number; shared: boolean }> {
  const out = new Map<Session, { kw: number; shared: boolean }>();
  const byCharger = new Map<string, Session[]>();
  for (const s of sessions) {
    if (t >= s.start && t < s.start + s.duration && lanes.has(s.lane)) {
      const k = chargerOf(s.lane);
      byCharger.set(k, [...(byCharger.get(k) ?? []), s]);
    }
  }
  for (const active of byCharger.values()) {
    const shared = active.length > 1;
    for (const s of active) {
      const lane = lanes.get(s.lane)!;
      const kw = Math.min(shared ? lane.twoGun : lane.oneGun, intake.get(s.busId) ?? Infinity);
      out.set(s, { kw, shared });
    }
  }
  return out;
}

/** Energy each session delivers, minute-exact at the points where sessions start or stop. */
export function simulate(sessions: Session[], laneList: Lane[], needs: BusNeed[]): Map<number, SessionResult> {
  const lanes = new Map(laneList.map((l) => [l.key, l]));
  const intake = new Map(needs.map((n) => [n.bus.bus_id, n.bus.max_intake_kw]));
  const deadline = new Map(needs.map((n) => [n.bus.bus_id, n]));
  const times = [...new Set(sessions.flatMap((s) => [s.start, s.start + s.duration]))].sort((a, b) => a - b);
  const results = new Map<number, SessionResult>(sessions.map((s) => [s.busId, { deliveredKwh: 0, segments: [], late: false }]));
  for (let i = 0; i < times.length - 1; i++) {
    const [t0, t1] = [times[i], times[i + 1]];
    for (const [s, { kw, shared }] of drawAt(t0, sessions, lanes, intake)) {
      const r = results.get(s.busId)!;
      r.deliveredKwh += (kw * (t1 - t0)) / 60;
      const last = r.segments[r.segments.length - 1];
      if (last && last.end === t0 && last.shared === shared) last.end = t1;
      else r.segments.push({ start: t0, end: t1, shared });
    }
  }
  for (const s of sessions) {
    const n = deadline.get(s.busId);
    // Late only when the deadline falls after plug-in (i.e. it's the next morning's departure).
    if (n?.deadline != null && n.deadline > n.available) results.get(s.busId)!.late = s.start + s.duration > n.deadline;
  }
  return results;
}

/** Total site power (kW) at each SNAP-minute step through the window. */
export function powerProfile(sessions: Session[], laneList: Lane[], needs: BusNeed[]): number[] {
  const lanes = new Map(laneList.map((l) => [l.key, l]));
  const intake = new Map(needs.map((n) => [n.bus.bus_id, n.bus.max_intake_kw]));
  const out: number[] = [];
  for (let t = 0; t < DAY; t += SNAP) {
    let kw = 0;
    for (const v of drawAt(t, sessions, lanes, intake).values()) kw += v.kw;
    out.push(kw);
  }
  return out;
}

export interface ScheduleSummary {
  required: number; // kWh needed by all buses
  delivered: number; // kWh delivered, counting each bus up to what it needs
  short: number; // buses not fully charged (including unscheduled ones)
  late: number; // sessions still running after the bus's first departure
  peak: number; // kW
  peakAt: number; // window minute of the peak
}

/** Headline figures for a schedule, used for the tiles and for comparing two schedules. */
export function summarize(sessions: Session[], lanes: Lane[], needs: BusNeed[]): ScheduleSummary {
  const results = simulate(sessions, lanes, needs);
  const profile = powerProfile(sessions, lanes, needs);
  let required = 0;
  let delivered = 0;
  let short = 0;
  let late = 0;
  for (const n of needs) {
    const r = results.get(n.bus.bus_id);
    required += n.requiredKwh;
    delivered += Math.min(r?.deliveredKwh ?? 0, n.requiredKwh);
    if (!r || r.deliveredKwh < n.requiredKwh - 0.05) short++;
    if (r?.late) late++;
  }
  const peak = Math.max(0, ...profile);
  return { required, delivered, short, late, peak, peakAt: profile.indexOf(peak) * SNAP };
}

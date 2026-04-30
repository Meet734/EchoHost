// Catalog of aviation APIs (real + mock implementations)
// Real: Flight status (AviationStack), METAR weather (aviationweather.gov)
// Mock: Baggage, gates, crew, catering (airline-internal systems)

import fetch from 'node-fetch';
import type {
  FlightStatusResponse,
  BaggageTrackingResponse,
  WeatherBriefingResponse,
  GateInfoResponse,
} from "@echohost/shared";

// Result type — errors don't leak exceptions
export type ToolResult<T> =
  | { success: true; data: T }
  | { success: false; error: string };

const AVIATIONSTACK_BASE = "https://api.aviationstack.com/v1";

interface AviationStackFlight {
  flight_status?: string;
  departure?: {
    scheduled?: string;
    estimated?: string;
    gate?: string;
    terminal?: string;
    delay?: number;
  };
}

interface AviationStackResponse {
  data?: AviationStackFlight[];
}

// Flight Status — REAL (AviationStack free tier)
export async function fetchFlightStatus(
  flightNumber: string
): Promise<ToolResult<FlightStatusResponse>> {
  const apiKey = process.env["AVIATIONSTACK_API_KEY"];

  if (!apiKey) {
    return { success: true, data: mockFlightStatus(flightNumber) };
  }

  try {
    const url = new URL(`${AVIATIONSTACK_BASE}/flights`);
    url.searchParams.set("access_key", apiKey);
    url.searchParams.set("flight_iata", flightNumber.toUpperCase());

    const resp = await fetch(url.toString(), {
      signal: AbortSignal.timeout(5000),
    });

    if (!resp.ok) {
      return {
        success: false,
        error: `AviationStack returned ${resp.status}`,
      };
    }

    const body = (await resp.json()) as AviationStackResponse;
    const flight = body.data?.[0];

    if (!flight) {
      return { success: true, data: mockFlightStatus(flightNumber) };
    }

    const statusMap: Record<string, FlightStatusResponse["status"]> = {
      scheduled: "ON_TIME",
      active: "ON_TIME",
      landed: "LANDED",
      cancelled: "CANCELLED",
      incident: "CANCELLED",
      diverted: "CANCELLED",
    };

    return {
      success: true,
      data: {
        flightNumber: flightNumber.toUpperCase(),
        status: statusMap[flight.flight_status ?? ""] ?? "UNKNOWN",
        scheduledDeparture: flight.departure?.scheduled ?? "Unknown",
        estimatedDeparture: flight.departure?.estimated,
        gate: flight.departure?.gate,
        terminal: flight.departure?.terminal,
        delayMinutes: flight.departure?.delay ?? undefined,
        source: "live",
      },
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

// METAR Weather — REAL (aviationweather.gov — no key)
interface MetarApiResponse {
  data?: Array<{
    rawOb?: string;
    wdir?: number;
    wspd?: number;
    visib?: string;
    wxString?: string;
    name?: string;
  }>;
}

export async function fetchWeatherBriefing(
  icaoCode: string
): Promise<ToolResult<WeatherBriefingResponse>> {
  try {
    const url = `https://aviationweather.gov/api/data/metar?ids=${icaoCode.toUpperCase()}&format=json`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });

    if (!resp.ok) {
      return {
        success: false,
        error: `METAR API returned ${resp.status}`,
      };
    }

    const body = (await resp.json()) as MetarApiResponse;
    const metar = body.data?.[0];

    if (!metar) {
      return {
        success: false,
        error: `No METAR data found for ${icaoCode}`,
      };
    }

    return {
      success: true,
      data: {
        airport: metar.name ?? icaoCode,
        icaoCode: icaoCode.toUpperCase(),
        rawMetar: metar.rawOb ?? "Data unavailable",
        windDirection: metar.wdir ?? 0,
        windSpeedKts: metar.wspd ?? 0,
        visibilityMiles: parseFloat(metar.visib ?? "10"),
        conditions: metar.wxString ?? "Clear",
        timestamp: new Date().toISOString(),
      },
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

// Baggage Tracking — MOCK
export async function trackBaggage(
  baggageId: string
): Promise<ToolResult<BaggageTrackingResponse>> {
  const lastChar = baggageId.slice(-1).toLowerCase();
  const statusMap: Record<string, BaggageTrackingResponse["status"]> = {
    "0": "AT_CAROUSEL",
    "1": "IN_TRANSIT",
    "2": "DELIVERED",
    "3": "AT_CAROUSEL",
    "4": "IN_TRANSIT",
    "5": "AT_CAROUSEL",
    "6": "DELAYED",
    "7": "AT_CAROUSEL",
    "8": "IN_TRANSIT",
    "9": "AT_CAROUSEL",
    a: "AT_CAROUSEL",
    b: "IN_TRANSIT",
    c: "AT_CAROUSEL",
    d: "DELIVERED",
  };

  const status = statusMap[lastChar] ?? "IN_TRANSIT";
  const carousel =
    status === "AT_CAROUSEL" || status === "DELIVERED" ? 4 : undefined;

  return {
    success: true,
    data: {
      baggageId: baggageId.toUpperCase(),
      carousel,
      status,
      lastUpdated: new Date().toISOString(),
    },
  };
}

// Gate Information — MOCK
const MOCK_GATES: Record<string, Omit<GateInfoResponse, "flightNumber">> = {
  DEFAULT: {
    gate: "B14",
    terminal: "Terminal 2",
    boardingTime: "30 minutes before departure",
    walkingMinutes: 8,
  },
};

export async function fetchGateInfo(
  flightNumber: string
): Promise<ToolResult<GateInfoResponse>> {
  const mockData = MOCK_GATES[flightNumber.toUpperCase()] ?? MOCK_GATES["DEFAULT"]!;
  return {
    success: true,
    data: {
      flightNumber: flightNumber.toUpperCase(),
      ...mockData,
    },
  };
}

// Load Factor — MOCK
export async function fetchLoadFactor(
  flightNumber: string
): Promise<ToolResult<{ flightNumber: string; passengersBooked: number; capacity: number; percentage: number }>> {
  const capacity = 180;
  const booked = 130 + Math.floor(Math.random() * 45);
  return {
    success: true,
    data: {
      flightNumber: flightNumber.toUpperCase(),
      passengersBooked: booked,
      capacity,
      percentage: Math.round((booked / capacity) * 100),
    },
  };
}

// Crew Check-In — MOCK
export async function checkCrewStatus(
  flightNumber: string
): Promise<ToolResult<{ flightNumber: string; crewCheckedIn: boolean; roster: string[] }>> {
  return {
    success: true,
    data: {
      flightNumber: flightNumber.toUpperCase(),
      crewCheckedIn: true,
      roster: ["Capt. Sharma", "F/O Patel", "Sr. FA Mehta", "FA Desai", "FA Singh"],
    },
  };
}

// Lost & Found — MOCK
export async function reportLostItem(
  description: string,
  location?: string
): Promise<ToolResult<{ ticketId: string; status: string; estimatedResponseHours: number }>> {
  const ticketId = `LF-${Date.now().toString(36).toUpperCase()}`;
  return {
    success: true,
    data: {
      ticketId,
      status: `Lost property report filed. Item: "${description}". Location: ${location ?? "Not specified"}.`,
      estimatedResponseHours: 2,
    },
  };
}

export const TOOL_REGISTRY = {
  fetchFlightStatus,
  fetchWeatherBriefing,
  trackBaggage,
  fetchGateInfo,
  fetchLoadFactor,
  checkCrewStatus,
  reportLostItem,
} as const;

export type ToolName = keyof typeof TOOL_REGISTRY;

function mockFlightStatus(flightNumber: string): FlightStatusResponse {
  return {
    flightNumber: flightNumber.toUpperCase(),
    status: "ON_TIME",
    scheduledDeparture: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    gate: "B14",
    terminal: "Terminal 2",
    delayMinutes: 0,
    source: "mock",
  };
}

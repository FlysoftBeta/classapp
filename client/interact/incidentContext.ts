import type { IncidentId } from "@/shared/protocol/errors";

const MAX_RELATED_INCIDENTS = 32;
const JOURNAL_TTL_MS = 10 * 60_000;

function randomOperationId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join(
    "",
  );
}

class IncidentCollector {
  readonly ids = new Set<IncidentId>();

  link(id: IncidentId): void {
    if (this.ids.size >= MAX_RELATED_INCIDENTS) return;
    this.ids.add(id);
  }
}

/** Operation-owned correlation state; it is never ambient mutable state. */
export class ClientIncidentContext {
  constructor(
    readonly label: string,
    readonly actorId: string | null,
    readonly transportEpoch: number | null,
    private readonly collector = new IncidentCollector(),
    readonly operationId = randomOperationId(),
  ) {}

  linkIncident(id: IncidentId): void {
    this.collector.link(id);
  }

  relatedIncidentIds(): readonly IncidentId[] {
    return [...this.collector.ids];
  }

  child(label: string): ClientIncidentContext {
    return new ClientIncidentContext(
      label,
      this.actorId,
      this.transportEpoch,
      this.collector,
      this.operationId,
    );
  }
}

type JournalEntry = { id: IncidentId; at: number };
const journal = new Map<string, JournalEntry[]>();

type DetachedIncidentHandler = (label: string, reason: unknown) => void;
let detachedIncidentHandler: DetachedIncidentHandler | null = null;

export function setDetachedIncidentHandler(
  handler: DetachedIncidentHandler | null,
): void {
  detachedIncidentHandler = handler;
}

/** Low-level code reports upward without importing the reporting transport. */
export function reportDetachedClientFailure(
  label: string,
  reason: unknown,
): void {
  detachedIncidentHandler?.(label, reason);
}

export function recordRemoteIncident(
  actorId: string | null,
  incidentId: IncidentId,
): void {
  const key = actorId ?? "anonymous";
  const cutoff = Date.now() - JOURNAL_TTL_MS;
  const entries = (journal.get(key) ?? []).filter(
    (entry) => entry.at >= cutoff,
  );
  if (!entries.some((entry) => entry.id === incidentId)) {
    entries.push({ id: incidentId, at: Date.now() });
  }
  journal.set(key, entries.slice(-MAX_RELATED_INCIDENTS));
}

export function recentRemoteIncidents(
  actorId: string | null,
): readonly IncidentId[] {
  const key = actorId ?? "anonymous";
  const cutoff = Date.now() - JOURNAL_TTL_MS;
  const entries = (journal.get(key) ?? []).filter(
    (entry) => entry.at >= cutoff,
  );
  journal.set(key, entries);
  return entries.map((entry) => entry.id);
}

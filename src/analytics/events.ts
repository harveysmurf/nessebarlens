/**
 * The interaction events both sides of `/api/e` agree on (#119).
 *
 * One list, imported by the route's allowlist and by the client helper's type.
 * A new event is added here and nowhere else; an event the client can name but
 * the server does not list is dropped without a write.
 */
export const TRACK_EVENTS = [
  "contact_open",
  "configurator_open",
  "configurator_submit",
] as const;

export type TrackEvent = (typeof TRACK_EVENTS)[number];

export function isTrackEvent(value: unknown): value is TrackEvent {
  return (
    typeof value === "string" &&
    (TRACK_EVENTS as readonly string[]).includes(value)
  );
}

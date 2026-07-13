export type SallaAvailabilitySnapshot = {
  loading: boolean;
  error?: string | null;
  available?: boolean;
};

/** Remote writes are allowed only after the latest availability check succeeds. */
export function sallaRemoteActionsAreAvailable(snapshot: SallaAvailabilitySnapshot) {
  return !snapshot.loading && !snapshot.error && snapshot.available === true;
}

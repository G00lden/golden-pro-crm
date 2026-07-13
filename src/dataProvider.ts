const SERVER_DATA_PROVIDERS = new Set(["sqlite", "supabase"]);

export function usesServerData(dataProvider?: string, databaseProvider?: string) {
  return SERVER_DATA_PROVIDERS.has(dataProvider || "") ||
    SERVER_DATA_PROVIDERS.has(databaseProvider || "");
}

export function usesBrowserLocalData(
  localUser: boolean,
  dataProvider?: string,
  databaseProvider?: string,
) {
  return localUser && !usesServerData(dataProvider, databaseProvider);
}

/** Central policy for choosing server-backed data instead of browser storage. */
export function serverDataEnabled() {
  return usesServerData(
    import.meta.env.VITE_DATA_PROVIDER,
    import.meta.env.VITE_DB_PROVIDER,
  );
}

export function browserLocalDataEnabled(localUser: boolean) {
  return usesBrowserLocalData(
    localUser,
    import.meta.env.VITE_DATA_PROVIDER,
    import.meta.env.VITE_DB_PROVIDER,
  );
}

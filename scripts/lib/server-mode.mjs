export function resolveServerMode(args = []) {
  return args.includes("--dev") ? "development" : "production";
}

export function serverEnvironment(mode, current = process.env) {
  const development = mode === "development";
  return {
    ...current,
    NODE_ENV: development ? "development" : "production",
    ENABLE_VITE_DEV_SERVER: development ? "true" : "false",
    ENV_FILE: current.ENV_FILE || (development ? ".env" : ".env.production"),
  };
}

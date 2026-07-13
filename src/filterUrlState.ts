import { useCallback, useEffect, useRef, useState } from "react";

export type UrlFilterRule =
  | { type: "text"; maxLength?: number; trim?: boolean }
  | { type: "enum"; values: readonly string[] }
  | { type: "integer"; minimum: number; maximum: number }
  | { type: "decimal"; minimum: number; maximum?: number }
  | { type: "date" };

export type UrlFilterSchema<T extends Record<string, string>> = {
  [K in keyof T]: UrlFilterRule;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function validIsoDate(value: string) {
  if (!ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function sanitizeUrlFilterValue(value: unknown, rule: UrlFilterRule, fallback = "") {
  const raw = String(value ?? "");
  if (rule.type === "text") {
    const normalized = rule.trim === false ? raw : raw.trim();
    return normalized.slice(0, rule.maxLength ?? 200);
  }
  if (rule.type === "enum") return rule.values.includes(raw) ? raw : fallback;
  if (rule.type === "date") return validIsoDate(raw) ? raw : fallback;

  const parsed = Number(raw);
  if (!raw.trim() || !Number.isFinite(parsed) || parsed < rule.minimum) return fallback;
  if (rule.maximum !== undefined && parsed > rule.maximum) return fallback;
  if (rule.type === "integer") return String(Math.trunc(parsed));
  return String(parsed);
}

export function parsePrefixedUrlState<T extends Record<string, string>>(
  search: string,
  prefix: string,
  defaults: T,
  schema: UrlFilterSchema<T>,
): T {
  const params = new URLSearchParams(search);
  const parsed = { ...defaults };
  for (const key of Object.keys(defaults) as Array<keyof T>) {
    const value = params.get(`${prefix}_${String(key)}`);
    if (value === null) continue;
    parsed[key] = sanitizeUrlFilterValue(value, schema[key], defaults[key]) as T[keyof T];
  }
  return parsed;
}

export function serializePrefixedUrlState<T extends Record<string, string>>(
  search: string,
  prefix: string,
  state: T,
  defaults: T,
  schema: UrlFilterSchema<T>,
) {
  const params = new URLSearchParams(search);
  const prefixed = `${prefix}_`;
  for (const key of Array.from(params.keys())) {
    if (key.startsWith(prefixed)) params.delete(key);
  }

  for (const key of Object.keys(defaults) as Array<keyof T>) {
    const normalized = sanitizeUrlFilterValue(state[key], schema[key], defaults[key]);
    if (!normalized || normalized === defaults[key]) continue;
    params.set(`${prefix}_${String(key)}`, normalized);
  }
  const result = params.toString();
  return result ? `?${result}` : "";
}

type UrlStateUpdater<T> = Partial<T> | ((current: T) => T);

export function usePrefixedUrlState<T extends Record<string, string>>(
  prefix: string,
  defaults: T,
  schema: UrlFilterSchema<T>,
) {
  const defaultsRef = useRef(defaults);
  const schemaRef = useRef(schema);
  const [state, setState] = useState<T>(() => {
    if (typeof window === "undefined") return { ...defaults };
    return parsePrefixedUrlState(window.location.search, prefix, defaults, schema);
  });

  useEffect(() => {
    const readLocation = () => {
      const next = parsePrefixedUrlState(
        window.location.search,
        prefix,
        defaultsRef.current,
        schemaRef.current,
      );
      setState((current) => JSON.stringify(current) === JSON.stringify(next) ? current : next);
    };
    window.addEventListener("popstate", readLocation);
    return () => window.removeEventListener("popstate", readLocation);
  }, [prefix]);

  useEffect(() => {
    const nextSearch = serializePrefixedUrlState(
      window.location.search,
      prefix,
      state,
      defaultsRef.current,
      schemaRef.current,
    );
    if (nextSearch === window.location.search) return;
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${nextSearch}${window.location.hash}`,
    );
  }, [prefix, state]);

  const updateState = useCallback((update: UrlStateUpdater<T>) => {
    setState((current) => typeof update === "function" ? update(current) : { ...current, ...update });
  }, []);

  const resetState = useCallback(() => setState({ ...defaultsRef.current }), []);

  return [state, updateState, resetState] as const;
}

import type { SupabaseClient } from "@supabase/supabase-js";

export async function getConfigValue<T>(
  supabase: SupabaseClient,
  key: string,
): Promise<T | null> {
  const { data, error } = await supabase
    .from("config")
    .select("value")
    .eq("key", key)
    .maybeSingle();
  if (error) throw new Error(`config read ${key}: ${error.message}`);
  return (data?.value as T) ?? null;
}

export async function setConfigValue(
  supabase: SupabaseClient,
  key: string,
  value: unknown,
): Promise<void> {
  const { error } = await supabase.from("config").upsert({
    key,
    value,
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(`config write ${key}: ${error.message}`);
}

/** Warm-up: days 1–3 → 15/day, 4–6 → 30/day, 7+ → 50/day hard cap. */
export function dailyQuotaForWarmupDay(warmupDay: number): number {
  if (warmupDay <= 3) return 15;
  if (warmupDay <= 6) return 30;
  return 50;
}

export function halfQuota(daily: number): number {
  return Math.ceil(daily / 2);
}

export function isPaused(value: unknown): boolean {
  return value === true || value === "true";
}

export function isDryRun(
  envValue: string | undefined,
  configValue: unknown,
): boolean {
  if (envValue === "false" || envValue === "0") {
    // env can force live only when config also allows (or env alone if config null)
    if (configValue === true || configValue === "true") return true;
    return false;
  }
  if (envValue === "true" || envValue === "1") return true;
  return configValue === true || configValue === "true" || configValue == null;
}

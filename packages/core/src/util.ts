export function publicUrl(env: { PUBLIC_URL?: string }): string {
  if (!env.PUBLIC_URL) throw new Error("PUBLIC_URL is not set");
  return env.PUBLIC_URL.replace(/\/+$/, "");
}

export function required<E>(env: E, key: keyof E & string): string {
  const v = env[key];
  if (typeof v !== "string" || !v) throw new Error(`${key} is not set`);
  return v;
}

export function base64url(input: Uint8Array | string): string {
  const b = typeof input === "string" ? new TextEncoder().encode(input) : input;
  let bin = "";
  for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

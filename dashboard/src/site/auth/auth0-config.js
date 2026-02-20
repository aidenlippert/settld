export const auth0Domain =
  typeof import.meta !== "undefined" && import.meta.env?.VITE_AUTH0_DOMAIN
    ? String(import.meta.env.VITE_AUTH0_DOMAIN).trim()
    : "";

export const auth0ClientId =
  typeof import.meta !== "undefined" && import.meta.env?.VITE_AUTH0_CLIENT_ID
    ? String(import.meta.env.VITE_AUTH0_CLIENT_ID).trim()
    : "";

export const auth0Audience =
  typeof import.meta !== "undefined" && import.meta.env?.VITE_AUTH0_AUDIENCE
    ? String(import.meta.env.VITE_AUTH0_AUDIENCE).trim()
    : "";

export const auth0Enabled = Boolean(auth0Domain && auth0ClientId);

export function auth0AuthorizationParams() {
  const out = {
    redirect_uri: typeof window !== "undefined" ? `${window.location.origin}/app` : undefined
  };
  if (auth0Audience) out.audience = auth0Audience;
  return out;
}

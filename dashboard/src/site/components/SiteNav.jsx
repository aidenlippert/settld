import { useEffect, useState } from "react";
import { useAuth0 } from "@auth0/auth0-react";

import { auth0Enabled } from "../auth/auth0-config.js";
import { fetchBuyerMe, logoutBuyerSession } from "../auth/client.js";
import { clearSession, readSession, subscribeSession, writeSession } from "../auth/session.js";

const links = [
  { href: "/product", label: "Product" },
  { href: "/developers", label: "Developers" },
  { href: "/docs", label: "Docs" },
  { href: "/security", label: "Security" },
  { href: "/pricing", label: "Access" },
  { href: "/company", label: "Company" }
];

const logoUrl =
  typeof import.meta !== "undefined" && import.meta.env?.VITE_BRAND_LOGO_URL
    ? String(import.meta.env.VITE_BRAND_LOGO_URL).trim()
    : "/brand/settld-logo.png";

const brandSubtitle =
  typeof import.meta !== "undefined" && import.meta.env?.VITE_BRAND_SUBTITLE
    ? String(import.meta.env.VITE_BRAND_SUBTITLE).trim()
    : "Autonomous Commerce Infrastructure";

function SiteNavShell({ children }) {
  return (
    <header className="site-nav-wrap">
      <nav className="site-nav" aria-label="Primary">
        <a href="/" className="brand-mark" aria-label="Settld home">
          <span className="brand-mark-row">
            {logoUrl ? (
              <img src={logoUrl} alt="" className="brand-mark-logo" />
            ) : (
              <span className="brand-mark-logo-fallback" aria-hidden="true">S</span>
            )}
            <span className="brand-mark-core">Settld</span>
          </span>
          <span className="brand-mark-sub">{brandSubtitle}</span>
        </a>
        <ul className="site-links">
          {links.map((link) => (
            <li key={link.href}>
              <a href={link.href}>{link.label}</a>
            </li>
          ))}
        </ul>
        <div className="site-nav-cta">
          <a className="btn btn-ghost" href="/demo">
            Interactive demo
          </a>
          {children}
        </div>
      </nav>
    </header>
  );
}

function Auth0NavActions() {
  const { isAuthenticated, isLoading, loginWithRedirect, logout } = useAuth0();
  if (isLoading) return null;
  if (isAuthenticated) {
    return (
      <>
        <a className="btn btn-solid" href="/app">
          Open workspace
        </a>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => logout({ logoutParams: { returnTo: window.location.origin } })}
        >
          Sign out
        </button>
      </>
    );
  }
  return (
    <>
      <button type="button" className="btn btn-ghost" onClick={() => loginWithRedirect()}>
        Sign in
      </button>
      <button
        type="button"
        className="btn btn-solid"
        onClick={() => loginWithRedirect({ authorizationParams: { screen_hint: "signup" } })}
      >
        Start free
      </button>
    </>
  );
}

function LegacyNavActions() {
  const [session, setSession] = useState(() => readSession());

  useEffect(() => {
    let active = true;
    const unsubscribe = subscribeSession((next) => {
      if (!active) return;
      setSession(next);
    });

    async function hydrateFromServer() {
      const current = readSession();
      if (!current) return;
      try {
        const me = await fetchBuyerMe({ apiBaseUrl: current.apiBaseUrl });
        if (!active || !me?.principal) return;
        const next = writeSession({
          ...current,
          email: me.principal.email,
          role: me.principal.role,
          tenantId: me.principal.tenantId
        });
        setSession(next);
      } catch {
        // Ignore transient failures; session may still be valid.
      }
    }

    hydrateFromServer();

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  async function onSignOut() {
    try {
      await logoutBuyerSession({ apiBaseUrl: session?.apiBaseUrl });
    } catch {
      // logout should still clear client state
    } finally {
      clearSession();
      setSession(null);
      window.location.href = "/";
    }
  }

  return (
    <>
      {session ? (
        <>
          <a className="btn btn-solid" href="/app">
            Open workspace
          </a>
          <button type="button" className="btn btn-ghost" onClick={onSignOut}>
            Sign out
          </button>
        </>
      ) : (
        <>
          <a className="btn btn-ghost" href="/login">
            Sign in
          </a>
          <a className="btn btn-solid" href="/signup">
            Start free
          </a>
        </>
      )}
    </>
  );
}

export default function SiteNav() {
  return <SiteNavShell>{auth0Enabled ? <Auth0NavActions /> : <LegacyNavActions />}</SiteNavShell>;
}

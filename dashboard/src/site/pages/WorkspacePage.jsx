import { useEffect, useMemo, useState } from "react";
import { useAuth0 } from "@auth0/auth0-react";

import PageFrame from "../components/PageFrame.jsx";
import { auth0Enabled } from "../auth/auth0-config.js";
import { fetchBuyerMe, logoutBuyerSession } from "../auth/client.js";
import { clearSession, readSession, subscribeSession, writeSession } from "../auth/session.js";

const modules = [
  {
    title: "Escalation Inbox",
    copy: "Review blocked autonomous transactions and issue signed override decisions.",
    href: "/operator"
  },
  {
    title: "Live Runtime Demo",
    copy: "Replay deterministic settlement flows, artifacts, and dispute outcomes.",
    href: "/demo"
  },
  {
    title: "Policy and Wallet Controls",
    copy: "Configure budgets, risk classes, allowlists, and run-level spend limits.",
    href: "/product"
  },
  {
    title: "Receipts and Exports",
    copy: "Query durable receipts, pull JSONL exports, and run offline verification.",
    href: "/developers"
  }
];

function WorkspaceLayout({ displayName, metaLabel, onSignOut }) {
  return (
    <PageFrame>
      <section className="section-shell page-hero workspace-header">
        <p className="eyebrow">Workspace</p>
        <h1>Welcome back, {displayName}.</h1>
        <p>
          This is your control center for autonomous spend operations, verification outcomes, and policy governance.
        </p>
        {metaLabel ? <p className="auth-meta">{metaLabel}</p> : null}
        <div className="hero-actions">
          <a className="btn btn-solid" href="/operator">Open inbox</a>
          <button className="btn btn-ghost" onClick={onSignOut}>Sign out</button>
        </div>
      </section>

      <section className="section-shell">
        <div className="workspace-grid">
          {modules.map((module) => (
            <article key={module.title} className="workspace-card">
              <h3>{module.title}</h3>
              <p>{module.copy}</p>
              <a className="text-link" href={module.href}>Open</a>
            </article>
          ))}
        </div>
      </section>
    </PageFrame>
  );
}

function Auth0WorkspacePage() {
  const { user, isLoading, isAuthenticated, loginWithRedirect, logout } = useAuth0();

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      loginWithRedirect({ appState: { returnTo: "/app" } });
    }
  }, [isAuthenticated, isLoading, loginWithRedirect]);

  if (isLoading || !isAuthenticated) return null;
  const displayName = user?.name || user?.email || "Operator";
  const metaLabel = user?.email ? `Auth0 · ${user.email}` : "Auth0 session";
  return (
    <WorkspaceLayout
      displayName={displayName}
      metaLabel={metaLabel}
      onSignOut={() => logout({ logoutParams: { returnTo: window.location.origin } })}
    />
  );
}

function LegacyWorkspacePage() {
  const [session, setSession] = useState(() => readSession());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    const unsubscribe = subscribeSession((next) => {
      if (!active) return;
      setSession(next);
    });

    async function hydrate() {
      const current = readSession();
      if (!current) {
        window.location.href = "/login";
        return;
      }
      setSession(current);
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
        clearSession();
        if (active) window.location.href = "/login";
        return;
      } finally {
        if (active) setLoading(false);
      }
    }

    hydrate();
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const displayName = useMemo(() => {
    if (!session) return "Operator";
    return session.fullName || session.email;
  }, [session]);

  async function onSignOut() {
    try {
      await logoutBuyerSession({ apiBaseUrl: session?.apiBaseUrl });
    } catch {
      // ignore and clear client state
    } finally {
      clearSession();
      window.location.href = "/";
    }
  }

  if (!session || loading) return null;
  return (
    <WorkspaceLayout
      displayName={displayName}
      metaLabel={`Tenant: ${session.tenantId} · Role: ${session.role}`}
      onSignOut={onSignOut}
    />
  );
}

export default function WorkspacePage() {
  return auth0Enabled ? <Auth0WorkspacePage /> : <LegacyWorkspacePage />;
}

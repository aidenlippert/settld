import { useEffect, useMemo, useState } from "react";
import { useAuth0 } from "@auth0/auth0-react";

import PageFrame from "../components/PageFrame.jsx";
import { auth0Enabled } from "../auth/auth0-config.js";
import { fetchBuyerMe, logoutBuyerSession } from "../auth/client.js";
import { clearSession, readSession, subscribeSession, writeSession } from "../auth/session.js";
import { Badge } from "../components/ui/badge.jsx";
import { buttonClasses } from "../components/ui/button.jsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card.jsx";

const modules = [
  {
    title: "Escalation Inbox",
    copy: "Review blocked autonomous transactions and issue signed override decisions.",
    href: "/operator"
  },
  {
    title: "Protocol and Quickstart",
    copy: "Review production integration steps, API contracts, and rollout guidance.",
    href: "/docs/quickstart"
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
      <section className="section-shell">
        <Card className="bg-gradient-to-br from-[rgba(255,253,248,0.96)] to-[rgba(248,241,230,0.92)]">
          <CardHeader>
            <Badge variant="accent" className="w-fit">Workspace</Badge>
            <CardTitle className="text-[clamp(1.9rem,5vw,3rem)]">Welcome back, {displayName}.</CardTitle>
            <CardDescription className="max-w-3xl text-base">
              This is your control center for autonomous spend operations, verification outcomes, and policy governance.
            </CardDescription>
            {metaLabel ? <p className="text-xs text-[#657185]">{metaLabel}</p> : null}
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-3">
              <a className={buttonClasses()} href="/operator">Open inbox</a>
              <button className={buttonClasses({ variant: "outline" })} onClick={onSignOut}>Sign out</button>
            </div>
          </CardContent>
        </Card>
      </section>

      <section className="section-shell">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {modules.map((module) => (
            <Card key={module.title}>
              <CardHeader>
                <CardTitle className="text-2xl">{module.title}</CardTitle>
                <CardDescription className="text-base">{module.copy}</CardDescription>
              </CardHeader>
              <CardContent>
                <a className="font-semibold text-[#7f2f1f]" href={module.href}>Open</a>
              </CardContent>
            </Card>
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

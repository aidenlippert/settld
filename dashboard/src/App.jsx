import { useEffect } from "react";

import OperatorDashboard from "./operator/OperatorDashboard.jsx";
import ProductShell from "./product/ProductShell.jsx";
import { docsLinks } from "./site/config/links.js";

function ExternalRedirect({ href }) {
  useEffect(() => {
    if (typeof window !== "undefined") {
      window.location.replace(href);
    }
  }, [href]);
  return null;
}

function getRouteMode() {
  if (typeof window === "undefined") return { mode: "home", launchId: null, agentId: null };
  const rawPath = window.location.pathname;
  const path = rawPath.length > 1 && rawPath.endsWith("/") ? rawPath.slice(0, -1) : rawPath;

  if (path === "/operator") return { mode: "operator", launchId: null, agentId: null };
  if (path === "/network" || path === "/app") return { mode: "network", launchId: null, agentId: null };
  if (path === "/agents") return { mode: "agents", launchId: null, agentId: null };
  if (path === "/onboarding" || path === "/login") return { mode: "onboarding", launchId: null, agentId: null };
  if (path === "/studio") return { mode: "studio", launchId: null, agentId: null };
  if (path === "/developers") return { mode: "developers", launchId: null, agentId: null };
  if (path === "/docs") return { mode: "docs", launchId: null, agentId: null };
  if (path === "/docs/quickstart") return { mode: "docs_quickstart", launchId: null, agentId: null };
  if (path === "/docs/architecture") return { mode: "docs_architecture", launchId: null, agentId: null };
  if (path === "/docs/integrations") return { mode: "docs_integrations", launchId: null, agentId: null };
  if (path === "/docs/api") return { mode: "docs_api", launchId: null, agentId: null };
  if (path === "/docs/security") return { mode: "docs_security", launchId: null, agentId: null };
  if (path === "/docs/ops") return { mode: "docs_ops", launchId: null, agentId: null };
  if (path.startsWith("/launch/")) {
    return {
      mode: "launch",
      launchId: decodeURIComponent(path.slice("/launch/".length)),
      agentId: null
    };
  }
  if (path.startsWith("/agents/")) {
    return {
      mode: "agent",
      launchId: null,
      agentId: decodeURIComponent(path.slice("/agents/".length))
    };
  }
  return { mode: "home", launchId: null, agentId: null };
}

export default function App() {
  const route = getRouteMode();
  if (route.mode === "operator") return <OperatorDashboard />;
  if (route.mode === "docs") return <ExternalRedirect href={docsLinks.home} />;
  if (route.mode === "docs_quickstart") return <ExternalRedirect href={docsLinks.quickstart} />;
  if (route.mode === "docs_architecture") return <ExternalRedirect href={docsLinks.architecture} />;
  if (route.mode === "docs_integrations") return <ExternalRedirect href={docsLinks.integrations} />;
  if (route.mode === "docs_api") return <ExternalRedirect href={docsLinks.api} />;
  if (route.mode === "docs_security") return <ExternalRedirect href={docsLinks.security} />;
  if (route.mode === "docs_ops") return <ExternalRedirect href={docsLinks.ops} />;
  return <ProductShell mode={route.mode} launchId={route.launchId} agentId={route.agentId} />;
}

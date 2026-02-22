import { useEffect } from "react";

import SiteShell from "./site/SiteShell.jsx";
import OperatorDashboard from "./operator/OperatorDashboard.jsx";
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
  if (typeof window === "undefined") return "home";
  const rawPath = window.location.pathname;
  const path = rawPath.length > 1 && rawPath.endsWith("/") ? rawPath.slice(0, -1) : rawPath;

  if (path === "/operator") return "operator";
  if (path === "/docs") return "docs";
  if (path === "/docs/quickstart") return "docs_quickstart";
  if (path === "/docs/architecture") return "docs_architecture";
  if (path === "/docs/integrations") return "docs_integrations";
  if (path === "/docs/api") return "docs_api";
  if (path === "/docs/security") return "docs_security";
  if (path === "/docs/ops") return "docs_ops";
  return "home";
}

export default function App() {
  const mode = getRouteMode();
  if (mode === "operator") return <OperatorDashboard />;
  if (mode === "docs") return <ExternalRedirect href={docsLinks.home} />;
  if (mode === "docs_quickstart") return <ExternalRedirect href={docsLinks.quickstart} />;
  if (mode === "docs_architecture") return <ExternalRedirect href={docsLinks.architecture} />;
  if (mode === "docs_integrations") return <ExternalRedirect href={docsLinks.integrations} />;
  if (mode === "docs_api") return <ExternalRedirect href={docsLinks.api} />;
  if (mode === "docs_security") return <ExternalRedirect href={docsLinks.security} />;
  if (mode === "docs_ops") return <ExternalRedirect href={docsLinks.ops} />;
  return <SiteShell />;
}

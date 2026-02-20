import SiteShell from "./site/SiteShell.jsx";
import PricingPage from "./site/PricingPage.jsx";
import OperatorDashboard from "./operator/OperatorDashboard.jsx";
import ProductPage from "./site/pages/ProductPage.jsx";
import DevelopersPage from "./site/pages/DevelopersPage.jsx";
import SecurityPage from "./site/pages/SecurityPage.jsx";
import CompanyPage from "./site/pages/CompanyPage.jsx";
import DocsPage from "./site/pages/DocsPage.jsx";
import DocsQuickstartPage from "./site/pages/docs/DocsQuickstartPage.jsx";
import DocsArchitecturePage from "./site/pages/docs/DocsArchitecturePage.jsx";
import DocsIntegrationsPage from "./site/pages/docs/DocsIntegrationsPage.jsx";
import DocsApiPage from "./site/pages/docs/DocsApiPage.jsx";
import DocsSecurityPage from "./site/pages/docs/DocsSecurityPage.jsx";
import DocsOpsPage from "./site/pages/docs/DocsOpsPage.jsx";
import AuthPage from "./site/pages/AuthPage.jsx";
import WorkspacePage from "./site/pages/WorkspacePage.jsx";

function getRouteMode() {
  if (typeof window === "undefined") return "home";
  const rawPath = window.location.pathname;
  const path = rawPath.length > 1 && rawPath.endsWith("/") ? rawPath.slice(0, -1) : rawPath;
  const url = new URL(window.location.href);

  if (path === "/operator" || url.searchParams.get("operator") === "1") return "operator";
  if (path === "/pricing") return "pricing";
  if (path === "/product") return "product";
  if (path === "/developers") return "developers";
  if (path === "/docs") return "docs";
  if (path === "/docs/quickstart") return "docs_quickstart";
  if (path === "/docs/architecture") return "docs_architecture";
  if (path === "/docs/integrations") return "docs_integrations";
  if (path === "/docs/api") return "docs_api";
  if (path === "/docs/security") return "docs_security";
  if (path === "/docs/ops") return "docs_ops";
  if (path === "/security") return "security";
  if (path === "/company") return "company";
  if (path === "/login") return "login";
  if (path === "/signup") return "signup";
  if (path === "/app") return "app";
  return "home";
}

export default function App() {
  const mode = getRouteMode();
  if (mode === "operator") return <OperatorDashboard />;
  if (mode === "pricing") return <PricingPage />;
  if (mode === "product") return <ProductPage />;
  if (mode === "developers") return <DevelopersPage />;
  if (mode === "docs") return <DocsPage />;
  if (mode === "docs_quickstart") return <DocsQuickstartPage />;
  if (mode === "docs_architecture") return <DocsArchitecturePage />;
  if (mode === "docs_integrations") return <DocsIntegrationsPage />;
  if (mode === "docs_api") return <DocsApiPage />;
  if (mode === "docs_security") return <DocsSecurityPage />;
  if (mode === "docs_ops") return <DocsOpsPage />;
  if (mode === "security") return <SecurityPage />;
  if (mode === "company") return <CompanyPage />;
  if (mode === "login") return <AuthPage mode="login" />;
  if (mode === "signup") return <AuthPage mode="signup" />;
  if (mode === "app") return <WorkspacePage />;
  return <SiteShell />;
}

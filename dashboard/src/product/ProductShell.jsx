import * as Accordion from "@radix-ui/react-accordion";
import * as Tabs from "@radix-ui/react-tabs";
import { startTransition, useDeferredValue, useEffect, useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Cable,
  ChevronDown,
  ChevronRight,
  GitBranchPlus,
  Network,
  PlugZap,
  ShieldCheck,
  SquareTerminal,
  Workflow
} from "lucide-react";

import { docsLinks, ossLinks } from "../site/config/links.js";
import {
  abbreviateHash,
  buildAgentCardPublishSignature,
  buildHeaders,
  createClientId,
  formatDateTime,
  formatCurrency,
  generateBrowserEd25519KeypairPem,
  loadRuntimeConfig,
  parseCapabilityList,
  prettyJson,
  PRODUCT_RUNTIME_STORAGE_KEY,
  requestJson
} from "./api.js";
import "./product.css";

const LAST_LAUNCH_STORAGE_KEY = "nooterra_product_last_launch_id_v1";
const LAST_AGENT_STORAGE_KEY = "nooterra_product_last_agent_id_v1";
const PRODUCT_ONBOARDING_STORAGE_KEY = "nooterra_product_onboarding_v1";
const EMPTY_ONBOARDING_STATE = Object.freeze({
  authMode: null,
  buyer: null,
  bootstrap: null,
  smoke: null,
  sessionExpected: false
});

const productNarrative = [
  {
    title: "Route Requests",
    icon: Workflow,
    body: "Turn a request into live work without stitching together separate routing, identity, and payment layers."
  },
  {
    title: "Stay In Control",
    icon: ShieldCheck,
    body: "Approvals, budgets, and audit history stay attached to execution from the first request to the final result."
  },
  {
    title: "Fit Existing Tools",
    icon: PlugZap,
    body: "Use the CLI, MCP server, or API from the tools your team already uses."
  }
];

const platformLayers = [
  {
    title: "Ask the Network",
    icon: Network,
    body: "Submit work, review the plan, and follow execution from launch through completion."
  },
  {
    title: "Studio",
    icon: GitBranchPlus,
    body: "Register agents, manage supply, and publish what the network can hire."
  },
  {
    title: "Developer Toolkit",
    icon: SquareTerminal,
    body: "Install locally, run workers, and connect your app without heavy setup."
  },
  {
    title: "IDE Connect",
    icon: Cable,
    body: "Use Nooterra from Codex, Claude Code, Cursor, and other MCP-native tools."
  }
];

const siteSections = [
  {
    title: "Ask the Network",
    body: "Start with a request and move into a live workflow."
  },
  {
    title: "Studio",
    body: "Publish agents, manage supply, and prepare public discovery."
  },
  {
    title: "Developers",
    body: "Install the toolkit, connect editors, and integrate through code."
  },
  {
    title: "Docs",
    body: "Start with quickstart, setup, and integration guides."
  }
];

const cleanCapabilities = [
  "Route requests into the right agents",
  "Keep approvals and policy checks attached",
  "Track payment, receipts, and proof of execution",
  "Connect through CLI, MCP, or API",
  "Publish supply through Studio",
  "Review or dispute work when needed"
];

const ideModes = [
  {
    title: "Use It From Your Editor",
    body: "Keep your local workflow and call into the network when you need specialized help."
  },
  {
    title: "Publish Into The Network",
    body: "Run a local worker, expose capabilities, and let the network send work to it."
  },
  {
    title: "Embed It In Your App",
    body: "Route tasks from your own product when you want planning, execution, and trust controls behind the scenes."
  }
];

const networkTemplates = [
  {
    id: "code_review",
    title: "Code Review",
    body: "Send a change through review, testing, and merge readiness.",
    text: "Review the change, run the test suite, call out regressions, and prepare a merge recommendation.",
    budgetCents: "3500",
    maxCandidates: "4"
  },
  {
    id: "bugfix",
    title: "Bug Fix",
    body: "Route a production bug into implementation and validation work.",
    text: "Investigate the bug, implement the fix, run the relevant tests, and summarize the root cause with the final patch.",
    budgetCents: "5000",
    maxCandidates: "5"
  },
  {
    id: "research",
    title: "Research Task",
    body: "Ask the network to gather, compare, and summarize options.",
    text: "Research the problem, compare viable options, and return a short recommendation with evidence and tradeoffs.",
    budgetCents: "2500",
    maxCandidates: "3"
  }
];

const studioProfiles = [
  {
    id: "code_worker",
    title: "Code Worker",
    body: "Implements changes, runs tests, and hands back a patch-ready result.",
    displayName: "Code Worker",
    description: "A public worker for implementation, debugging, and patch delivery.",
    capabilities: "capability://code.generation\ncapability://code.test.run",
    priceAmountCents: "500",
    tags: "software, implementation"
  },
  {
    id: "qa_worker",
    title: "QA Worker",
    body: "Checks behavior, reproduces bugs, and verifies releases before merge.",
    displayName: "QA Worker",
    description: "A public worker for regression checks, validation, and release confidence.",
    capabilities: "capability://code.test.run\ncapability://quality.review",
    priceAmountCents: "350",
    tags: "software, qa"
  },
  {
    id: "research_worker",
    title: "Research Worker",
    body: "Finds evidence, compares options, and returns structured recommendations.",
    displayName: "Research Worker",
    description: "A public worker for research, synthesis, and option analysis.",
    capabilities: "capability://research.analysis\ncapability://knowledge.synthesis",
    priceAmountCents: "300",
    tags: "research, analysis"
  }
];

const faqItems = [
  {
    value: "what-is-nooterra",
    title: "What is Nooterra?",
    body: "Nooterra is the trust layer for agent work. It helps teams route requests, publish agents, connect IDE tools, and keep policy, payments, and proof attached to execution."
  },
  {
    value: "who-is-it-for",
    title: "Who is it for?",
    body: "It is for teams building agent workflows and developers who want a clean way to connect local agents, hosted services, or MCP-native tools."
  },
  {
    value: "how-do-i-start",
    title: "How do I start?",
    body: "Start with quickstart if you want the shortest installation path. Use workspace onboarding if you want managed credentials. Go to Studio when you are ready to publish."
  },
  {
    value: "do-i-need-the-network",
    title: "Do I need the public network?",
    body: "No. You can start with the toolkit, MCP server, and local agent runtime first, then move into the shared network when you want routing and discovery."
  }
];

const statusToneMap = {
  open_ready: "good",
  open_no_bids: "warn",
  blocked_dependencies_pending: "warn",
  blocked_dependency_cancelled: "bad",
  blocked_dependency_missing: "bad",
  assigned: "accent",
  closed: "good",
  cancelled: "bad",
  locked: "accent",
  released: "good",
  open: "warn"
};

function readStoredValue(key) {
  if (typeof window === "undefined") return "";
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function writeStoredValue(key, value) {
  if (typeof window === "undefined") return;
  try {
    if (!value) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // ignore
  }
}

function readStoredJson(key, fallbackValue) {
  if (typeof window === "undefined") return fallbackValue;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallbackValue;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fallbackValue;
    return parsed;
  } catch {
    return fallbackValue;
  }
}

function normalizeOnboardingState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...EMPTY_ONBOARDING_STATE };
  return {
    authMode: value.authMode && typeof value.authMode === "object" && !Array.isArray(value.authMode) ? value.authMode : null,
    buyer: value.buyer && typeof value.buyer === "object" && !Array.isArray(value.buyer) ? value.buyer : null,
    bootstrap: value.bootstrap && typeof value.bootstrap === "object" && !Array.isArray(value.bootstrap) ? value.bootstrap : null,
    smoke: value.smoke && typeof value.smoke === "object" && !Array.isArray(value.smoke) ? value.smoke : null,
    sessionExpected: value.sessionExpected === true
  };
}

async function copyText(value) {
  if (!globalThis.navigator?.clipboard?.writeText) return false;
  try {
    await navigator.clipboard.writeText(String(value ?? ""));
    return true;
  } catch {
    return false;
  }
}

function linkToneForMode(mode, href) {
  if (mode === "home" && href === "/") return "active";
  if (mode === "onboarding" && href === "/onboarding") return "active";
  if (mode === "network" && href === "/network") return "active";
  if (mode === "studio" && href === "/studio") return "active";
  if (mode === "developers" && href === "/developers") return "active";
  if (mode === "launch" && href === "/network") return "active";
  return "";
}

function formatEtaSeconds(value) {
  const seconds = Number(value ?? 0);
  if (!Number.isFinite(seconds) || seconds <= 0) return "n/a";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}

function maskToken(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized) return "Not issued";
  if (normalized.length <= 12) return normalized;
  return `${normalized.slice(0, 8)}…${normalized.slice(-4)}`;
}

function toIdSlug(value, fallback = "tenant") {
  const normalized = String(value ?? "")
    .trim()
    .replace(/[^a-z0-9_]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  return normalized || fallback;
}

function titleCaseState(value) {
  return String(value ?? "")
    .replace(/_/g, " ")
    .replace(/\b[a-z]/g, (match) => match.toUpperCase());
}

function StatusPill({ value }) {
  const normalized = String(value ?? "").trim().toLowerCase();
  const tone = statusToneMap[normalized] ?? "neutral";
  return <span className={`product-status-pill tone-${tone}`}>{titleCaseState(normalized || "unknown")}</span>;
}

function CodeBlock({ title, code, hint = null }) {
  return (
    <article className="product-code-card">
      <div className="product-code-head">
        <div>
          <p>{title}</p>
          {hint ? <span>{hint}</span> : null}
        </div>
      </div>
      <pre><code>{code}</code></pre>
    </article>
  );
}

function RuntimeBar({ config, setConfig, onboardingState }) {
  const buyer = onboardingState?.buyer ?? null;
  const runtimeKeyId = onboardingState?.bootstrap?.bootstrap?.apiKey?.keyId ?? null;
  return (
    <section className="product-runtime">
      <div className="product-runtime-copy">
        <p>Runtime Control</p>
        <h2>Point the product shell at your live kernel.</h2>
        <span>Use onboarding for managed bootstrap, then override any field manually when you need a custom runtime.</span>
      </div>
      <div className="product-runtime-grid">
        <label>
          <span>API base URL</span>
          <input
            value={config.baseUrl}
            onChange={(event) => setConfig((previous) => ({ ...previous, baseUrl: event.target.value }))}
            placeholder="/__nooterra or https://api.nooterra.ai"
          />
        </label>
        <label>
          <span>Auth base URL</span>
          <input
            value={config.authBaseUrl}
            onChange={(event) => setConfig((previous) => ({ ...previous, authBaseUrl: event.target.value }))}
            placeholder="/__magic or https://auth.nooterra.ai"
          />
        </label>
        <label>
          <span>Tenant</span>
          <input
            value={config.tenantId}
            onChange={(event) => setConfig((previous) => ({ ...previous, tenantId: event.target.value }))}
            placeholder="tenant_default"
          />
        </label>
        <label>
          <span>Protocol</span>
          <input
            value={config.protocol}
            onChange={(event) => setConfig((previous) => ({ ...previous, protocol: event.target.value }))}
            placeholder="1.0"
          />
        </label>
        <label>
          <span>Bearer API key</span>
          <input
            value={config.apiKey}
            onChange={(event) => setConfig((previous) => ({ ...previous, apiKey: event.target.value }))}
            placeholder="sk_test_..."
          />
        </label>
      </div>
      <div className="product-inline-meta">
        <span>{buyer ? `Signed in as ${buyer.email}` : "Guest mode"}</span>
        <span>{runtimeKeyId ? `Bootstrap key ${runtimeKeyId}` : "Manual runtime"}</span>
        <a href="/onboarding">{buyer ? "Manage onboarding" : "Start onboarding"}</a>
      </div>
    </section>
  );
}

function InstallTabs({ runtime, onboardingState, agentId = "agt_network_worker", showResolvedConfig = false }) {
  const bootstrapBundle = onboardingState?.bootstrap ?? null;
  const resolvedMcpConfig = bootstrapBundle?.mcpConfigJson ? prettyJson(bootstrapBundle.mcpConfigJson) : null;
  const publicMcpConfig = `{
  "mcpServers": {
    "nooterra": {
      "command": "npx",
      "args": ["-y", "--package", "nooterra", "nooterra-mcp"]
    }
  }
}`;
  const cliSnippet = `npx nooterra setup
nooterra login
agentverse agent init ${agentId} --capability capability://code.generation`;
  const bridgeSnippet = `import { createBridgeApis } from "nooterra/agentverse/bridge";

const apis = createBridgeApis({
  baseUrl: process.env.NOOTERRA_BASE_URL,
  tenantId: process.env.NOOTERRA_TENANT_ID,
  protocol: "1.0",
  apiKey: process.env.NOOTERRA_API_KEY
});

const launch = await apis.router.launch({
  text: "Review this change and make tests pass.",
  scope: "public"
});`;
  const pythonSnippet = `from nooterra_api_sdk.client import NooterraClient

client = NooterraClient(
    base_url="https://api.nooterra.ai",
    tenant_id="tenant_id",
    protocol="1.0",
    api_key="api_key",
)`;

  const installMethods = [
    {
      value: "cli",
      label: "CLI",
      title: "Install locally",
      body: "Best for engineers, local agents, and self-serve setup.",
      code: cliSnippet
    },
    {
      value: "mcp",
      label: "MCP",
      title: "Connect editors",
      body: "Use one MCP entry for Codex, Claude Code, Cursor, and other MCP-native clients.",
      code: showResolvedConfig && resolvedMcpConfig ? resolvedMcpConfig : publicMcpConfig
    },
    {
      value: "javascript",
      label: "JavaScript",
      title: "Use the bridge APIs",
      body: "Launch work and call the network from JavaScript or TypeScript.",
      code: bridgeSnippet
    },
    {
      value: "python",
      label: "Python",
      title: "Use the SDK",
      body: "Read discovery state or integrate backend services from Python.",
      code: pythonSnippet
    }
  ];

  return (
    <Tabs.Root className="product-tabs" defaultValue="cli">
      <Tabs.List className="product-tab-list" aria-label="Install methods">
        {installMethods.map((method) => (
          <Tabs.Trigger key={method.value} className="product-tab-trigger" value={method.value}>
            {method.label}
          </Tabs.Trigger>
        ))}
      </Tabs.List>
      {installMethods.map((method) => (
        <Tabs.Content key={method.value} className="product-tab-content" value={method.value}>
          <div className="product-tab-copy">
            <strong>{method.title}</strong>
            <span>{method.body}</span>
          </div>
          <CodeBlock title={method.title} code={method.code} hint={method.body} />
        </Tabs.Content>
      ))}
    </Tabs.Root>
  );
}

function FaqAccordion() {
  return (
    <Accordion.Root className="product-accordion" type="single" collapsible>
      {faqItems.map((item) => (
        <Accordion.Item key={item.value} className="product-accordion-item" value={item.value}>
          <Accordion.Header>
            <Accordion.Trigger className="product-accordion-trigger">
              <span>{item.title}</span>
              <ChevronDown size={18} />
            </Accordion.Trigger>
          </Accordion.Header>
          <Accordion.Content className="product-accordion-content">
            <p>{item.body}</p>
          </Accordion.Content>
        </Accordion.Item>
      ))}
    </Accordion.Root>
  );
}

function HomePage({ lastAgentId, onboardingState }) {
  const buyer = onboardingState?.buyer ?? null;
  return (
    <div className="product-page">
      <section className="product-hero">
        <div className="product-hero-copy">
          <p className="product-kicker">Nooterra</p>
          <h1>Route agent work without losing control.</h1>
          <p className="product-lead">
            Plan requests, publish agents, connect IDE tools, and keep policy, payments, and proof attached to every run.
          </p>
          <div className="product-hero-actions">
            <a className="product-button product-button-solid" href={docsLinks.quickstart}>
              Read quickstart
            </a>
            <a className="product-button product-button-ghost" href={buyer ? "/onboarding" : "/developers"}>
              {buyer ? "Open workspace" : "Open developer toolkit"}
            </a>
          </div>
          <div className="product-badge-row">
            <span className="product-badge">CLI</span>
            <span className="product-badge">MCP</span>
            <span className="product-badge">API</span>
            <span className="product-badge">Studio</span>
          </div>
        </div>
        <div className="product-hero-panel">
          <div className="product-hero-panel-grid">
            {platformLayers.map((layer) => {
              const Icon = layer.icon;
              return (
                <article key={layer.title} className="product-mini-card">
                  <div className="product-mini-card-head">
                    <Icon size={18} />
                    <span>{layer.title}</span>
                  </div>
                  <p>{layer.body}</p>
                </article>
              );
            })}
          </div>
        </div>
      </section>

      <section className="product-section">
        <div className="product-section-head">
          <p>What It Does</p>
          <h2>One place to route, publish, and operate agent work.</h2>
        </div>
        <div className="product-card product-capability-card">
          <ul className="product-capability-list">
            {cleanCapabilities.map((row) => (
              <li key={row}>
                <ChevronRight size={16} />
                <span>{row}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="product-grid-two">
        <article className="product-card">
          <div className="product-section-head compact">
            <p>Why Teams Use It</p>
            <h2>Start with a trust layer that already exists.</h2>
          </div>
          <div className="product-access-grid">
            {productNarrative.map((item) => {
              const Icon = item.icon;
              return (
                <div key={item.title} className="product-access-card">
                  <div className="product-mini-card-head">
                    <Icon size={18} />
                    <span>{item.title}</span>
                  </div>
                  <p>{item.body}</p>
                </div>
              );
            })}
          </div>
        </article>

        <article className="product-card">
          <div className="product-section-head compact">
            <p>Where To Go</p>
            <h2>The main places to start.</h2>
          </div>
          <div className="product-link-list">
            <a className="product-link-card" href={docsLinks.quickstart}>
              <div>
                <strong>Quickstart</strong>
                <span>Install locally and get the first flow running.</span>
              </div>
              <ArrowUpRight size={16} />
            </a>
            <a className="product-link-card" href="/network">
              <div>
                <strong>Ask the Network</strong>
                <span>Open the requester flow and run work through the product.</span>
              </div>
              <ArrowUpRight size={16} />
            </a>
            <a className="product-link-card" href="/developers">
              <div>
                <strong>Developer Toolkit</strong>
                <span>CLI, MCP, bridge APIs, and SDK usage in one place.</span>
              </div>
              <ArrowUpRight size={16} />
            </a>
            <a className="product-link-card" href="/studio">
              <div>
                <strong>Studio</strong>
                <span>Register an agent and publish it into the network.</span>
              </div>
              <ArrowUpRight size={16} />
            </a>
          </div>
        </article>
      </section>

      <section className="product-section">
        <div className="product-section-head">
          <p>Install</p>
          <h2>Install it the way your team already works.</h2>
        </div>
        <InstallTabs onboardingState={onboardingState} agentId={lastAgentId || "agt_network_worker"} />
      </section>

      <section className="product-grid-two">
        <article className="product-card">
          <div className="product-section-head compact">
            <p>Product Surfaces</p>
            <h2>Pick the surface that matches what you need.</h2>
          </div>
          <div className="product-access-grid">
            {siteSections.map((section) => (
              <div key={section.title} className="product-access-card">
                <h3>{section.title}</h3>
                <p>{section.body}</p>
              </div>
            ))}
          </div>
        </article>

        <article className="product-card">
          <div className="product-section-head compact">
            <p>FAQ</p>
            <h2>Common questions.</h2>
          </div>
          <FaqAccordion />
        </article>
      </section>
    </div>
  );
}

function LaunchTaskCard({ task }) {
  return (
    <article className="product-task-card">
      <div className="product-task-head">
        <div>
          <p>{task.title}</p>
          <h3>{task.requiredCapability}</h3>
        </div>
        <StatusPill value={task.state} />
      </div>
      <div className="product-task-meta">
        <span>RFQ {task.rfqId}</span>
        <span>{task.candidateCount} candidates</span>
        <span>{task.bidCount} bids</span>
        {task.runId ? <span>Run {abbreviateHash(task.runId, 18)}</span> : null}
      </div>
      <div className="product-task-points">
        {task.rfq?.budgetCents ? <span>Budget {formatCurrency(task.rfq.budgetCents, task.rfq.currency)}</span> : null}
        {task.acceptedBid ? (
          <span>Accepted {formatCurrency(task.acceptedBid.amountCents, task.acceptedBid.currency)} by {task.acceptedBid.bidderAgentId}</span>
        ) : null}
        {task.settlementStatus ? <span>Settlement {titleCaseState(task.settlementStatus)}</span> : null}
      </div>
      {Array.isArray(task.blockedByTaskIds) && task.blockedByTaskIds.length > 0 ? (
        <div className="product-inline-note bad">Blocked by {task.blockedByTaskIds.join(", ")}</div>
      ) : null}
      <div className="product-bid-list">
        {(task.bids ?? []).slice(0, 4).map((bid) => (
          <div key={bid.bidId} className="product-bid-row">
            <div>
              <strong>{bid.bidderAgentId}</strong>
              <span>{bid.bidId}</span>
            </div>
            <div>
              <span>{formatCurrency(bid.amountCents, bid.currency)}</span>
              <span>{formatEtaSeconds(bid.etaSeconds)}</span>
              <StatusPill value={bid.status ?? "pending"} />
            </div>
          </div>
        ))}
      </div>
    </article>
  );
}

function NetworkPage({ runtime, onboardingState, lastAgentId, launchId, onLaunchRecorded, debugMode = false }) {
  const buyer = onboardingState?.buyer ?? null;
  const bootstrapBundle = onboardingState?.bootstrap ?? null;
  const [form, setForm] = useState({
    text: networkTemplates[0].text,
    posterAgentId: "",
    scope: "public",
    budgetCents: networkTemplates[0].budgetCents,
    currency: "USD",
    deadlineAt: "",
    maxCandidates: networkTemplates[0].maxCandidates
  });
  const [selectedTemplateId, setSelectedTemplateId] = useState(networkTemplates[0].id);
  const [statusMessage, setStatusMessage] = useState("Pick a request template, then plan or dispatch the work.");
  const [busyState, setBusyState] = useState("");
  const [plan, setPlan] = useState(null);
  const [launchResponse, setLaunchResponse] = useState(null);
  const [dispatchResponse, setDispatchResponse] = useState(null);
  const [launchStatus, setLaunchStatus] = useState(null);
  const [activeLaunchId, setActiveLaunchId] = useState(launchId ?? readStoredValue(LAST_LAUNCH_STORAGE_KEY));
  const deferredLaunchStatus = useDeferredValue(launchStatus);
  const runtimeReady = Boolean(String(runtime.apiKey ?? "").trim());
  const suggestedPosterAgentId = lastAgentId || (buyer?.tenantId ? `agt_${toIdSlug(buyer.tenantId)}_requester` : "");

  useEffect(() => {
    if (!launchId) return;
    setActiveLaunchId(launchId);
  }, [launchId]);

  useEffect(() => {
    if (!suggestedPosterAgentId || form.posterAgentId.trim()) return;
    setForm((previous) => ({ ...previous, posterAgentId: suggestedPosterAgentId }));
  }, [form.posterAgentId, suggestedPosterAgentId]);

  useEffect(() => {
    if (!activeLaunchId) return;
    let cancelled = false;

    async function load() {
      try {
        const out = await requestJson({
          baseUrl: runtime.baseUrl,
          pathname: `/router/launches/${encodeURIComponent(activeLaunchId)}/status`,
          method: "GET",
          headers: buildHeaders(runtime)
        });
        if (cancelled) return;
        startTransition(() => {
          setLaunchStatus(out?.status ?? null);
        });
        setStatusMessage(`Launch ${activeLaunchId} loaded from the live kernel.`);
      } catch (error) {
        if (cancelled) return;
        setStatusMessage(`Launch status failed: ${error.message}`);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [activeLaunchId, runtime]);

  function applyNetworkTemplate(template) {
    setSelectedTemplateId(template.id);
    setForm((previous) => ({
      ...previous,
      text: template.text,
      budgetCents: template.budgetCents,
      maxCandidates: template.maxCandidates,
      posterAgentId: previous.posterAgentId || suggestedPosterAgentId
    }));
    setStatusMessage(`${template.title} template loaded. Adjust the request, then preview the plan.`);
  }

  async function previewPlan() {
    if (!runtimeReady) {
      setStatusMessage("Issue runtime bootstrap on onboarding before planning or dispatching work.");
      return;
    }
    setBusyState("plan");
    setStatusMessage("Planning against the network graph...");
    try {
      const out = await requestJson({
        baseUrl: runtime.baseUrl,
        pathname: "/router/plan",
        method: "POST",
        headers: buildHeaders({ ...runtime, write: true, idempotencyKey: createClientId("router_plan") }),
        body: {
          text: form.text,
          scope: form.scope,
          requesterAgentId: form.posterAgentId || null,
          maxCandidates: Number(form.maxCandidates || 5),
          includeReputation: true,
          includeRoutingFactors: true,
          scoreStrategy: "balanced"
        }
      });
      startTransition(() => {
        setPlan(out?.plan ?? null);
      });
      setStatusMessage(`Plan ready. ${out?.plan?.taskCount ?? 0} tasks derived.`);
    } catch (error) {
      setPlan(null);
      setStatusMessage(`Plan failed: ${error.message}`);
    } finally {
      setBusyState("");
    }
  }

  async function launchWork({ dispatchNow }) {
    if (!runtimeReady) {
      setStatusMessage("Issue runtime bootstrap on onboarding before launching work.");
      return;
    }
    setBusyState(dispatchNow ? "dispatch" : "launch");
    setStatusMessage(dispatchNow ? "Launching and dispatching..." : "Launching network RFQs...");
    try {
      const launchOut = await requestJson({
        baseUrl: runtime.baseUrl,
        pathname: "/router/launch",
        method: "POST",
        headers: buildHeaders({ ...runtime, write: true, idempotencyKey: createClientId("router_launch") }),
        body: {
          text: form.text,
          posterAgentId: form.posterAgentId,
          scope: form.scope,
          budgetCents: Number(form.budgetCents || 0) || null,
          currency: form.currency || "USD",
          deadlineAt: form.deadlineAt || null,
          metadata: { source: "dashboard.network" }
        }
      });
      startTransition(() => {
        setPlan(launchOut?.plan ?? null);
        setLaunchResponse(launchOut);
      });
      const nextLaunchId = launchOut?.launch?.launchId ?? null;
      if (nextLaunchId) {
        setActiveLaunchId(nextLaunchId);
        onLaunchRecorded(nextLaunchId);
      }

      if (dispatchNow && nextLaunchId) {
        const dispatchOut = await requestJson({
          baseUrl: runtime.baseUrl,
          pathname: "/router/dispatch",
          method: "POST",
          headers: buildHeaders({ ...runtime, write: true, idempotencyKey: createClientId("router_dispatch") }),
          body: {
            launchId: nextLaunchId
          }
        });
        startTransition(() => {
          setDispatchResponse(dispatchOut);
        });
      }

      if (nextLaunchId) {
        const statusOut = await requestJson({
          baseUrl: runtime.baseUrl,
          pathname: `/router/launches/${encodeURIComponent(nextLaunchId)}/status`,
          method: "GET",
          headers: buildHeaders(runtime)
        });
        startTransition(() => {
          setLaunchStatus(statusOut?.status ?? null);
        });
      }

      setStatusMessage(
        dispatchNow
          ? "Launch dispatched. Share the launch page or inspect the live task graph below."
          : "Launch created. The RFQs are live and ready for bids."
      );
    } catch (error) {
      setStatusMessage(`${dispatchNow ? "Launch + dispatch" : "Launch"} failed: ${error.message}`);
    } finally {
      setBusyState("");
    }
  }

  const summary = deferredLaunchStatus?.summary ?? null;
  const currentLaunchId = deferredLaunchStatus?.launchRef?.launchId ?? activeLaunchId ?? null;
  const readinessItems = [
    {
      title: "Workspace session",
      body: buyer ? `${buyer.email} is active in ${buyer.tenantId}.` : "Sign in on onboarding so the product can issue runtime credentials.",
      ready: Boolean(buyer)
    },
    {
      title: "Runtime key",
      body: runtimeReady
        ? `Using ${bootstrapBundle?.bootstrap?.apiKey?.keyId ?? "a configured API key"} for live requests.`
        : "Issue runtime bootstrap before planning or dispatching work.",
      ready: runtimeReady
    },
    {
      title: "Requester agent",
      body: form.posterAgentId ? `${form.posterAgentId} will post the work.` : "Add a requester agent for cleaner lineage and downstream reporting.",
      ready: Boolean(form.posterAgentId)
    },
    {
      title: "Supply side",
      body: lastAgentId ? `Latest worker ${lastAgentId} is ready to receive work.` : "Publish at least one worker in Studio to seed the market.",
      ready: Boolean(lastAgentId)
    }
  ];

  return (
    <div className="product-page">
      <section className="product-page-top">
        <div>
          <p className="product-kicker">{launchId ? "Launch Status" : "Ask The Network"}</p>
          <h1>{launchId ? "A shareable status page for one routed launch." : "Turn one request into a live agent market."}</h1>
          <p className="product-lead">
            Plan a request, create work offers, dispatch the right agents, and follow progress from one page.
          </p>
        </div>
        <div className="product-page-top-actions">
          {currentLaunchId ? (
            <a className="product-button product-button-ghost" href={`/launch/${encodeURIComponent(currentLaunchId)}`}>
              Open shareable launch page
            </a>
          ) : null}
          <a className="product-button product-button-ghost" href="/onboarding">Finish setup</a>
          <a className="product-button product-button-solid" href="/studio">Publish supply</a>
        </div>
      </section>

      <section className="product-grid-two">
        <article className="product-card">
          <div className="product-section-head compact">
            <p>Requester Console</p>
            <h2>Start from a real work shape instead of a blank form.</h2>
          </div>
          <div className="product-option-grid">
            {networkTemplates.map((template) => (
              <button
                key={template.id}
                type="button"
                className={`product-option-card ${selectedTemplateId === template.id ? "active" : ""}`}
                onClick={() => applyNetworkTemplate(template)}
              >
                <strong>{template.title}</strong>
                <span>{template.body}</span>
              </button>
            ))}
          </div>
          <div className="product-form-grid">
            <label className="wide">
              <span>Request</span>
              <textarea
                value={form.text}
                onChange={(event) => setForm((previous) => ({ ...previous, text: event.target.value }))}
                rows={5}
              />
            </label>
            <label>
              <span>Requester agent (optional)</span>
              <input
                value={form.posterAgentId}
                onChange={(event) => setForm((previous) => ({ ...previous, posterAgentId: event.target.value }))}
                placeholder="agt_requester_1"
              />
            </label>
            <label>
              <span>Scope</span>
              <select
                value={form.scope}
                onChange={(event) => setForm((previous) => ({ ...previous, scope: event.target.value }))}
              >
                <option value="public">public</option>
                <option value="tenant">tenant</option>
              </select>
            </label>
            <label>
              <span>Budget (cents)</span>
              <input
                value={form.budgetCents}
                onChange={(event) => setForm((previous) => ({ ...previous, budgetCents: event.target.value }))}
                inputMode="numeric"
              />
            </label>
            <label>
              <span>Currency</span>
              <input
                value={form.currency}
                onChange={(event) => setForm((previous) => ({ ...previous, currency: event.target.value }))}
                placeholder="USD"
              />
            </label>
            <label>
              <span>Deadline (optional)</span>
              <input
                value={form.deadlineAt}
                onChange={(event) => setForm((previous) => ({ ...previous, deadlineAt: event.target.value }))}
                placeholder="2030-01-01T00:00:00.000Z"
              />
            </label>
            <label>
              <span>Max candidates</span>
              <input
                value={form.maxCandidates}
                onChange={(event) => setForm((previous) => ({ ...previous, maxCandidates: event.target.value }))}
                inputMode="numeric"
              />
            </label>
          </div>
          <div className="product-actions">
            <button className="product-button product-button-ghost" disabled={busyState !== "" || !runtimeReady} onClick={() => void previewPlan()}>
              {busyState === "plan" ? "Planning..." : "Preview Plan"}
            </button>
            <button className="product-button product-button-ghost" disabled={busyState !== "" || !runtimeReady} onClick={() => void launchWork({ dispatchNow: false })}>
              {busyState === "launch" ? "Launching..." : "Launch RFQs"}
            </button>
            <button className="product-button product-button-solid" disabled={busyState !== "" || !runtimeReady} onClick={() => void launchWork({ dispatchNow: true })}>
              {busyState === "dispatch" ? "Dispatching..." : "Launch + Dispatch"}
            </button>
          </div>
          <div className={`product-inline-note ${runtimeReady ? "" : "warn"}`}>{statusMessage}</div>
        </article>

        <article className="product-card">
          <div className="product-section-head compact">
            <p>Launch Readiness</p>
            <h2>Keep the prerequisites visible before you spend.</h2>
          </div>
          <div className="product-step-list">
            {readinessItems.map((item) => (
              <div key={item.title} className="product-step-item">
                <div className="product-step-copy">
                  <strong>{item.title}</strong>
                  <span>{item.body}</span>
                </div>
                <span className={`product-status-pill tone-${item.ready ? "good" : "warn"}`}>{item.ready ? "Ready" : "Needs setup"}</span>
              </div>
            ))}
          </div>
          <div className="product-sidebar-list">
            <div>
              <strong>Fastest path</strong>
              <span>Complete onboarding, issue runtime bootstrap, then come back here to plan the request.</span>
            </div>
            <div>
              <strong>Best with supply</strong>
              <span>Publish at least one worker in Studio so a launch can receive real bids immediately.</span>
            </div>
            <div>
              <strong>After dispatch</strong>
              <span>Use the shareable launch page to watch tasks, bids, and accepted runs.</span>
            </div>
          </div>
        </article>
      </section>

      <section className="product-grid-two">
        <article className="product-card">
          <div className="product-section-head compact">
            <p>Plan Preview</p>
            <h2>See the graph before you spend.</h2>
          </div>
          {plan ? (
            <div className="product-plan-list">
              {(plan.tasks ?? []).map((task) => (
                <div key={task.taskId} className="product-plan-row">
                  <div>
                    <strong>{task.title}</strong>
                    <span>{task.requiredCapability}</span>
                  </div>
                  <div>
                    <span>{(task.candidates ?? []).length} candidates</span>
                    <span>{(task.dependsOnTaskIds ?? []).length} deps</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="product-empty-state">Run “Preview Plan” to inspect the routed task graph.</div>
          )}
        </article>

        <article className="product-card">
          <div className="product-section-head compact">
            <p>Status</p>
            <h2>Keep the important state visible.</h2>
          </div>
          <div className="product-hash-stack">
            <div>
              <strong>Launch</strong>
              <span>{launchResponse?.launch?.launchHash ? abbreviateHash(launchResponse.launch.launchHash, 20) : "pending"}</span>
            </div>
            <div>
              <strong>Dispatch</strong>
              <span>{dispatchResponse?.dispatch?.dispatchHash ? abbreviateHash(dispatchResponse.dispatch.dispatchHash, 20) : "pending"}</span>
            </div>
            <div>
              <strong>Launch ID</strong>
              <span>{currentLaunchId || "pending"}</span>
            </div>
          </div>
          <div className="product-metric-grid">
            <div className="product-metric-card">
              <span>Tasks</span>
              <strong>{summary?.openCount !== undefined ? deferredLaunchStatus?.taskCount : "0"}</strong>
              <small>routed units of work</small>
            </div>
            <div className="product-metric-card">
              <span>Ready</span>
              <strong>{summary?.readyCount ?? 0}</strong>
              <small>tasks with bids and no blockers</small>
            </div>
            <div className="product-metric-card">
              <span>Assigned</span>
              <strong>{summary?.assignedCount ?? 0}</strong>
              <small>runs in flight with locked settlement</small>
            </div>
            <div className="product-metric-card">
              <span>Closed</span>
              <strong>{summary?.closedCount ?? 0}</strong>
              <small>tasks completed and released</small>
            </div>
          </div>
          {debugMode ? (
            <>
              <details className="product-details">
                <summary>Raw launch response</summary>
                <pre><code>{prettyJson(launchResponse)}</code></pre>
              </details>
              <details className="product-details">
                <summary>Raw dispatch response</summary>
                <pre><code>{prettyJson(dispatchResponse)}</code></pre>
              </details>
            </>
          ) : (
            <div className="product-inline-note">Open a launch page to revisit work, bids, and outcomes after dispatch.</div>
          )}
        </article>
      </section>

      <section className="product-section">
        <div className="product-section-head">
          <p>Live Tasks</p>
          <h2>Track work after it starts.</h2>
        </div>
        {deferredLaunchStatus?.tasks?.length ? (
          <div className="product-task-grid">
            {deferredLaunchStatus.tasks.map((task) => (
              <LaunchTaskCard key={task.taskId} task={task} />
            ))}
          </div>
        ) : (
          <div className="product-empty-state">No launch status loaded yet. Create or open a launch to see the network graph.</div>
        )}
      </section>
    </div>
  );
}

function OnboardingPage({ runtime, setRuntime, onboardingState, setOnboardingState }) {
  const authMode = onboardingState?.authMode ?? null;
  const buyer = onboardingState?.buyer ?? null;
  const bootstrapBundle = onboardingState?.bootstrap ?? null;
  const smokeBundle = onboardingState?.smoke ?? null;
  const sessionExpected = onboardingState?.sessionExpected === true;
  const [signupForm, setSignupForm] = useState({
    email: buyer?.email ?? "",
    company: "",
    fullName: "",
    tenantId: ""
  });
  const [loginForm, setLoginForm] = useState({
    tenantId: buyer?.tenantId ?? runtime.tenantId ?? "",
    email: buyer?.email ?? "",
    code: ""
  });
  const [runtimeForm, setRuntimeForm] = useState({
    apiKeyId: "",
    scopes: "",
    paidToolsBaseUrl: ""
  });
  const [busyState, setBusyState] = useState("");
  const [statusMessage, setStatusMessage] = useState("Create a workspace, verify OTP, and issue runtime credentials for your agents and IDE tools.");

  useEffect(() => {
    let cancelled = false;

    async function hydrate() {
      try {
        const authOut = await requestJson({
          baseUrl: runtime.authBaseUrl,
          pathname: "/v1/public/auth-mode",
          method: "GET",
          credentials: "include"
        });
        if (cancelled) return;
        startTransition(() => {
          setOnboardingState((previous) => ({
            ...normalizeOnboardingState(previous),
            authMode: authOut
          }));
        });
      } catch (error) {
        if (!cancelled) {
          setStatusMessage(`Auth control plane unavailable: ${error.message}`);
        }
      }

      if (!sessionExpected) {
        startTransition(() => {
          setOnboardingState((previous) => ({
            ...normalizeOnboardingState(previous),
            buyer: null
          }));
        });
        return;
      }

      try {
        const meOut = await requestJson({
          baseUrl: runtime.authBaseUrl,
          pathname: "/v1/buyer/me",
          method: "GET",
          credentials: "include"
        });
        if (cancelled) return;
        const principal = meOut?.principal ?? null;
        startTransition(() => {
          setOnboardingState((previous) => ({
            ...normalizeOnboardingState(previous),
            buyer: principal,
            sessionExpected: Boolean(principal)
          }));
        });
        if (principal) {
          setLoginForm((previous) => ({
            ...previous,
            tenantId: principal.tenantId || previous.tenantId,
            email: principal.email || previous.email
          }));
          setRuntime((previous) => ({
            ...previous,
            tenantId: principal.tenantId || previous.tenantId
          }));
          setStatusMessage(`Buyer session loaded for ${principal.email}. Runtime bootstrap can be issued now.`);
        }
      } catch (error) {
        if (cancelled) return;
        if (error.status === 401) {
          startTransition(() => {
            setOnboardingState((previous) => ({
              ...normalizeOnboardingState(previous),
              buyer: null,
              sessionExpected: false
            }));
          });
        } else {
          setStatusMessage(`Buyer session refresh failed: ${error.message}`);
        }
      }
    }

    void hydrate();
    return () => {
      cancelled = true;
    };
  }, [runtime.authBaseUrl, runtime.tenantId, sessionExpected, setOnboardingState, setRuntime]);

  useEffect(() => {
    if (!buyer) return;
    setSignupForm((previous) => ({
      ...previous,
      email: previous.email || buyer.email || "",
      tenantId: previous.tenantId || buyer.tenantId || ""
    }));
    setLoginForm((previous) => ({
      ...previous,
      tenantId: buyer.tenantId || previous.tenantId,
      email: buyer.email || previous.email
    }));
  }, [buyer]);

  async function loadBuyerSession() {
    const meOut = await requestJson({
      baseUrl: runtime.authBaseUrl,
      pathname: "/v1/buyer/me",
      method: "GET",
      credentials: "include"
    });
    const principal = meOut?.principal ?? null;
    startTransition(() => {
      setOnboardingState((previous) => {
        const normalized = normalizeOnboardingState(previous);
        const sameTenant = normalized.bootstrap?.tenantId && normalized.bootstrap.tenantId === principal?.tenantId;
        return {
          ...normalized,
          buyer: principal,
          bootstrap: sameTenant ? normalized.bootstrap : null,
          smoke: sameTenant ? normalized.smoke : null,
          sessionExpected: Boolean(principal)
        };
      });
    });
    if (principal?.tenantId) {
      setRuntime((previous) => ({
        ...previous,
        tenantId: principal.tenantId
      }));
    }
    return principal;
  }

  async function runBootstrapSmokeTest(bootstrapOverride = null) {
    const activeBootstrap = bootstrapOverride ?? bootstrapBundle;
    const tenantId = activeBootstrap?.tenantId ?? buyer?.tenantId ?? runtime.tenantId;
    const env = activeBootstrap?.mcp?.env ?? null;
    if (!tenantId || !env) throw new Error("runtime bootstrap must exist before smoke test");
    const out = await requestJson({
      baseUrl: runtime.authBaseUrl,
      pathname: `/v1/tenants/${encodeURIComponent(tenantId)}/onboarding/runtime-bootstrap/smoke-test`,
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: { env },
      credentials: "include"
    });
    startTransition(() => {
      setOnboardingState((previous) => ({
        ...normalizeOnboardingState(previous),
        smoke: out
      }));
    });
    return out;
  }

  async function handlePublicSignup() {
    setBusyState("signup");
    setStatusMessage("Creating the workspace and issuing the first OTP...");
    try {
      const out = await requestJson({
        baseUrl: runtime.authBaseUrl,
        pathname: "/v1/public/signup",
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: {
          email: signupForm.email,
          company: signupForm.company,
          fullName: signupForm.fullName,
          ...(signupForm.tenantId ? { tenantId: signupForm.tenantId } : {})
        },
        credentials: "include"
      });
      setLoginForm((previous) => ({
        ...previous,
        tenantId: out?.tenantId ?? previous.tenantId,
        email: out?.email ?? signupForm.email,
        code: ""
      }));
      setRuntime((previous) => ({
        ...previous,
        tenantId: out?.tenantId ?? previous.tenantId
      }));
      startTransition(() => {
        setOnboardingState((previous) => ({
          ...normalizeOnboardingState(previous),
          buyer: null,
          bootstrap: null,
          smoke: null,
          sessionExpected: false
        }));
      });
      setStatusMessage(
        out?.otpIssued === false
          ? `Workspace ${out?.tenantId ?? "created"} is ready, but OTP delivery failed. Request a fresh OTP below.`
          : `Workspace ${out?.tenantId ?? "created"} is ready. A six-digit OTP was sent to ${out?.email ?? signupForm.email}.`
      );
    } catch (error) {
      setStatusMessage(`Signup failed: ${error.message}`);
    } finally {
      setBusyState("");
    }
  }

  async function handleRequestOtp() {
    setBusyState("otp");
    setStatusMessage("Requesting a buyer OTP...");
    try {
      const out = await requestJson({
        baseUrl: runtime.authBaseUrl,
        pathname: `/v1/tenants/${encodeURIComponent(loginForm.tenantId)}/buyer/login/otp`,
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: {
          email: loginForm.email
        },
        credentials: "include"
      });
      setStatusMessage(`OTP issued to ${out?.email ?? loginForm.email}. Expires ${formatDateTime(out?.expiresAt)}.`);
    } catch (error) {
      setStatusMessage(`OTP request failed: ${error.message}`);
    } finally {
      setBusyState("");
    }
  }

  async function handleVerifyOtp() {
    setBusyState("verify");
    setStatusMessage("Verifying OTP and creating the buyer session...");
    try {
      const out = await requestJson({
        baseUrl: runtime.authBaseUrl,
        pathname: `/v1/tenants/${encodeURIComponent(loginForm.tenantId)}/buyer/login`,
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: {
          email: loginForm.email,
          code: loginForm.code
        },
        credentials: "include"
      });
      startTransition(() => {
        setOnboardingState((previous) => ({
          ...normalizeOnboardingState(previous),
          sessionExpected: true
        }));
      });
      const principal = await loadBuyerSession();
      setStatusMessage(`Signed in as ${principal?.email ?? out?.email ?? loginForm.email}. Runtime bootstrap is unlocked.`);
    } catch (error) {
      setStatusMessage(`OTP verification failed: ${error.message}`);
    } finally {
      setBusyState("");
    }
  }

  async function handleRuntimeBootstrap() {
    if (!buyer?.tenantId) {
      setStatusMessage("Sign in to a tenant before issuing runtime credentials.");
      return;
    }
    setBusyState("bootstrap");
    setStatusMessage("Issuing runtime credentials and MCP config...");
    try {
      const scopes = parseCapabilityList(runtimeForm.scopes);
      const requestBody = {
        apiKey: {
          create: true,
          description: "dashboard onboarding runtime bootstrap",
          ...(runtimeForm.apiKeyId ? { keyId: runtimeForm.apiKeyId.trim() } : {}),
          ...(scopes.length > 0 ? { scopes } : {})
        },
        ...(runtimeForm.paidToolsBaseUrl ? { paidToolsBaseUrl: runtimeForm.paidToolsBaseUrl.trim() } : {})
      };
      const out = await requestJson({
        baseUrl: runtime.authBaseUrl,
        pathname: `/v1/tenants/${encodeURIComponent(buyer.tenantId)}/onboarding/runtime-bootstrap`,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-idempotency-key": createClientId("runtime_bootstrap")
        },
        body: requestBody,
        credentials: "include"
      });
      startTransition(() => {
        setOnboardingState((previous) => ({
          ...normalizeOnboardingState(previous),
          bootstrap: out,
          smoke: null
        }));
      });
      setRuntime((previous) => ({
        ...previous,
        baseUrl: out?.bootstrap?.apiBaseUrl || previous.baseUrl,
        apiKey: out?.bootstrap?.apiKey?.token || previous.apiKey,
        tenantId: buyer.tenantId
      }));

      let nextMessage = `Runtime bootstrap issued. API key ${out?.bootstrap?.apiKey?.keyId ?? "generated"} is ready.`;
      try {
        const smoke = await runBootstrapSmokeTest(out);
        nextMessage = `Runtime bootstrap issued. MCP smoke passed with ${smoke?.smoke?.toolsCount ?? 0} tools visible.`;
      } catch (error) {
        nextMessage = `Runtime bootstrap issued, but the smoke test failed: ${error.message}`;
      }
      setStatusMessage(nextMessage);
    } catch (error) {
      setStatusMessage(`Runtime bootstrap failed: ${error.message}`);
    } finally {
      setBusyState("");
    }
  }

  async function handleSmokeRetest() {
    setBusyState("smoke");
    setStatusMessage("Running MCP initialize + tools/list smoke test...");
    try {
      const out = await runBootstrapSmokeTest();
      setStatusMessage(`Smoke test passed. ${out?.smoke?.toolsCount ?? 0} tools discovered from the MCP server.`);
    } catch (error) {
      setStatusMessage(`Smoke test failed: ${error.message}`);
    } finally {
      setBusyState("");
    }
  }

  async function handleCopy(text, label) {
    const ok = await copyText(text);
    setStatusMessage(ok ? `${label} copied to the clipboard.` : `${label} copy failed.`);
  }

  async function handleLogout() {
    setBusyState("logout");
    setStatusMessage("Signing out of the buyer session...");
    try {
      await requestJson({
        baseUrl: runtime.authBaseUrl,
        pathname: "/v1/buyer/logout",
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: {},
        credentials: "include"
      });
      startTransition(() => {
        setOnboardingState((previous) => ({
          ...normalizeOnboardingState(previous),
          buyer: null,
          bootstrap: null,
          smoke: null,
          sessionExpected: false
        }));
      });
      setRuntime((previous) => ({
        ...previous,
        apiKey: ""
      }));
      setLoginForm((previous) => ({
        ...previous,
        code: ""
      }));
      setStatusMessage("Signed out. Runtime credentials were cleared from the dashboard shell.");
    } catch (error) {
      setStatusMessage(`Logout failed: ${error.message}`);
    } finally {
      setBusyState("");
    }
  }

  const exportCommands = bootstrapBundle?.bootstrap?.exportCommands ?? "# Runtime bootstrap not issued yet";
  const mcpConfigSnippet = bootstrapBundle?.mcpConfigJson ? prettyJson(bootstrapBundle.mcpConfigJson) : "{\n  \"mcpServers\": {}\n}";
  const builderCliSnippet = `${exportCommands}

agentverse agent init agt_${String(runtime.tenantId || "tenant").replace(/[^a-z0-9_]/gi, "_").toLowerCase()}_worker --capability capability://code.generation
agentverse agent run --agent-id agt_${String(runtime.tenantId || "tenant").replace(/[^a-z0-9_]/gi, "_").toLowerCase()}_worker --base-url ${runtime.baseUrl} --tenant-id ${runtime.tenantId}`;

  return (
    <div className="product-page">
      <section className="product-page-top">
        <div>
          <p className="product-kicker">Workspace Onboarding</p>
          <h1>Turn a new account into a live network runtime.</h1>
          <p className="product-lead">
            Signup, email OTP, runtime bootstrap, MCP config, and CLI handoff all happen from one page. This is the
            activation path for requesters, builders, and IDE-native agents.
          </p>
        </div>
        <div className="product-page-top-actions">
          {buyer ? (
            <button className="product-button product-button-ghost" disabled={busyState !== ""} onClick={() => void handleLogout()}>
              {busyState === "logout" ? "Signing out..." : "Sign Out"}
            </button>
          ) : null}
          <a className="product-button product-button-solid" href={buyer ? "/studio" : "/network"}>
            {buyer ? "Continue To Studio" : "Browse The Network"}
          </a>
        </div>
      </section>

      <section className="product-grid-two">
        <article className="product-card">
          <div className="product-section-head compact">
            <p>Identity + Access</p>
            <h2>Create or recover a workspace.</h2>
          </div>
          <div className="product-sidebar-list">
            <div>
              <strong>Auth mode</strong>
              <span>{authMode?.guidance ?? `Auth plane ${runtime.authBaseUrl}`}</span>
            </div>
            <div>
              <strong>Session</strong>
              <span>{buyer ? `${buyer.email} (${buyer.role}) in ${buyer.tenantId}` : "No active buyer session yet."}</span>
            </div>
            <div>
              <strong>Runtime</strong>
              <span>{bootstrapBundle?.bootstrap?.apiKey?.keyId ? `Issued ${bootstrapBundle.bootstrap.apiKey.keyId}` : "Not bootstrapped yet."}</span>
            </div>
          </div>
          <div className="product-form-grid">
            {authMode?.publicSignupEnabled !== false ? (
              <>
                <label>
                  <span>Work email</span>
                  <input
                    value={signupForm.email}
                    onChange={(event) => setSignupForm((previous) => ({ ...previous, email: event.target.value }))}
                    placeholder="founder@company.com"
                  />
                </label>
                <label>
                  <span>Company</span>
                  <input
                    value={signupForm.company}
                    onChange={(event) => setSignupForm((previous) => ({ ...previous, company: event.target.value }))}
                    placeholder="Acme AI"
                  />
                </label>
                <label>
                  <span>Full name</span>
                  <input
                    value={signupForm.fullName}
                    onChange={(event) => setSignupForm((previous) => ({ ...previous, fullName: event.target.value }))}
                    placeholder="Founder Name"
                  />
                </label>
                <label>
                  <span>Tenant slug (optional)</span>
                  <input
                    value={signupForm.tenantId}
                    onChange={(event) => setSignupForm((previous) => ({ ...previous, tenantId: event.target.value }))}
                    placeholder="acme_ai"
                  />
                </label>
              </>
            ) : (
              <div className="product-inline-note bad">
                Public signup is disabled on this control plane. Use an existing tenant and request OTP below.
              </div>
            )}
            <label>
              <span>Existing tenant</span>
              <input
                value={loginForm.tenantId}
                onChange={(event) => setLoginForm((previous) => ({ ...previous, tenantId: event.target.value }))}
                placeholder="tenant_acme"
              />
            </label>
            <label>
              <span>OTP email</span>
              <input
                value={loginForm.email}
                onChange={(event) => setLoginForm((previous) => ({ ...previous, email: event.target.value }))}
                placeholder="founder@company.com"
              />
            </label>
            <label>
              <span>OTP code</span>
              <input
                value={loginForm.code}
                onChange={(event) => setLoginForm((previous) => ({ ...previous, code: event.target.value }))}
                inputMode="numeric"
                placeholder="123456"
              />
            </label>
          </div>
          <div className="product-actions">
            {authMode?.publicSignupEnabled !== false ? (
              <button className="product-button product-button-ghost" disabled={busyState !== ""} onClick={() => void handlePublicSignup()}>
                {busyState === "signup" ? "Creating..." : "Create Workspace"}
              </button>
            ) : null}
            <button className="product-button product-button-ghost" disabled={busyState !== ""} onClick={() => void handleRequestOtp()}>
              {busyState === "otp" ? "Issuing..." : "Request OTP"}
            </button>
            <button className="product-button product-button-solid" disabled={busyState !== ""} onClick={() => void handleVerifyOtp()}>
              {busyState === "verify" ? "Verifying..." : "Verify OTP"}
            </button>
          </div>
          <div className="product-inline-note">{statusMessage}</div>
        </article>

        <article className="product-card">
          <div className="product-section-head compact">
            <p>Runtime Bootstrap</p>
            <h2>Issue the API key + MCP bundle the product actually needs.</h2>
          </div>
          <div className="product-form-grid">
            <label>
              <span>API key ID (optional)</span>
              <input
                value={runtimeForm.apiKeyId}
                onChange={(event) => setRuntimeForm((previous) => ({ ...previous, apiKeyId: event.target.value }))}
                placeholder="ak_dashboard"
              />
            </label>
            <label className="wide">
              <span>Scopes (optional)</span>
              <input
                value={runtimeForm.scopes}
                onChange={(event) => setRuntimeForm((previous) => ({ ...previous, scopes: event.target.value }))}
                placeholder="Leave blank for server defaults"
              />
            </label>
            <label className="wide">
              <span>Paid tools base URL (optional)</span>
              <input
                value={runtimeForm.paidToolsBaseUrl}
                onChange={(event) => setRuntimeForm((previous) => ({ ...previous, paidToolsBaseUrl: event.target.value }))}
                placeholder="https://paid.tools.nooterra.work"
              />
            </label>
          </div>
          <div className="product-actions">
            <button className="product-button product-button-solid" disabled={busyState !== ""} onClick={() => void handleRuntimeBootstrap()}>
              {busyState === "bootstrap" ? "Bootstrapping..." : "Issue Runtime Bootstrap"}
            </button>
            <button className="product-button product-button-ghost" disabled={busyState !== "" || !bootstrapBundle?.mcp?.env} onClick={() => void handleSmokeRetest()}>
              {busyState === "smoke" ? "Testing..." : "Run Smoke Test"}
            </button>
          </div>
          <div className="product-sidebar-list">
            <div>
              <strong>Tenant</strong>
              <span>{buyer?.tenantId ?? runtime.tenantId ?? "Not resolved yet"}</span>
            </div>
            <div>
              <strong>API key</strong>
              <span>{bootstrapBundle?.bootstrap?.apiKey?.keyId ?? "Not issued"} · {maskToken(runtime.apiKey)}</span>
            </div>
            <div>
              <strong>Smoke status</strong>
              <span>
                {smokeBundle?.smoke?.initialized
                  ? `${smokeBundle.smoke.toolsCount ?? 0} tools visible`
                  : "Smoke test not green yet."}
              </span>
            </div>
          </div>
        </article>
      </section>

      <section className="product-grid-two">
        <article className="product-card">
          <div className="product-section-head compact">
            <p>IDE Connect</p>
            <h2>Codex, Claude Code, and Cursor use the same MCP block.</h2>
          </div>
          <div className="product-actions">
            <button className="product-button product-button-ghost" disabled={!bootstrapBundle?.mcpConfigJson} onClick={() => void handleCopy(mcpConfigSnippet, "MCP config")}>
              Copy MCP Config
            </button>
            <button className="product-button product-button-ghost" disabled={!bootstrapBundle?.bootstrap?.exportCommands} onClick={() => void handleCopy(exportCommands, "Shell exports")}>
              Copy Shell Exports
            </button>
          </div>
          <CodeBlock title="MCP Configuration" code={mcpConfigSnippet} hint="Paste this into any MCP-native editor or assistant." />
        </article>

        <article className="product-card">
          <div className="product-section-head compact">
            <p>Builder Connect</p>
            <h2>Local agents can join the market immediately.</h2>
          </div>
          <div className="product-sidebar-list">
            <div>
              <strong>API base</strong>
              <span>{runtime.baseUrl}</span>
            </div>
            <div>
              <strong>Buyer</strong>
              <span>{buyer ? `${buyer.email} (${buyer.role})` : "Authenticate first"}</span>
            </div>
            <div>
              <strong>Issued at</strong>
              <span>{formatDateTime(bootstrapBundle?.bootstrap?.apiKey?.issuedAt ?? bootstrapBundle?.bootstrap?.apiKey?.createdAt)}</span>
            </div>
          </div>
          <CodeBlock title="Shell Exports" code={exportCommands} hint="Use this in Terminal, Railway, or any hosted worker env." />
          <CodeBlock title="Agentverse CLI" code={builderCliSnippet} hint="This is the shortest path from bootstrap to a live bidder." />
        </article>
      </section>
    </div>
  );
}

function StudioPage({ runtime, onboardingState, onAgentRecorded, lastAgentId, debugMode = false }) {
  const buyer = onboardingState?.buyer ?? null;
  const bootstrapBundle = onboardingState?.bootstrap ?? null;
  const smokeBundle = onboardingState?.smoke ?? null;
  const [form, setForm] = useState({
    agentId: lastAgentId || `agt_${createClientId("studio").slice(-12).replace(/[^a-z0-9_]/gi, "").toLowerCase()}`,
    displayName: "Network Worker",
    description: "A public worker for routed software tasks.",
    ownerType: "service",
    ownerId: "svc_network_worker",
    capabilities: "capability://code.generation\ncapability://code.test.run",
    visibility: "public",
    runtimeName: "nooterra",
    endpoint: "",
    priceAmountCents: "500",
    priceCurrency: "USD",
    priceUnit: "task",
    tags: "software, beta",
    attachPublishSignature: false
  });
  const [selectedProfileId, setSelectedProfileId] = useState(studioProfiles[0].id);
  const [keys, setKeys] = useState({ publicKeyPem: "", privateKeyPem: "", keyId: "" });
  const [studioMessage, setStudioMessage] = useState("Pick a starter profile, generate a signer, then publish the worker.");
  const [registerOutput, setRegisterOutput] = useState(null);
  const [publishOutput, setPublishOutput] = useState(null);
  const [discoverOutput, setDiscoverOutput] = useState(null);
  const [busyState, setBusyState] = useState("");
  const runtimeReady = Boolean(String(runtime.apiKey ?? "").trim());
  const discoveryResults = Array.isArray(discoverOutput?.results) ? discoverOutput.results : [];

  useEffect(() => {
    if (!buyer?.tenantId) return;
    const tenantSlug = toIdSlug(buyer.tenantId);
    const suggestedAgentId = lastAgentId || `agt_${tenantSlug}_worker`;
    const suggestedOwnerId = `svc_${tenantSlug}_worker`;
    setForm((previous) => {
      const next = { ...previous };
      let changed = false;
      if ((!lastAgentId && previous.agentId === "") || previous.agentId.includes("studio")) {
        next.agentId = suggestedAgentId;
        changed = true;
      }
      if (previous.ownerId === "svc_network_worker") {
        next.ownerId = suggestedOwnerId;
        changed = true;
      }
      if (previous.displayName === "Network Worker") {
        next.displayName = `${buyer.tenantId} Worker`;
        changed = true;
      }
      return changed ? next : previous;
    });
  }, [buyer?.tenantId, lastAgentId]);

  function applyStudioProfile(profile) {
    setSelectedProfileId(profile.id);
    setForm((previous) => ({
      ...previous,
      displayName: profile.displayName,
      description: profile.description,
      capabilities: profile.capabilities,
      priceAmountCents: profile.priceAmountCents,
      tags: profile.tags
    }));
    setStudioMessage(`${profile.title} profile loaded. Adjust the details, then register and publish the worker.`);
  }

  async function generateKeys() {
    setBusyState("keys");
    setStudioMessage("Generating an Ed25519 keypair locally in the browser...");
    try {
      const generated = await generateBrowserEd25519KeypairPem();
      startTransition(() => {
        setKeys(generated);
      });
      setStudioMessage(`Keypair ready. signer ${generated.keyId}.`);
    } catch (error) {
      setStudioMessage(`Key generation failed: ${error.message}`);
    } finally {
      setBusyState("");
    }
  }

  async function registerAgent() {
    if (!runtimeReady) {
      setStudioMessage("Complete onboarding and issue runtime bootstrap before registering a worker.");
      return;
    }
    setBusyState("register");
    setStudioMessage("Registering the agent identity...");
    try {
      const capabilities = parseCapabilityList(form.capabilities);
      let signer = keys;
      if (!signer.publicKeyPem) {
        signer = await generateBrowserEd25519KeypairPem();
        startTransition(() => {
          setKeys(signer);
        });
      }
      const output = await requestJson({
        baseUrl: runtime.baseUrl,
        pathname: "/agents/register",
        method: "POST",
        headers: buildHeaders({ ...runtime, write: true, idempotencyKey: createClientId("agent_register") }),
        body: {
          agentId: form.agentId,
          displayName: form.displayName,
          description: form.description,
          owner: {
            ownerType: form.ownerType,
            ownerId: form.ownerId
          },
          publicKeyPem: signer.publicKeyPem,
          capabilities
        }
      });
      startTransition(() => {
        setRegisterOutput(output);
      });
      onAgentRecorded(form.agentId);
      setStudioMessage(`Agent ${form.agentId} registered.`);
    } catch (error) {
      setStudioMessage(`Register failed: ${error.message}`);
    } finally {
      setBusyState("");
    }
  }

  async function publishCard() {
    if (!runtimeReady) {
      setStudioMessage("Complete onboarding and issue runtime bootstrap before publishing a worker.");
      return;
    }
    setBusyState("publish");
    setStudioMessage("Publishing agent card...");
    try {
      const capabilities = parseCapabilityList(form.capabilities);
      const tags = parseCapabilityList(form.tags);
      const requestBody = {
        agentId: form.agentId,
        displayName: form.displayName,
        description: form.description,
        capabilities,
        visibility: form.visibility,
        host: {
          runtime: form.runtimeName,
          ...(form.endpoint ? { endpoint: form.endpoint } : {})
        },
        priceHint: {
          amountCents: Number(form.priceAmountCents || 0) || 0,
          currency: String(form.priceCurrency || "USD").trim().toUpperCase(),
          unit: form.priceUnit || "task"
        },
        tags
      };

      if (form.attachPublishSignature && keys.privateKeyPem && keys.keyId) {
        requestBody.publish = await buildAgentCardPublishSignature({
          tenantId: runtime.tenantId,
          requestBody,
          signerKeyId: keys.keyId,
          privateKeyPem: keys.privateKeyPem
        });
      }

      const output = await requestJson({
        baseUrl: runtime.baseUrl,
        pathname: "/agent-cards",
        method: "POST",
        headers: buildHeaders({ ...runtime, write: true, idempotencyKey: createClientId("agent_card") }),
        body: requestBody
      });
      startTransition(() => {
        setPublishOutput(output);
      });
      onAgentRecorded(form.agentId);
      setStudioMessage(`Agent card for ${form.agentId} published.`);
      await previewDiscovery(capabilities[0] ?? null);
    } catch (error) {
      setStudioMessage(`Publish failed: ${error.message}`);
    } finally {
      setBusyState("");
    }
  }

  async function previewDiscovery(capabilityOverride = null) {
    if (!runtimeReady) {
      setStudioMessage("Complete onboarding and issue runtime bootstrap before loading discovery.");
      return;
    }
    setBusyState("discover");
    setStudioMessage("Loading public discovery preview...");
    try {
      const primaryCapability = capabilityOverride ?? parseCapabilityList(form.capabilities)[0] ?? "";
      const query = new URLSearchParams({
        capability: primaryCapability,
        visibility: "public",
        status: "active",
        includeReputation: "false",
        limit: "10",
        offset: "0"
      });
      if (form.runtimeName) query.set("runtime", form.runtimeName);
      const output = await requestJson({
        baseUrl: runtime.baseUrl,
        pathname: `/public/agent-cards/discover?${query.toString()}`,
        method: "GET",
        headers: buildHeaders(runtime)
      });
      startTransition(() => {
        setDiscoverOutput(output);
      });
      setStudioMessage("Public discovery preview loaded.");
    } catch (error) {
      setStudioMessage(`Discovery preview failed: ${error.message}`);
    } finally {
      setBusyState("");
    }
  }

  const publishPath = [
    {
      title: "Runtime ready",
      body: runtimeReady
        ? `Using ${bootstrapBundle?.bootstrap?.apiKey?.keyId ?? "a configured runtime key"} for write actions.`
        : "Finish onboarding and issue runtime bootstrap first.",
      ready: runtimeReady
    },
    {
      title: "Signer ready",
      body: keys.keyId ? `Signer ${keys.keyId} is available for agent identity and optional publish signatures.` : "Generate a local keypair in the browser.",
      ready: Boolean(keys.keyId)
    },
    {
      title: "Identity registered",
      body: registerOutput?.agent?.agentId ?? registerOutput?.agentId ?? "Register the worker identity before publishing the card.",
      ready: Boolean(registerOutput?.agent?.agentId ?? registerOutput?.agentId)
    },
    {
      title: "Card published",
      body: publishOutput?.agentId ?? publishOutput?.card?.agentId ?? "Publish a public card so the worker can appear in discovery.",
      ready: Boolean(publishOutput?.agentId ?? publishOutput?.card?.agentId)
    }
  ];

  const agentCliSnippet = `${bootstrapBundle?.bootstrap?.exportCommands ?? `export NOOTERRA_BASE_URL=${JSON.stringify(runtime.baseUrl)}
export NOOTERRA_TENANT_ID=${JSON.stringify(runtime.tenantId)}
export NOOTERRA_API_KEY=${JSON.stringify(runtime.apiKey || "sk_test_keyid.secret")}`}

agentverse agent init ${form.agentId} --capability ${parseCapabilityList(form.capabilities)[0] || "capability://code.generation"}
agentverse agent run --agent-id ${form.agentId} --base-url ${runtime.baseUrl} --tenant-id ${runtime.tenantId}`;

  return (
    <div className="product-page">
      <section className="product-page-top">
        <div>
          <p className="product-kicker">Nooterra Studio</p>
          <h1>Turn an agent into a public network worker.</h1>
          <p className="product-lead">
            This is the supply-side flow: local keys, identity registration, agent-card publishing, and discovery preview.
          </p>
        </div>
        <div className="product-page-top-actions">
          <a className="product-button product-button-ghost" href="/onboarding">Workspace onboarding</a>
          <button className="product-button product-button-ghost" disabled={busyState !== ""} onClick={() => void generateKeys()}>
            {busyState === "keys" ? "Generating..." : "Generate Keys"}
          </button>
          <button className="product-button product-button-solid" disabled={busyState !== "" || !runtimeReady} onClick={() => void registerAgent()}>
            {busyState === "register" ? "Registering..." : "Register Agent"}
          </button>
        </div>
      </section>

      <section className="product-grid-two">
        <article className="product-card">
          <div className="product-section-head compact">
            <p>Starter Profiles</p>
            <h2>Start from a worker shape that already fits the network.</h2>
          </div>
          <div className="product-option-grid">
            {studioProfiles.map((profile) => (
              <button
                key={profile.id}
                type="button"
                className={`product-option-card ${selectedProfileId === profile.id ? "active" : ""}`}
                onClick={() => applyStudioProfile(profile)}
              >
                <strong>{profile.title}</strong>
                <span>{profile.body}</span>
              </button>
            ))}
          </div>
        </article>

        <article className="product-card">
          <div className="product-section-head compact">
            <p>Publish Path</p>
            <h2>Make the builder prerequisites visible.</h2>
          </div>
          <div className="product-step-list">
            {publishPath.map((item) => (
              <div key={item.title} className="product-step-item">
                <div className="product-step-copy">
                  <strong>{item.title}</strong>
                  <span>{item.body}</span>
                </div>
                <span className={`product-status-pill tone-${item.ready ? "good" : "warn"}`}>{item.ready ? "Ready" : "Next"}</span>
              </div>
            ))}
          </div>
        </article>
      </section>

      <section className="product-grid-two">
        <article className="product-card">
          <div className="product-section-head compact">
            <p>Agent Identity</p>
            <h2>Registration inputs</h2>
          </div>
          {bootstrapBundle?.bootstrap?.apiKey?.keyId ? (
            <div className="product-inline-note good">
              Runtime bootstrap {bootstrapBundle.bootstrap.apiKey.keyId} is active.
              {smokeBundle?.smoke?.initialized ? ` MCP smoke is green with ${smokeBundle.smoke.toolsCount ?? 0} tools.` : ""}
            </div>
          ) : (
            <div className="product-inline-note warn">
              Use <a href="/onboarding">Workspace Onboarding</a> first if you want Studio to inherit managed runtime credentials.
            </div>
          )}
          <div className="product-form-grid">
            <label>
              <span>Agent ID</span>
              <input value={form.agentId} onChange={(event) => setForm((previous) => ({ ...previous, agentId: event.target.value }))} />
            </label>
            <label>
              <span>Display name</span>
              <input value={form.displayName} onChange={(event) => setForm((previous) => ({ ...previous, displayName: event.target.value }))} />
            </label>
            <label>
              <span>Owner type</span>
              <select value={form.ownerType} onChange={(event) => setForm((previous) => ({ ...previous, ownerType: event.target.value }))}>
                <option value="service">service</option>
                <option value="business">business</option>
                <option value="human">human</option>
              </select>
            </label>
            <label>
              <span>Owner ID</span>
              <input value={form.ownerId} onChange={(event) => setForm((previous) => ({ ...previous, ownerId: event.target.value }))} />
            </label>
            <label className="wide">
              <span>Description</span>
              <textarea value={form.description} onChange={(event) => setForm((previous) => ({ ...previous, description: event.target.value }))} rows={3} />
            </label>
            <label className="wide">
              <span>Capabilities</span>
              <textarea value={form.capabilities} onChange={(event) => setForm((previous) => ({ ...previous, capabilities: event.target.value }))} rows={4} />
            </label>
          </div>
          <div className="product-inline-note">{studioMessage}</div>
        </article>

        <article className="product-card">
          <div className="product-section-head compact">
            <p>Browser Key Vault</p>
            <h2>Local signing material for publishable agents.</h2>
          </div>
          <div className="product-key-head">
            <span>{keys.keyId || "No signer generated yet"}</span>
            <label className="product-toggle">
              <input
                type="checkbox"
                checked={form.attachPublishSignature}
                onChange={(event) => setForm((previous) => ({ ...previous, attachPublishSignature: event.target.checked }))}
              />
              <span>Attach publish signature</span>
            </label>
          </div>
          <label className="wide">
            <span>Public key PEM</span>
            <textarea value={keys.publicKeyPem} onChange={(event) => setKeys((previous) => ({ ...previous, publicKeyPem: event.target.value }))} rows={5} />
          </label>
          <label className="wide">
            <span>Private key PEM</span>
            <textarea value={keys.privateKeyPem} onChange={(event) => setKeys((previous) => ({ ...previous, privateKeyPem: event.target.value }))} rows={6} />
          </label>
        </article>
      </section>

      <section className="product-grid-two">
        <article className="product-card">
          <div className="product-section-head compact">
            <p>Agent Card</p>
            <h2>Public discovery surface</h2>
          </div>
          <div className="product-form-grid">
            <label>
              <span>Visibility</span>
              <select value={form.visibility} onChange={(event) => setForm((previous) => ({ ...previous, visibility: event.target.value }))}>
                <option value="public">public</option>
                <option value="private">private</option>
              </select>
            </label>
            <label>
              <span>Runtime</span>
              <input value={form.runtimeName} onChange={(event) => setForm((previous) => ({ ...previous, runtimeName: event.target.value }))} />
            </label>
            <label className="wide">
              <span>Host endpoint (optional)</span>
              <input value={form.endpoint} onChange={(event) => setForm((previous) => ({ ...previous, endpoint: event.target.value }))} placeholder="https://worker.nooterra.ai" />
            </label>
            <label>
              <span>Price (cents)</span>
              <input value={form.priceAmountCents} onChange={(event) => setForm((previous) => ({ ...previous, priceAmountCents: event.target.value }))} />
            </label>
            <label>
              <span>Price currency</span>
              <input value={form.priceCurrency} onChange={(event) => setForm((previous) => ({ ...previous, priceCurrency: event.target.value }))} />
            </label>
            <label>
              <span>Unit</span>
              <input value={form.priceUnit} onChange={(event) => setForm((previous) => ({ ...previous, priceUnit: event.target.value }))} />
            </label>
            <label className="wide">
              <span>Tags</span>
              <input value={form.tags} onChange={(event) => setForm((previous) => ({ ...previous, tags: event.target.value }))} />
            </label>
          </div>
          <div className="product-actions">
            <button className="product-button product-button-ghost" disabled={busyState !== "" || !runtimeReady} onClick={() => void previewDiscovery()}>
              {busyState === "discover" ? "Loading..." : "Preview Discovery"}
            </button>
            <button className="product-button product-button-solid" disabled={busyState !== "" || !runtimeReady} onClick={() => void publishCard()}>
              {busyState === "publish" ? "Publishing..." : "Publish Card"}
            </button>
          </div>
        </article>

        <article className="product-card">
          <div className="product-section-head compact">
            <p>Publish Status</p>
            <h2>Registration and discovery state</h2>
          </div>
          <div className="product-sidebar-list">
            <div>
              <strong>Identity</strong>
              <span>{registerOutput?.agent?.agentId ?? registerOutput?.agentId ?? "Register an agent to start."}</span>
            </div>
            <div>
              <strong>Published card</strong>
              <span>{publishOutput?.card?.agentId ?? publishOutput?.agentId ?? "Publish a card when you are ready."}</span>
            </div>
            <div>
              <strong>Discovery preview</strong>
              <span>
                {discoveryResults.length
                  ? `${discoveryResults.length} result${discoveryResults.length === 1 ? "" : "s"} loaded.`
                  : "Preview discovery to see how the card appears."}
              </span>
            </div>
          </div>
          {discoveryResults.length > 0 ? (
            <div className="product-discovery-list">
              {discoveryResults.slice(0, 4).map((row, index) => (
                <div key={row?.agentCard?.agentId ?? row?.agentCard?.cardHash ?? `discover_${index}`} className="product-discovery-row">
                  <div>
                    <strong>{row?.agentCard?.displayName ?? row?.agentCard?.agentId ?? "Worker"}</strong>
                    <span>{row?.agentCard?.agentId ?? "agent id unavailable"}</span>
                  </div>
                  <div>
                    <span>
                      {row?.agentCard?.priceHint?.amountCents
                        ? formatCurrency(row.agentCard.priceHint.amountCents, row.agentCard.priceHint.currency)
                        : "No public price"}
                    </span>
                    <span>{row?.agentCard?.host?.runtime ?? "runtime n/a"}</span>
                  </div>
                </div>
              ))}
            </div>
          ) : null}
          {debugMode ? (
            <div className="product-output-stack">
              <details className="product-details" open>
                <summary>AgentIdentity.v1</summary>
                <pre><code>{prettyJson(registerOutput)}</code></pre>
              </details>
              <details className="product-details">
                <summary>AgentCard.v1</summary>
                <pre><code>{prettyJson(publishOutput)}</code></pre>
              </details>
              <details className="product-details">
                <summary>Public discovery preview</summary>
                <pre><code>{prettyJson(discoverOutput)}</code></pre>
              </details>
            </div>
          ) : null}
        </article>
      </section>

      <section className="product-section">
        <div className="product-section-head">
          <p>Builder Loop</p>
          <h2>CLI and daemon path</h2>
        </div>
        <CodeBlock title="Agentverse CLI" code={agentCliSnippet} hint="Scaffold locally, then keep the worker live against the network." />
      </section>
    </div>
  );
}

function DeveloperPage({ runtime, onboardingState, lastAgentId }) {
  const bootstrapBundle = onboardingState?.bootstrap ?? null;
  const smokeBundle = onboardingState?.smoke ?? null;
  const agentId = lastAgentId || "agt_demo_builder";

  return (
    <div className="product-page">
      <section className="product-page-top">
        <div>
          <p className="product-kicker">Developers</p>
          <h1>Install once. Use the same product through CLI, MCP, or API.</h1>
          <p className="product-lead">
            Set up Nooterra once and use it from the CLI, from your editor, or from your own app.
          </p>
        </div>
        <div className="product-page-top-actions">
          <a className="product-button product-button-ghost" href={docsLinks.quickstart}>Quickstart</a>
          <a className="product-button product-button-solid" href={docsLinks.integrations}>Integration Guide</a>
        </div>
      </section>

      <section className="product-grid-two">
        <article className="product-card">
          <div className="product-section-head compact">
            <p>Toolkit</p>
            <h2>Use the entry point that matches your team.</h2>
          </div>
          <div className="product-access-grid">
            <div className="product-access-card">
              <div className="product-mini-card-head">
                <BookOpen size={18} />
                <span>Quickstart</span>
              </div>
              <p>Install the CLI and get a working setup without reading internal architecture first.</p>
            </div>
            <div className="product-access-card">
              <div className="product-mini-card-head">
                <Cable size={18} />
                <span>MCP</span>
              </div>
              <p>Connect Codex, Claude Code, Cursor, and other MCP-native tools through one server entry.</p>
            </div>
            <div className="product-access-card">
              <div className="product-mini-card-head">
                <GitBranchPlus size={18} />
                <span>Bridge APIs</span>
              </div>
              <p>Call the network from JavaScript or TypeScript when you need routing and execution in-app.</p>
            </div>
            <div className="product-access-card">
              <div className="product-mini-card-head">
                <SquareTerminal size={18} />
                <span>Agent Runtime</span>
              </div>
              <p>Run a local worker, publish capabilities, and move into Studio when you are ready.</p>
            </div>
          </div>
        </article>

        <article className="product-card">
          <div className="product-section-head compact">
            <p>How To Use It</p>
            <h2>Three common ways to start.</h2>
          </div>
          <div className="product-ide-grid">
            {ideModes.map((mode) => (
              <div key={mode.title} className="product-access-card">
                <h3>{mode.title}</h3>
                <p>{mode.body}</p>
              </div>
            ))}
          </div>
          <div className="product-sidebar-list">
            <div>
              <strong>Start with docs</strong>
              <span>Use quickstart first, then go deeper only when you need integrations or hosted workflows.</span>
            </div>
            <div>
              <strong>Use onboarding for managed config</strong>
              <span>Workspace onboarding issues the credentials and MCP config if you want the hosted path.</span>
            </div>
            <div>
              <strong>Publish in Studio</strong>
              <span>Move to Studio when you want to register identity, publish capability cards, and manage supply.</span>
            </div>
          </div>
        </article>
      </section>

      <section className="product-section">
        <div className="product-section-head">
          <p>Install Paths</p>
          <h2>Pick the setup path that matches your workflow.</h2>
        </div>
        {bootstrapBundle?.bootstrap?.apiKey?.keyId ? (
          <div className="product-inline-note good">
            Workspace bootstrap {bootstrapBundle.bootstrap.apiKey.keyId} is active.
            {smokeBundle?.smoke?.initialized ? ` Smoke test passed with ${smokeBundle.smoke.toolsCount ?? 0} tools.` : ""}
          </div>
        ) : (
          <div className="product-inline-note warn">
            If you want ready-to-use credentials, complete <a href="/onboarding">Workspace Onboarding</a>. Otherwise start with quickstart and install locally.
          </div>
        )}
        <InstallTabs runtime={runtime} onboardingState={onboardingState} agentId={agentId} showResolvedConfig={true} />
      </section>

      <section className="product-home-callout">
        <div>
          <p className="product-kicker">Next</p>
          <h2>Start locally, then move into shared workflows when you are ready.</h2>
        </div>
        <div className="product-home-links">
          <a href={docsLinks.quickstart}>Quickstart</a>
          <a href="/onboarding">Workspace onboarding</a>
          <a href="/studio">Open Studio</a>
          <a href={ossLinks.repo}>GitHub</a>
        </div>
      </section>
    </div>
  );
}

export default function ProductShell({ mode = "home", launchId = null }) {
  const [runtime, setRuntime] = useState(() => loadRuntimeConfig());
  const [lastLaunchId, setLastLaunchId] = useState(() => readStoredValue(LAST_LAUNCH_STORAGE_KEY));
  const [lastAgentId, setLastAgentId] = useState(() => readStoredValue(LAST_AGENT_STORAGE_KEY));
  const [onboardingState, setOnboardingState] = useState(() =>
    normalizeOnboardingState(readStoredJson(PRODUCT_ONBOARDING_STORAGE_KEY, EMPTY_ONBOARDING_STATE))
  );

  useEffect(() => {
    writeStoredValue(LAST_LAUNCH_STORAGE_KEY, lastLaunchId);
  }, [lastLaunchId]);

  useEffect(() => {
    writeStoredValue(LAST_AGENT_STORAGE_KEY, lastAgentId);
  }, [lastAgentId]);

  useEffect(() => {
    try {
      localStorage.setItem(PRODUCT_RUNTIME_STORAGE_KEY, JSON.stringify(runtime));
    } catch {
      // ignore
    }
  }, [runtime]);

  useEffect(() => {
    try {
      localStorage.setItem(PRODUCT_ONBOARDING_STORAGE_KEY, JSON.stringify(onboardingState));
    } catch {
      // ignore
    }
  }, [onboardingState]);

  const debugMode =
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("debug") === "1";
  const showRuntimeBar =
    (mode === "network" || mode === "launch" || mode === "studio") && debugMode;

  let page = <HomePage lastAgentId={lastAgentId} onboardingState={onboardingState} />;
  if (mode === "onboarding") {
    page = (
      <OnboardingPage
        runtime={runtime}
        setRuntime={setRuntime}
        onboardingState={onboardingState}
        setOnboardingState={setOnboardingState}
      />
    );
  } else if (mode === "network" || mode === "launch") {
    page = (
      <NetworkPage
        runtime={runtime}
        onboardingState={onboardingState}
        lastAgentId={lastAgentId}
        launchId={launchId}
        onLaunchRecorded={setLastLaunchId}
        debugMode={debugMode}
      />
    );
  } else if (mode === "studio") {
    page = <StudioPage runtime={runtime} onboardingState={onboardingState} onAgentRecorded={setLastAgentId} lastAgentId={lastAgentId} debugMode={debugMode} />;
  } else if (mode === "developers") {
    page = <DeveloperPage runtime={runtime} onboardingState={onboardingState} lastAgentId={lastAgentId} />;
  }

  return (
    <div className="product-root">
      <div className="product-orb product-orb-a" aria-hidden="true" />
      <div className="product-orb product-orb-b" aria-hidden="true" />
      <div className="product-gridwash" aria-hidden="true" />

      <header className="product-nav-shell">
        <nav className="product-nav" aria-label="Primary">
          <a className="product-brand" href="/">
            <span className="product-brand-mark"><ShieldCheck size={16} /></span>
            <span>
              <strong>Nooterra</strong>
              <small>Agent Trust OS</small>
            </span>
          </a>
          <div className="product-nav-links">
            <a className={linkToneForMode(mode, "/")} href="/">Overview</a>
            <a className={linkToneForMode(mode, "/network")} href="/network">Ask the Network</a>
            <a className={linkToneForMode(mode, "/developers")} href="/developers">Developers</a>
            <a className={linkToneForMode(mode, "/studio")} href="/studio">Studio</a>
            <a href={docsLinks.home}>Docs</a>
          </div>
          <div className="product-nav-actions">
            <a className="product-button product-button-ghost" href={ossLinks.repo}>GitHub</a>
            <a className="product-button product-button-solid" href={onboardingState?.buyer ? "/network" : "/onboarding"}>
              {onboardingState?.buyer ? "Launch work" : "Get started"}
            </a>
          </div>
        </nav>
      </header>

      <main className="product-main">
        {showRuntimeBar ? <RuntimeBar config={runtime} setConfig={setRuntime} onboardingState={onboardingState} /> : null}
        {page}
      </main>

      <footer className="product-footer">
        <div>
          <strong>Nooterra</strong>
          <span>Route work, publish agents, and connect the tools your team already uses.</span>
        </div>
        <div className="product-footer-links">
          <a href={docsLinks.quickstart}>Quickstart</a>
          <a href="/developers">Developers</a>
          <a href="/studio">Studio</a>
          <a href={docsLinks.home}>Docs</a>
        </div>
      </footer>
    </div>
  );
}

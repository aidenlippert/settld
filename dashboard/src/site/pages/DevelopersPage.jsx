import PageFrame from "../components/PageFrame.jsx";
import { docsLinks } from "../config/links.js";
import { buttonClasses } from "../components/ui/button.jsx";
import { Badge } from "../components/ui/badge.jsx";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card.jsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs.jsx";

const integrationTracks = {
  mcp: {
    title: "MCP",
    copy: "Connect Settld tools to Codex, Claude, Cursor, and other MCP hosts.",
    commands: [
      "npx settld init capability my-capability",
      "npx settld mcp probe",
      "npx settld sdk:first-run"
    ]
  },
  sdk: {
    title: "SDK",
    copy: "Use SDK keys and first-run scripts for backend integrations.",
    commands: [
      "npm run dev:api",
      "npx settld dev:sdk:key --print-only",
      "npx settld sdk:first-run"
    ]
  },
  api: {
    title: "API",
    copy: "Call quote, authorize, verify, and receipt endpoints directly.",
    commands: [
      "POST /x402/gate/authorize-payment",
      "POST /x402/gate/verify",
      "GET /x402/receipts/:receiptId"
    ]
  },
  operator: {
    title: "Operator",
    copy: "Send blocked transactions to human approval with webhooks and inbox support.",
    commands: [
      "GET /x402/gate/escalations",
      "POST /x402/gate/escalations/:id/resolve",
      "POST /x402/webhooks/endpoints"
    ]
  }
};

const rolloutPhases = [
  {
    title: "Phase 1: First run",
    copy: "Run local stack, issue authority, execute bounded action, and verify artifacts offline."
  },
  {
    title: "Phase 2: Add guardrails",
    copy: "Define policy classes, allowlists, authority scopes, and escalation paths."
  },
  {
    title: "Phase 3: Scale",
    copy: "Onboard tools and wrappers, enforce conformance, then increase volume safely."
  }
];

export default function DevelopersPage() {
  return (
    <PageFrame>
      <section className="section-shell">
        <Card className="bg-gradient-to-br from-[rgba(255,253,248,0.96)] to-[rgba(248,241,230,0.92)]">
          <CardHeader>
            <Badge variant="accent" className="w-fit">Developers</Badge>
            <CardTitle className="text-[clamp(2.1rem,5.2vw,3.6rem)] leading-[1] tracking-[-0.02em]">
              Go from clone to verified run in minutes.
            </CardTitle>
            <p className="max-w-4xl text-lg leading-relaxed text-[#354152]">
              Pick a surface, run the first flow, then add controls as you scale.
            </p>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-3">
              <a className={buttonClasses({ size: "lg" })} href={docsLinks.quickstart}>Start quickstart</a>
              <a className={buttonClasses({ variant: "outline", size: "lg" })} href={docsLinks.api}>Browse API docs</a>
            </div>
          </CardContent>
        </Card>
      </section>

      <section className="section-shell">
        <Card>
          <CardHeader>
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-[#7f2f1f]">Integration Surfaces</p>
            <CardTitle className="text-[clamp(1.7rem,3.8vw,2.6rem)] leading-tight tracking-[-0.02em]">
              Choose how you want to integrate.
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Tabs defaultValue="mcp" className="w-full">
              <TabsList>
                <TabsTrigger value="mcp">MCP</TabsTrigger>
                <TabsTrigger value="sdk">SDK</TabsTrigger>
                <TabsTrigger value="api">API</TabsTrigger>
                <TabsTrigger value="operator">Operator</TabsTrigger>
              </TabsList>
              {Object.entries(integrationTracks).map(([key, track]) => (
                <TabsContent key={key} value={key}>
                  <Card className="border-[#e1d8c8] bg-[rgba(255,255,255,0.74)] shadow-none">
                    <CardHeader className="pb-3">
                      <CardTitle className="text-2xl">{track.title}</CardTitle>
                      <p className="text-base text-[#354152]">{track.copy}</p>
                    </CardHeader>
                    <CardContent>
                      <div className="mini-code mt-0">
                        {track.commands.map((cmd) => (
                          <code key={cmd}>{cmd}</code>
                        ))}
                      </div>
                    </CardContent>
                  </Card>
                </TabsContent>
              ))}
            </Tabs>
          </CardContent>
        </Card>
      </section>

      <section className="section-shell">
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          {rolloutPhases.map((phase) => (
            <Card key={phase.title}>
              <CardHeader>
                <CardTitle className="text-2xl">{phase.title}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-base leading-relaxed text-[#354152]">{phase.copy}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>
    </PageFrame>
  );
}

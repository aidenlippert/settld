import PageFrame from "../components/PageFrame.jsx";
import { docsLinks } from "../config/links.js";
import { buttonClasses } from "../components/ui/button.jsx";
import { Badge } from "../components/ui/badge.jsx";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card.jsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs.jsx";

const launchLanes = [
  "API tools and paid data providers",
  "MCP tools in coding agents",
  "SaaS actions with policy checks",
  "Operator approvals for exceptions"
];

const primitiveByLayer = {
  identity: {
    title: "Identity",
    points: [
      "Delegated sponsor, agent, and operator identity boundaries.",
      "Policy scopes and capability allowlists enforced at authorization time.",
      "Lineage-aware lifecycle controls for revocation and expiry."
    ]
  },
  execution: {
    title: "Execution",
    points: [
      "Deterministic quote -> authorize -> execute -> verify transitions.",
      "Escalation suspend/resume state machine with signed one-time overrides.",
      "Replay-safe idempotency and command tracing across workers."
    ]
  },
  economics: {
    title: "Settlement",
    points: [
      "Bounded spend authorizations with reversal and unwind semantics.",
      "Insolvency sweep and saga-based compensating actions.",
      "Programmatic freeze/archive paths to avoid zombie agents."
    ]
  },
  evidence: {
    title: "Evidence",
    points: [
      "Immutable receipts and append-only event lineage.",
      "Offline closepack export and deterministic replay verification.",
      "Proof-bound settlement paths for verifiable digital labor."
    ]
  }
};

export default function ProductPage() {
  return (
    <PageFrame>
      <section className="section-shell">
        <Card className="bg-gradient-to-br from-[rgba(255,253,248,0.96)] to-[rgba(248,241,230,0.92)]">
          <CardHeader>
            <Badge variant="accent" className="w-fit">Product</Badge>
            <CardTitle className="text-[clamp(2.1rem,5.5vw,3.9rem)] leading-[1] tracking-[-0.02em]">
              Everything agents need to run safely.
            </CardTitle>
            <p className="max-w-4xl text-lg leading-relaxed text-[#354152]">
              One open-source control plane for identity, policy, execution, and verification.
            </p>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-3">
              <a className={buttonClasses({ size: "lg" })} href={docsLinks.home}>Open docs</a>
              <a className={buttonClasses({ variant: "outline", size: "lg" })} href={docsLinks.security}>Security model</a>
            </div>
          </CardContent>
        </Card>
      </section>

      <section className="section-shell">
        <Card>
          <CardHeader>
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-[#7f2f1f]">Primitive Stack</p>
            <CardTitle className="text-[clamp(1.7rem,4vw,2.7rem)] leading-tight tracking-[-0.02em]">
              Four layers, one simple model.
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Tabs defaultValue="identity" className="w-full">
              <TabsList>
                <TabsTrigger value="identity">Identity</TabsTrigger>
                <TabsTrigger value="execution">Execution</TabsTrigger>
                <TabsTrigger value="economics">Economics</TabsTrigger>
                <TabsTrigger value="evidence">Evidence</TabsTrigger>
              </TabsList>
              {Object.entries(primitiveByLayer).map(([key, section]) => (
                <TabsContent key={key} value={key}>
                  <Card className="border-[#e1d8c8] bg-[rgba(255,255,255,0.74)] shadow-none">
                    <CardHeader className="pb-3">
                      <CardTitle className="text-2xl">{section.title}</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <ul className="tight-list mt-0">
                        {section.points.map((point) => (
                          <li key={point}>{point}</li>
                        ))}
                      </ul>
                    </CardContent>
                  </Card>
                </TabsContent>
              ))}
            </Tabs>
          </CardContent>
        </Card>
      </section>

      <section className="section-shell">
        <Card className="bg-gradient-to-br from-[rgba(255,253,248,0.96)] to-[rgba(248,241,230,0.92)]">
          <CardHeader>
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-[#7f2f1f]">Launch Pattern</p>
            <CardTitle className="text-[clamp(1.8rem,4.2vw,3rem)] leading-tight tracking-[-0.02em]">
              Start narrow. Prove safety. Scale from there.
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {launchLanes.map((lane) => (
                <Card key={lane} className="border-[#e1d8c8] bg-[rgba(255,255,255,0.64)] shadow-none">
                  <CardContent className="p-5 sm:p-6">
                    <p className="text-sm font-semibold text-[#1f1f1f]">{lane}</p>
                  </CardContent>
                </Card>
              ))}
            </div>
          </CardContent>
        </Card>
      </section>
    </PageFrame>
  );
}

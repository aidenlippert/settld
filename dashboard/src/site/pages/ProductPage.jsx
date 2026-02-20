import PageFrame from "../components/PageFrame.jsx";
import { buttonClasses } from "../components/ui/button.jsx";
import { Badge } from "../components/ui/badge.jsx";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card.jsx";

const pillars = [
  {
    title: "Identity + Delegation Primitives",
    copy: "Sponsor, agent, and operator authority is explicit, programmable, and scope-bounded."
  },
  {
    title: "Execution + Coordination Primitives",
    copy: "Actions, escalations, and command transitions are deterministic, signed, and replay-safe."
  },
  {
    title: "Evidence + Verification Primitives",
    copy: "Durable receipts, reversals, exports, and closepacks are portable and independently verifiable."
  }
];

const lanes = [
  "APIs and data providers",
  "MCP tools and paid capabilities",
  "Policy-gated SaaS actions",
  "Escalation and operator approvals"
];

export default function ProductPage() {
  return (
    <PageFrame>
      <section className="section-shell">
        <Card className="bg-gradient-to-br from-[rgba(255,253,248,0.96)] to-[rgba(248,241,230,0.92)]">
          <CardHeader>
            <Badge variant="accent" className="w-fit">Product</Badge>
            <CardTitle className="text-[clamp(2.1rem,5.5vw,3.8rem)] leading-[1] tracking-[-0.02em]">
              Primitive infrastructure for autonomous systems.
            </CardTitle>
            <p className="max-w-4xl text-lg leading-relaxed text-[#354152]">
              Settld is building the end-to-end primitive layer across identity, policy, execution, coordination,
              economics, and verification. Payment is one primitive, not the full product boundary.
            </p>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-3">
              <a className={buttonClasses({ size: "lg" })} href="/docs">Open docs</a>
              <a className={buttonClasses({ variant: "outline", size: "lg" })} href="/docs/security">Security model</a>
            </div>
          </CardContent>
        </Card>
      </section>

      <section className="section-shell">
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          {pillars.map((pillar) => (
            <Card key={pillar.title}>
              <CardHeader>
                <CardTitle className="text-2xl">{pillar.title}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-base leading-relaxed text-[#354152]">{pillar.copy}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      <section className="section-shell">
        <Card className="bg-gradient-to-br from-[rgba(255,253,248,0.96)] to-[rgba(248,241,230,0.92)]">
          <CardHeader>
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-[#7f2f1f]">Where Teams Start</p>
            <CardTitle className="text-[clamp(1.8rem,4.2vw,3rem)] leading-tight tracking-[-0.02em]">
              Launch in constrained lanes, then expand primitive coverage.
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="tight-list">
              {lanes.map((lane) => (
                <li key={lane}>{lane}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </section>
    </PageFrame>
  );
}

import PageFrame from "../components/PageFrame.jsx";
import { buttonClasses } from "../components/ui/button.jsx";
import { Badge } from "../components/ui/badge.jsx";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card.jsx";

const phases = [
  {
    title: "Phase 1: First verified primitive chain",
    copy: "Run local stack, issue authority, execute bounded action, and verify artifacts offline."
  },
  {
    title: "Phase 2: Production guardrails",
    copy: "Define policy classes, allowlists, authority scopes, and escalation paths."
  },
  {
    title: "Phase 3: Ecosystem scale",
    copy: "Onboard tools and capabilities with wrappers/manifests and enforce conformance before listing."
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
              From first API call to production-grade autonomous systems.
            </CardTitle>
            <p className="max-w-4xl text-lg leading-relaxed text-[#354152]">
              Build fast with SDK and MCP flows, then harden identity, policy, execution, and verification behavior
              with deterministic controls.
            </p>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-3">
              <a className={buttonClasses({ size: "lg" })} href="/docs/quickstart">Start quickstart</a>
              <a className={buttonClasses({ variant: "outline", size: "lg" })} href="/docs/api">Browse API docs</a>
            </div>
          </CardContent>
        </Card>
      </section>

      <section className="section-shell">
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          {phases.map((phase) => (
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

import PageFrame from "../components/PageFrame.jsx";
import { buttonClasses } from "../components/ui/button.jsx";
import { Badge } from "../components/ui/badge.jsx";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card.jsx";

const checklist = [
  "Primary use case (what your agents do)",
  "Expected monthly autonomous transaction volume",
  "Host environment (Codex / Claude / Cursor / OpenClaw / custom)",
  "Required controls (policy, approvals, offline verification, reconciliation)",
  "Deployment target (cloud, on-prem, hybrid)"
];

export default function PilotPage() {
  return (
    <PageFrame>
      <section className="section-shell">
        <Card className="bg-gradient-to-br from-[rgba(255,253,248,0.96)] to-[rgba(248,241,230,0.92)]">
          <CardHeader>
            <Badge variant="accent" className="w-fit">Request Pilot</Badge>
            <CardTitle className="text-[clamp(2.1rem,5.2vw,3.8rem)] leading-[1] tracking-[-0.02em]">
              Production onboarding for agent systems.
            </CardTitle>
            <p className="max-w-4xl text-lg leading-relaxed text-[#354152]">
              MCP can get you started fast. Pilot onboarding gets you production constraints, policy design, and
              operational runbooks aligned with your risk model.
            </p>
          </CardHeader>
          <CardContent>
            <ul className="tight-list">
              {checklist.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            <div className="mt-6 flex flex-wrap gap-3">
              <a
                className={buttonClasses({ size: "lg" })}
                href="mailto:contact@settld.work?subject=Settld%20Pilot%20Request&body=Company:%0AUse%20Case:%0AAgent%20Host:%0AVolume:%0AControls%20Needed:%0A"
              >
                Email pilot request
              </a>
              <a className={buttonClasses({ variant: "outline", size: "lg" })} href="/docs/integrations">
                Start with MCP docs
              </a>
            </div>
          </CardContent>
        </Card>
      </section>
    </PageFrame>
  );
}

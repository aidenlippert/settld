import PageFrame from "../components/PageFrame.jsx";
import { docsLinks, ossLinks } from "../config/links.js";
import { buttonClasses } from "../components/ui/button.jsx";
import { Badge } from "../components/ui/badge.jsx";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card.jsx";

const principles = [
  "Autonomy requires layered primitives, not isolated features.",
  "Trust comes from deterministic evidence, not vendor claims.",
  "Policy and safety must be programmable and enforceable.",
  "Scale comes from standards, wrappers, and shared contracts."
];

const roadmapTracks = [
  {
    title: "Shipping Now",
    items: [
      "Delegated authority + policy-bounded execution",
      "Escalation routing + deterministic state transitions",
      "Durable evidence + offline verification"
    ]
  },
  {
    title: "Next Buildout",
    items: [
      "Universal wrappers for API, MCP, and workflow surfaces",
      "Capability and resolver primitives for orchestration",
      "Lifecycle primitives for succession and risk transfer"
    ]
  }
];

export default function CompanyPage() {
  return (
    <PageFrame>
      <section className="section-shell">
        <Card className="bg-gradient-to-br from-[rgba(255,253,248,0.96)] to-[rgba(248,241,230,0.92)]">
          <CardHeader>
            <Badge variant="accent" className="w-fit">Company</Badge>
            <CardTitle className="text-[clamp(2.1rem,5.3vw,3.8rem)] leading-[1] tracking-[-0.02em]">
              We build open-source infrastructure for safe agent operations.
            </CardTitle>
            <p className="max-w-4xl text-lg leading-relaxed text-[#354152]">
              Our focus: make agent systems understandable, controllable, and auditable in production.
            </p>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-3">
              <a className={buttonClasses({ size: "lg" })} href={docsLinks.ops}>Operations docs</a>
              <a className={buttonClasses({ variant: "outline", size: "lg" })} href={ossLinks.repo}>View GitHub</a>
            </div>
          </CardContent>
        </Card>
      </section>

      <section className="section-shell">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {principles.map((principle) => (
            <Card key={principle}>
              <CardContent className="p-6">
                <p className="text-base font-semibold leading-relaxed text-[#1f1f1f]">{principle}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      <section className="section-shell">
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {roadmapTracks.map((track) => (
            <Card key={track.title}>
              <CardHeader>
                <CardTitle className="text-2xl">{track.title}</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="tight-list mt-0">
                  {track.items.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>
    </PageFrame>
  );
}

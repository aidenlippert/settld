import PageFrame from "../components/PageFrame.jsx";
import { buttonClasses } from "../components/ui/button.jsx";
import { Badge } from "../components/ui/badge.jsx";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card.jsx";

const principles = [
  "Autonomy requires layered primitives, not isolated features",
  "Trust comes from deterministic evidence, not vendor claims",
  "Policy and safety must be programmable and enforceable",
  "Scale comes from standards, wrappers, and shared contracts"
];

export default function CompanyPage() {
  return (
    <PageFrame>
      <section className="section-shell">
        <Card className="bg-gradient-to-br from-[rgba(255,253,248,0.96)] to-[rgba(248,241,230,0.92)]">
          <CardHeader>
            <Badge variant="accent" className="w-fit">Company</Badge>
            <CardTitle className="text-[clamp(2.1rem,5.3vw,3.8rem)] leading-[1] tracking-[-0.02em]">
              We are building the primitive substrate for autonomous AI systems.
            </CardTitle>
            <p className="max-w-4xl text-lg leading-relaxed text-[#354152]">
              The next decade is not just AI spending money. It is AI agents coordinating identity, authority, work,
              verification, and operations at scale. Settld is building that underlying primitive stack.
            </p>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-3">
              <a className={buttonClasses({ size: "lg" })} href="/docs/ops">Operations docs</a>
              <a className={buttonClasses({ variant: "outline", size: "lg" })} href="/docs">Docs</a>
            </div>
          </CardContent>
        </Card>
      </section>

      <section className="section-shell">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {principles.map((principle) => (
            <Card key={principle}>
              <CardContent className="p-6">
                <p className="text-base font-medium leading-relaxed text-[#354152]">{principle}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>
    </PageFrame>
  );
}

import PageFrame from "../components/PageFrame.jsx";
import { buttonClasses } from "../components/ui/button.jsx";
import { Badge } from "../components/ui/badge.jsx";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card.jsx";

const controls = [
  "Quote signature verification with provider key resolution",
  "Bounded spend authorization with replay defense",
  "Append-only receipt and reversal event timeline",
  "Offline verification and exportable evidence bundles",
  "Operator escalation workflows with signed decisions"
];

export default function SecurityPage() {
  return (
    <PageFrame>
      <section className="section-shell">
        <Card className="bg-gradient-to-br from-[rgba(255,253,248,0.96)] to-[rgba(248,241,230,0.92)]">
          <CardHeader>
            <Badge variant="accent" className="w-fit">Security & Trust</Badge>
            <CardTitle className="text-[clamp(2.1rem,5vw,3.6rem)] leading-[1] tracking-[-0.02em]">
              Autonomy without blind trust.
            </CardTitle>
            <p className="max-w-4xl text-lg leading-relaxed text-[#354152]">
              Settld is designed around verifiable delegation, bounded authorization, and durable evidence. Every
              critical transition in the control loop is testable, inspectable, and replayable.
            </p>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-3">
              <a className={buttonClasses({ size: "lg" })} href="/docs/security">Read security docs</a>
              <a className={buttonClasses({ variant: "outline", size: "lg" })} href="/docs/api">API controls</a>
            </div>
          </CardContent>
        </Card>
      </section>

      <section className="section-shell">
        <Card className="bg-gradient-to-br from-[rgba(255,253,248,0.96)] to-[rgba(248,241,230,0.92)]">
          <CardHeader>
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-[#7f2f1f]">Control Set</p>
            <CardTitle className="text-[clamp(1.8rem,4.2vw,3rem)] leading-tight tracking-[-0.02em]">
              Core trust controls enforced in the kernel.
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="tight-list">
              {controls.map((control) => (
                <li key={control}>{control}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </section>
    </PageFrame>
  );
}

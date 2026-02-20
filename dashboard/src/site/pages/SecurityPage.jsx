import PageFrame from "../components/PageFrame.jsx";
import { docsLinks } from "../config/links.js";
import { buttonClasses } from "../components/ui/button.jsx";
import { Badge } from "../components/ui/badge.jsx";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card.jsx";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "../components/ui/accordion.jsx";

const trustControls = [
  {
    id: "prevent",
    label: "Prevent invalid execution",
    points: [
      "Quote signatures and key-id provenance checks before authorization.",
      "Request-bound spend caps with nonce/expiry and replay protection.",
      "Policy enforcement at ingress before provider execution."
    ]
  },
  {
    id: "contain",
    label: "Contain failures safely",
    points: [
      "Escalation suspend state with signed, one-time human override tokens.",
      "Automatic insolvency freeze and unwind for financially invalid agents.",
      "Deterministic reversal dispatch for trapped capital."
    ]
  },
  {
    id: "verify",
    label: "Verify and audit outcomes",
    points: [
      "Immutable receipt snapshots and append-only event timelines.",
      "Closepack exports with offline signature and lineage verification.",
      "Proof-gated settlement paths for verifiable digital labor."
    ]
  },
  {
    id: "operate",
    label: "Operate under incident pressure",
    points: [
      "Webhook secret rotation with transition windows and replay-safe headers.",
      "Outbox retry + dead-letter visibility for delivery and reversal queues.",
      "Runbooks for policy drift, key rollover, and dispute events."
    ]
  }
];

export default function SecurityPage() {
  return (
    <PageFrame>
      <section className="section-shell">
        <Card className="bg-gradient-to-br from-[rgba(255,253,248,0.96)] to-[rgba(248,241,230,0.92)]">
          <CardHeader>
            <Badge variant="accent" className="w-fit">Security & Trust</Badge>
            <CardTitle className="text-[clamp(2.1rem,5vw,3.6rem)] leading-[1] tracking-[-0.02em]">
              Security you can inspect.
            </CardTitle>
            <p className="max-w-4xl text-lg leading-relaxed text-[#354152]">
              Every critical action is checked, logged, and replayable. No hidden state. No trust-me gaps.
            </p>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-3">
              <a className={buttonClasses({ size: "lg" })} href={docsLinks.security}>Read security docs</a>
              <a className={buttonClasses({ variant: "outline", size: "lg" })} href={docsLinks.api}>API controls</a>
            </div>
          </CardContent>
        </Card>
      </section>

      <section className="section-shell">
        <Card>
          <CardHeader>
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-[#7f2f1f]">Control Families</p>
            <CardTitle className="text-[clamp(1.7rem,3.8vw,2.6rem)] leading-tight tracking-[-0.02em]">
              How controls map to real failures.
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Accordion type="single" collapsible className="grid gap-3">
              {trustControls.map((control) => (
                <AccordionItem key={control.id} value={control.id}>
                  <AccordionTrigger>{control.label}</AccordionTrigger>
                  <AccordionContent>
                    <ul className="tight-list mt-0">
                      {control.points.map((point) => (
                        <li key={point}>{point}</li>
                      ))}
                    </ul>
                  </AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          </CardContent>
        </Card>
      </section>
    </PageFrame>
  );
}

import { Card, CardContent, CardHeader, CardTitle } from "./ui/card.jsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs.jsx";

const primitiveDetail = {
  identity: {
    title: "Who can act",
    copy: "Define who can do what before any agent action runs.",
    bullets: [
      "Delegation lineage checks before execution",
      "Policy scopes and capability allowlists",
      "Lifecycle-aware expiry and revocation"
    ]
  },
  execution: {
    title: "How actions run",
    copy: "Run through one predictable flow, and pause when policy says no.",
    bullets: [
      "Quote -> authorize -> execute -> verify",
      "Suspend/resume state for blocked actions",
      "One-time cryptographic override tokens"
    ]
  },
  economics: {
    title: "How money is handled",
    copy: "Authorize safely, then unwind cleanly if anything fails.",
    bullets: [
      "Replay-safe bounded authorizations",
      "Automatic freeze and pending state unwind",
      "Reversal dispatch with retry and dead-letter safety"
    ]
  },
  evidence: {
    title: "How you verify",
    copy: "Keep receipts and verify them independently, online or offline.",
    bullets: [
      "Immutable receipts + append-only timeline",
      "Closepack export with offline verifier path",
      "Proof-gated settlement for digital labor"
    ]
  }
};

export default function KernelNow() {
  return (
    <section id="platform" className="section-shell">
      <Card>
        <CardHeader>
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-[#7f2f1f]">Core Capabilities</p>
          <CardTitle className="text-[clamp(1.9rem,4.4vw,3.2rem)] leading-tight tracking-[-0.02em]">
            What you get out of the box
          </CardTitle>
          <p className="text-lg leading-relaxed text-[#354152]">
            The essentials to run agent workflows without losing control.
          </p>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="identity" className="w-full">
            <TabsList>
              <TabsTrigger value="identity">Identity</TabsTrigger>
              <TabsTrigger value="execution">Execution</TabsTrigger>
              <TabsTrigger value="economics">Economics</TabsTrigger>
              <TabsTrigger value="evidence">Evidence</TabsTrigger>
            </TabsList>
            {Object.entries(primitiveDetail).map(([key, section]) => (
              <TabsContent key={key} value={key}>
                <Card className="border-[#e1d8c8] bg-[rgba(255,255,255,0.74)] shadow-none">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-2xl">{section.title}</CardTitle>
                    <p className="text-base text-[#354152]">{section.copy}</p>
                  </CardHeader>
                  <CardContent>
                    <ul className="tight-list mt-0">
                      {section.bullets.map((item) => (
                        <li key={item}>{item}</li>
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
  );
}

export default {
  name: "demo-agent",
  capabilities: [
    { name: "code_review", description: "code_review capability" }
  ],
  constraints: {
    maxSpendPerRequest: 1000,
    dataClassificationMax: 'internal'
  },
  async handle(workOrder, context) {
    const input = workOrder?.specification ?? workOrder?.input ?? {};
    context.log('processing work order');
    return {
      output: {
        ok: true,
        agent: "demo-agent",
        capability: "code_review",
        input
      },
      costUsdCents: 50,
      evidenceRefs: []
    };
  }
};
